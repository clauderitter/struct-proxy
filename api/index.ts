// struct-proxy: a transparent proxy for the Blatent API with lightweight analytics.
//
// Requests to /v1/* (or /<tag>/v1/*) are forwarded unchanged to UPSTREAM_URL and the
// upstream response is returned as-is. After the response is sent, a one-line summary
// (status, latency, token usage, error code...) goes to the Vercel runtime log and, when
// Upstash Redis is configured, into a capped request log plus per-hour counters.
// /_proxy/* serves the dashboard API (see public/index.html).

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";

const env = process.env;
const UPSTREAM = (env.UPSTREAM_URL || "https://api.blatent.ai").replace(/\/+$/, "");
const UPSTREAM_TIMEOUT_MS = int(env.UPSTREAM_TIMEOUT_MS, 295_000);
const REDIS_URL = (env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const REDIS_TOKEN = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "";
const PREFIX = env.REDIS_PREFIX || "sp:";
const LOG_LIMIT = Math.max(1, int(env.LOG_LIMIT, 2000));
const LOG_BODIES = !["0", "false", "off", "no"].includes((env.LOG_BODIES || "").toLowerCase());
const BODY_LIMIT = int(env.BODY_LIMIT, 16_384);
const BODY_TTL_S = Math.max(1, int(env.BODY_TTL_DAYS, 7)) * 86_400;
const COUNTER_TTL_S = 120 * 86_400;
const DASHBOARD_TOKEN = env.DASHBOARD_TOKEN || "";

// Hop-by-hop headers, headers fetch() sets itself, and Vercel's routing headers never go upstream.
const DROP_REQUEST = new Set([
  "host", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "accept-encoding", "forwarded", "x-real-ip",
  "x-matched-path", "x-proxy-tag",
]);
// fetch() already decoded the body, so its encoding and length headers no longer apply.
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

type Cmd = (string | number)[];

interface Entry {
  id: string; // X-Blatent-Request-ID, or a local id when the upstream never answered
  ts: number;
  tag: string;
  method: string;
  path: string;
  status: number;
  code: string | null;
  ms: number;
  in: number | null;
  out: number | null;
  reqBytes: number;
  resBytes: number;
  schema: string | null; // schema_id, "inline" or null
  digest: string | null;
  policy: string | null; // policy_id, "inline" or null
  key: string | null; // first 8 hex chars of sha256(API key), never the key itself
  ua: string | null;
  retryAfter: string | null;
  timing: string | null; // upstream Server-Timing
}

async function handle(req: Request): Promise<Response> {
  const url = requestUrl(req);
  if (url.pathname.startsWith("/_proxy/")) return admin(req, url);
  const match = url.pathname.match(/^\/(?:([^/]+)\/)?(v1(?:\/.*)?)$/);
  if (!match) {
    return json(404, { error: { code: "NOT_FOUND", message: "struct-proxy forwards /v1/* and /<tag>/v1/*." } });
  }
  return proxy(req, url, "/" + match[2], tagFrom(match[1] ?? req.headers.get("x-proxy-tag")));
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;

async function proxy(req: Request, url: URL, path: string, tag: string): Promise<Response> {
  const ts = Date.now();
  const started = performance.now();
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!DROP_REQUEST.has(key) && !key.startsWith("x-vercel-") && !key.startsWith("x-forwarded-")) headers.set(key, value);
  });
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await req.arrayBuffer());
  const signals = [AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)];
  if (req.signal) signals.push(req.signal);

  let status: number;
  let resHeaders: Headers;
  let resBody: Uint8Array;
  try {
    const upstream = await fetch(UPSTREAM + path + url.search, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
    resBody = new Uint8Array(await upstream.arrayBuffer());
    status = upstream.status;
    resHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!DROP_RESPONSE.has(key)) resHeaders.append(key, value);
    });
  } catch (err) {
    const aborted = req.signal?.aborted;
    const timedOut = (err as Error).name === "TimeoutError";
    status = aborted ? 499 : timedOut ? 504 : 502;
    const code = aborted ? "PROXY_CLIENT_CLOSED" : timedOut ? "PROXY_UPSTREAM_TIMEOUT" : "PROXY_UPSTREAM_ERROR";
    const message = `struct-proxy could not reach ${UPSTREAM}: ${(err as Error).message}`;
    resBody = encoder.encode(JSON.stringify({ error: { code, message, path: "", request_id: null } }));
    resHeaders = new Headers({ "content-type": "application/json" });
  }
  const ms = Math.round(performance.now() - started);

  waitUntil(record(summarize({ req, ts, tag, path, status, ms, body, resHeaders, resBody }), body, resBody));

  const empty = req.method === "HEAD" || status === 204 || status === 304;
  return new Response(empty ? null : resBody, { status, headers: resHeaders });
}

