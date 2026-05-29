# Cloudflare Workflows — local `wrangler dev` `SQLITE_TOOBIG` on small binary step outputs

Minimal reproduction: under `wrangler dev` (local/miniflare/workerd), a Workflow **step that returns a ~200 KB `Uint8Array` aborts the whole run** with:

```
Uncaught Error: string or blob too big: SQLITE_TOOBIG
```

…while a step returning a **2 MB `string`** completes fine. The same workflow runs without issue when deployed to production Workflows.

## TL;DR

A step that returns a **`Uint8Array`** of only ~200 KB overflows the local Workflows engine's per-value SQLite cap and aborts the run with `string or blob too big: SQLITE_TOOBIG`. The **exact same bytes returned as a raw `ArrayBuffer`** persist fine up to ~2 MB, and a **2 MB `string`** is fine too. So the bug is specific to the **`Uint8Array` (typed-array view)** path, which behaves as if its stored representation is many times larger than its `byteLength`.

Two things make this look like a bug rather than a documented limit:

1. It surfaces as a **raw `string or blob too big: SQLITE_TOOBIG`**, not the friendly guard `WorkflowInternalError: Step output is too large. Maximum allowed size is 1MiB.` (which is what an oversized `string`/`ArrayBuffer` correctly gets).
2. The friendly guard never fires for `Uint8Array` — a ~200 KB view dies with the raw error, while `ArrayBuffer`/`string` of the same or larger size pass.

(We have not traced the exact internal serialization; the section below is just the observed black-box behaviour. The `Uint8Array`-vs-`ArrayBuffer` split strongly suggests typed-array views are serialized differently — and far less efficiently — than raw buffers.)

## Measured behaviour

`wrangler 4.95.0`, `compatibility_date = 2026-02-26`, macOS (Apple Silicon). Each row is one `step.do()` returning a single value:

| step output type | size (byteLength / length) | result |
| --- | --- | --- |
| `Uint8Array` | 100,000 / 175,000 | ✅ completes |
| `Uint8Array` | **200,000 (~200 KB)** | ❌ **`string or blob too big: SQLITE_TOOBIG`** |
| `Uint8Array` | 300,000 / 500,000 / 950,000 | ❌ `SQLITE_TOOBIG` |
| `ArrayBuffer` | 100,000 → 2,000,000 | ✅ completes (same bytes that fail as `Uint8Array`) |
| `ArrayBuffer` | 4,000,000 (4 MB) | ⚠️ clean guard: `Step output is too large. Maximum allowed size is 1MiB.` |
| `string` | 300,000 → 2,000,000 | ✅ completes |
| `string` | 4,000,000 (4 MB) | ⚠️ clean guard: `Step output is too large. Maximum allowed size is 1MiB.` |

The smoking gun: at the **same 950 KB**, a `Uint8Array` fails with `SQLITE_TOOBIG` but an `ArrayBuffer` (and a `string`) succeeds. `ArrayBuffer` and `string` behave identically (fine to ~2 MB, then the clean 1 MiB guard); only the `Uint8Array` view hits the raw error, at ~200 KB.

It is **not** about cumulative state: **500 sequential string steps × 128 KiB ≈ 62 MiB total** completes fine, as does 10-way-concurrent `60 × 900 KB`. The trigger is a single **`Uint8Array`** step output of ~200 KB.

(The exact `Uint8Array` threshold drifts a little with the byte *values*, because the failure is driven by the serialized size; ~175 KB passed and ~200 KB failed with random bytes.)

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

# COMPLETES: the SAME 950 KB of bytes, returned as a raw ArrayBuffer instead of a view
curl 'http://localhost:8787/start?valueType=arraybuffer&size=950000'

# COMPLETES: ~100 KB Uint8Array
curl 'http://localhost:8787/start?valueType=bytes&size=100000'

# COMPLETES: 2 MB *string* — 10x larger than the failing view, but fine
curl 'http://localhost:8787/start?valueType=string&size=2000000'

# COMPLETES: 500 sequential 128 KiB string steps (~62 MiB total) — not cumulative
curl 'http://localhost:8787/start?valueType=string&size=131072&count=500'
```

Poll an instance's status with `curl 'http://localhost:8787/status?id=<id>'`.

### Endpoint

`GET /start?valueType=<bytes|arraybuffer|string>&size=<bytes>&count=<n>&concurrency=<n>`

Defaults reproduce the bug: `valueType=bytes`, `size=262144` (256 KiB), `count=1`, `concurrency=1`.

## Expected vs actual

- **Expected:** a ~200 KB `Uint8Array` step output should persist just like the identical `ArrayBuffer` / `string` does. If a value genuinely exceeds a limit, it should fail with the documented `Step output ... Maximum allowed size is 1MiB` guard, measured against the same representation that gets stored.
- **Actual:** a ~200 KB `Uint8Array` aborts the run with a raw `string or blob too big: SQLITE_TOOBIG`, while the same bytes as an `ArrayBuffer` (up to ~2 MB) and a 2 MB `string` succeed.

## Why this matters

Returning a `Uint8Array` from a step (gzip output, protobuf, image bytes — `Uint8Array` is the idiomatic binary type) is common. The effective local ceiling for a `Uint8Array` step output is ~175 KB here — far below the documented 1 MiB step-output limit and far below what production accepts — so workflows that are fine in production fail only under `wrangler dev`. Workaround: wrap the view in its `.buffer` (`ArrayBuffer`) or store as a (base64) string.

## Environment

- `wrangler` 4.95.0 (also reproduced on 4.93.1)
- `compatibility_date` 2026-02-26
- macOS 15 (Apple Silicon)
- Engine code path: `node_modules/miniflare/dist/src/workers/workflows/binding.worker.js`
