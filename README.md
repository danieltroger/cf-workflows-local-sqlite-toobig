# Cloudflare Workflows — local `wrangler dev` `SQLITE_TOOBIG` on small binary step outputs

Minimal reproduction: under `wrangler dev` (local/miniflare/workerd), a Workflow **step that returns a ~200 KB `Uint8Array` aborts the whole run** with:

```
Uncaught Error: string or blob too big: SQLITE_TOOBIG
```

…while a step returning a **2 MB `string`** completes fine. The same workflow runs without issue when deployed to production Workflows.

## TL;DR

A **binary** step output (`Uint8Array`/`ArrayBuffer`) of only ~200 KB overflows the local Workflows engine's per-value SQLite cap, even though a **2 MB string** stores fine. The binary path behaves as if its stored representation is many times larger than its `byteLength` (a ~200 KB buffer fails like a multi-MB value). Two things make this look like a bug rather than a documented limit:

1. It surfaces as a **raw `string or blob too big: SQLITE_TOOBIG`**, not the friendly guard `WorkflowInternalError: Step output is too large. Maximum allowed size is 1MiB.`
2. The guard's size check and what actually gets stored **disagree**: a 200 KB buffer is nowhere near 1 MiB, yet storage fails — and conversely a 2 MB string passes.

(We have not traced the exact internal serialization; the section below is just the observed black-box behaviour.)

## Measured behaviour

`wrangler 4.95.0`, `compatibility_date = 2026-02-26`, macOS (Apple Silicon). Each row is one `step.do()` returning a single value:

| step output type | size (byteLength / length) | result |
| --- | --- | --- |
| `string` | 1,000,000 (1 MB) | ✅ completes |
| `string` | 2,000,000 (2 MB) | ✅ completes |
| `string` | 4,000,000 (4 MB) | ⚠️ clean guard: `Step output is too large. Maximum allowed size is 1MiB.` |
| `Uint8Array` | 100,000 (~100 KB) | ✅ completes |
| `Uint8Array` | 175,000 (~175 KB) | ✅ completes |
| `Uint8Array` | **200,000 (~200 KB)** | ❌ **`string or blob too big: SQLITE_TOOBIG`** |
| `Uint8Array` | 300,000 / 500,000 | ❌ `SQLITE_TOOBIG` |

It is **not** about cumulative state: a run of **500 sequential string steps × 128 KiB = ~62 MiB total** completes fine, as does 10-way-concurrent `60 × 900 KB` strings (~54 MiB). The trigger is a **single binary step output** of ~200 KB.

(The exact `Uint8Array` threshold drifts with the byte *values*, because the failure is driven by the serialized size, not the raw `byteLength`. ~175 KB passed and ~200 KB failed here with random bytes.)

## Reproduce

```bash
npm install
npm run dev          # wrangler dev on http://localhost:8787

# In another shell — watch the `wrangler dev` console:

# FAILS: one step returning a 256 KiB Uint8Array
curl 'http://localhost:8787/start'
#   -> console: Uncaught Error: string or blob too big: SQLITE_TOOBIG

# FAILS: ~200 KB Uint8Array is already enough
curl 'http://localhost:8787/start?valueType=bytes&size=200000'

# COMPLETES: ~100 KB Uint8Array
curl 'http://localhost:8787/start?valueType=bytes&size=100000'

# COMPLETES: 2 MB *string* — 10x larger than the failing buffer, but fine
curl 'http://localhost:8787/start?valueType=string&size=2000000'

# COMPLETES: 500 sequential 128 KiB string steps (~62 MiB total) — not cumulative
curl 'http://localhost:8787/start?valueType=string&size=131072&count=500'
```

Poll an instance's status with `curl 'http://localhost:8787/status?id=<id>'`.

### Endpoint

`GET /start?valueType=<bytes|string>&size=<bytes>&count=<n>&concurrency=<n>`

Defaults reproduce the bug: `valueType=bytes`, `size=262144` (256 KiB), `count=1`, `concurrency=1`.

## Expected vs actual

- **Expected:** a ~200 KB step output is well within limits and should persist (binary outputs especially shouldn't balloon ~13× in storage). If a value genuinely exceeds a limit, it should fail with the documented `Step output ... Maximum allowed size is 1MiB` guard, consistently measured against the same representation that gets stored.
- **Actual:** a ~200 KB `Uint8Array` aborts the run with a raw `string or blob too big: SQLITE_TOOBIG`, while a 2 MB `string` succeeds.

## Why this matters

Returning compressed/binary blobs from a step (e.g. `gzip` output, protobuf, image bytes) is common. The effective local ceiling for a binary step output is ~175 KB here, far below the documented 1 MiB step-output limit and far below what production accepts — so workflows that are fine in production fail only under `wrangler dev`.

## Environment

- `wrangler` 4.95.0 (also reproduced on 4.93.1)
- `compatibility_date` 2026-02-26
- macOS 15 (Apple Silicon)
- Engine code path: `node_modules/miniflare/dist/src/workers/workflows/binding.worker.js`
