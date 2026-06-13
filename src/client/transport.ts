/**
 * Minimal JSON-RPC 2.0 transport for celestia-node.
 *
 * Supports both http(s) (request/response) and ws(s) (subscriptions).
 * No heavy deps — uses fetch / WebSocket available in browser and Node 18+.
 */

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class CelestiaRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(err: RpcError) {
    super(`celestia-node RPC error ${err.code}: ${err.message}`);
    this.code = err.code;
    this.data = err.data;
    this.name = "CelestiaRpcError";
  }
}

export class Transport {
  private id = 0;
  private url: string;
  private token?: string;
  private timeoutMs: number;

  constructor(url: string, token?: string, timeoutMs = 30_000) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    // Auth is a bearer token from `celestia <node> auth <perm>`.
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  /** Single request/response call over HTTP. */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params });
    const ctrl = new AbortController();
    const timer =
      this.timeoutMs > 0 ? setTimeout(() => ctrl.abort(), this.timeoutMs) : undefined;
    let res: Response;
    try {
      res = await fetch(this.httpUrl(), {
        method: "POST",
        headers: this.headers(),
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (ctrl.signal.aborted) {
        throw new Error(
          `celestia-node request timed out after ${this.timeoutMs}ms calling ${method}`,
        );
      }
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} calling ${method}${detail ? `: ${detail}` : ""}`);
    }
    let json: { result?: T; error?: RpcError };
    try {
      json = (await res.json()) as { result?: T; error?: RpcError };
    } catch {
      throw new Error(`celestia-node returned a non-JSON response for ${method}`);
    }
    if (json.error) throw new CelestiaRpcError(json.error);
    return json.result as T;
  }

  /** Coerce ws:// to http:// for non-subscription calls if needed. */
  private httpUrl(): string {
    return this.url.replace(/^ws(s?):\/\//, "http$1://");
  }

  /** ws:// form of the configured URL (for subscriptions). */
  wsUrl(): string {
    return this.url.replace(/^http(s?):\/\//, "ws$1://");
  }

  authToken(): string | undefined {
    return this.token;
  }
}

/**
 * WebSocket subscription transport for celestia-node.
 *
 * celestia-node exposes subscription methods (e.g. header.Subscribe) over a
 * JSON-RPC WebSocket. This opens one socket, sends the subscribe request, and
 * invokes `onItem` for every pushed notification until `close()`.
 *
 * Uses the global WebSocket in browsers; in Node 22+ a global WebSocket also
 * exists. For older Node, inject one via the `WebSocketImpl` option.
 */
export interface SubscriptionOptions {
  WebSocketImpl?: typeof WebSocket;
  /** Auto-reconnect + resubscribe on unexpected socket close (default true). */
  reconnect?: boolean;
  /** Base backoff in ms; doubles each attempt (default 1000). */
  reconnectDelayMs?: number;
  /** Max reconnect attempts before giving up and reporting onError (default 10). */
  maxReconnectAttempts?: number;
}

export class Subscription<T> {
  private ws!: WebSocket;
  private closed = false;
  /** id of our subscribe request — its response is an ack, not an item. */
  private readonly reqId = 1;
  /** Channel id from the ack (go-jsonrpc); null until the server acks. */
  private chanId: unknown = null;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly WS: typeof WebSocket;
  private readonly authedUrl: string;
  private readonly reconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;

  constructor(
    url: string,
    private readonly method: string,
    private readonly params: unknown[],
    token: string | undefined,
    private readonly onItem: (item: T) => void,
    private readonly onError: (err: Error) => void,
    opts: SubscriptionOptions = {},
  ) {
    const WS = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
    if (!WS) {
      throw new Error("No WebSocket implementation available; pass WebSocketImpl");
    }
    this.WS = WS;
    // Browser WebSocket can't set an Authorization header, so celestia-node
    // accepts the auth token as a query param (verified live: without it the
    // node rejects with "missing permission to invoke 'Subscribe'").
    this.authedUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
    this.reconnect = opts.reconnect ?? true;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 10;
    this.connect();
  }

  private connect(): void {
    this.chanId = null;
    this.ws = new this.WS(this.authedUrl);

    this.ws.addEventListener("open", () => {
      this.attempts = 0;
      this.ws.send(
        JSON.stringify({ jsonrpc: "2.0", id: this.reqId, method: this.method, params: this.params }),
      );
    });

    this.ws.addEventListener("message", (ev: MessageEvent) => {
      if (this.closed) return;
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.error) {
          this.onError(new CelestiaRpcError(msg.error));
          return;
        }
        // A frame with an id is a response to a request (per JSON-RPC 2.0),
        // never a push. Our subscribe ack carries the channel id in result
        // (go-jsonrpc); remember it to filter notifications.
        if (msg.id !== undefined) {
          if (msg.id === this.reqId) this.chanId = msg.result;
          return;
        }
        // go-jsonrpc dialect (celestia-node): {method:"xrpc.ch.val", params:[chanId, value]}
        if (msg.method === "xrpc.ch.val" && Array.isArray(msg.params)) {
          const [chan, value] = msg.params;
          if (this.chanId !== null && chan !== this.chanId) return;
          if (value !== undefined) this.onItem(value as T);
          return;
        }
        // eth/jsonrpsee dialect: {method, params:{subscription, result}}
        const item = msg.params?.result;
        if (item !== undefined) this.onItem(item as T);
      } catch (e) {
        this.onError(e as Error);
      }
    });

    this.ws.addEventListener("error", () => {
      if (!this.closed) this.onError(new Error("WebSocket error"));
    });

    this.ws.addEventListener("close", () => {
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.reconnect) return;
    if (this.attempts >= this.maxReconnectAttempts) {
      this.onError(
        new Error(`subscription gave up after ${this.attempts} reconnect attempts`),
      );
      return;
    }
    const delay = this.reconnectDelayMs * 2 ** this.attempts;
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) this.connect();
    }, delay);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
