import "./style.css";

/* ============================================================================
 * Live Web — PowerPoint content add-in
 *
 * Shows one live website per add-in instance. All state lives in
 * Office.context.document.settings, so it travels inside the .pptx and each
 * instance (one per slide, or several per slide) is independent.
 * ========================================================================== */

type Mode = "direct" | "proxy";

interface Settings {
  url: string;
  mode: Mode;
  proxyBase: string; // per-presentation override; "" = use config.json
  zoom: number; // percent, 50..200
  toolbarHidden: boolean;
  refreshSeconds: number; // 0 = off
}

const DEFAULTS: Settings = {
  url: "",
  mode: "direct",
  proxyBase: "",
  zoom: 100,
  toolbarHidden: false,
  refreshSeconds: 0,
};
const SETTING_KEYS = Object.keys(DEFAULTS) as (keyof Settings)[];
const REFRESH_CHOICES = [0, 15, 30, 60];
const LOAD_TIMEOUT_MS = 8000;
const TOOLBAR_IDLE_MS = 3000;
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";
const ALLOW = "fullscreen; clipboard-write";

/* ---------------------------------------------------------------- helpers */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Accepts "example.com" or "https://example.com/x". Returns a normalised https URL or throws. */
function normaliseSiteUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error("Enter a website address.");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("That doesn't look like a valid web address.");
  }
  if (u.protocol !== "https:") throw new Error("Only https:// addresses are supported.");
  if (!u.hostname || u.username || u.password) throw new Error("That doesn't look like a valid web address.");
  return u.href;
}

/** Proxy base: https only, no query/hash, no trailing slash. "" stays "". */
function normaliseProxyBase(input: string): string {
  const s = input.trim();
  if (!s) return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("The proxy address isn't a valid URL.");
  }
  if (u.protocol !== "https:") throw new Error("The proxy must use https://.");
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

function sanitise(raw: Partial<Record<keyof Settings, unknown>>): Settings {
  const s: Settings = { ...DEFAULTS };
  if (typeof raw.url === "string") {
    try {
      s.url = normaliseSiteUrl(raw.url);
    } catch {
      /* ignore bad stored url */
    }
  }
  if (raw.mode === "proxy" || raw.mode === "direct") s.mode = raw.mode;
  if (typeof raw.proxyBase === "string") {
    try {
      s.proxyBase = normaliseProxyBase(raw.proxyBase);
    } catch {
      /* ignore */
    }
  }
  const z = raw.zoom == null || raw.zoom === "" ? NaN : Number(raw.zoom);
  if (Number.isFinite(z)) s.zoom = Math.min(200, Math.max(50, Math.round(z)));
  s.toolbarHidden = raw.toolbarHidden === true;
  const r = Number(raw.refreshSeconds);
  if (REFRESH_CHOICES.includes(r)) s.refreshSeconds = r;
  return s;
}

/* ---------------------------------------------------------------- storage */

interface Store {
  load(): Settings;
  save(s: Settings): Promise<void>;
}

/** Office document settings: stored inside the .pptx, per add-in instance. */
function officeStore(): Store {
  const ds = Office.context.document.settings;
  return {
    load() {
      const raw: Partial<Record<keyof Settings, unknown>> = {};
      for (const k of SETTING_KEYS) raw[k] = ds.get(k);
      return sanitise(raw);
    },
    save(s) {
      for (const k of SETTING_KEYS) ds.set(k, s[k]);
      return new Promise((resolve, reject) => {
        ds.saveAsync((res) => {
          if (res.status === Office.AsyncResultStatus.Succeeded) resolve();
          else reject(new Error(res.error?.message || "Could not save settings."));
        });
      });
    },
  };
}

/** Fallback when opened in a plain browser (local development / testing). */
function browserStore(): Store {
  const key = "liveweb.settings" + location.search;
  return {
    load() {
      try {
        return sanitise(JSON.parse(localStorage.getItem(key) || "{}"));
      } catch {
        return { ...DEFAULTS };
      }
    },
    async save(s) {
      try {
        localStorage.setItem(key, JSON.stringify(s));
      } catch {
        /* private mode etc. */
      }
    },
  };
}

/* ------------------------------------------------------------------ state */

let store: Store;
let inOffice = false;
let settings: Settings = { ...DEFAULTS }; // what is currently applied
let configProxyBase = ""; // from config.json
let slideShow = false;
let loaded = false; // has the visible frame finished its first load?

let current: HTMLIFrameElement | null = null;
let buffer: HTMLIFrameElement | null = null;
let loadTimer: number | undefined;
let bufferTimer: number | undefined;
let refreshTimer: number | undefined;
let toolbarTimer: number | undefined;

