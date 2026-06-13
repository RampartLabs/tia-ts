import { describe, it, expect, afterEach, vi } from "vitest";
import { Celestia } from "../src/index.js";

/**
 * HTTP-path regression for normalizeHeader: feed a canonical raw
 * ExtendedHeader (shape per celestiaorg/celestia-openrpc Go types) through
 * a stubbed fetch and check the flattened Header.
 */

// Trimmed real-world shape: height is a STRING, hashes are hex strings,
// dah roots are base64. Extra fields present to prove they're ignored.
const RAW_EXTENDED_HEADER = {
  header: {
    version: { block: "11", app: "3" },
    chain_id: "mocha-4",
    height: "4720981",
    time: "2026-06-10T11:59:30.123456789Z",
    last_block_id: { hash: "AAA111", parts: { total: 1, hash: "BBB" } },
    data_hash: "3D96B7D238E7E0456F6AF8E7CDF0A67BD6CF9C2089ECB559C659DCAA1F880353",
    validators_hash: "CCC",
    app_hash: "DDD",
  },
  commit: {
    height: 4720981,
    round: 0,
    block_id: {
      hash: "F93E4D0D8F23B5B0429BA9873539FC55D3A1D6E9C81D0C6C459C28E0DA8D9C32",
      parts: { total: 1, hash: "EEE" },
    },
    signatures: [],
  },
  validator_set: { validators: [], proposer: null },
  dah: {
    row_roots: ["base64row0==", "base64row1=="],
    column_roots: ["base64col0=="],
  },
};

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeHeader over the HTTP path", () => {
  it("flattens a canonical raw ExtendedHeader", async () => {
    const fetchMock = stubFetch(RAW_EXTENDED_HEADER);
    const da = new Celestia("http://localhost:26658", { token: "tok" });
    const head = await da.header.networkHead();

    expect(head.height).toBe(4720981);
    expect(typeof head.height).toBe("number"); // wire sends a string
    expect(head.hash).toBe("F93E4D0D8F23B5B0429BA9873539FC55D3A1D6E9C81D0C6C459C28E0DA8D9C32");
    expect(head.time).toBe("2026-06-10T11:59:30.123456789Z");
    // data root = header.data_hash (root of the DAH), not dah.row_roots[0]
    expect(head.dataRoot).toBe("3D96B7D238E7E0456F6AF8E7CDF0A67BD6CF9C2089ECB559C659DCAA1F880353");

    // request envelope sanity: method + bearer token
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).method).toBe("header.NetworkHead");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
  });

  it("getByHeight sends the height param and normalizes the same way", async () => {
    const fetchMock = stubFetch(RAW_EXTENDED_HEADER);
    const da = new Celestia("http://localhost:26658");
    const h = await da.header.getByHeight(4720981);

    expect(h.height).toBe(4720981);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.method).toBe("header.GetByHeight");
    expect(body.params).toEqual([4720981]);
  });
});
