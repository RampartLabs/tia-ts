/**
 * Celestia — ergonomic typed client for celestia-node JSON-RPC.
 *
 * Covers the MVP surface a rollup or app developer actually needs:
 *   blob.Submit / blob.Get / blob.GetAll / blob.GetProof / blob.Included
 *   header.NetworkHead / header.GetByHeight
 *   state.Balance
 *
 * Method names and signatures follow celestia-node API v0.28.x.
 */

import { Transport, Subscription, SubscriptionOptions } from "./transport.js";
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
  base64Decode,
} from "../types/index.js";

/** Shape a Blob into the wire object celestia-node expects. */
function blobToWire(b: Blob) {
  return {
    namespace: b.namespace.toBase64(),
    data: base64Encode(b.data),
    share_version: b.shareVersion ?? 0,
    commitment: b.commitment,
  };
}

function blobFromWire(w: any, fallbackNs: Namespace): Blob {
  return {
    namespace:
      typeof w.namespace === "string" ? Namespace.fromBase64(w.namespace) : fallbackNs,
    data: base64Decode(w.data),
    shareVersion: w.share_version ?? 0,
    commitment: w.commitment,
    index: w.index,
  };
}

/**
 * Shape TxConfig into celestia-node's jsonTxConfig (snake_case, omitempty).
 *
 * Always returns an object, never null: a null config deserializes to a nil
 * *TxConfig server-side and celestia-node v0.31 then panics in
 * TxConfig.GasPrice (nil pointer) on blob.Submit / state.Transfer /
 * SubmitPayForBlob. An empty {} deserializes to a zero-value config and the
 * node estimates gas itself. Verified live on Mocha 2026-06-10.
 */
function txConfigToWire(c: TxConfig = {}): Record<string, unknown> {
  const w: Record<string, unknown> = {};
  if (c.gasPrice != null) {
    w.gas_price = c.gasPrice;
    w.is_gas_price_set = true;
  }
  if (c.maxGasPrice != null) w.max_gas_price = c.maxGasPrice;
  if (c.gas != null) w.gas = c.gas;
  if (c.txPriority != null) w.tx_priority = c.txPriority;
  if (c.keyName != null) w.key_name = c.keyName;
  if (c.signerAddress != null) w.signer_address = c.signerAddress;
  if (c.feeGranterAddress != null) w.fee_granter_address = c.feeGranterAddress;
  return w;
}

/** Flatten a cosmos-sdk TxResponse; height may arrive as a string. */
function txResponseFromWire(w: any): TxResponse {
  return {
    height: Number(w?.height ?? 0),
    txHash: w?.txhash ?? "",
    code: Number(w?.code ?? 0),
    rawLog: w?.raw_log,
    gasWanted: w?.gas_wanted != null ? Number(w.gas_wanted) : undefined,
    gasUsed: w?.gas_used != null ? Number(w.gas_used) : undefined,
  };
}

export interface CelestiaOptions {
  /** Auth token from `celestia light auth <perm>`. Omit if node runs --rpc.skip-auth. */
  token?: string;
  /** Per-request HTTP timeout in ms (default 30000). Set 0 to disable. */
  timeoutMs?: number;
}

export class Celestia {
  readonly blob: BlobModule;
  readonly header: HeaderModule;
  readonly state: StateModule;
  readonly node: NodeModule;

  constructor(url: string = "http://localhost:26658", opts: CelestiaOptions = {}) {
    const t = new Transport(url, opts.token, opts.timeoutMs);
    this.blob = new BlobModule(t);
    this.header = new HeaderModule(t);
    this.state = new StateModule(t);
    this.node = new NodeModule(t);
  }
}

class BlobModule {
  constructor(private t: Transport) {}

  /** Post blobs; resolves to the block height they were included at. */
  async submit(blobs: Blob[], opts: TxConfig = {}): Promise<number> {
    const wire = blobs.map(blobToWire);
    return this.t.call<number>("blob.Submit", [wire, txConfigToWire(opts)]);
  }

  /** Retrieve a single blob by namespace + commitment at a height. */
  async get(height: number, ns: Namespace, commitment: Commitment): Promise<Blob> {
    const w = await this.t.call<any>("blob.Get", [height, ns.toBase64(), commitment]);
    return blobFromWire(w, ns);
  }

  /** Retrieve all blobs under the given namespaces at a height. */
  async getAll(height: number, namespaces: Namespace[]): Promise<Blob[]> {
    if (namespaces.length === 0) return [];
    const w = await this.t.call<any[]>(
      "blob.GetAll",
      [height, namespaces.map((n) => n.toBase64())],
    );
    return (w ?? []).map((b) => blobFromWire(b, namespaces[0]));
  }

  /** Inclusion proof for a blob. */
  async getProof(height: number, ns: Namespace, commitment: Commitment): Promise<Proof> {
    return this.t.call<Proof>("blob.GetProof", [height, ns.toBase64(), commitment]);
  }

  /** Verify a blob is included at a height under a namespace. */
  async included(
    height: number,
    ns: Namespace,
    proof: Proof,
    commitment: Commitment,
  ): Promise<boolean> {
    return this.t.call<boolean>("blob.Included", [height, ns.toBase64(), proof, commitment]);
  }

