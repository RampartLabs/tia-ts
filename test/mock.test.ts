import { describe, it, expect } from "vitest";
import { MockCelestia, Namespace } from "../src/index.js";

describe("MockCelestia — blob lifecycle", () => {
  it("submit advances height", async () => {
    const da = new MockCelestia();
    const ns = Namespace.v0("test");
    const h1 = await da.blob.submit([{ namespace: ns, data: bytes("a"), shareVersion: 0 }]);
    const h2 = await da.blob.submit([{ namespace: ns, data: bytes("b"), shareVersion: 0 }]);
    expect(h2).toBeGreaterThan(h1);
  });

  it("getAll returns what was submitted", async () => {
    const da = new MockCelestia();
    const ns = Namespace.v0("test");
    const h = await da.blob.submit([{ namespace: ns, data: bytes("hello"), shareVersion: 0 }]);
    const blobs = await da.blob.getAll(h, [ns]);
    expect(blobs).toHaveLength(1);
    expect(new TextDecoder().decode(blobs[0].data)).toBe("hello");
  });

  it("getProof + included verifies", async () => {
    const da = new MockCelestia();
    const ns = Namespace.v0("test");
    const h = await da.blob.submit([{ namespace: ns, data: bytes("x"), shareVersion: 0 }]);
    const [b] = await da.blob.getAll(h, [ns]);
    const proof = await da.blob.getProof(h, ns, b.commitment!);
    const ok = await da.blob.included(h, ns, proof, b.commitment!);
    expect(ok).toBe(true);
  });

  it("namespace isolation", async () => {
    const da = new MockCelestia();
    const mine = Namespace.v0("mine");
    const other = Namespace.v0("other");
    const h = await da.blob.submit([{ namespace: mine, data: bytes("secret"), shareVersion: 0 }]);
    const seen = await da.blob.getAll(h, [other]);
    expect(seen).toHaveLength(0);
  });

  it("balance decreases after submit", async () => {
    const da = new MockCelestia();
    const ns = Namespace.v0("test");
    const before = Number((await da.state.balance()).amount);
    await da.blob.submit([{ namespace: ns, data: bytes("x"), shareVersion: 0 }]);
    const after = Number((await da.state.balance()).amount);
    expect(after).toBeLessThan(before);
  });

  it("get by commitment retrieves correct blob", async () => {
    const da = new MockCelestia();
    const ns = Namespace.v0("test");
    const h = await da.blob.submit([{ namespace: ns, data: bytes("data1"), shareVersion: 0 }]);
    const [b] = await da.blob.getAll(h, [ns]);
    const got = await da.blob.get(h, ns, b.commitment!);
    expect(new TextDecoder().decode(got.data)).toBe("data1");
  });
});

describe("MockCelestia — header", () => {
  it("networkHead reflects current height", async () => {
    const da = new MockCelestia();
    const ns = Namespace.v0("test");
    await da.blob.submit([{ namespace: ns, data: bytes("x"), shareVersion: 0 }]);
    const head = await da.header.networkHead();
    expect(head.height).toBeGreaterThanOrEqual(1);
  });

  it("getByHeight returns deterministic header", async () => {
    const da = new MockCelestia();
    const a = await da.header.getByHeight(5);
    const b = await da.header.getByHeight(5);
    expect(a.hash).toBe(b.hash);
  });

  it("subscribe emits one header per new block, close() stops delivery", async () => {
    const da = new MockCelestia();
    const ns = Namespace.v0("test");
    const seen: number[] = [];
    const sub = da.header.subscribe((h) => seen.push(h.height));

    const h1 = await da.blob.submit([{ namespace: ns, data: bytes("a"), shareVersion: 0 }]);
    const h2 = await da.blob.submit([{ namespace: ns, data: bytes("b"), shareVersion: 0 }]);
    expect(seen).toEqual([h1, h2]);

    sub.close();
    await da.blob.submit([{ namespace: ns, data: bytes("c"), shareVersion: 0 }]);
    expect(seen).toEqual([h1, h2]);
  });

  it("subscriber can read the new block's blobs from inside the callback", async () => {
    const da = new MockCelestia();
    const ns = Namespace.v0("test");
    let payload = "";
    da.header.subscribe((h) => {
      void da.blob.getAll(h.height, [ns]).then((blobs) => {
        payload = new TextDecoder().decode(blobs[0].data);
      });
    });
    await da.blob.submit([{ namespace: ns, data: bytes("from-sub"), shareVersion: 0 }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(payload).toBe("from-sub");
  });
});

describe("MockCelestia — extended API surface", () => {
  it("blob.subscribe fires once per block carrying matching blobs", async () => {
    const da = new MockCelestia();
    const ns = Namespace.v0("sub");
    const seen: { count: number; height: number }[] = [];
    const sub = da.blob.subscribe(ns, (blobs, height) =>
      seen.push({ count: blobs.length, height }),
    );
    const h = await da.blob.submit([{ namespace: ns, data: bytes("a"), shareVersion: 0 }]);
    expect(seen).toEqual([{ count: 1, height: h }]);
    sub.close();
  });

  it("blob.subscribe skips blocks with no matching namespace", async () => {
    const da = new MockCelestia();
    const mine = Namespace.v0("mine");
    const other = Namespace.v0("other");
    const seen: number[] = [];
    da.blob.subscribe(mine, (_b, h) => seen.push(h));
    await da.blob.submit([{ namespace: other, data: bytes("x"), shareVersion: 0 }]);
    expect(seen).toEqual([]);
  });

  it("header.getByHash round-trips with networkHead; localHead equals head", async () => {
    const da = new MockCelestia();
    await da.blob.submit([{ namespace: Namespace.v0("t"), data: bytes("x"), shareVersion: 0 }]);
    const head = await da.header.networkHead();
    expect((await da.header.getByHash(head.hash)).height).toBe(head.height);
    expect((await da.header.localHead()).height).toBe(head.height);
  });

  it("node.info/ready respond", async () => {
    const da = new MockCelestia();
    expect((await da.node.info()).type).toBeDefined();
    expect(await da.node.ready()).toBe(true);
  });
});

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
