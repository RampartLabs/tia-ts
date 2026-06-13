import { describe, it, expect, afterEach, vi } from "vitest";
import { Celestia, MockCelestia, Namespace } from "../src/index.js";

const ADDR = "celestia1j87gwhvg6w5cs8sywflkx8sxqdnp5rtyv9te2s";

describe("MockCelestia — state.transfer / submitPayForBlob", () => {
  it("transfer debits the balance and returns code 0 with a tx hash", async () => {
    const da = new MockCelestia();
    const before = Number((await da.state.balance()).amount);
    const res = await da.state.transfer(ADDR, 5_000);
    const after = Number((await da.state.balance()).amount);

    expect(res.code).toBe(0);
    expect(res.height).toBeGreaterThan(0);
    expect(res.txHash).toMatch(/^[0-9A-F]{64}$/);
    expect(after).toBe(before - 5_000);
  });

  it("transfer over balance returns ABCI error code, balance untouched", async () => {
    const da = new MockCelestia();
    const before = Number((await da.state.balance()).amount);
    const res = await da.state.transfer(ADDR, before + 1);
    expect(res.code).not.toBe(0);
    expect(Number((await da.state.balance()).amount)).toBe(before);
  });

  it("transfer rejects junk amounts", async () => {
    const da = new MockCelestia();
    await expect(da.state.transfer(ADDR, "not-a-number")).rejects.toThrow(/invalid/);
    await expect(da.state.transfer(ADDR, -5)).rejects.toThrow(/invalid/);
  });

  it("submitPayForBlob stores blobs like blob.submit and returns a TxResponse", async () => {
    const da = new MockCelestia();
    const ns = Namespace.v0("pfb-test");
    const data = new TextEncoder().encode("via-pfb");

    const res = await da.state.submitPayForBlob([{ namespace: ns, data, shareVersion: 0 }]);
    expect(res.code).toBe(0);
    expect(res.txHash).toMatch(/^[0-9A-F]{64}$/);

    const blobs = await da.blob.getAll(res.height, [ns]);
    expect(blobs).toHaveLength(1);
    expect(new TextDecoder().decode(blobs[0].data)).toBe("via-pfb");
  });

  it("accountAddress is stable; balanceForAddress mirrors the mock balance", async () => {
    const da = new MockCelestia();
    expect(await da.state.accountAddress()).toMatch(/^celestia1/);
    const bal = await da.state.balanceForAddress(ADDR);
    expect(bal.denom).toBe("utia");
    expect(Number(bal.amount)).toBeGreaterThan(0);
  });
});

describe("state over the HTTP path (wire shapes)", () => {
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

  afterEach(() => vi.unstubAllGlobals());

  it("transfer sends [to, amount-as-string, txConfig] and flattens TxResponse", async () => {
    const fetchMock = stubFetch({
      height: "4720999",
      txhash: "AB12",
      code: 0,
      raw_log: "",
      gas_wanted: "80000",
      gas_used: "67000",
    });
    const da = new Celestia("http://localhost:26658");
    const res = await da.state.transfer(ADDR, 12_345n, { gasPrice: 0.004, gas: 80_000 });

    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(body.method).toBe("state.Transfer");
    expect(body.params[0]).toBe(ADDR);
    expect(body.params[1]).toBe("12345"); // cosmos Int — string on the wire
    expect(body.params[2]).toEqual({ gas_price: 0.004, is_gas_price_set: true, gas: 80_000 });

    expect(res).toMatchObject({ height: 4720999, txHash: "AB12", code: 0, gasUsed: 67000 });
  });

  it("submitPayForBlob sends wire blobs and null config when empty", async () => {
    const fetchMock = stubFetch({ height: 4721000, txhash: "CD34", code: 0 });
    const da = new Celestia("http://localhost:26658");
    const ns = Namespace.v0("pfb");
    await da.state.submitPayForBlob([
      { namespace: ns, data: new TextEncoder().encode("x"), shareVersion: 0 },
    ]);

    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(body.method).toBe("state.SubmitPayForBlob");
    expect(body.params[0][0]).toMatchObject({
      namespace: ns.toBase64(),
      share_version: 0,
    });
    expect(typeof body.params[0][0].data).toBe("string");
    // Empty config must serialize to {} (NOT null) — a null TxConfig panics
    // celestia-node v0.31 with a nil-pointer deref. Verified live on Mocha.
    expect(body.params[1]).toEqual({});
  });

  it("blob.submit with no opts sends {} config, never null (node panics on null)", async () => {
    const fetchMock = stubFetch(4721002);
    const da = new Celestia("http://localhost:26658");
    const ns = Namespace.v0("nullcfg");
    await da.blob.submit([
      { namespace: ns, data: new TextEncoder().encode("x"), shareVersion: 0 },
    ]);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(body.params[1]).toEqual({});
    expect(body.params[1]).not.toBeNull();
  });

  it("blob.submit forwards full TxConfig on the wire", async () => {
    const fetchMock = stubFetch(4721001);
    const da = new Celestia("http://localhost:26658");
    const ns = Namespace.v0("cfg");
    await da.blob.submit(
      [{ namespace: ns, data: new TextEncoder().encode("x"), shareVersion: 0 }],
      { gasPrice: 0.002, keyName: "my_celes_key" },
    );

    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(body.method).toBe("blob.Submit");
    expect(body.params[1]).toEqual({
      gas_price: 0.002,
      is_gas_price_set: true,
      key_name: "my_celes_key",
    });
  });

  it("node.info maps snake_case api_version to apiVersion", async () => {
    stubFetch({ type: 0, api_version: "v0.30.2" });
    const da = new Celestia("http://localhost:26658");
    const info = await da.node.info();
    expect(info.apiVersion).toBe("v0.30.2");
    expect(info.type).toBe(0);
  });
});
