/**
 * Live Web proxy — Node version for self-hosting (Docker or plain `node`).
 * Same behaviour as ../cloudflare/worker.ts; the logic lives in ../shared/core.ts.
 *
 * Env:
 *   ALLOWED_HOSTS  comma/space separated, e.g. "dashboard.example.com, *.example.org"   (required)
 *   ADDIN_ORIGIN   origin hosting the add-in, e.g. "https://liveweb.example.org"         (required)
 *   DEFAULT_TARGET optional single-site mode, e.g. "https://presenter.example.com": that site is
 *                  served at the proxy's own paths, for apps that read their own URL/query.
 *   PORT           listen port (default 8787)
 *   PUBLIC_ORIGIN  the https origin browsers use to reach this proxy, if it's behind a
 *                  TLS-terminating reverse proxy that doesn't send X-Forwarded-Proto/Host.
 *   TRUST_PROXY    "1" to honour X-Forwarded-Proto / X-Forwarded-Host (default 1)
 *
 * Needs Node 22.18+ (runs .ts directly via built-in type stripping).
 * The proxy must be reached over HTTPS — put it behind Caddy/nginx/IIS/Cloudflare Tunnel.
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { Readable, type Duplex, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RewritingStream } from "parse5-html-rewriting-stream";
import {
  type RewriteCtx,
  clientShim,
  downstreamHeaders,
  handleElement,
  isCss,
  isHtml,
  parseConfig,
  preflightHeaders,
  canonicalRedirect,
  resolveTarget,
  rewriteCss,
  textResponseHeaders,
  upstreamHeaders,
} from "../shared/core.ts";

const cfg = parseConfig(process.env);
const PORT = Number(process.env.PORT || 8787);
const TRUST_PROXY = process.env.TRUST_PROXY !== "0";
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : "";

if (!cfg.allowedHosts.length) console.warn("[live-web-proxy] ALLOWED_HOSTS is empty: every request will get 403.");
if (!cfg.addinOrigin) console.warn("[live-web-proxy] ADDIN_ORIGIN is not set: CORS is disabled for the add-in.");

/* ---------------------------------------------------------------- utils */

function toHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i];
    if (k.startsWith(":")) continue;
    try {
      h.append(k, req.rawHeaders[i + 1]);
    } catch {
      /* invalid header value: skip */
    }
  }
  return h;
}

function requestUrl(req: IncomingMessage): URL {
  if (PUBLIC_ORIGIN) return new URL(req.url || "/", PUBLIC_ORIGIN);
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(",")[0].trim();
  const proto = (TRUST_PROXY && first(req.headers["x-forwarded-proto"])) || "http";
  const host = (TRUST_PROXY && first(req.headers["x-forwarded-host"])) || req.headers.host || `localhost:${PORT}`;
  return new URL(req.url || "/", `${proto}://${host}`);
}

