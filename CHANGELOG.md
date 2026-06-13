# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
semantic versioning.

## [0.2.0] - 2026-06-11

### Added
- `blob.subscribe(namespace, cb)` - stream blobs published under a namespace
  over WebSocket.
- `state.accountAddress()` and `state.balanceForAddress(addr)`.
- `header.getByHash(hash)` and `header.localHead()`.
- `node` module with `info()` and `ready()` (health-check).
- `Namespace.fromBytes()`, `Namespace.fromBase64()`, and a `version` getter.
- `CelestiaOptions.timeoutMs` - per-request HTTP timeout (default 30s,
  `AbortController`-based; set `0` to disable).
- WebSocket subscriptions now auto-reconnect and resubscribe on unexpected
  socket close, configurable via `SubscriptionOptions`
  (`reconnect`, `reconnectDelayMs`, `maxReconnectAttempts`).
- `MockCelestia` mirrors every new method.

### Fixed
- `blob.getAll` now tags each returned blob with its own namespace parsed from
  the wire response, instead of mis-mapping by request index when several
  namespaces are queried (single-namespace calls were unaffected).
- `Namespace.fromHex` now parses a full 29-byte namespace instead of silently
  keeping only the last 10 bytes and forcing version 0.
- HTTP errors now include the response body; a non-JSON response produces a
  clear error instead of an opaque JSON-parse failure.
- `blob.subscribe` now sends a single namespace as base64, matching
  celestia-node's `blob.Subscribe(ns)`. It previously wrapped the namespace in
  an array, which the live node rejected with "cannot unmarshal string into Go
  value of type uint8". The signature is now `subscribe(namespace, cb)`.

### Notes
- Verified live against a Mocha testnet node (v0.31.2) through the RampartLabs
  gateway, June 2026: `blob.subscribe`, `header.getByHash` / `localHead`,
  `state.accountAddress` / `balanceForAddress`, and `node.ready` all pass.
  `node.Info` requires an `admin` token, so it is exercised only when one is
  supplied (`CELESTIA_ADMIN`). Wire-field casing is handled defensively.

## [0.1.0] - 2026-06-10

### Added
- Initial typed TypeScript client for celestia-node JSON-RPC: `blob`
  (`submit` / `get` / `getAll` / `getProof` / `included`), `header`
  (`networkHead` / `getByHeight` / `subscribe`), `state`
  (`balance` / `transfer` / `submitPayForBlob`).
- In-memory `MockCelestia` mirroring the API for offline, deterministic tests.
- Zero runtime dependencies; works in the browser and Node 18+ (WebSocket
  injection for Node < 22).
