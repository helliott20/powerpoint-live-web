/**
 * Live Web proxy — shared logic used by BOTH the Cloudflare Worker and the
 * Node server. Only Web-standard APIs (URL, Headers, Response) are used here.
 *
 * Request shapes:
 *   GET|POST /?url=<absolute target>     the normal, explicit form
 *   GET|POST /some/path?x=1              "fallback": a relative URL the page built in
 *                                        JS / CSS. Resolved against the Referer (or the
 *                                        lw_base cookie) of the proxied page.
 *
 * SECURITY: every target, redirect and rewritten link is checked against
 * ALLOWED_HOSTS. Anything else gets 403. This is never an open proxy.
 */

export interface ProxyConfig {
  allowedHosts: string[]; // "example.com" (exact) or "*.example.com" (subdomains + apex)
  addinOrigin: string; // e.g. https://liveweb.pages.dev  (no trailing slash)
  /**
   * Optional single-site ("mirror") mode. When set, this origin is served at the
   * proxy's own paths: https://proxy/some/path?q=1 <-> https://site/some/path?q=1.
   * Needed for single-page apps that read their own path / query string.
   */
  defaultTarget: string; // origin, or ""
  /** Optional CSS added to every proxied HTML page, e.g. to hide a site's own buttons. */
  injectCss: string;
}

export interface EnvLike {
  ALLOWED_HOSTS?: string;
  ADDIN_ORIGIN?: string;
  DEFAULT_TARGET?: string;
  INJECT_CSS?: string;
}

export const BASE_COOKIE = "lw_base";
const COOKIE_PREFIX = "lw~";

export function parseConfig(env: EnvLike): ProxyConfig {
  const allowedHosts = (env.ALLOWED_HOSTS || "")
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  let addinOrigin = "";
  if (env.ADDIN_ORIGIN) {
    try {
      addinOrigin = new URL(env.ADDIN_ORIGIN).origin;
    } catch {
      /* invalid -> no CORS, no frame-ancestors entry */
    }
  }
  let defaultTarget = "";
  if (env.DEFAULT_TARGET) {
    try {
      const u = new URL(env.DEFAULT_TARGET);
      if (u.protocol === "https:" || u.protocol === "http:") {
        defaultTarget = u.origin;
        // The mirrored site is implicitly allowed.
        if (!allowedHosts.includes(u.hostname.toLowerCase())) allowedHosts.push(u.hostname.toLowerCase());
      }
    } catch {
      /* invalid -> mirror mode off */
    }
  }
  return { allowedHosts, addinOrigin, defaultTarget, injectCss: (env.INJECT_CSS || "").trim() };
}

export function hostAllowed(hostname: string, cfg: ProxyConfig): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  return cfg.allowedHosts.some((rule) => {
    if (rule.startsWith("*.")) {
      const apex = rule.slice(2);
      return h === apex || h.endsWith("." + apex);
    }
    return h === rule;
  });
}

/* ------------------------------------------------------------ targets */

export type Resolution =
  | { kind: "target"; target: URL; viaFallback: boolean }
  | { kind: "error"; status: number; message: string };