function send(res: ServerResponse, status: number, headers: Headers, body?: string | Buffer) {
  const out: Record<string, string | string[]> = {};
  headers.forEach((v, k) => {
    if (k !== "set-cookie") out[k] = v;
  });
  const cookies = headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(status, out);
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/* --------------------------------------------------------- HTML rewrite */

function htmlTransform(ctx: RewriteCtx, shim: string): Transform {
  const rw = new RewritingStream();
  let injected = false;
  rw.on("startTag", (tag) => {
    const get = (n: string) => tag.attrs.find((a) => a.name === n)?.value ?? null;
    const set = (n: string, v: string) => {
      const a = tag.attrs.find((x) => x.name === n);
      if (a) a.value = v;
    };
    const action = handleElement(tag.tagName, get, set, ctx);
    if (!injected && tag.tagName !== "html" && tag.tagName !== "head") {
      rw.emitRaw(shim); // page without <head>: inject before the first real element
      injected = true;
    }
    if (action !== "keep") return; // drop <base>, CSP/XFO <meta>
    rw.emitStartTag(tag);
    if (!injected && tag.tagName === "head") {
      rw.emitRaw(shim);
      injected = true;
    }
  });
  return rw as unknown as Transform;
}

/* -------------------------------------------------------------- handler */

async function handle(req: IncomingMessage, res: ServerResponse) {
  const reqUrl = requestUrl(req);
  const reqHeaders = toHeaders(req);
  const reqOrigin = reqHeaders.get("origin");
  const text = (status: number, body: string) => send(res, status, textResponseHeaders(cfg, reqOrigin), body);

  if (req.method === "OPTIONS") return send(res, 204, preflightHeaders(reqHeaders, cfg));
  if (reqUrl.pathname === "/healthz") return text(200, "ok");
  if (reqUrl.pathname === "/favicon.ico" && !reqHeaders.get("referer")) return text(404, "");

  const r = resolveTarget(reqUrl, reqHeaders, cfg);
  if (r.kind === "error") return text(r.status, r.message);
  const { target, viaFallback } = r;
  const proxyOrigin = reqUrl.origin;

  // Send navigations to their canonical proxy URL (see canonicalRedirect).
  const redirectTo = canonicalRedirect(reqUrl, reqHeaders, req.method || "GET", target, viaFallback, cfg);
  if (redirectTo) {
    const h = textResponseHeaders(cfg, reqOrigin);
    h.set("location", redirectTo);
    return send(res, 302, h);
  }

  const method = req.method || "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await readBody(req));
  let upstream: Response;
  try {
    upstream = await fetch(target.href, {
      method,
      headers: upstreamHeaders(reqHeaders, target, proxyOrigin, cfg),
      body,
      redirect: "manual",
    });
  } catch (e) {
    return text(502, `Upstream fetch failed: ${(e as Error).message}`);
  }

  const out = downstreamHeaders(
    { status: upstream.status, headers: upstream.headers, setCookies: upstream.headers.getSetCookie() },
    target,
    proxyOrigin,
    reqOrigin,
    cfg,
  );

  if (method === "HEAD" || [204, 205, 304].includes(upstream.status) || !upstream.body) {
    return send(res, upstream.status, out);
  }

  const ctx: RewriteCtx = { base: target, proxyOrigin, cfg };
  if (isCss(upstream.headers)) return send(res, upstream.status, out, rewriteCss(await upstream.text(), ctx));

  writeHead(res, upstream.status, out);
  const source = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
  if (isHtml(upstream.headers)) {
    source.setEncoding("utf8");
    await pipeline(source, htmlTransform(ctx, clientShim(target, proxyOrigin, cfg)), res);
  } else {
    await pipeline(source, res);
  }
}

function writeHead(res: ServerResponse, status: number, headers: Headers) {
  const out: Record<string, string | string[]> = {};
  headers.forEach((v, k) => {
    if (k !== "set-cookie") out[k] = v;
  });
  const cookies = headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(status, out);
}

/* ------------------------------------------------------------ websocket */

function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const reject = (status: number, msg: string) => {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${msg}`);
  };
  if ((req.headers.upgrade || "").toLowerCase() !== "websocket") return reject(400, "Only WebSocket upgrades are supported.");
  const reqUrl = requestUrl(req);
  const reqHeaders = toHeaders(req);
  const r = resolveTarget(reqUrl, reqHeaders, cfg);
  if (r.kind === "error") return reject(r.status === 200 ? 400 : r.status, r.message);
  const { target } = r;

  const h = upstreamHeaders(reqHeaders, target, reqUrl.origin, cfg);
  const headers: Record<string, string> = {};
  h.forEach((v, k) => (headers[k] = v));
  headers["connection"] = "Upgrade";
  headers["upgrade"] = "websocket";
  headers["host"] = target.host;

  const lib = target.protocol === "https:" ? https : http;
  const up = lib.request(target.href, { method: "GET", headers });
  up.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 101 Switching Protocols`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    const close = () => {
      upSocket.destroy();
      socket.destroy();
    };
    upSocket.on("error", close);
    socket.on("error", close);
    upSocket.on("close", close);
    socket.on("close", close);
  });
  up.on("response", (upRes) => {
    reject(upRes.statusCode || 502, "Upstream refused the WebSocket upgrade.");
    upRes.resume();
  });
  up.on("error", (e) => reject(502, `Upstream WebSocket failed: ${e.message}`));
  up.end();
}

/* ---------------------------------------------------------------- serve */

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("[live-web-proxy]", e);
    if (!res.headersSent) send(res, 502, textResponseHeaders(cfg, null), "Proxy error");
    else res.destroy();
  });
});
server.on("upgrade", upgrade);
server.listen(PORT, () => {
  console.log(`[live-web-proxy] listening on :${PORT}`);
  console.log(`[live-web-proxy] ALLOWED_HOSTS=${cfg.allowedHosts.join(",") || "(none)"} ADDIN_ORIGIN=${cfg.addinOrigin || "(unset)"}`);
});
