import { describe, it, expect, afterEach, vi } from "vitest";
import { Celestia } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("Transport reliability", () => {
  it("aborts and rejects with a timeout error when the node never responds", async () => {
    // fetch that hangs until the abort signal fires
    vi.stubGlobal("fetch", (_url: string, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
    const da = new Celestia("http://localhost:26658", { timeoutMs: 20 });
    await expect(da.header.networkHead()).rejects.toThrow(/timed out after 20ms/);
  });

  it("includes the response body in HTTP errors", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom details", { status: 500 }));
    const da = new Celestia("http://localhost:26658");
    await expect(da.header.networkHead()).rejects.toThrow(/HTTP 500.*boom details/);
  });

  it("rejects clearly when the node returns non-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const da = new Celestia("http://localhost:26658");
    await expect(da.header.networkHead()).rejects.toThrow(/non-JSON/);
  });
});