const effectiveProxyBase = (s: Settings = settings) => s.proxyBase || configProxyBase;
const effectiveMode = (s: Settings = settings): Mode => (s.mode === "proxy" && effectiveProxyBase(s) ? "proxy" : "direct");

function frameSrc(s: Settings = settings): string {
  if (effectiveMode(s) === "proxy") return effectiveProxyBase(s) + "/?url=" + encodeURIComponent(s.url);
  return s.url;
}

/* ------------------------------------------------------------ live frame */

function makeFrame(src: string): HTMLIFrameElement {
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", SANDBOX);
  f.setAttribute("allow", ALLOW);
  f.setAttribute("title", "Live website");
  f.setAttribute("allowfullscreen", "");
  f.src = src; // set before insertion so there is no initial about:blank load event
  return f;
}

/**
 * Best-effort "did the browser refuse to render this?" check.
 * A cross-origin document is unreadable (contentDocument === null), which we
 * treat as "something real loaded". WebKit/Gecko leave an empty same-origin
 * about:blank document behind when X-Frame-Options/frame-ancestors blocks.
 * Chromium shows its own error page, which is indistinguishable from a real
 * site — there the 8s timeout and the manual Pop out button are the fallback.
 */
function looksBlank(f: HTMLIFrameElement): boolean {
  try {
    const d = f.contentDocument;
    if (!d) return false;
    const href = d.location?.href || "";
    if (href === "about:blank" || href.startsWith("chrome-error:")) return true;
    const b = d.body;
    return !b || (b.childElementCount === 0 && !(b.textContent || "").trim());
  } catch {
    return false;
  }
}

function applyZoom() {
  const wrap = $("frameWrap");
  const z = settings.zoom / 100;
  wrap.style.transform = z === 1 ? "" : `scale(${z})`;
  wrap.style.width = `${100 / z}%`;
  wrap.style.height = `${100 / z}%`;
}

function clearFrames() {
  window.clearTimeout(loadTimer);
  window.clearTimeout(bufferTimer);
  $("frameWrap").replaceChildren();
  current = buffer = null;
}

/** Fresh, visible load (first show, Reload, settings changed). */
function showSite() {
  clearFrames();
  hideBlocked();
  $("empty").hidden = true;
  if (!settings.url) {
    $("stage").hidden = true;
    updateChrome();
    return;
  }
  $("stage").hidden = false;
  applyZoom();
  loaded = false;
  const f = makeFrame(frameSrc());
  current = f;
  f.addEventListener("load", () => {
    if (f !== current) return;
    const first = !loaded;
    loaded = true;
    window.clearTimeout(loadTimer);
    if (first && looksBlank(f)) showBlocked();
    else if (first) hideBlocked();
  });
  loadTimer = window.setTimeout(() => {
    if (f === current && !loaded) showBlocked();
  }, LOAD_TIMEOUT_MS);
  $("frameWrap").appendChild(f);
  scheduleRefresh();
  updateChrome();
  flashToolbar();
}

/**
 * Auto-refresh without flicker: load into a hidden second frame and swap it in
 * only once it has loaded. If it fails or stalls, keep showing the old page.
 */
function backgroundRefresh() {
  if (!current || !settings.url || !loaded) return showSite();
  if (buffer) buffer.remove();
  window.clearTimeout(bufferTimer);
  const f = makeFrame(frameSrc());
  f.classList.add("buffer");
  buffer = f;
  const drop = () => {
    if (buffer === f) buffer = null;
    f.remove();
  };
  f.addEventListener(
    "load",
    () => {
      if (buffer !== f) return;
      window.clearTimeout(bufferTimer);
      if (looksBlank(f)) return drop();
      const old = current;
      f.classList.remove("buffer");
      current = f;
      buffer = null;
      old?.remove();
    },
    { once: true },
  );
  bufferTimer = window.setTimeout(drop, LOAD_TIMEOUT_MS * 2);
  $("frameWrap").appendChild(f);
}

function scheduleRefresh() {
  window.clearInterval(refreshTimer);
  refreshTimer = undefined;
  if (settings.url && settings.refreshSeconds > 0) {
    refreshTimer = window.setInterval(backgroundRefresh, settings.refreshSeconds * 1000);
  }
}

/* -------------------------------------------------------- blocked overlay */

