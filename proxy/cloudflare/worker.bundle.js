// Live Web proxy: single-file build of proxy/cloudflare/worker.ts + proxy/shared/core.ts.
// Paste this into the Cloudflare dashboard (Workers > Edit code). Regenerate with:
//   cd proxy/cloudflare && npx wrangler deploy --dry-run --outdir out
// Set variables ALLOWED_HOSTS and ADDIN_ORIGIN in the Worker's Settings > Variables.
// Variables: ALLOWED_HOSTS, ADDIN_ORIGIN, optional DEFAULT_TARGET (single-site mode).

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../shared/core.ts
var BASE_COOKIE = "lw_base";
var COOKIE_PREFIX = "lw~";
function parseConfig(env) {
  const allowedHosts = (env.ALLOWED_HOSTS || "").split(/[\s,]+/).map((h) => h.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  let addinOrigin = "";
  if (env.ADDIN_ORIGIN) {
    try {
      addinOrigin = new URL(env.ADDIN_ORIGIN).origin;
    } catch {
    }
  }
  let defaultTarget = "";
  if (env.DEFAULT_TARGET) {
    try {
      const u = new URL(env.DEFAULT_TARGET);
      if (u.protocol === "https:" || u.protocol === "http:") {
        defaultTarget = u.origin;
        if (!allowedHosts.includes(u.hostname.toLowerCase())) allowedHosts.push(u.hostname.toLowerCase());
      }
    } catch {
    }
  }
  return { allowedHosts, addinOrigin, defaultTarget };
}
__name(parseConfig, "parseConfig");
function hostAllowed(hostname, cfg) {
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
__name(hostAllowed, "hostAllowed");
function toHttp(u) {
  if (u.protocol === "ws:") u.protocol = "http:";
  else if (u.protocol === "wss:") u.protocol = "https:";
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return u;
}
__name(toHttp, "toHttp");
function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
__name(readCookie, "readCookie");
function proxiedPageFrom(ref, proxyOrigin) {
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
__name(proxiedPageFrom, "proxiedPageFrom");
function resolveTarget(reqUrl, headers, cfg) {
  const explicit = reqUrl.pathname === "/" ? reqUrl.searchParams.get("url") : null;
  let target = null;
  let viaFallback = false;
  if (explicit) {
    try {
      target = toHttp(new URL(explicit));
    } catch {
      target = null;
    }
    if (!target) return { kind: "error", status: 400, message: "Bad url parameter (absolute http(s) URL required)." };
  } else {
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
__name(resolveTarget, "resolveTarget");
function proxify(abs, proxyOrigin, cfg) {
  if (cfg?.defaultTarget) {
    const o = abs.protocol === "ws:" ? "http:" : abs.protocol === "wss:" ? "https:" : abs.protocol;
    if (o + "//" + abs.host === cfg.defaultTarget) return proxyOrigin + abs.pathname + abs.search + abs.hash;
  }
  return proxyOrigin + "/?url=" + encodeURIComponent(abs.href);
}
__name(proxify, "proxify");
function canonicalRedirect(reqUrl, headers, method, target, viaFallback, cfg) {
  if (method !== "GET" || !isNavigation(headers)) return null;
  const mirrored = !!cfg.defaultTarget && target.origin === cfg.defaultTarget;
  if (!viaFallback && !mirrored) return null;
  const canonical = proxify(target, reqUrl.origin, cfg);
  return canonical === reqUrl.href ? null : canonical;
}
__name(canonicalRedirect, "canonicalRedirect");
function rewriteUrl(value, ctx) {
  const v = value.trim();
  if (!v || v.startsWith("#") || /^(javascript|data|blob|mailto|tel|about|sms):/i.test(v)) return value;
  let abs;
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
__name(rewriteUrl, "rewriteUrl");
function rewriteSrcset(value, ctx) {
  return value.split(/,(?=\s*\S)/).map((cand) => {
    const m = cand.match(/^(\s*)(\S+)(.*)$/s);
    return m ? m[1] + rewriteUrl(m[2], ctx) + m[3] : cand;
  }).join(",");
}
__name(rewriteSrcset, "rewriteSrcset");
function rewriteMetaRefresh(content, ctx) {
  return content.replace(/(url\s*=\s*['"]?)([^'";]+)/i, (_, pre, u) => pre + rewriteUrl(u, ctx));
}
__name(rewriteMetaRefresh, "rewriteMetaRefresh");
function rewriteCss(css, ctx) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => `url(${q}${rewriteUrl(u, ctx)}${q})`).replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${rewriteUrl(u, ctx)}${q}`);
}
__name(rewriteCss, "rewriteCss");
var URL_ATTRS = {
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
  object: ["data"]
};
function handleElement(tag, get, set, ctx) {
  tag = tag.toLowerCase();
  if (tag === "base") {
    const href = get("href");
    if (href && ctx.cfg.defaultTarget && ctx.base.origin === ctx.cfg.defaultTarget) {
      const rewritten = rewriteUrl(href, ctx);
      try {
        ctx.base = new URL(href, ctx.base);
      } catch {
      }
      set("href", rewritten);
      return "keep";
    }
    if (href) {
      try {
        ctx.base = new URL(href, ctx.base);
      } catch {
      }
    }
    return "base";
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
__name(handleElement, "handleElement");
var DROP_REQUEST_HEADERS = [
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
  "cdn-loop"
];
function upstreamCookies(header, target) {
  if (!header) return "";
  const host = target.hostname.toLowerCase();
  const out = [];
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
      out.push(p);
    }
  }
  return out.join("; ");
}
__name(upstreamCookies, "upstreamCookies");
function upstreamHeaders(req, target, proxyOrigin, cfg) {
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
  const pageOrigin = page?.origin || cfg?.defaultTarget || target.origin;
  const origin = req.get("origin");
  if (origin) h.set("origin", origin === proxyOrigin ? pageOrigin : origin);
  if (page) h.set("referer", page.href);
  else if (ref) {
    try {
      const r = new URL(ref);
      if (r.origin === proxyOrigin) h.set("referer", new URL(r.pathname + r.search, cfg?.defaultTarget || target).href);
    } catch {
    }
  }
  return h;
}
__name(upstreamHeaders, "upstreamHeaders");
function rewriteSetCookie(sc, target) {
  const parts = sc.split(";");
  const first = parts.shift() || "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  let scope = target.hostname.toLowerCase();
  const keep = [];
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
    "; "
  );
}
__name(rewriteSetCookie, "rewriteSetCookie");
var DROP_RESPONSE_HEADERS = [
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
  "access-control-max-age"
];
function frameAncestors(cfg) {
  const list = ["'self'", "https://*.officeapps.live.com", "https://*.office.com", "https://*.officeppe.com"];
  if (cfg.addinOrigin) list.push(cfg.addinOrigin);
  return "frame-ancestors " + list.join(" ");
}
__name(frameAncestors, "frameAncestors");
function applyCors(h, reqOrigin, cfg) {
  h.append("vary", "Origin");
  if (cfg.addinOrigin && reqOrigin === cfg.addinOrigin) {
    h.set("access-control-allow-origin", cfg.addinOrigin);
    h.set("access-control-allow-credentials", "true");
  }
}
__name(applyCors, "applyCors");
function preflightHeaders(req, cfg) {
  const h = new Headers({ "cache-control": "no-store" });
  applyCors(h, req.get("origin"), cfg);
  if (h.has("access-control-allow-origin")) {
    h.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    h.set("access-control-allow-headers", req.get("access-control-request-headers") || "*");
    h.set("access-control-max-age", "600");
  }
  return h;
}
__name(preflightHeaders, "preflightHeaders");
function downstreamHeaders(up, target, proxyOrigin, reqOrigin, cfg) {
  const h = new Headers();
  up.headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.includes(key.toLowerCase())) h.set(key, value);
  });
  h.set("content-security-policy", frameAncestors(cfg));
  h.set("cache-control", "no-store");
  h.set("referrer-policy", "same-origin");
  applyCors(h, reqOrigin, cfg);
  const loc = up.headers.get("location");
  if (loc) {
    let abs = null;
    try {
      abs = new URL(loc, target);
    } catch {
      abs = null;
    }
    if (abs && /^https?:$/.test(abs.protocol) && hostAllowed(abs.hostname, cfg)) h.set("location", proxify(abs, proxyOrigin, cfg));
    else if (abs) h.set("location", abs.href);
  }
  for (const sc of up.setCookies) {
    const r = rewriteSetCookie(sc, target);
    if (r) h.append("set-cookie", r);
  }
  if (isHtml(up.headers)) {
    h.append(
      "set-cookie",
      `${BASE_COOKIE}=${encodeURIComponent(target.href)}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned`
    );
  }
  return h;
}
__name(downstreamHeaders, "downstreamHeaders");
var isHtml = /* @__PURE__ */ __name((h) => /\btext\/html\b|application\/xhtml\+xml/i.test(h.get("content-type") || ""), "isHtml");
var isCss = /* @__PURE__ */ __name((h) => /\btext\/css\b/i.test(h.get("content-type") || ""), "isCss");
function textResponseHeaders(cfg, reqOrigin) {
  const h = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  applyCors(h, reqOrigin, cfg);
  return h;
}
__name(textResponseHeaders, "textResponseHeaders");
function isNavigation(h) {
  return h.get("sec-fetch-mode") === "navigate" || h.get("sec-fetch-dest") === "iframe" || h.get("sec-fetch-dest") === "document";
}
__name(isNavigation, "isNavigation");
function clientShim(target, proxyOrigin, cfg) {
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
}catch(e){}})();<\/script>`;
}
__name(clientShim, "clientShim");

// worker.ts
var worker_default = {
  async fetch(request, env) {
    const cfg = parseConfig(env);
    const reqUrl = new URL(request.url);
    const reqOrigin = request.headers.get("origin");
    const text = /* @__PURE__ */ __name((status, body) => new Response(body, { status, headers: textResponseHeaders(cfg, reqOrigin) }), "text");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: preflightHeaders(request.headers, cfg) });
    if (reqUrl.pathname === "/favicon.ico" && !request.headers.get("referer")) return text(404, "");
    const res = resolveTarget(reqUrl, request.headers, cfg);
    if (res.kind === "error") return text(res.status, res.message);
    const { target, viaFallback } = res;
    const proxyOrigin = reqUrl.origin;
    const redirectTo = canonicalRedirect(reqUrl, request.headers, request.method, target, viaFallback, cfg);
    if (redirectTo) return Response.redirect(redirectTo, 302);
    const headers = upstreamHeaders(request.headers, target, proxyOrigin, cfg);
    if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") {
      headers.set("upgrade", "websocket");
      return fetch(target.href, { method: "GET", headers });
    }
    let upstream;
    try {
      upstream = await fetch(target.href, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? void 0 : request.body,
        redirect: "manual"
      });
    } catch (e) {
      return text(502, `Upstream fetch failed: ${e.message}`);
    }
    const out = downstreamHeaders(
      { status: upstream.status, headers: upstream.headers, setCookies: upstream.headers.getSetCookie() },
      target,
      proxyOrigin,
      reqOrigin,
      cfg
    );
    const init = { status: upstream.status, statusText: upstream.statusText, headers: out };
    const noBody = request.method === "HEAD" || [101, 204, 205, 304].includes(upstream.status);
    if (noBody) return new Response(null, init);
    if (isHtml(upstream.headers)) return rewriteHtml(upstream, init, { base: target, proxyOrigin, cfg }, target, cfg);
    if (isCss(upstream.headers)) {
      return new Response(rewriteCss(await upstream.text(), { base: target, proxyOrigin, cfg }), init);
    }
    return new Response(upstream.body, init);
  }
};
function rewriteHtml(upstream, init, ctx, target, cfg) {
  let injected = false;
  const shim = clientShim(target, ctx.proxyOrigin, cfg);
  const rewriter = new HTMLRewriter().on("head", {
    element(el) {
      if (!injected) {
        el.prepend(shim, { html: true });
        injected = true;
      }
    }
  }).on("*", {
    element(el) {
      const action = handleElement(
        el.tagName,
        (n) => el.getAttribute(n),
        (n, v) => el.setAttribute(n, v),
        ctx
      );
      if (action !== "keep") el.remove();
      if (!injected && el.tagName !== "html" && el.tagName !== "head") {
        el.before(shim, { html: true });
        injected = true;
      }
    }
  });
  return rewriter.transform(new Response(upstream.body, init));
}
__name(rewriteHtml, "rewriteHtml");
export {
  worker_default as default
};