function summarize(x: {
  req: Request; ts: number; tag: string; path: string; status: number; ms: number;
  body: Uint8Array | undefined; resHeaders: Headers; resBody: Uint8Array;
}): Entry {
  const request = asObject(parseJson(x.body));
  const response = asObject(parseJson(x.resBody));
  const usage = asObject(response.usage);
  return {
    id: x.resHeaders.get("x-blatent-request-id") || randomUUID(),
    ts: x.ts,
    tag: x.tag,
    method: x.req.method,
    path: x.path,
    status: x.status,
    code: x.status >= 400 ? errorCode(x.status, response) : null,
    ms: x.ms,
    in: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
    out: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
    reqBytes: x.body?.length ?? 0,
    resBytes: x.resBody.length,
    schema: str(request.schema_id) ?? ("schema" in request ? "inline" : null),
    digest: str(response.schema_digest),
    policy: str(request.policy_id) ?? (request.policy ? "inline" : null),
    key: keyFingerprint(x.req.headers.get("authorization")),
    ua: x.req.headers.get("user-agent")?.slice(0, 120) ?? null,
    retryAfter: x.resHeaders.get("retry-after"),
    timing: x.resHeaders.get("server-timing")?.slice(0, 200) ?? null,
  };
}

// Blatent errors carry error.code, except 401 ({"detail": "..."}) and request validation 422 ({"detail": [...]}).
function errorCode(status: number, body: Record<string, any>): string {
  const code = asObject(body.error).code;
  if (typeof code === "string") return code;
  if (typeof body.detail === "string") return status === 401 ? "UNAUTHORIZED" : "ERROR";
  if (Array.isArray(body.detail)) return "VALIDATION_ERROR";
  return `HTTP_${status}`;
}

async function record(entry: Entry, reqBody: Uint8Array | undefined, resBody: Uint8Array): Promise<void> {
  console.log(JSON.stringify({ event: "struct-proxy", ...entry }));
  if (!REDIS_URL) return;
  const iso = new Date(entry.ts).toISOString();
  const day = `${PREFIX}day:${iso.slice(0, 10)}`;
  const field = `${entry.tag}|${iso.slice(11, 13)}|`; // tag|UTC hour|metric
  const cmds: Cmd[] = [
    ["LPUSH", `${PREFIX}log`, JSON.stringify(entry)],
    ["LTRIM", `${PREFIX}log`, 0, LOG_LIMIT - 1],
    ["HINCRBY", day, field + "req", 1],
    ["HINCRBY", day, field + "ms", entry.ms],
  ];
  if (entry.status >= 400) cmds.push(["HINCRBY", day, field + "err", 1]);
  if (entry.in) cmds.push(["HINCRBY", day, field + "in", entry.in]);
  if (entry.out) cmds.push(["HINCRBY", day, field + "out", entry.out]);
  cmds.push(["EXPIRE", day, COUNTER_TTL_S]);
  if (LOG_BODIES) {
    const bodies = JSON.stringify({ request: clip(reqBody), response: clip(resBody) });
    cmds.push(["SET", `${PREFIX}body:${entry.id}`, bodies, "EX", BODY_TTL_S]);
  }
  try {
    await redis(cmds);
  } catch (err) {
    console.error("struct-proxy: analytics write failed:", (err as Error).message);
  }
}

// ---- Dashboard API ------------------------------------------------------------------

