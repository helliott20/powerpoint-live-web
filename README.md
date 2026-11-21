# Live Web — a free PowerPoint add-in for live websites

Live Web puts a live, interactive website on a slide. It keeps working during Slide Show, on PowerPoint for Windows, Mac and the web.

- **The core add-in is static files only.** You can host it anywhere that serves HTTPS: Cloudflare Pages, GitHub Pages, Netlify, IIS or S3. It has no backend, no database and no build-time secrets.
- **The proxy is optional.** Some sites refuse to be embedded (`X-Frame-Options` or CSP `frame-ancestors`). For those, you can deploy a small proxy, either a Cloudflare Worker on the free tier or a Node/Docker container. It only serves hosts on an allowlist you set.
- **Settings are stored inside the .pptx.** Each add-in instance has its own URL, mode, zoom and refresh settings.

```
addin/                     CORE (standalone)
  index.html               the add-in page
  redirect.html            same-origin bounce page used by "Pop out"
  public/config.json       optional runtime config: { "proxyBase": "" }
  public/assets/icon-*.png placeholder icons (regenerate: npm run icons)
  src/main.ts, style.css
  manifest.template.xml    fixed GUID lives here
  scripts/make-manifest.ts generates manifest.xml for your host
proxy/                     OPTIONAL
  shared/core.ts           allowlist, header/cookie/URL rewriting, client shim (used by both)
  cloudflare/worker.ts     Worker (HTMLRewriter)
  cloudflare/wrangler.toml
  node/server.ts           same logic for self-hosting (parse5 streaming rewriter)
  node/Dockerfile
```

---

## 1. Deploy the core add-in (no proxy)

Requires Node 22.18 or later.

```bash
npm install
```

```bash
npm run build
```

Upload the contents of **`dist/`** to any HTTPS static host. It can sit at a domain root or in a sub-folder, because every path is relative.

Generate the manifest for that location:

```bash
npm run manifest -- --host https://liveweb.example.com
```

This writes `manifest.xml` with the SourceLocation, icon URLs and AppDomains for your host, plus the fixed add-in GUID. To check it, run Microsoft's validator: `npx office-addin-manifest validate manifest.xml`.

### Sideload it

If you use the GitHub Pages deploy, the manifest is already published at `<pages-url>/manifest.xml`. Download it first: Office reads the manifest from a file, not from a URL.

