import { describe, it, expect, afterEach, vi } from "vitest";
import { Celestia, Namespace } from "../src/index.js";

function stubFetch(result: unknown) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin);
}

afterEach(() => vi.unstubAllGlobals());

describe("blob.getAll namespace mapping (HTTP path)", () => {
  it("tags each blob with its OWN wire namespace, not the request-index namespace", async () => {
    const nsA = Namespace.v0("aaa");
    const nsB = Namespace.v0("bbb");
    // Node returns blobs interleaved across namespaces — more blobs than the
    // 2 requested namespaces. The old code mapped by result index and would
    // mislabel index >= 2 (namespaces[2] === undefined).
    stubFetch([
      { namespace: nsA.toBase64(), data: b64("1"), share_version: 0, commitment: "c1" },
      { namespace: nsB.toBase64(), data: b64("2"), share_version: 0, commitment: "c2" },
      { namespace: nsA.toBase64(), data: b64("3"), share_version: 0, commitment: "c3" },
    ]);

    const da = new Celestia("http://localhost:26658");
    const blobs = await da.blob.getAll(100, [nsA, nsB]);

    expect(blobs.map((b) => b.namespace.toBase64())).toEqual([
      nsA.toBase64(),
      nsB.toBase64(),
      nsA.toBase64(),
    ]);
    expect(new TextDecoder().decode(blobs[2].data)).toBe("3");
  });

  it("falls back to the requested namespace when wire omits it", async () => {
    const ns = Namespace.v0("solo");
    stubFetch([{ data: b64("x"), share_version: 0, commitment: "c" }]);
    const da = new Celestia("http://localhost:26658");
    const [blob] = await da.blob.getAll(7, [ns]);
    expect(blob.namespace.toBase64()).toBe(ns.toBase64());
  });
});
