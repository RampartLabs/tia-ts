/**
 * MockCelestia — an in-memory Data Availability layer for tests.
 *
 * Why this exists:
 *   Today, to test rollup logic that posts blobs you must either run
 *   `local-celestia-devnet` in Docker or hit a public testnet via a Discord
 *   faucet. Both are slow, flaky in CI, and impossible offline.
 *
 *   MockCelestia implements the same surface as `Celestia` (blob/header/state)
 *   entirely in memory: blobs are stored, heights advance deterministically,
 *   commitments are derived, and inclusion proofs validate against the same
 *   data. Drop it into unit tests as a stand-in for the real client.
 *
 * It is intentionally NOT cryptographically faithful — commitments are stable
 * hashes, not real NMT roots. The point is fast, deterministic behavioral
 * parity for application logic, not consensus-grade verification.
 */

import {
  Blob,
  Namespace,
  Commitment,
  Proof,
  Header,
  Balance,
  NodeInfo,
  TxConfig,
  TxResponse,
  base64Encode,
} from "../types/index.js";
import type { SubscriptionOptions } from "../client/transport.js";

interface StoredBlob {
  blob: Blob;
  height: number;
  commitment: Commitment;
}

/** Tiny stable digest (FNV-1a) → base64. Deterministic, dependency-free. */
function digest(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setUint32(0, h >>> 0);
  new DataView(out.buffer).setUint32(4, (h * 2654435761) >>> 0);
  return base64Encode(out);
}

export class MockCelestia {
  readonly blob: MockBlobModule;
  readonly header: MockHeaderModule;
  readonly state: MockStateModule;
  readonly node: MockNodeModule;

  private store: StoredBlob[] = [];
  private height = 1;
  private _balance = 100_000_000; // 100 TIA in utia-ish units
  private headerSubs = new Set<(height: number) => void>();

  constructor() {
    this.blob = new MockBlobModule(this);
    this.header = new MockHeaderModule(this);
    this.state = new MockStateModule(this);
    this.node = new MockNodeModule();
  }

  /** @internal */ _advance(): number {
    return ++this.height;
  }
  /** @internal */ _notifyNewBlock(height: number) {
    for (const fn of [...this.headerSubs]) fn(height);
  }
  /** @internal */ _subscribe(fn: (height: number) => void): { close: () => void } {
    this.headerSubs.add(fn);
    return {
      close: () => {
        this.headerSubs.delete(fn);
      },
    };
  }
  /** @internal */ _currentHeight(): number {
    return this.height;
  }
  /** @internal */ _put(b: StoredBlob) {
    this.store.push(b);
  }
  /** @internal */ _at(height: number): StoredBlob[] {
    return this.store.filter((s) => s.height === height);
  }
  /** @internal */ _commit(blob: Blob): Commitment {
    const ns = blob.namespace.bytes;
    const joined = new Uint8Array(ns.length + blob.data.length);
    joined.set(ns);
    joined.set(blob.data, ns.length);
    return digest(joined);
  }
  /** @internal */ _spend(amount = 1000) {
    this._balance = Math.max(0, this._balance - amount);
  }
  /** @internal */ _bal(): number {
    return this._balance;
  }
}

class MockBlobModule {
  constructor(private m: MockCelestia) {}

  async submit(blobs: Blob[], _opts: TxConfig = {}): Promise<number> {
    const height = this.m._advance();
    for (const b of blobs) {
      const commitment = this.m._commit(b);
      this.m._put({ blob: { ...b, commitment }, height, commitment });
      this.m._spend();
    }
    // Notify after the block's blobs are stored, like a real node:
    // a subscriber reacting to the header can getAll() at that height.
    this.m._notifyNewBlock(height);
    return height;
  }

  async get(height: number, ns: Namespace, commitment: Commitment): Promise<Blob> {
    const found = this.m
      ._at(height)
      .find((s) => s.commitment === commitment && nsEq(s.blob.namespace, ns));
    if (!found) throw new Error(`blob not found at height ${height}`);
    return found.blob;
  }

  async getAll(height: number, namespaces: Namespace[]): Promise<Blob[]> {
    return this.m
      ._at(height)
      .filter((s) => namespaces.some((n) => nsEq(s.blob.namespace, n)))
      .map((s) => s.blob);
  }

  // Proof is an array of NMT range proofs (one per row), mirroring the real
  // API's `[]*nmt.Proof`. The mock emits a single-range proof.
  async getProof(height: number, ns: Namespace, commitment: Commitment): Promise<Proof> {
    const blobs = this.m._at(height);
    const idx = blobs.findIndex(
      (s) => s.commitment === commitment && nsEq(s.blob.namespace, ns),
    );
    if (idx < 0) throw new Error(`no blob to prove at height ${height}`);
    return [{ start: idx, end: idx + 1, nodes: [commitment] }];
  }