| Platform | How |
|---|---|
| **PowerPoint on the web** | Open a presentation → **Home → Add-ins → More Settings → Upload My Add-in** → browse to `manifest.xml` → **Upload**. The upload is stored in browser storage, so you need to repeat it in another browser or after clearing the cache. |
| **Windows** | Put `manifest.xml` in a folder and share it (folder **Properties → Sharing → Share**, then note the `\\PC\share` path). In PowerPoint, go to **File → Options → Trust Center → Trust Center Settings → Trusted Add-in Catalogs**, paste the **network path** into *Catalog Url*, click **Add catalog**, tick **Show in Menu**, then click OK. Restart PowerPoint, then go to **Home → Add-ins → Advanced → SHARED FOLDER** → select Live Web → **Add**. *Catalog Url must be a network share path. An https:// link to the manifest does not work.* |
| **Mac** | Copy `manifest.xml` into `~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef` (create `wef` if it's missing). Restart PowerPoint, then go to **Home → Add-ins** → select Live Web. |
| **Whole organisation** | Microsoft 365 admin centre → Settings → *Integrated apps* → *Upload custom apps* → upload `manifest.xml` and assign users. This is the production route; Microsoft says the shared-folder catalog is for testing only. |

Reference: Microsoft Learn, *Sideload Office Add-ins for testing*, *Create a network shared folder catalog*, *Sideload an Office Add-in on Mac*.

### Use it

1. Insert the add-in on a slide. The setup panel opens.
2. Enter an `https://` URL. Choose a zoom level (50–200%) and an auto-refresh interval (off, 15s, 30s or 60s).
3. Use **Load** to preview without saving, or **Save** to store the settings in the presentation.
4. Hover over the top-right corner to see the toolbar: **Reload · Edit · Pop out · Not showing? · Hide**. The toolbar fades after 3 seconds. Once you hide it, a small corner handle at the bottom right brings it back.
5. In Slide Show the website stays interactive, and the toolbar is never shown.

Auto-refresh loads the page into a hidden second frame and swaps it in only once it has loaded. A slow or failed refresh never blanks the slide.

### Sites that refuse to be embedded

Many sites, such as banks, Google and Microsoft 365 apps, forbid framing. When the add-in detects this, it shows *"This site blocks embedding."* with:

- **Pop out**: opens the site in an Office dialog (90% × 90%) via `redirect.html`. Office requires the dialog to start on the add-in's own domain. The dialog then navigates to the site, which is shown top-level, so no framing rules apply. If no dialog is available, it falls back to a normal browser window. **Test the dialog in Slide Show on both Windows and Mac**, because dialog behaviour during a slide show differs between PowerPoint builds.
- **Try proxy**: shown only when a proxy is configured (see below).

> **Detection limits.** A page cannot inspect a cross-origin frame. On Safari/WebKit (PowerPoint for Mac) and Firefox, a blocked frame leaves an empty document behind, so it is detected automatically. A frame that never loads is reported after 8 seconds on every platform. **Chromium-based hosts** (PowerPoint on the web in Edge or Chrome, and WebView2 on Windows) show their own "refused to connect" page instead. To the add-in, that page looks exactly like a real site, so automatic detection is impossible there. For those hosts, the toolbar's **Not showing?** button opens the same panel by hand.

---

## 2. Add the proxy later (optional)

The proxy fetches an allowlisted site and makes these changes:

- It strips the headers that block framing (`X-Frame-Options`, `Content-Security-Policy(-Report-Only)` and `Cross-Origin-Opener/Embedder/Resource-Policy`) and also removes CSP and X-Frame-Options `<meta>` tags.
- It sets `Content-Security-Policy: frame-ancestors 'self' https://*.officeapps.live.com https://*.office.com https://*.officeppe.com <ADDIN_ORIGIN>`, so only Office and your add-in can frame the result.
- It rewrites `href`, `src`, `action`, `srcset` (plus `formaction`, `poster`, `data`, meta refresh and CSS `url()`/`@import`) on allowed hosts so they go back through the proxy. Links to other hosts are left untouched.
- It injects a small script that sends `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `window.open` calls through the proxy when they target an allowed host. Root-relative requests the page builds itself are resolved from the `Referer` or an `lw_base` cookie.
- **Cookies:** it drops `Domain`, forces `SameSite=None; Secure; Partitioned` and namespaces each cookie by host, so two proxied sites can't overwrite each other's cookies. Logins persist.
- **Redirects:** `Location` headers on allowed hosts are rewritten through the proxy.
- **WebSockets:** upgrades to allowed hosts are passed through.
- **Responses:** every response gets `Cache-Control: no-store`. CORS is allowed for `ADDIN_ORIGIN` only.
- **Security:** any host that isn't in `ALLOWED_HOSTS` gets **403**. The proxy is never open. Redirects, rewritten links and WebSockets are all checked against the same list.

### Option A: Cloudflare Worker (free tier)

Edit `proxy/cloudflare/wrangler.toml`:

```toml
[vars]
ALLOWED_HOSTS = "dashboard.example.com, *.status.example.org"   # "*." = the domain + all subdomains
ADDIN_ORIGIN  = "https://liveweb.example.com"
```

```bash
cd proxy/cloudflare
```

```bash
npm install
```

```bash
npx wrangler deploy
```

This prints the proxy's URL, for example `https://live-web-proxy.<you>.workers.dev`.

### Option B: Node / Docker (self-hosted)

```bash
cd proxy
```

```bash
docker build -f node/Dockerfile -t live-web-proxy .
```

```bash
docker run -d -p 8787:8787 -e ALLOWED_HOSTS="dashboard.example.com" -e ADDIN_ORIGIN="https://liveweb.example.com" live-web-proxy
```

You can also run it without Docker (Node 22.18 or later runs the TypeScript directly): `cd proxy/node && npm install && ALLOWED_HOSTS=... ADDIN_ORIGIN=... npm start`.

The Node proxy listens on plain HTTP. **Put it behind HTTPS** (Caddy, nginx, IIS ARR or Cloudflare Tunnel). By default it trusts `X-Forwarded-Proto/Host` from that front end. Alternatively, set `PUBLIC_ORIGIN=https://proxy.example.org`. `GET /healthz` returns `ok`.

### Point the add-in at the proxy

Choose one of these. The first match wins: **per-presentation setting > `config.json` > none**.

- **Deployment-wide:** edit `config.json` on your static host. This is a runtime file, so no rebuild is needed:
  ```json
  { "proxyBase": "https://live-web-proxy.you.workers.dev" }
  ```
- **One presentation only:** paste the proxy URL into *Edit → Advanced → Proxy base URL*.

When no proxy is configured, the *Via proxy* option is hidden completely.

Finally, re-generate the manifest so the proxy domain is listed in `<AppDomains>`, and re-upload it:

```bash
npm run manifest -- --host https://liveweb.example.com --proxy https://live-web-proxy.you.workers.dev
```

### Proxy caveats

- **Third-party cookies.** Inside PowerPoint on the web, the proxy is a third-party site. Cookies use CHIPS (`Partitioned`), which Chromium accepts. Safari/WKWebView (Mac) may still block them, which means a proxied login may not persist on Mac. If you can, serve the proxy from a subdomain of the same site as the add-in, for example `liveweb.example.org` and `proxy.liveweb.example.org`.
- **Single sign-on.** Sites that log in through a separate identity provider (Microsoft or Google SSO) only work if every host in the login flow is in `ALLOWED_HOSTS`. Even then, many identity providers refuse to run proxied. The proxy works best for dashboards, status pages and internal tools.
- **Heavy single-page apps.** Apps that build absolute URLs in unusual ways, such as service workers or `postMessage` origin checks, may need more hosts allowlisted, or may simply be better popped out.
- **Terms of service.** Only proxy sites you own or are allowed to re-frame.

---

## 3. Development

```bash
npm run dev
```

This serves the add-in on `http://localhost:3000`. Opened in a normal browser (outside Office), it falls back to `localStorage` for settings, so you can work on the UI without PowerPoint. For sideloading during development, Office needs HTTPS: use a tunnel (for example `cloudflared tunnel --url http://localhost:3000`) and generate the manifest with that URL.

| Script | What it does |
|---|---|
| `npm run build` | Type-checks and writes static files to `dist/` |
| `npm run manifest -- --host <url> [--proxy <url>] [--version 1.0.1.0] [--out file]` | Writes `manifest.xml` |
| `npm run icons` | Regenerates the placeholder PNG icons (16/32/64/80/128) |
| `npm run typecheck` | Type-checks the add-in, Worker and Node proxy (run `npm install` in each proxy folder first) |

Keep the GUID in `addin/manifest.template.xml` stable. Existing presentations find the add-in by that ID. If you fork this project into a different add-in, generate a new GUID once.

---

## 4. Test checklist

- [ ] Core with no proxy: a frame-friendly site loads, and the *Via proxy* option is hidden.
- [ ] A blocked site shows the blocked message (or use **Not showing?** on Chromium hosts), and **Pop out** works.
- [ ] With the proxy: the blocked site renders, links work, login persists, and live updates (fetch/WebSocket) come through.
- [ ] Settings survive Save, closing the file and reopening it.
- [ ] Slide Show: the site is interactive and the toolbar is hidden.
- [ ] Multiple slides with different URLs and modes.
- [ ] A host that isn't allowlisted returns 403 through the proxy.
- [ ] Works on PowerPoint on the web, Windows and Mac. Test the Pop-out dialog in Slide Show on Windows and Mac.

## Out of scope

Office Store submission, analytics and any paid service.
