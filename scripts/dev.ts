// Local dev server: `npm run dev`.
// Mirrors Vercel's routing (the rewrites in vercel.json plus static files from public/) and,
// unless Upstash credentials are set (e.g. in .env.local), stores analytics in memory.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const inMemory = !process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL;
if (inMemory) {
  process.env.KV_REST_API_URL = `http://localhost:${PORT}/__upstash`;
  process.env.KV_REST_API_TOKEN = "dev";
}
process.env.DASHBOARD_TOKEN ||= "dev";

// The handler reads its configuration at import time, so import it after the env is set.
const api: Record<string, (req: Request) => Promise<Response>> = await import(new URL("../api/index.ts", import.meta.url).href);

createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/__upstash/pipeline") return send(res, upstash(JSON.parse((await readBody(req)).toString() || "[]")));
    if (/^\/(?:[^/]+\/)?v1(?:\/|$)/.test(path) || path.startsWith("/_proxy/")) {
      const handler = api[req.method ?? "GET"];
      if (!handler) return send(res, new Response(null, { status: 405 }));
      return send(res, await handler(await toRequest(req, res)));
    }
    const file = path === "/" ? "index.html" : path.slice(1);
    if (file.includes("..")) return send(res, new Response("Not found", { status: 404 }));
    const content = await readFile(join(PUBLIC_DIR, file)).catch(() => null);
    if (!content) return send(res, new Response("Not found", { status: 404 }));
    return send(res, new Response(content, { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream" } }));
  } catch (err) {
    console.error(err);
    return send(res, new Response("Internal error", { status: 500 }));
  }
}).listen(PORT, () => {
  console.log(`struct-proxy dev server on http://localhost:${PORT}`);
  console.log(`  proxy:     http://localhost:${PORT}/v1/... or /<tag>/v1/... -> ${process.env.UPSTREAM_URL || "https://api.blatent.ai"}`);
  console.log(`  dashboard: http://localhost:${PORT}/#token=${process.env.DASHBOARD_TOKEN === "dev" ? "dev" : "<DASHBOARD_TOKEN>"}`);
  console.log(`  storage:   ${inMemory ? "in memory (set KV_REST_API_URL/KV_REST_API_TOKEN in .env.local for Upstash)" : "Upstash"}`);
});

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function toRequest(req: IncomingMessage, res: ServerResponse): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  return new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body, signal: controller.signal });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.appendHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

// ---- In-memory stand-in for the Upstash REST pipeline endpoint ------------------------

const memory = new Map<string, { value: any; expires?: number }>();

function upstash(cmds: (string | number)[][]): Response {
  return Response.json(cmds.map((cmd) => {
    try {
      return { result: run(cmd.map(String)) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }));
}

function run([op, key, ...args]: string[]): unknown {
  const item = memory.get(key);
  const live = item && (!item.expires || item.expires > Date.now()) ? item : undefined;
  const range = (list: string[], start: number, stop: number) => list.slice(start, stop < 0 ? list.length + stop + 1 : stop + 1);
  switch (op.toUpperCase()) {
    case "GET":
      return live?.value ?? null;
    case "SET": {
      const ex = args.findIndex((a) => a.toUpperCase() === "EX");
      memory.set(key, { value: args[0], expires: ex >= 0 ? Date.now() + Number(args[ex + 1]) * 1000 : undefined });
      return "OK";
    }
    case "LPUSH": {
      const list: string[] = live?.value ?? [];
      list.unshift(...args.reverse());
      memory.set(key, { value: list, expires: live?.expires });
      return list.length;
    }
    case "LTRIM":
      if (live) live.value = range(live.value, Number(args[0]), Number(args[1]));
      return "OK";
    case "LRANGE":
      return live ? range(live.value, Number(args[0]), Number(args[1])) : [];
    case "HINCRBY": {
      const hash: Record<string, number> = live?.value ?? {};
      hash[args[0]] = (hash[args[0]] ?? 0) + Number(args[1]);
      memory.set(key, { value: hash, expires: live?.expires });
      return hash[args[0]];
    }
    case "HGETALL":
      return live ? Object.entries(live.value as Record<string, number>).flatMap(([f, v]) => [f, String(v)]) : [];
    case "EXPIRE":
      if (!live) return 0;
      live.expires = Date.now() + Number(args[0]) * 1000;
      return 1;
    default:
      throw new Error(`ERR command ${op} not supported by the dev store`);
  }
}
