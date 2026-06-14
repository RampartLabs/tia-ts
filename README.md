# tia-ts

Typed TypeScript client for [celestia-node](https://github.com/celestiaorg/celestia-node) JSON-RPC, with an in-memory `MockCelestia` for tests.

Official Celestia clients exist only for Go and Rust. This fills the JS/TS gap with an ergonomic, fully-typed surface — and ships a mock DA layer so you can unit-test rollup logic without Docker or a testnet.

## Install

```bash
npm install @rampartlabs/tia-ts
```

## Quick start

```typescript
import { Celestia, Namespace } from "@rampartlabs/tia-ts";

const da = new Celestia("http://localhost:26658", { token: process.env.CELESTIA_NODE_AUTH_TOKEN });
const ns = Namespace.v0("my-rollup");

// post data
const height = await da.blob.submit([
  { namespace: ns, data: new TextEncoder().encode("hello da"), shareVersion: 0 },
]);

// read it back
const blobs = await da.blob.getAll(height, [ns]);
console.log(new TextDecoder().decode(blobs[0].data)); // "hello da"

// verify inclusion
const proof = await da.blob.getProof(height, ns, blobs[0].commitment!);
const ok = await da.blob.included(height, ns, proof, blobs[0].commitment!);
```

## Subscribe to new headers

```typescript
const sub = da.header.subscribe((h) => {
  console.log("new block", h.height, h.dataRoot);
});
// later
sub.close();
```

Uses the global `WebSocket` (browsers, Node 22+). On older Node, inject one:

```typescript
import WebSocket from "ws"; // npm i ws — optional, only for Node < 22

const sub = da.header.subscribe(onHeader, onError, {
  WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
});
```

## Testing without a node

`MockCelestia` mirrors the same API in memory — deterministic, instant, offline.

```typescript
import { MockCelestia, Namespace } from "@rampartlabs/tia-ts";

const da = new MockCelestia();           // swap Celestia → MockCelestia
const ns = Namespace.v0("test");
const data = new TextEncoder().encode("hello");

const h = await da.blob.submit([{ namespace: ns, data, shareVersion: 0 }]);
const blobs = await da.blob.getAll(h, [ns]);

// header.subscribe is mirrored too — fires once per submitted block,
// synchronously and deterministically (no sockets, no timers):
const sub = da.header.subscribe((head) => console.log("block", head.height));
await da.blob.submit([{ namespace: ns, data, shareVersion: 0 }]); // → "block 3"
sub.close();
```

A test that passes on `MockCelestia` passes on `Celestia` too (except cryptographic proof verification — mock commitments are stable hashes, not NMT roots).

## API surface

| Module | Methods |
|---|---|
| `blob` | `submit`, `get`, `getAll`, `getProof`, `included`, `subscribe` |
| `header` | `networkHead`, `getByHeight`, `getByHash`, `localHead`, `subscribe` |
| `state` | `balance`, `accountAddress`, `balanceForAddress`, `transfer`, `submitPayForBlob` |
| `node` | `info`, `ready` |

The core `blob` / `header` / `state` surface was verified live against a Mocha
node (v0.31.2). The methods added in 0.2.0 (`blob.subscribe`,
`state.accountAddress` / `balanceForAddress`, `header.getByHash` / `localHead`,
`node.*`) follow the documented node API but are not yet live-verified.
`MockCelestia` implements every method with identical signatures.

## Scope & limitations

A focused client for the surface most rollup/app developers need (`blob`,
`header`, `state`, plus a `node` health-check). The node's `share`, `das`,
`p2p`, `blobstream`, and `da` modules are **not covered** yet (PRs welcome).

- **Timeouts.** HTTP calls abort after `timeoutMs` (default 30s); pass
  `new Celestia(url, { timeoutMs })` to tune, or `0` to disable.
- **Subscriptions reconnect** automatically on an unexpected socket close;
  tune via the options bag on `subscribe(...)`.
- **`MockCelestia` is not cryptographic** - commitments are stable FNV-1a
  hashes, not real NMT roots. For fast deterministic app-logic tests, not
  consensus verification.

```typescript
// send TIA (amount in utia)
const tx = await da.state.transfer("celestia1...", 100_000n);
if (tx.code === 0) console.log("sent in block", tx.height, tx.txHash);

// low-level PayForBlob — full TxResponse instead of just a height
const res = await da.state.submitPayForBlob([{ namespace: ns, data, shareVersion: 0 }]);
```

Wire-format notes (verified against the canonical
[celestia-openrpc](https://github.com/celestiaorg/celestia-openrpc) Go types):

- `Header.dataRoot` is the raw header's `data_hash` — the root of the
  DataAvailabilityHeader.
- `Proof` is an **array** of NMT range proofs (`NmtProof[]`), one per block
  row the blob spans — pass it back to `included` as-is.
- `Blob.index` (the blob's first share index) is populated by the node on
  reads.

## Auth

Get a token from your node:

```bash
celestia light auth admin --p2p.network mocha
```

Or run with `--rpc.skip-auth` and pass no token.

> **Security note:** WebSocket subscriptions pass the auth token as a `?token=`
> query parameter (browser `WebSocket` can't set headers), so it may appear in
> proxy/server access logs. Prefer a read-scoped token for subscriptions.

## Demo

[`demo/index.html`](./demo/index.html) is a single static page running the full
submit → retrieve → verify round-trip on `MockCelestia` in the browser — no
node, no build step. Open it locally:

```bash
npx serve demo          # → http://localhost:3000
```

### Deploy to GitHub Pages

The repo ships [`.github/workflows/pages.yml`](./.github/workflows/pages.yml)
which publishes `demo/` on every push to `main`. One-time setup:

1. Repo → Settings → Pages → Source: **GitHub Actions**.
2. Push to `main` (or run the workflow manually from the Actions tab).
3. Demo appears at `https://<user>.github.io/<repo>/`.

### Deploy to Vercel

```bash
npm i -g vercel
vercel deploy demo --prod
```

`demo/` has no build step, so Vercel serves it as-is (framework preset: Other).

## Development

```bash
npm install
npm test          # vitest
npm run build     # tsup → ESM + CJS + .d.ts
```

Contributions welcome - open an issue to discuss the design before a PR.

## License

Apache-2.0