function showBlocked(manual = false) {
  $("blockedTitle").textContent = manual ? "Site not showing?" : "This site blocks embedding.";
  $("dismissBtn").textContent = manual ? "Close" : "Keep waiting";
  const canProxy = !!effectiveProxyBase() && effectiveMode() === "direct";
  $("tryProxyBtn").hidden = !canProxy;
  $("blockedSub").textContent =
    effectiveMode() === "proxy"
      ? "The proxy couldn't show it either. Check the proxy's ALLOWED_HOSTS, or pop it out."
      : canProxy
        ? "Open it in a separate window, or load it through your proxy."
        : manual
          ? "Many sites refuse to be shown inside other pages. Open it in a separate window instead."
          : "It may still open in a separate window.";
  $("blocked").hidden = false;
}
function hideBlocked() {
  $("blocked").hidden = true;
}

/* ------------------------------------------------------------- pop-out */

function popOut() {
  if (!settings.url) return;
  const bounce = new URL("redirect.html", location.href);
  bounce.search = "?u=" + encodeURIComponent(settings.url);
  const fallback = () => window.open(settings.url, "_blank", "noopener");
  if (!inOffice || !Office.context.ui?.displayDialogAsync) return fallback();
  try {
    Office.context.ui.displayDialogAsync(bounce.href, { height: 90, width: 90, displayInIframe: false }, (res) => {
      if (res.status !== Office.AsyncResultStatus.Succeeded) {
        // 12007 = a dialog is already open; anything else: try a normal window.
        if (res.error?.code !== 12007) fallback();
      }
    });
  } catch {
    fallback();
  }
}

/* -------------------------------------------------------------- toolbar */

function flashToolbar() {
  const tb = $("toolbar");
  if (tb.hidden) return;
  tb.classList.add("visible");
  window.clearTimeout(toolbarTimer);
  toolbarTimer = window.setTimeout(() => tb.classList.remove("visible"), TOOLBAR_IDLE_MS);
}

/** Toolbar / restore handle / empty-state visibility for the current view. */
function updateChrome() {
  const setupOpen = !$("setup").hidden;
  const hasSite = !!settings.url;
  $("toolbar").hidden = slideShow || setupOpen || !hasSite || settings.toolbarHidden;
  $("restore").hidden = slideShow || setupOpen || !hasSite || !settings.toolbarHidden;
  $("empty").hidden = !(slideShow && !hasSite);
}

/* ---------------------------------------------------------------- setup */

function readForm(): Settings | null {
  const urlEl = $<HTMLInputElement>("urlInput");
  const proxyEl = $<HTMLInputElement>("proxyInput");
  let ok = true;
  const next: Settings = { ...settings };

  try {
    next.url = normaliseSiteUrl(urlEl.value);
    setError(urlEl, "urlError", "");
  } catch (e) {
    ok = false;
    setError(urlEl, "urlError", (e as Error).message);
  }
  try {
    next.proxyBase = normaliseProxyBase(proxyEl.value);
    setError(proxyEl, "proxyError", "");
  } catch (e) {
    ok = false;
    setError(proxyEl, "proxyError", (e as Error).message);
    $<HTMLDetailsElement>("advanced").open = true;
  }
  const mode = (document.querySelector('input[name="mode"]:checked') as HTMLInputElement | null)?.value;
  next.mode = mode === "proxy" && effectiveProxyBase(next) ? "proxy" : "direct";
  next.zoom = Number($<HTMLInputElement>("zoomInput").value) || 100;
  next.refreshSeconds = Number($<HTMLSelectElement>("refreshInput").value) || 0;
  return ok ? next : null;
}

function setError(input: HTMLInputElement, errId: string, msg: string) {
  const el = $(errId);
  el.textContent = msg;
  el.hidden = !msg;
  input.setAttribute("aria-invalid", msg ? "true" : "false");
}

/** Show/hide the Proxy mode toggle depending on whether any proxy base is available. */
function refreshModeField() {
  let typed = "";
  try {
    typed = normaliseProxyBase($<HTMLInputElement>("proxyInput").value);
  } catch {
    /* invalid -> treat as none for now */
  }
  const available = typed || configProxyBase;
  $("modeField").hidden = !available;
  if (!available) $q<HTMLInputElement>('input[name="mode"][value="direct"]').checked = true;
  $("proxyHint").textContent = configProxyBase
    ? `Leave blank to use this deployment's default: ${configProxyBase}`
    : "Optional. Lets this presentation use a proxy without redeploying the add-in.";
}

