import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";

interface Env {
  STEP_OUTPUT_WORKFLOW: Workflow;
}

interface Params {
  /** Size, in bytes, of the value each step returns (and the engine persists). */
  sizeBytes: number;
  /** How many steps to run in total. */
  count: number;
  /** How many step.do calls to keep in flight concurrently (default 1 = sequential). */
  concurrency?: number;
  /** What kind of value each step returns: "string" (default), "bytes" (Uint8Array), or "arraybuffer". */
  valueType?: "string" | "bytes" | "arraybuffer";
}

/**
 * Build a ~`bytes`-long printable, hard-to-compress string so the persisted
 * step output is genuinely that size (a run of random chars from a 36-symbol
 * alphabet — JSON-encodes ~1 byte/char and barely compresses).
 */
function makePayload(bytes: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const random = new Uint8Array(bytes);
  // crypto.getRandomValues rejects requests larger than 65536 bytes, so fill in chunks.
  for (let offset = 0; offset < bytes; offset += 65536) {
    crypto.getRandomValues(random.subarray(offset, Math.min(offset + 65536, bytes)));
  }
  let out = "";
  const CHUNK = 8192;
  for (let start = 0; start < bytes; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes);
    let chunk = "";
    for (let i = start; i < end; i++) chunk += alphabet[random[i]! % 36];
    out += chunk;
  }
  return out;
}

/** A `bytes`-long Uint8Array — mirrors a step returning binary (e.g. gzip output). */
function makePayloadBytes(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let offset = 0; offset < bytes; offset += 65536) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + 65536, bytes)));
  }
  return out;
}

/**
 * Runs `count` step.do calls (optionally `concurrency` in flight), each
 * returning a `sizeBytes` value of type `valueType`.
 *
 * The bug (local `wrangler dev` only): a step that returns a **Uint8Array**
 * of only ~200 KB aborts the run with `string or blob too big: SQLITE_TOOBIG`,
 * while the SAME bytes returned as a raw **ArrayBuffer** (up to ~2 MB) — or a
 * **2 MB string** — succeed. So it is specific to the Uint8Array (typed-array
 * view) path, which serializes as if far larger than its byteLength. It also
 * surfaces as a raw SQLITE_TOOBIG, never the friendly
 * "Step output is too large. Maximum allowed size is 1MiB." guard that an
 * oversized string/ArrayBuffer gets. The same workflows run fine in production.
 */
export class StepOutputWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { sizeBytes, count } = event.payload;
    const concurrency = Math.max(1, event.payload.concurrency ?? 1);
    const valueType = event.payload.valueType ?? "string";
    console.log(
      `[repro] start: ${count} steps x ${sizeBytes}B (${valueType}), concurrency=${concurrency}`
    );

    let next = 0;
    let persisted = 0;
    const runOne = async () => {
      for (let i = next++; i < count; i = next++) {
        await step.do(`step-${i}`, async () => {
          if (valueType === "arraybuffer") return makePayloadBytes(sizeBytes).buffer as ArrayBuffer;
          if (valueType === "bytes") return makePayloadBytes(sizeBytes);
          return makePayload(sizeBytes);
        });
        persisted++;
        console.log(
          `[repro] OK step ${i}: value=${sizeBytes}B (${valueType}, persisted=${persisted})`
        );
      }
    };
    await Promise.all(Array.from({ length: concurrency }, runOne));

    console.log(`[repro] COMPLETE: all ${count} steps persisted, no SQLITE_TOOBIG`);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/start") {
      // Defaults reproduce the bug: one step returning a 256 KiB Uint8Array.
      const sizeBytes = Number(url.searchParams.get("size") ?? "262144"); // 256 KiB
      const count = Number(url.searchParams.get("count") ?? "1");
      const concurrency = Number(url.searchParams.get("concurrency") ?? "1");
      const vt = url.searchParams.get("valueType");
      const valueType = vt === "string" || vt === "arraybuffer" ? vt : "bytes";
      const instance = await env.STEP_OUTPUT_WORKFLOW.create({
        params: { sizeBytes, count, concurrency, valueType },
      });
      return Response.json({ id: instance.id, sizeBytes, count, concurrency, valueType });
    }

    if (url.pathname === "/status") {
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "missing ?id=" }, { status: 400 });
      const instance = await env.STEP_OUTPUT_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }

    return new Response(
      [
        "Cloudflare Workflows — local `wrangler dev` SQLITE_TOOBIG repro",
        "",
        "  GET /start?valueType=<bytes|arraybuffer|string>&size=<bytes>&count=<n>&concurrency=<n>",
        "  GET /status?id=<id>",
        "",
        "Defaults reproduce the bug: valueType=bytes, size=262144 (256 KiB), count=1.",
        "",
        "Reproduce (watch the `wrangler dev` console):",
        "  curl 'http://localhost:8787/start'                                 -> SQLITE_TOOBIG",
        "  curl 'http://localhost:8787/start?valueType=bytes&size=200000'     -> SQLITE_TOOBIG",
        "Contrast — these COMPLETE fine (same/again-larger sizes):",
        "  curl 'http://localhost:8787/start?valueType=arraybuffer&size=950000' -> ok (same bytes, raw buffer!)",
        "  curl 'http://localhost:8787/start?valueType=string&size=2000000'     -> ok (2 MB string!)",
        "",
        "A ~200 KB Uint8Array step output aborts with `string or blob too big:",
        "SQLITE_TOOBIG`, yet the same bytes as an ArrayBuffer (or a 2 MB string)",
        "are fine. Specific to the Uint8Array view. Same workflow runs in prod.",
      ].join("\n"),
      { headers: { "content-type": "text/plain" } }
    );
  },
};