async function admin(req: Request, url: URL): Promise<Response> {
  const route = url.pathname.slice("/_proxy".length);
  if (route === "/health") {
    return json(200, { ok: true, upstream: UPSTREAM, storage: Boolean(REDIS_URL), dashboard: Boolean(DASHBOARD_TOKEN) });
  }
  if (!DASHBOARD_TOKEN) {
    return json(503, { error: { code: "DASHBOARD_DISABLED", message: "Set the DASHBOARD_TOKEN environment variable to enable the dashboard." } });
  }
  if (!authorized(req)) return json(401, { error: { code: "UNAUTHORIZED", message: "Invalid dashboard token." } });
  const isReset = route === "/reset";
  const method = isReset ? "POST" : "GET";
  if (req.method !== method) return json(405, { error: { code: "METHOD_NOT_ALLOWED", message: `Use ${method}.` } });
  if (!REDIS_URL) {
    return json(200, isReset ? { deleted: 0 } : { storage: false, bodies: LOG_BODIES, logLimit: LOG_LIMIT, now: Date.now(), days: [], logs: [] });
  }

  try {
    if (isReset) return await reset();
    if (route === "/stats") return await stats(url);
    const log = route.match(/^\/log\/([A-Za-z0-9-]{1,64})$/);
    if (log) {
      const [raw] = await redis([["GET", `${PREFIX}body:${log[1]}`]]);
      if (typeof raw !== "string") return json(404, { error: { code: "NOT_FOUND", message: "No stored bodies for this request." } });
      return json(200, JSON.parse(raw));
    }
  } catch (err) {
    return json(502, { error: { code: "STORAGE_ERROR", message: (err as Error).message } });
  }
  return json(404, { error: { code: "NOT_FOUND", message: "Unknown dashboard route." } });
}

async function stats(url: URL): Promise<Response> {
  const days = clamp(int(url.searchParams.get("days"), 7), 1, 90);
  const limit = clamp(int(url.searchParams.get("limit"), 500), 1, LOG_LIMIT);
  const now = Date.now();
  const dates = Array.from({ length: days }, (_, i) => new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  const results = await redis([
    ...dates.map((date): Cmd => ["HGETALL", `${PREFIX}day:${date}`]),
    ["LRANGE", `${PREFIX}log`, 0, limit - 1],
  ]);
  const logs = ((results.pop() as string[] | null) ?? []).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  return json(200, {
    storage: true,
    bodies: LOG_BODIES,
    logLimit: LOG_LIMIT,
    now,
    days: dates.map((date, i) => ({ date, fields: hashToObject(results[i]) })),
    logs,
  });
}

// Deletes everything struct-proxy stored: the request log, counters and bodies.
async function reset(): Promise<Response> {
  const match = PREFIX.replace(/[*?[\]\\]/g, "\\$&") + "*";
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [page] = await redis([["SCAN", cursor, "MATCH", match, "COUNT", 1000]]);
    const [next, batch] = page as [string | number, string[]];
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== "0");
  const dels: Cmd[] = [];
  for (let i = 0; i < keys.length; i += 500) dels.push(["DEL", ...keys.slice(i, i + 500)]);
  if (dels.length) await redis(dels);
  console.log(JSON.stringify({ event: "struct-proxy-reset", deleted: keys.length }));
  return json(200, { deleted: keys.length });
}

function authorized(req: Request): boolean {
  const presented = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim();
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(DASHBOARD_TOKEN).digest();
  return timingSafeEqual(a, b);
}

// ---- Upstash Redis (REST pipeline) --------------------------------------------------

async function redis(cmds: Cmd[]): Promise<unknown[]> {
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Upstash responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const results = (await res.json()) as { result?: unknown; error?: string }[];
  return results.map((r) => {
    if (r.error) throw new Error(`Upstash: ${r.error}`);
    return r.result;
  });
}

// ---- Helpers ------------------------------------------------------------------------

// The vercel.json rewrites also pass the original path as ?__path=, so routing works
// whether the function sees the original URL or the rewritten /api one.
function requestUrl(req: Request): URL {
  const url = new URL(req.url, "http://localhost");
  const original = url.searchParams.get("__path");
  if (original === null) return url;
  url.searchParams.delete("__path");
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) url.pathname = original;
  return url;
}

function tagFrom(raw: string | null | undefined): string {
  if (!raw) return "default";
  let tag = raw;
  try {
    tag = decodeURIComponent(raw);
  } catch {}
  tag = tag.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return tag || "default";
}

function keyFingerprint(authorization: string | null): string | null {
  const key = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 8) : null;
}

function clip(bytes: Uint8Array | undefined): string | null {
  if (!bytes?.length) return null;
  const text = decoder.decode(bytes.subarray(0, BODY_LIMIT));
  return bytes.length > BODY_LIMIT ? text + `… [truncated, ${bytes.length} bytes total]` : text;
}

function parseJson(bytes: Uint8Array | undefined): unknown {
  if (!bytes?.length) return undefined;
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, 200) : null;
}

function hashToObject(flat: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (Array.isArray(flat)) for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = Number(flat[i + 1]);
  return out;
}

function int(value: string | null | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