function openSetup() {
  $<HTMLInputElement>("urlInput").value = settings.url;
  $<HTMLInputElement>("proxyInput").value = settings.proxyBase;
  $<HTMLInputElement>("zoomInput").value = String(settings.zoom);
  $("zoomOut").textContent = settings.zoom + "%";
  $<HTMLSelectElement>("refreshInput").value = String(settings.refreshSeconds);
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) r.checked = r.value === effectiveMode();
  setError($<HTMLInputElement>("urlInput"), "urlError", "");
  setError($<HTMLInputElement>("proxyInput"), "proxyError", "");
  $<HTMLDetailsElement>("advanced").open = !!settings.proxyBase;
  refreshModeField();
  $("cancelBtn").hidden = !settings.url;
  $("status").textContent = "";
  $("setup").hidden = false;
  updateChrome();
  $<HTMLInputElement>("urlInput").focus();
}

function closeSetup() {
  $("setup").hidden = true;
  updateChrome();
}

function $q<T extends Element>(sel: string) {
  return document.querySelector(sel) as T;
}

async function persist(): Promise<boolean> {
  try {
    await store.save(settings);
    return true;
  } catch (e) {
    console.warn("Live Web: save failed", e);
    return false;
  }
}

/* --------------------------------------------------------------- events */

function wire() {
  // Toolbar + blocked overlay share data-action buttons.
  document.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!btn) return;
    switch (btn.dataset.action) {
      case "reload":
        showSite();
        break;
      case "edit":
        openSetup();
        break;
      case "popout":
        popOut();
        break;
      case "hide":
        settings.toolbarHidden = true;
        updateChrome();
        void persist();
        break;
      case "help":
        showBlocked(true);
        break;
      case "dismiss":
        hideBlocked();
        break;
      case "try-proxy":
        settings.mode = "proxy";
        showSite();
        void persist();
        break;
    }
  });

  $("restore").addEventListener("click", () => {
    settings.toolbarHidden = false;
    updateChrome();
    flashToolbar();
    void persist();
  });

  // Mouse events stop at the iframe edge, so the toolbar also reveals itself on
  // hover (CSS) and keyboard focus; anything that reaches this document shows it.
  document.addEventListener("mousemove", flashToolbar);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("setup").hidden && settings.url) closeSetup();
  });

  $("zoomInput").addEventListener("input", (ev) => {
    $("zoomOut").textContent = (ev.target as HTMLInputElement).value + "%";
  });
  $("proxyInput").addEventListener("input", refreshModeField);
  $("cancelBtn").addEventListener("click", closeSetup);

  // Load = apply now without saving (preview). Save = apply and store in the .pptx.
  $("loadBtn").addEventListener("click", () => {
    const next = readForm();
    if (!next) return;
    settings = next;
    closeSetup();
    showSite();
  });
  $("setup").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const next = readForm();
    if (!next) return;
    settings = next;
    $("status").textContent = "Saving…";
    const ok = await persist();
    if (!ok) {
      $("status").textContent = "Couldn't save to the presentation. Your changes are applied but not stored.";
      return;
    }
    closeSetup();
    showSite();
  });
}

/* ------------------------------------------------------- slide show view */

function setView(view: string | undefined) {
  const next = view === "read"; // PowerPoint reports "read" during Slide Show
  if (next === slideShow) return;
  slideShow = next;
  if (slideShow && !$("setup").hidden) closeSetup();
  if (!slideShow && !settings.url) openSetup();
  updateChrome();
}

function watchView() {
  const doc = Office.context.document;
  try {
    doc.getActiveViewAsync((res) => {
      if (res.status === Office.AsyncResultStatus.Succeeded) setView(res.value);
    });
    doc.addHandlerAsync(Office.EventType.ActiveViewChanged, (e: { activeView: string }) => setView(e.activeView));
  } catch {
    /* ActiveView API not available on this host; stay in edit behaviour */
  }
}

/* ----------------------------------------------------------------- boot */

async function loadConfig(): Promise<string> {
  try {
    const res = await fetch(new URL("config.json", location.href).href, { cache: "no-store" });
    if (!res.ok) return "";
    const cfg = (await res.json()) as { proxyBase?: unknown };
    return typeof cfg.proxyBase === "string" ? normaliseProxyBase(cfg.proxyBase) : "";
  } catch {
    return "";
  }
}

async function start(host: Office.HostType | null) {
  inOffice = !!host;
  store = inOffice ? officeStore() : browserStore();
  configProxyBase = await loadConfig();
  settings = store.load();
  wire();
  if (inOffice) watchView();
  if (settings.url) showSite();
  else openSetup();
}

function boot() {
  let started = false;
  const go = (host: Office.HostType | null) => {
    if (started) return;
    started = true;
    void start(host);
  };
  if (typeof Office !== "undefined" && typeof Office.onReady === "function") {
    Office.onReady((info) => go(info.host ?? null));
  } else {
    // office.js failed to load (offline / blocked CDN): still usable in a browser.
    go(null);
  }
}

boot();
