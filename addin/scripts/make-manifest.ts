/**
 * Generate manifest.xml for a given host.
 *
 *   npm run manifest -- --host https://liveweb.pages.dev
 *   npm run manifest -- --host https://intranet.example.org/liveweb --proxy https://proxy.example.workers.dev
 *
 * Options:
 *   --host <https url>     where /dist is served (required)
 *   --proxy <https url>    optional proxy base; its origin is added to <AppDomains>
 *   --domain <https url>   extra AppDomain (repeatable)
 *   --version <a.b.c.d>    manifest version (default 1.0.0.0)
 *   --support <url>        SupportUrl (default: the host)
 *   --out <file>           output path (default ./manifest.xml)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
  const opts: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`Unexpected argument: ${a}`);
    const [k, inline] = a.slice(2).split("=", 2);
    const v = inline ?? argv[++i];
    if (v === undefined || v.startsWith("--")) fail(`--${k} needs a value`);
    (opts[k] ||= []).push(v);
  }
  return opts;
}

function fail(msg: string): never {
  console.error(`make-manifest: ${msg}\nUsage: npm run manifest -- --host https://your-host/path [--proxy https://proxy]`);
  process.exit(1);
}

function httpsUrl(name: string, value: string): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    fail(`--${name} is not a valid URL: ${value}`);
  }
  if (u.protocol !== "https:") fail(`--${name} must be https:// (Office requires HTTPS): ${value}`);
  return u;
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const opts = parseArgs(process.argv.slice(2));
if (!opts.host) fail("--host is required");

const hostUrl = httpsUrl("host", opts.host[0]);
const host = (hostUrl.origin + hostUrl.pathname).replace(/\/+$/, "").replace(/\/index\.html$/, "");
const version = opts.version?.[0] ?? "1.0.0.0";
if (!/^\d+(\.\d+){0,3}$/.test(version)) fail("--version must look like 1.0.0.0");

const domains = new Set<string>([hostUrl.origin]);
for (const p of opts.proxy ?? []) domains.add(httpsUrl("proxy", p).origin);
for (const d of opts.domain ?? []) domains.add(httpsUrl("domain", d).origin);

const template = readFileSync(join(here, "..", "manifest.template.xml"), "utf8");
const xml = template
  .replace(/<!--[\s\S]*?-->\n?/, "") // drop the template-only comment
  .replaceAll("{{HOST}}", xmlEscape(host))
  .replaceAll("{{VERSION}}", version)
  .replaceAll("{{SUPPORT_URL}}", xmlEscape(opts.support?.[0] ?? host + "/"))
  .replaceAll("{{APP_DOMAINS}}", [...domains].map((d) => `    <AppDomain>${xmlEscape(d)}</AppDomain>`).join("\n"));

if (/\{\{[A-Z_]+\}\}/.test(xml)) fail("template still contains unreplaced tokens");

const out = resolve(opts.out?.[0] ?? "manifest.xml");
writeFileSync(out, xml);
console.log(`Wrote ${out}`);
console.log(`  SourceLocation: ${host}/index.html`);
console.log(`  AppDomains:     ${[...domains].join(", ")}`);
