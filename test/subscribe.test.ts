import { describe, it, expect } from "vitest";
import { Celestia } from "../src/index.js";

/**
 * header.subscribe against a fake WebSocket — no real node involved.
 *
 * The fake captures the subscribe frame and lets the test push server
 * messages. Wire shapes used here follow the JSON-RPC subscription
 * patterns celestia-node may speak (go-jsonrpc `xrpc.ch.val` and the
 * eth/jsonrpsee `params.result` style). Phase D verifies which one the
 * real node actually sends.
 */

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset() {
    FakeWebSocket.instances = [];
  }

  url: string;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, ev: unknown = {}) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }

  /** Push a server frame as a message event. */
  message(obj: unknown) {
    this.emit("message", { data: JSON.stringify(obj) });
  }
}

const WS = FakeWebSocket as unknown as typeof WebSocket;

/** Raw ExtendedHeader as celestia-openrpc shapes it (height is a string, data_hash is the data root). */
function rawHeader(height: number) {
  return {
    header: {
      height: String(height),
      time: `2026-06-10T12:00:0${height % 10}Z`,
      data_hash: `DATAROOT${height}`,
    },
    commit: { block_id: { hash: `HASH${height}` } },
    dah: { row_roots: [`ROOT${height}A`, `ROOT${height}B`], column_roots: [] },
  };
}

function setup(opts: Record<string, unknown> = {}) {
  FakeWebSocket.reset();
  const da = new Celestia("http://localhost:26658");
  const headers: { height: number; hash: string; time: string; dataRoot: string }[] = [];
  const errors: Error[] = [];
  const sub = da.header.subscribe(
    (h) => headers.push(h),
    (e) => errors.push(e),
    { WebSocketImpl: WS, ...opts },
  );
  const ws = FakeWebSocket.instances[0];
  return { da, sub, ws, headers, errors };
}

describe("header.subscribe over fake WebSocket", () => {
  it("connects to the ws:// form of the URL and sends header.Subscribe on open", () => {
    const { ws } = setup();
    expect(ws.url).toBe("ws://localhost:26658");
    ws.emit("open");
    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0]);
    expect(frame).toMatchObject({ jsonrpc: "2.0", method: "header.Subscribe", params: [] });
    expect(frame.id).toBeDefined();
  });

  it("passes the auth token as a query param (browser WS can't set headers)", () => {
    FakeWebSocket.reset();
    const da = new Celestia("http://localhost:26658", { token: "secret+tok" });
    da.header.subscribe(() => {}, () => {}, { WebSocketImpl: WS });
    expect(FakeWebSocket.instances[0].url).toBe(
      "ws://localhost:26658?token=secret%2Btok",
    );
  });

  it("does NOT deliver the subscription ack (id-response) as a header", () => {
    const { ws, headers, errors } = setup();
    ws.emit("open");
    // Server acks the subscribe request — channel id 7 in result.
    ws.message({ jsonrpc: "2.0", id: 1, result: 7 });
    expect(headers).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("delivers N go-jsonrpc notifications (xrpc.ch.val) as normalized headers", () => {
    const { ws, headers } = setup();
    ws.emit("open");
    ws.message({ jsonrpc: "2.0", id: 1, result: 7 });
    const N = 3;
    for (let i = 1; i <= N; i++) {
      ws.message({ jsonrpc: "2.0", method: "xrpc.ch.val", params: [7, rawHeader(100 + i)] });
    }
    expect(headers).toHaveLength(N);
    expect(headers.map((h) => h.height)).toEqual([101, 102, 103]);
    // normalizeHeader applied: nested wire fields flattened + height is a number
    expect(headers[0].hash).toBe("HASH101");
    expect(headers[0].dataRoot).toBe("DATAROOT101");
    expect(headers[0].time).toBe("2026-06-10T12:00:01Z");
    expect(typeof headers[0].height).toBe("number");
  });

  it("ignores xrpc.ch.val frames for a different channel id", () => {
    const { ws, headers } = setup();
    ws.emit("open");
    ws.message({ jsonrpc: "2.0", id: 1, result: 7 });
    ws.message({ jsonrpc: "2.0", method: "xrpc.ch.val", params: [99, rawHeader(500)] });
    expect(headers).toHaveLength(0);
  });

  it("delivers eth-style notifications (params.result) as normalized headers", () => {
    const { ws, headers } = setup();
    ws.emit("open");
    ws.message({ jsonrpc: "2.0", id: 1, result: "0xsub" });
    for (let i = 1; i <= 2; i++) {
      ws.message({
        jsonrpc: "2.0",
        method: "header.Subscribe",
        params: { subscription: "0xsub", result: rawHeader(200 + i) },
      });
    }
    expect(headers.map((h) => h.height)).toEqual([201, 202]);
    expect(headers[1].hash).toBe("HASH202");
  });

  it("routes an RPC error frame to onError, not onHeader", () => {
    const { ws, headers, errors } = setup();
    ws.emit("open");
    ws.message({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } });
    expect(headers).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("method not found");
  });

  it("close() closes the socket and stops delivery", () => {
    const { ws, sub, headers } = setup();
    ws.emit("open");
    ws.message({ jsonrpc: "2.0", id: 1, result: 7 });
    sub.close();
    expect(ws.closed).toBe(true);
    ws.message({ jsonrpc: "2.0", method: "xrpc.ch.val", params: [7, rawHeader(300)] });
    expect(headers).toHaveLength(0);
  });

  it("socket-level error event reaches onError", () => {
    const { ws, errors } = setup();
    ws.emit("open");
    ws.emit("error");
    expect(errors).toHaveLength(1);
  });

  it("reconnects and resubscribes after an unexpected socket close", async () => {
    const { ws } = setup({ reconnect: true, reconnectDelayMs: 5, maxReconnectAttempts: 3 });
    ws.emit("open");
    ws.message({ jsonrpc: "2.0", id: 1, result: 7 });
    expect(FakeWebSocket.instances).toHaveLength(1);

    ws.emit("close"); // unexpected drop
    await new Promise((r) => setTimeout(r, 30)); // wait past the 5ms backoff

    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const ws2 = FakeWebSocket.instances[1];
    ws2.emit("open");
    expect(JSON.parse(ws2.sent[0]).method).toBe("header.Subscribe");
  });

  it("does NOT reconnect after an explicit close()", async () => {
    const { ws, sub } = setup({ reconnect: true, reconnectDelayMs: 5 });
    ws.emit("open");
    sub.close();
    ws.emit("close");
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
