/**
 * Core domain types for the Celestia Data Availability layer.
 *
 * These mirror the wire format of celestia-node JSON-RPC (v0.28.x) but expose
 * an ergonomic, fully-typed surface so JS/TS developers never touch raw base64
 * JSON-RPC envelopes by hand.
 */

/** A namespace partitions block data so each rollup downloads only its own blobs. */
export class Namespace {
  /** 29-byte namespace id: 1 version byte + 28 id bytes. */
  readonly bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get version(): number {
    return this.bytes[0] ?? 0;
  }

  /**
   * Create a version-0 namespace from up to 10 user bytes (right-padded).
   * Mirrors `Namespace::new_v0` from the Rust client.
   */
  static v0(id: Uint8Array | string): Namespace {
    const raw = typeof id === "string" ? new TextEncoder().encode(id) : id;
    if (raw.length > 10) {
      throw new RangeError(`v0 namespace id must be <= 10 bytes, got ${raw.length}`);
    }
    // version(1)=0 + 18 leading zero bytes + 10-byte right-padded id
    const out = new Uint8Array(29);
    out.set(raw, 29 - 10 + (10 - raw.length));
    return new Namespace(out);
  }

  static fromBytes(bytes: Uint8Array): Namespace {
    if (bytes.length !== 29) {
      throw new RangeError(`namespace must be 29 bytes, got ${bytes.length}`);
    }
    return new Namespace(new Uint8Array(bytes));
  }

  static fromBase64(s: string): Namespace {
    return Namespace.fromBytes(base64Decode(s));
  }

  /** Parse a 0x-hex string: a full 29-byte namespace, or a <=10-byte v0 id. */
  static fromHex(hex: string): Namespace {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0) {
      throw new RangeError(`hex must have an even length, got ${clean.length}`);
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    if (bytes.length === 29) return Namespace.fromBytes(bytes);
    if (bytes.length <= 10) return Namespace.v0(bytes);
    throw new RangeError(
      `hex must be a 29-byte namespace or a <=10-byte v0 id, got ${bytes.length} bytes`,
    );
  }

  toHex(): string {
    return "0x" + [...this.bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Wire format expects base64 of the full 29 bytes. */
  toBase64(): string {
    return base64Encode(this.bytes);
  }
}

/** A unit of data posted to Celestia under one namespace. */
export interface Blob {
  namespace: Namespace;
  /** Raw payload bytes. */
  data: Uint8Array;
  /** Share version (0 for standard blobs). */
  shareVersion: number;
  /** Merkle-subtree-root commitment; populated by the node after submit. */
  commitment?: Commitment;
  /** Index of the blob's first share in the block; set by the node on reads. */
  index?: number;
}

/** Merkle subtree root identifying a blob within a block. */
export type Commitment = string; // base64 on the wire

/**
 * One NMT range proof. Wire shape follows nmt's pb.Proof JSON
 * (snake_case, omitempty — optional fields may be absent).
 */
export interface NmtProof {
  start: number;
  end: number;
  /** NMT proof nodes, base64-encoded. */
  nodes: string[];
  leaf_hash?: string;
  is_max_namespace_ignored?: boolean;
}

/**
 * Inclusion proof returned by blob.GetProof — an ARRAY of NMT proofs,
 * one per block row the blob spans (Go: `type Proof []*nmt.Proof`).
 */
export type Proof = NmtProof[];

/** Extended header for a Celestia block. */
export interface Header {
  height: number;
  hash: string;
  time: string;
  /** Root of the data availability commitment. */
  dataRoot: string;
}

export interface Balance {
  denom: string;
  amount: string;
}

export interface NodeInfo {
  type?: string | number;
  apiVersion?: string;
}

/**
 * Transaction options for state-submitting calls (wire: celestia-node
 * TxConfig). Every field is optional — the node estimates what's omitted.
 */
export interface TxConfig {
  /** utia per gas. Omit to let the node estimate. */
  gasPrice?: number;
  /** Ceiling for automatic gas price escalation. */
  maxGasPrice?: number;
  /** Gas limit. */
  gas?: number;
  txPriority?: number;
  /** Keystore key to sign with (defaults to the node's key). */
  keyName?: string;
  signerAddress?: string;
  feeGranterAddress?: string;
}

/** @deprecated Use TxConfig — kept as an alias for early adopters. */
export type SubmitOptions = TxConfig;

/** Result of a submitted transaction (cosmos-sdk TxResponse, trimmed). */
export interface TxResponse {
  height: number;
  txHash: string;
  /** 0 = success; anything else is an ABCI error code. */
  code: number;
  rawLog?: string;
  gasWanted?: number;
  gasUsed?: number;
}

/** ---- internal base64 helpers (browser + node, no Buffer dependency) ---- */
export function base64Encode(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  // node fallback
  return (globalThis as any).Buffer.from(bytes).toString("base64");
}

export function base64Decode(s: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array((globalThis as any).Buffer.from(s, "base64"));
}