/** Turn ws(s) into http(s) for fetch(); refuse anything else. */
function toHttp(u: URL): URL | null {
  if (u.protocol === "ws:") u.protocol = "http:";
  else if (u.protocol === "wss:") u.protocol = "https:";
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return u;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The proxied page URL that `ref` (a URL on the proxy) represents, if any. */
function proxiedPageFrom(ref: string | null, proxyOrigin: string): URL | null {
  if (!ref) return null;
  try {
    const r = new URL(ref);
    if (r.origin !== proxyOrigin) return null;
    const u = r.searchParams.get("url");
    return u ? new URL(u) : null;
  } catch {
    return null;
  }
}

export function resolveTarget(reqUrl: URL, headers: Headers, cfg: ProxyConfig): Resolution {
  const explicit = reqUrl.pathname === "/" ? reqUrl.searchParams.get("url") : null;
  let target: URL | null = null;
  let viaFallback = false;

  if (explicit) {
    try {
      target = toHttp(new URL(explicit));
    } catch {
      target = null;
    }
    if (!target) return { kind: "error", status: 400, message: "Bad url parameter (absolute http(s) URL required)." };
  } else {
    // Fallback: a relative request from a proxied page (fetch('/api'), CSS url(/x.png), ...)
    let base = proxiedPageFrom(headers.get("referer"), reqUrl.origin);
    if (!base && cfg.defaultTarget) base = new URL(cfg.defaultTarget + "/");
    if (!base) {
      const c = readCookie(headers.get("cookie"), BASE_COOKIE);
      if (c) {
        try {
          base = new URL(decodeURIComponent(c));
        } catch {
          base = null;
        }
      }
    }
    if (!base) {
      if (reqUrl.pathname === "/" && !reqUrl.search) return { kind: "error", status: 200, message: "Live Web proxy is running. Use /?url=<https://allowed-host/...>" };
      return { kind: "error", status: 400, message: "Missing ?url= parameter." };
    }
    try {
      target = toHttp(new URL(reqUrl.pathname + reqUrl.search, base));
    } catch {
      target = null;
    }
    if (!target) return { kind: "error", status: 400, message: "Could not resolve relative request." };
    viaFallback = true;
  }

  if (!hostAllowed(target.hostname, cfg)) {
    return { kind: "error", status: 403, message: `Host not allowed by this proxy: ${target.hostname}` };
  }
  return { kind: "target", target, viaFallback };
}

/* -------------------------------------------------------- URL rewriting */

export interface RewriteCtx {
  base: URL; // URL relative references resolve against (the target page, or its <base>)
  proxyOrigin: string;
  cfg: ProxyConfig;
}

export function proxify(abs: URL, proxyOrigin: string, cfg?: ProxyConfig): string {
  if (cfg?.defaultTarget) {
    const o = abs.protocol === "ws:" ? "http:" : abs.protocol === "wss:" ? "https:" : abs.protocol;
    if (o + "//" + abs.host === cfg.defaultTarget) return proxyOrigin + abs.pathname + abs.search + abs.hash;
  }
  return proxyOrigin + "/?url=" + encodeURIComponent(abs.href);
}

/**
 * Where a request should be redirected to reach its canonical proxy URL, or
 * null to serve it as is. Navigations arriving via the relative fallback, and
 * explicit ?url= navigations to the mirrored site, get redirected.
 */
export function canonicalRedirect(
  reqUrl: URL,
  headers: Headers,
  method: string,
  target: URL,
  viaFallback: boolean,
  cfg: ProxyConfig,
): string | null {
  if (method !== "GET" || !isNavigation(headers)) return null;
  const mirrored = !!cfg.defaultTarget && target.origin === cfg.defaultTarget;
  if (!viaFallback && !mirrored) return null;
  const canonical = proxify(target, reqUrl.origin, cfg);
  return canonical === reqUrl.href ? null : canonical;
}

/** Rewrite one URL if it points at an allowed host; otherwise leave it exactly as it was. */
export function rewriteUrl(value: string, ctx: RewriteCtx): string {
  const v = value.trim();
  if (!v || v.startsWith("#") || /^(javascript|data|blob|mailto|tel|about|sms):/i.test(v)) return value;
  let abs: URL;
  try {
    abs = new URL(v, ctx.base);
  } catch {
    return value;
  }
  if (abs.origin === ctx.proxyOrigin) return value;
  if (!/^(https?|wss?):$/.test(abs.protocol)) return value;
  if (!hostAllowed(abs.hostname, ctx.cfg)) return value;
  return proxify(abs, ctx.proxyOrigin, ctx.cfg);
}

export function rewriteSrcset(value: string, ctx: RewriteCtx): string {
  return value
    .split(/,(?=\s*\S)/)
    .map((cand) => {
      const m = cand.match(/^(\s*)(\S+)(.*)$/s);
      return m ? m[1] + rewriteUrl(m[2], ctx) + m[3] : cand;
    })
    .join(",");
}

export function rewriteMetaRefresh(content: string, ctx: RewriteCtx): string {
  return content.replace(/(url\s*=\s*['"]?)([^'";]+)/i, (_, pre: string, u: string) => pre + rewriteUrl(u, ctx));
}

export function rewriteCss(css: string, ctx: RewriteCtx): string {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q: string, u: string) => `url(${q}${rewriteUrl(u, ctx)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q: string, u: string) => `@import ${q}${rewriteUrl(u, ctx)}${q}`);
}

/** Which attributes hold URLs, per element. srcset gets special handling. */
export const URL_ATTRS: Record<string, string[]> = {
  a: ["href"],
  area: ["href"],
  link: ["href"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  script: ["src"],
  iframe: ["src"],
  frame: ["src"],
  embed: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  input: ["src", "formaction"],
  button: ["formaction"],
  form: ["action"],
  object: ["data"],
};

export type ElementAction = "keep" | "remove" | "base";

/**
 * Decide what to do with an element, and rewrite its URL attributes in place
 * via the provided get/set callbacks. Used by both HTML rewriters.
 */
export function handleElement(
  tag: string,
  get: (name: string) => string | null,
  set: (name: string, value: string) => void,
  ctx: RewriteCtx,
): ElementAction {
  tag = tag.toLowerCase();
  if (tag === "base") {
    const href = get("href");
    // Mirror mode: paths map 1:1, so keep <base> (single-page apps such as
    // AngularJS in HTML5 mode require it), just pointed at the proxy.
    if (href && ctx.cfg.defaultTarget && ctx.base.origin === ctx.cfg.defaultTarget) {
      const rewritten = rewriteUrl(href, ctx);
      try {
        ctx.base = new URL(href, ctx.base);
      } catch {
        /* ignore */
      }
      set("href", rewritten);
      return "keep";
    }
    if (href) {
      try {
        ctx.base = new URL(href, ctx.base);
      } catch {
        /* ignore */
      }
    }
    return "base"; // removed: we resolve everything against it ourselves
  }
  if (tag === "meta") {
    const equiv = (get("http-equiv") || "").toLowerCase();
    if (equiv === "content-security-policy" || equiv === "x-frame-options") return "remove";
    if (equiv === "refresh") {
      const c = get("content");
      if (c) set("content", rewriteMetaRefresh(c, ctx));
    }
    return "keep";
  }
  const attrs = URL_ATTRS[tag];
  if (!attrs) return "keep";
  for (const a of attrs) {
    const v = get(a);
    if (v == null) continue;
    set(a, a === "srcset" ? rewriteSrcset(v, ctx) : rewriteUrl(v, ctx));
  }
  return "keep";
}

/* ------------------------------------------------------------- headers */

const DROP_REQUEST_HEADERS = [
  "host",
  "cookie",
  "origin",
  "referer",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "content-length",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "cdn-loop",
];

/** Turn the browser's cookies for the proxy into the cookies the target expects. */
export function upstreamCookies(header: string | null, target: URL): string {
  if (!header) return "";
  const host = target.hostname.toLowerCase();
  const out: string[] = [];
  for (const part of header.split(";")) {
    const p = part.trim();
    const i = p.indexOf("=");
    if (i <= 0) continue;
    const name = p.slice(0, i);
    const value = p.slice(i + 1);
    if (name === BASE_COOKIE) continue;
    if (name.startsWith(COOKIE_PREFIX)) {
      const rest = name.slice(COOKIE_PREFIX.length);
      const j = rest.indexOf("~");
      if (j <= 0) continue;
      const scope = rest.slice(0, j);
      if (host === scope || host.endsWith("." + scope)) out.push(`${rest.slice(j + 1)}=${value}`);
    } else {
      out.push(p); // set by page JavaScript via document.cookie on the proxy origin
    }
  }
  return out.join("; ");
}

export function upstreamHeaders(req: Headers, target: URL, proxyOrigin: string, cfg?: ProxyConfig): Headers {
  const h = new Headers();
  req.forEach((value, key) => {
    const k = key.toLowerCase();
    if (DROP_REQUEST_HEADERS.includes(k) || k.startsWith("cf-") || k.startsWith("x-lw-")) return;
    h.set(key, value);
  });
  const cookies = upstreamCookies(req.get("cookie"), target);
  if (cookies) h.set("cookie", cookies);

  const ref = req.get("referer");
  const page = proxiedPageFrom(ref, proxyOrigin);
  // The origin of the page that made this request, as the target would see it.
  const pageOrigin = page?.origin || cfg?.defaultTarget || target.origin;

  const origin = req.get("origin");
  if (origin) h.set("origin", origin === proxyOrigin ? pageOrigin : origin);

  if (page) h.set("referer", page.href);
  else if (ref) {
    try {
      const r = new URL(ref);
      if (r.origin === proxyOrigin) h.set("referer", new URL(r.pathname + r.search, cfg?.defaultTarget || target).href);
    } catch {
      /* drop */
    }
  }
  return h;
}

/**
 * Rewrite one Set-Cookie for the proxy origin: drop Domain, Path=/, force
 * SameSite=None; Secure; Partitioned (CHIPS, so it survives third-party-cookie
 * blocking inside the Office iframe), and namespace the name by host scope so
 * cookies from different sites don't collide in the proxy's single cookie jar.
 */
export function rewriteSetCookie(sc: string, target: URL): string | null {
  const parts = sc.split(";");
  const first = parts.shift() || "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  let scope = target.hostname.toLowerCase();
  const keep: string[] = [];
  for (const raw of parts) {
    const attr = raw.trim();
    const k = attr.split("=")[0].trim().toLowerCase();
    if (k === "domain") {
      const d = attr.slice(attr.indexOf("=") + 1).trim().replace(/^\./, "").toLowerCase();
      if (d && (scope === d || scope.endsWith("." + d))) scope = d;
      continue;
    }
    if (k === "path" || k === "samesite" || k === "secure" || k === "partitioned") continue;
    if (attr) keep.push(attr);
  }
  return [`${COOKIE_PREFIX}${scope}~${name}=${value}`, ...keep, "Path=/", "SameSite=None", "Secure", "Partitioned"].join(
    "; ",
  );
}

const DROP_RESPONSE_HEADERS = [
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "strict-transport-security",
  "alt-svc",
  "clear-site-data",
  "report-to",
  "nel",
  "set-cookie",
  "location",
  "referrer-policy",
  "permissions-policy",
  "cache-control",
  "expires",
  "pragma",
  "etag",
  "last-modified",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
];

export function frameAncestors(cfg: ProxyConfig): string {
  const list = ["'self'", "https://*.officeapps.live.com", "https://*.office.com", "https://*.officeppe.com"];
  if (cfg.addinOrigin) list.push(cfg.addinOrigin);
  return "frame-ancestors " + list.join(" ");
}

/** CORS for the add-in origin only. */
export function applyCors(h: Headers, reqOrigin: string | null, cfg: ProxyConfig) {
  h.append("vary", "Origin");
  if (cfg.addinOrigin && reqOrigin === cfg.addinOrigin) {
    h.set("access-control-allow-origin", cfg.addinOrigin);
    h.set("access-control-allow-credentials", "true");
  }
}

export function preflightHeaders(req: Headers, cfg: ProxyConfig): Headers {
  const h = new Headers({ "cache-control": "no-store" });
  applyCors(h, req.get("origin"), cfg);
  if (h.has("access-control-allow-origin")) {
    h.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    h.set("access-control-allow-headers", req.get("access-control-request-headers") || "*");
    h.set("access-control-max-age", "600");
  }
  return h;
}

export interface UpstreamMeta {
  status: number;
  headers: Headers;
  setCookies: string[];
}

export function downstreamHeaders(
  up: UpstreamMeta,
  target: URL,
  proxyOrigin: string,
  reqOrigin: string | null,
  cfg: ProxyConfig,
): Headers {
  const h = new Headers();
  up.headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.includes(key.toLowerCase())) h.set(key, value);
  });

  h.set("content-security-policy", frameAncestors(cfg));
  h.set("cache-control", "no-store");
  // Full referrer on same-origin (proxy) requests powers the relative-URL fallback.
  h.set("referrer-policy", "same-origin");
  applyCors(h, reqOrigin, cfg);

  const loc = up.headers.get("location");
  if (loc) {
    let abs: URL | null = null;
    try {
      abs = new URL(loc, target);
    } catch {
      abs = null;
    }
    if (abs && /^https?:$/.test(abs.protocol) && hostAllowed(abs.hostname, cfg)) h.set("location", proxify(abs, proxyOrigin, cfg));
    else if (abs) h.set("location", abs.href); // leaves the proxy; the browser goes direct
  }

  for (const sc of up.setCookies) {
    const r = rewriteSetCookie(sc, target);
    if (r) h.append("set-cookie", r);
  }

  if (isHtml(up.headers)) {
    h.append(
      "set-cookie",
      `${BASE_COOKIE}=${encodeURIComponent(target.href)}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned`,
    );
  }
  return h;
}

export const isHtml = (h: Headers) => /\btext\/html\b|application\/xhtml\+xml/i.test(h.get("content-type") || "");
export const isCss = (h: Headers) => /\btext\/css\b/i.test(h.get("content-type") || "");

export function textResponseHeaders(cfg: ProxyConfig, reqOrigin: string | null): Headers {
  const h = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  applyCors(h, reqOrigin, cfg);
  return h;
}

/** Navigations that arrive via the fallback get redirected to the canonical ?url= form. */
export function isNavigation(h: Headers): boolean {
  return h.get("sec-fetch-mode") === "navigate" || h.get("sec-fetch-dest") === "iframe" || h.get("sec-fetch-dest") === "document";
}

/* ---------------------------------------------------------- client shim */

/**
 * Small script injected at the top of every proxied HTML page. It routes
 * fetch / XHR / WebSocket / EventSource / window.open calls that target an
 * allowed host (or are root-relative) back through the proxy.
 */
export function clientShim(target: URL, proxyOrigin: string, cfg: ProxyConfig): string {
  // "</" can't appear inside <style>, so a value can never close the tag early.
  const css = cfg.injectCss ? `<style data-live-web>${cfg.injectCss.replace(/<\//g, "<\\/")}</style>` : "";
  return css + shimScript(target, proxyOrigin, cfg);
}

function shimScript(target: URL, proxyOrigin: string, cfg: ProxyConfig): string {
  const data = JSON.stringify({ t: target.href, p: proxyOrigin, a: cfg.allowedHosts, d: cfg.defaultTarget }).replace(/</g, "\\u003c");
  return `<script>(function(){try{var C=${data};var A=C.a,P=C.p,T=C.t,D=C.d;
function ok(h){h=h.toLowerCase();for(var i=0;i<A.length;i++){var r=A[i];if(r.indexOf("*.")===0){var b=r.slice(2);if(h===b||h.slice(-b.length-1)==="."+b)return true}else if(h===r)return true}return false}
function rw(u,ws){try{if(u==null)return u;var s=String(u);if(/^(data|blob|javascript|about):/i.test(s))return u;var x=new URL(s,T);if(x.host===new URL(P).host){if(x.pathname==="/"&&x.searchParams.get("url"))return u;x=new URL(x.pathname+x.search+x.hash,T)}
if(!/^(https?|wss?):$/.test(x.protocol)||!ok(x.hostname))return u;var o=ws?P.replace(/^http/,"ws"):P;if(D&&x.protocol.replace(/^ws/,"http")+"//"+x.host===D)return o+x.pathname+x.search+x.hash;return o+"/?url="+encodeURIComponent(x.href)}catch(e){return u}}
var F=window.fetch;if(F)window.fetch=function(i,n){if(typeof Request!=="undefined"&&i instanceof Request){var r=rw(i.url);if(r!==i.url)i=new Request(r,i)}else i=rw(i);return F.call(this,i,n)};
var X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=rw(u);return X.apply(this,a)};
if(window.WebSocket){var W=window.WebSocket;var NW=function(u,p){return p===undefined?new W(rw(u,1)):new W(rw(u,1),p)};NW.prototype=W.prototype;NW.CONNECTING=0;NW.OPEN=1;NW.CLOSING=2;NW.CLOSED=3;window.WebSocket=NW}
if(window.EventSource){var E=window.EventSource;var NE=function(u,o){return new E(rw(u),o)};NE.prototype=E.prototype;window.EventSource=NE}
var O=window.open;window.open=function(u){var a=[].slice.call(arguments);if(u)a[0]=rw(u);return O.apply(this,a)};
}catch(e){}})();</script>`;
}
