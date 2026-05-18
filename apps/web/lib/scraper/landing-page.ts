// Lightweight landing-page scraper for the onboarding flow.
//
// Given a URL, fetch the page, pull out brand-signal-bearing content
// (title, meta, headings, body copy, links) plus design hints (hex colors
// from inline styles, font-family declarations from CSS, logo URL), and
// return a clean markdown document that can be stored as a brand-document
// and run through /api/brand-extract.
//
// Intentionally regex-based, no headless browser. Most marketing landing
// pages are SSR'd enough that this works; fully client-rendered SPAs will
// produce thin output — the wizard can fall back to doc upload in that case.

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — landing pages should be tiny.
const MAX_STYLESHEETS = 4;
const USER_AGENT =
  "Mozilla/5.0 (compatible; MarketingAgentBot/1.0; +brand-onboarding)";

export type ScrapeResult = {
  url: string;
  finalUrl: string;
  host: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  ogImage: string | null;
  logoUrl: string | null;
  headings: string[];
  bodyText: string;
  links: { text: string; href: string }[];
  colors: string[];
  fontFamilies: string[];
  /** Markdown rendering, suitable to feed into /api/brand-extract. */
  markdown: string;
};

export class ScrapeError extends Error {
  readonly kind: "fetch_failed" | "non_html" | "empty" | "invalid_url";
  readonly status?: number;
  constructor(kind: ScrapeError["kind"], message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export async function scrapeLandingPage(rawUrl: string): Promise<ScrapeResult> {
  const url = normalizeUrl(rawUrl);
  const { html, finalUrl } = await fetchWithLimit(url);

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1] ? decode(titleMatch[1]).trim() || null : null;
  const description =
    metaContent(html, "description") ??
    metaContent(html, "og:description") ??
    metaContent(html, "twitter:description");
  const siteName = metaContent(html, "og:site_name");
  const ogImage = absolutize(metaContent(html, "og:image"), finalUrl);

  const headings = extractHeadings(html);
  const bodyText = extractBodyText(html);
  const links = extractLinks(html, finalUrl);
  const logoUrl = extractLogoUrl(html, finalUrl);

  // CSS: inline <style> blocks first, then fetch a few linked stylesheets
  // (best-effort — failures are silent).
  const inlineCss = matchAll(html, /<style[^>]*>([\s\S]*?)<\/style>/gi).join("\n");
  const linkedSheets = extractStylesheetHrefs(html, finalUrl).slice(0, MAX_STYLESHEETS);
  const externalCss = (
    await Promise.all(
      linkedSheets.map((href) =>
        fetchText(href).catch(() => ""),
      ),
    )
  ).join("\n");
  const allCss = `${inlineCss}\n${externalCss}`;

  const colors = uniq(extractHexColors(`${allCss}\n${html}`)).slice(0, 20);
  const fontFamilies = uniq(extractFontFamilies(allCss)).slice(0, 12);

  const host = new URL(finalUrl).host;

  const markdown = renderMarkdown({
    finalUrl,
    host,
    title,
    description,
    siteName,
    ogImage,
    logoUrl,
    headings,
    bodyText,
    links,
    colors,
    fontFamilies,
  });

  if (!title && headings.length === 0 && bodyText.length < 80) {
    throw new ScrapeError(
      "empty",
      "Couldn't read enough content from the page. The site may be client-rendered — try uploading documents instead.",
    );
  }

  return {
    url,
    finalUrl,
    host,
    title,
    description,
    siteName,
    ogImage,
    logoUrl,
    headings,
    bodyText,
    links,
    colors,
    fontFamilies,
    markdown,
  };
}

// --- helpers -------------------------------------------------------------

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new ScrapeError("invalid_url", "URL is empty.");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol)) {
      throw new ScrapeError("invalid_url", "URL must use http or https.");
    }
    return u.toString();
  } catch (e) {
    if (e instanceof ScrapeError) throw e;
    throw new ScrapeError("invalid_url", `Invalid URL: ${raw}`);
  }
}

async function fetchWithLimit(url: string): Promise<{ html: string; finalUrl: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.8" },
      redirect: "follow",
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new ScrapeError(
        "fetch_failed",
        `Site returned HTTP ${res.status}.`,
        res.status,
      );
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) {
      throw new ScrapeError("non_html", `Expected HTML, got ${ct}.`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      throw new ScrapeError(
        "fetch_failed",
        `Page is too large (${Math.round(buf.byteLength / 1024)} KB).`,
      );
    }
    return { html: new TextDecoder("utf-8").decode(buf), finalUrl: res.url || url };
  } catch (err) {
    if (err instanceof ScrapeError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ScrapeError("fetch_failed", `Couldn't reach ${url}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: ac.signal,
    });
    if (!res.ok) return "";
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return "";
    return new TextDecoder("utf-8").decode(buf);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function metaContent(html: string, nameOrProp: string): string | null {
  const escaped = nameOrProp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${escaped}["']`,
      "i",
    ),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return decode(m[1]).trim() || null;
  }
  return null;
}

function extractHeadings(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const level = Number(m[1] ?? "1");
    const text = stripTags(m[2] ?? "").trim();
    if (text) out.push(`${"#".repeat(level)} ${text}`);
  }
  return out.slice(0, 80);
}