  /**
   * Subscribe to blobs published under a namespace. Fires once per block that
   * carries matching blobs. Returns a Subscription; call `.close()`.
   *
   * celestia-node's blob.Subscribe takes a SINGLE namespace, sent as a base64
   * string (NOT wrapped in an array). Passing an array makes the node reject
   * the params with "cannot unmarshal string into Go value of type uint8".
   */
  subscribe(
    namespace: Namespace,
    onBlobs: (blobs: Blob[], height: number) => void,
    onError: (e: Error) => void = () => {},
    opts: SubscriptionOptions = {},
  ): Subscription<any> {
    return new Subscription<any>(
      this.t.wsUrl(),
      "blob.Subscribe",
      [namespace.toBase64()],
      this.t.authToken(),
      (raw) => {
        const wire = raw?.Blobs ?? raw?.blobs ?? [];
        const blobs = wire.map((b: any) => blobFromWire(b, namespace));
        onBlobs(blobs, Number(raw?.Height ?? raw?.height ?? 0));
      },
      onError,
      opts,
    );
  }
}

class HeaderModule {
  constructor(private t: Transport) {}

  /** Latest known header (chain head). */
  async networkHead(): Promise<Header> {
    const h = await this.t.call<any>("header.NetworkHead", []);
    return normalizeHeader(h);
  }

  async getByHeight(height: number): Promise<Header> {
    const h = await this.t.call<any>("header.GetByHeight", [height]);
    return normalizeHeader(h);
  }

  /** Header by block hash (hex string). */
  async getByHash(hash: string): Promise<Header> {
    const h = await this.t.call<any>("header.GetByHash", [hash]);
    return normalizeHeader(h);
  }

  /** The node's local chain head (may lag NetworkHead while syncing). */
  async localHead(): Promise<Header> {
    const h = await this.t.call<any>("header.LocalHead", []);
    return normalizeHeader(h);
  }

  /**
   * Subscribe to new headers over WebSocket.
   * Returns a Subscription; call `.close()` to stop.
   */
  subscribe(
    onHeader: (h: Header) => void,
    onError: (e: Error) => void = () => {},
    opts: SubscriptionOptions = {},
  ): Subscription<any> {
    return new Subscription<any>(
      this.t.wsUrl(),
      "header.Subscribe",
      [],
      this.t.authToken(),
      (raw) => onHeader(normalizeHeader(raw)),
      onError,
      opts,
    );
  }
}

class StateModule {
  constructor(private t: Transport) {}

  /** TIA balance of the node's account. */
  async balance(): Promise<Balance> {
    return this.t.call<Balance>("state.Balance", []);
  }

  /** The node's own account address (bech32 `celestia1...`). */
  async accountAddress(): Promise<string> {
    return this.t.call<string>("state.AccountAddress", []);
  }

  /** Balance of an arbitrary account address. */
  async balanceForAddress(address: string): Promise<Balance> {
    return this.t.call<Balance>("state.BalanceForAddress", [address]);
  }

  /**
   * Send TIA to another account. `amount` is in utia (cosmos Int — sent as
   * a string on the wire).
   */
  async transfer(
    to: string,
    amount: string | number | bigint,
    config: TxConfig = {},
  ): Promise<TxResponse> {
    const w = await this.t.call<any>(
      "state.Transfer",
      [to, String(amount), txConfigToWire(config)],
    );
    return txResponseFromWire(w);
  }

  /**
   * Low-level PayForBlob: like blob.submit but returns the full TxResponse
   * (tx hash, gas, ABCI code) instead of just the height.
   */
  async submitPayForBlob(blobs: Blob[], config: TxConfig = {}): Promise<TxResponse> {
    const w = await this.t.call<any>(
      "state.SubmitPayForBlob",
      [blobs.map(blobToWire), txConfigToWire(config)],
    );
    return txResponseFromWire(w);
  }
}

class NodeModule {
  constructor(private t: Transport) {}

  /** Node type + API version. */
  async info(): Promise<NodeInfo> {
    const w = await this.t.call<any>("node.Info", []);
    return { type: w?.type, apiVersion: w?.apiVersion ?? w?.api_version };
  }

  /** Whether the node is ready to serve requests. */
  async ready(): Promise<boolean> {
    return this.t.call<boolean>("node.Ready", []);
  }
}

/**
 * Flatten a raw ExtendedHeader (celestia-openrpc wire shape) into Header.
 * Field mapping verified against celestiaorg/celestia-openrpc Go types:
 *   header.height        — int64 marshaled as a JSON string
 *   commit.block_id.hash — block hash (hex string)
 *   header.time          — RFC3339
 *   header.data_hash     — root of the DataAvailabilityHeader (the data root;
 *                          NOT dah.row_roots[0], which is just the first row)
 * Final confirmation against a live node: test/integration.test.ts (Phase D).
 */
function normalizeHeader(h: any): Header {
  return {
    height: Number(h?.header?.height ?? h?.height ?? 0),
    hash: h?.commit?.block_id?.hash ?? h?.hash ?? "",
    time: h?.header?.time ?? h?.time ?? "",
    dataRoot: h?.header?.data_hash ?? h?.dataRoot ?? "",
  };
}
