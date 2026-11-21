/**
 * Live Web proxy — Cloudflare Worker (free tier).
 * Same behaviour as ../node/server.ts; the logic lives in ../shared/core.ts.
 *
 * Vars (wrangler.toml [vars] or dashboard):
 *   ALLOWED_HOSTS  comma/space separated, e.g. "dashboard.example.com, *.example.org"
 *   ADDIN_ORIGIN   origin hosting the add-in, e.g. "https://liveweb.pages.dev"
 */
import {
  type ProxyConfig,
  type RewriteCtx,
  clientShim,
  downstreamHeaders,
  handleElement,
  isCss,
  isHtml,
  isNavigation,
  parseConfig,
  preflightHeaders,
  proxify,
  resolveTarget,
  rewriteCss,
  textResponseHeaders,
  upstreamHeaders,
} from "../shared/core.ts";

interface Env {
  ALLOWED_HOSTS?: string;
  ADDIN_ORIGIN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cfg = parseConfig(env);
    const reqUrl = new URL(request.url);
    const reqOrigin = request.headers.get("origin");
    const text = (status: number, body: string) =>
      new Response(body, { status, headers: textResponseHeaders(cfg, reqOrigin) });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: preflightHeaders(request.headers, cfg) });
    if (reqUrl.pathname === "/favicon.ico" && !request.headers.get("referer")) return text(404, "");

    const res = resolveTarget(reqUrl, request.headers, cfg);
    if (res.kind === "error") return text(res.status, res.message);
    const { target, viaFallback } = res;
    const proxyOrigin = reqUrl.origin;

    // Relative navigations (location.href = '/x') -> canonical ?url= form so later relative URLs resolve.
    if (viaFallback && isNavigation(request.headers) && request.method === "GET") {
      return Response.redirect(proxify(target, proxyOrigin), 302);
    }

    const headers = upstreamHeaders(request.headers, target, proxyOrigin);

    // WebSocket upgrade: hand straight to the allowed upstream.
    if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") {
      headers.set("upgrade", "websocket");
      return fetch(target.href, { method: "GET", headers });
    }

    let upstream: Response;
    try {
      upstream = await fetch(target.href, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
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
    const init = { status: upstream.status, statusText: upstream.statusText, headers: out };
    const noBody = request.method === "HEAD" || [101, 204, 205, 304].includes(upstream.status);
    if (noBody) return new Response(null, init);

    if (isHtml(upstream.headers)) return rewriteHtml(upstream, init, { base: target, proxyOrigin, cfg }, target, cfg);
    if (isCss(upstream.headers)) {
      return new Response(rewriteCss(await upstream.text(), { base: target, proxyOrigin, cfg }), init);
    }
    return new Response(upstream.body, init);
  },
};

function rewriteHtml(upstream: Response, init: ResponseInit, ctx: RewriteCtx, target: URL, cfg: ProxyConfig): Response {
  let injected = false;
  const shim = clientShim(target, ctx.proxyOrigin, cfg);
  const rewriter = new HTMLRewriter()
    .on("head", {
      element(el) {
        if (!injected) {
          el.prepend(shim, { html: true });
          injected = true;
        }
      },
    })
    .on("*", {
      element(el) {
        const action = handleElement(
          el.tagName,
          (n) => el.getAttribute(n),
          (n, v) => el.setAttribute(n, v),
          ctx,
        );
        if (action !== "keep") el.remove();
        // Pages without <head>: inject before the first real element instead.
        if (!injected && el.tagName !== "html" && el.tagName !== "head") {
          el.before(shim, { html: true });
          injected = true;
        }
      },
    });
  return rewriter.transform(new Response(upstream.body, init));
}