function extractBodyText(html: string): string {
  // Drop script/style/noscript blocks entirely, then strip tags.
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ");

  const text = stripTags(cleaned)
    .replace(/\s+/g, " ")
    .trim();

  // Cap so we don't blow up the LLM context with footer noise.
  return text.length > 16_000 ? `${text.slice(0, 16_000)}…` : text;
}

function extractLinks(
  html: string,
  base: string,
): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  for (const m of html.matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const href = absolutize(m[1] ?? null, base);
    const text = stripTags(m[2] ?? "").trim();
    if (!href || !text) continue;
    if (/^(javascript:|mailto:|tel:|#)/i.test(href)) continue;
    out.push({ text, href });
    if (out.length >= 40) break;
  }
  return out;
}

function extractLogoUrl(html: string, base: string): string | null {
  // Apple touch icon → og:image → standard icon → first <img> in <header>.
  const apple = html.match(
    /<link[^>]+rel=["'](?:apple-touch-icon[^"']*)["'][^>]+href=["']([^"']+)["']/i,
  );
  if (apple) return absolutize(apple[1], base);

  const og = metaContent(html, "og:image");
  if (og) return absolutize(og, base);

  const icon = html.match(
    /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i,
  );
  if (icon) return absolutize(icon[1], base);

  const headerImg = html.match(
    /<header[\s\S]*?<img[^>]+src=["']([^"']+)["']/i,
  );
  if (headerImg) return absolutize(headerImg[1], base);

  return null;
}

function extractStylesheetHrefs(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(
    /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi,
  )) {
    const abs = absolutize(m[1], base);
    if (abs && /^https?:/.test(abs)) out.push(abs);
  }
  return uniq(out);
}

function extractHexColors(input: string): string[] {
  const out: string[] = [];
  for (const m of input.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{8}|[0-9a-fA-F]{3})\b/g)) {
    const raw = m[1];
    if (!raw) continue;
    let hex = `#${raw}`;
    if (hex.length === 4) {
      // Expand #abc → #aabbcc so the LLM sees a stable canonical form.
      const a = hex[1];
      const b = hex[2];
      const c = hex[3];
      if (!a || !b || !c) continue;
      hex = `#${a}${a}${b}${b}${c}${c}`;
    }
    // Drop pure black/white — too noisy to be useful as "brand colors".
    const norm = hex.slice(0, 7).toLowerCase();
    if (norm === "#000000" || norm === "#ffffff") continue;
    out.push(norm);
  }
  return out;
}

function extractFontFamilies(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    // Take the first family in the stack (the brand-intended one).
    const raw = m[1];
    if (!raw) continue;
    const first = (raw.split(",")[0] ?? "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!first) continue;
    // Skip CSS generics and obvious system fallbacks.
    if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|-apple-system|ui-[a-z]+|inherit|initial|unset)$/i.test(first)) {
      continue;
    }
    out.push(first);
  }
  return out;
}

function absolutize(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function stripTags(s: string): string {
  return decode(s.replace(/<[^>]+>/g, " "));
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function matchAll(input: string, re: RegExp): string[] {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const r = new RegExp(re.source, flags);
  const out: string[] = [];
  for (const m of input.matchAll(r)) out.push(m[1] ?? m[0]);
  return out;
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function renderMarkdown(r: {
  finalUrl: string;
  host: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  ogImage: string | null;
  logoUrl: string | null;
  headings: string[];
  bodyText: string;
  links: { text: string; href: string }[];
  colors: string[];
  fontFamilies: string[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${r.title ?? r.siteName ?? r.host} (landing page)`);
  lines.push("");
  lines.push(`Source URL: ${r.finalUrl}`);
  if (r.siteName) lines.push(`Site name: ${r.siteName}`);
  if (r.description) lines.push(`Meta description: ${r.description}`);
  if (r.logoUrl) lines.push(`Logo URL: ${r.logoUrl}`);
  if (r.ogImage && r.ogImage !== r.logoUrl) lines.push(`OG image: ${r.ogImage}`);
  lines.push("");

  if (r.headings.length > 0) {
    lines.push("## Headings (in document order)");
    lines.push("");
    for (const h of r.headings) lines.push(h);
    lines.push("");
  }

  if (r.bodyText) {
    lines.push("## Page copy");
    lines.push("");
    lines.push(r.bodyText);
    lines.push("");
  }

  if (r.links.length > 0) {
    lines.push("## Navigation / outbound links");
    lines.push("");
    for (const l of r.links.slice(0, 30)) {
      lines.push(`- [${l.text}](${l.href})`);
    }
    lines.push("");
  }

  if (r.colors.length > 0) {
    lines.push("## Colors observed in CSS/HTML");
    lines.push("");
    lines.push(
      "These hex values appear in the page's stylesheets or inline styles. They are likely (but not guaranteed) to be brand colors.",
    );
    lines.push("");
    for (const c of r.colors) lines.push(`- ${c}`);
    lines.push("");
  }

  if (r.fontFamilies.length > 0) {
    lines.push("## Font families observed in CSS");
    lines.push("");
    for (const f of r.fontFamilies) lines.push(`- ${f}`);
    lines.push("");
  }

  return lines.join("\n");
}