  async included(
    height: number,
    ns: Namespace,
    proof: Proof,
    commitment: Commitment,
  ): Promise<boolean> {
    const blobs = this.m._at(height);
    return proof.some((p) =>
      blobs.some(
        (s, i) =>
          i >= p.start &&
          i < p.end &&
          s.commitment === commitment &&
          nsEq(s.blob.namespace, ns),
      ),
    );
  }

  /** Mirror of blob.subscribe — fires per new block carrying matching blobs. */
  subscribe(
    namespace: Namespace,
    onBlobs: (blobs: Blob[], height: number) => void,
    _onError: (e: Error) => void = () => {},
    _opts: SubscriptionOptions = {},
  ): { close(): void } {
    return this.m._subscribe((height) => {
      const blobs = this.m
        ._at(height)
        .filter((s) => nsEq(s.blob.namespace, namespace))
        .map((s) => s.blob);
      if (blobs.length) onBlobs(blobs, height);
    });
  }
}

class MockHeaderModule {
  constructor(private m: MockCelestia) {}
  async networkHead(): Promise<Header> {
    return this.synth(this.m._currentHeight());
  }
  async getByHeight(height: number): Promise<Header> {
    return this.synth(height);
  }
  async getByHash(hash: string): Promise<Header> {
    for (let h = 1; h <= this.m._currentHeight(); h++) {
      const hdr = this.synth(h);
      if (hdr.hash === hash) return hdr;
    }
    throw new Error(`header not found for hash ${hash}`);
  }
  async localHead(): Promise<Header> {
    return this.synth(this.m._currentHeight());
  }
  /**
   * Mirror of Celestia.header.subscribe — emits a header for every new
   * block (each blob.submit advances one block). Synchronous and
   * deterministic: no sockets, no timers. `close()` stops delivery.
   */
  subscribe(
    onHeader: (h: Header) => void,
    _onError: (e: Error) => void = () => {},
    _opts: SubscriptionOptions = {},
  ): { close(): void } {
    return this.m._subscribe((height) => onHeader(this.synth(height)));
  }
  private synth(height: number): Header {
    return {
      height,
      hash: digest(new Uint8Array([height & 0xff, (height >> 8) & 0xff])),
      time: new Date(1_700_000_000_000 + height * 6000).toISOString(),
      dataRoot: digest(new Uint8Array([height])),
    };
  }
}

class MockStateModule {
  constructor(private m: MockCelestia) {}
  async balance(): Promise<Balance> {
    return { denom: "utia", amount: String(this.m._bal()) };
  }

  async accountAddress(): Promise<string> {
    return "celestia1mockaccount0000000000000000000000000";
  }

  async balanceForAddress(_address: string): Promise<Balance> {
    return { denom: "utia", amount: String(this.m._bal()) };
  }

  /** Mirror of state.transfer — debits the balance, fails on overdraft. */
  async transfer(
    to: string,
    amount: string | number | bigint,
    _config: TxConfig = {},
  ): Promise<TxResponse> {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      throw new Error(`invalid transfer amount: ${amount}`);
    }
    if (amt > this.m._bal()) {
      // Real node returns an ABCI error; mock mirrors it as code 5
      // (cosmos ErrInsufficientFunds) without throwing.
      return { height: this.m._currentHeight(), txHash: this.txHash(to, amt), code: 5, rawLog: "insufficient funds" };
    }
    this.m._spend(amt);
    const height = this.m._advance();
    this.m._notifyNewBlock(height);
    return { height, txHash: this.txHash(to, amt), code: 0 };
  }

  /** Mirror of state.submitPayForBlob — same storage path as blob.submit. */
  async submitPayForBlob(blobs: Blob[], config: TxConfig = {}): Promise<TxResponse> {
    const height = await this.m.blob.submit(blobs, config);
    return { height, txHash: this.txHash("pfb", height), code: 0 };
  }

  private txHash(seed: string, n: number): string {
    return hexDigest(new TextEncoder().encode(`${seed}:${n}:${this.m._currentHeight()}`));
  }
}

class MockNodeModule {
  async info(): Promise<NodeInfo> {
    return { type: "light", apiVersion: "mock" };
  }
  async ready(): Promise<boolean> {
    return true;
  }
}

/** 64-char uppercase hex digest (cosmos txhash shape), FNV-1a based. */
function hexDigest(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  const a = (h >>> 0).toString(16).padStart(8, "0");
  const b = ((h * 2654435761) >>> 0).toString(16).padStart(8, "0");
  return (a + b + a + b + a + b + a + b).toUpperCase();
}

function nsEq(a: Namespace, b: Namespace): boolean {
  if (a.bytes.length !== b.bytes.length) return false;
  for (let i = 0; i < a.bytes.length; i++) if (a.bytes[i] !== b.bytes[i]) return false;
  return true;
}
