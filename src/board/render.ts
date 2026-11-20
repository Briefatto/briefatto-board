// Capture an HTML page in Chromium and collect the computed styles of visible elements.

import { chromium, type Browser, type Page } from "playwright";
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatById, type BoardFormat } from "./formats.js";

export interface Box { x: number; y: number; w: number; h: number }

export interface TextRun {
  text: string;
  family: string;
  /** The whole font-family list as written. */
  stack: string;
  loaded: boolean;
  size: number;
  weight: number;
  letterSpacingEm: number;
  lineHeight: number;
  transform: string;
  italic: boolean;
  align: string;
  color: string;
  box: Box;
  clipped: boolean;
  /** Indices of text runs whose element contains this one (a <strong> inside a <p>). */
  within: number[];
}

export interface ColourUse { value: string; kind: "text" | "bg" | "border" | "fill" | "stroke" | "gradient" | "shadow"; area: number }

export interface ImageUse { box: Box; fit: string; filter: string; radius: number; src: string }

export interface Drawn {
  width: number;
  height: number;
  texts: TextRun[];
  colours: ColourUse[];
  radii: Array<{ px: number; full: boolean }>;
  images: ImageUse[];
  shadows: number;
  fontLinks: string[];
  fontFaces?: string[];
  /** Additional computed styles that the visual metrics do not consume. */
  designStyles?: { colours: string[]; stacks: string[]; sizes: number[] };
  siteStyles?: { title: string; variables: Record<string, string> };
  /** Elements marked data-device: the brand's one recurring graphic device. */
  devices: Array<{ box: Box; colours: string[]; radius: number; tag: string }>;
  /** The composition family the page says it follows (<meta name="board-family">), if any. */
  family: string | null;
}

export interface Rendered extends Drawn {
  png: string;
  /** WCAG 2.x contrast of each text run against the median of a ring of pixels around it (null when the ring is empty). */
  contrast: Array<number | null>;
}

export interface WebsiteRender {
  source: string;
  viewport: { width: number; height: number };
  captureHtml?: (html: string) => void;
}

/** Runs inside the page. Must stay self-contained (it is serialised by Playwright). */
function readPage(canvas: { width: number; height: number; collectDesignStyles: boolean; website: boolean }): Drawn {
  const W = canvas.width, H = canvas.height;
  const inter = (r: DOMRect) => {
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(W, r.right), y1 = Math.min(H, r.bottom);
    return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
  };
  const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "-apple-system", "blinkmacsystemfont", "emoji", "math"]);
  const ctx = document.createElement("canvas").getContext("2d")!;
  const probe = "mmmmmmmmmmlli1WQ@#&gy";
  const loadedCache = new Map<string, boolean>();
  const fontLoaded = (fam: string) => {
    if (generic.has(fam.toLowerCase())) return true;
    if (loadedCache.has(fam)) return loadedCache.get(fam)!;
    let ok = false;
    for (const fb of ["monospace", "serif", "sans-serif"]) {
      ctx.font = `72px ${fb}`;
      const w0 = ctx.measureText(probe).width;
      ctx.font = `72px "${fam}", ${fb}`;
      if (Math.abs(ctx.measureText(probe).width - w0) > 0.01) { ok = true; break; }
    }
    loadedCache.set(fam, ok);
    return ok;
  };
  const out: Drawn = { width: W, height: H, texts: [], colours: [], radii: [], images: [], shadows: 0, fontLinks: [], devices: [], family: document.querySelector('meta[name="board-family"]')?.getAttribute("content") ?? null };
  if (canvas.website) {
    const variables = new Map<string, string>();
    for (const element of [document.documentElement, document.body]) {
      const css = getComputedStyle(element);
      for (const name of Array.from(css).filter((name) => name.startsWith("--"))) {
        variables.set(name, css.getPropertyValue(name).trim());
      }
    }
    out.siteStyles = { title: document.title, variables: Object.fromEntries(variables) };
  }
  const styles = { colours: new Set<string>(), stacks: new Set<string>(), sizes: new Set<number>() };
  const cssColours = /(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([^()]*\)/g;
  const recordStyleColours = (...values: string[]) => {
    for (const value of values) for (const colour of value.match(cssColours) ?? []) styles.colours.add(colour);
  };
  const transparent = (c: string) => !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
  const rootBgs = [document.documentElement, document.body].map((e) => getComputedStyle(e).backgroundColor).filter((c) => !transparent(c));
  for (const c of rootBgs) out.colours.push({ value: c, kind: "bg", area: W * H });
  const els = Array.from(document.body.querySelectorAll("*"));
  if (canvas.collectDesignStyles) els.unshift(document.documentElement, document.body);
  const runOf = new Map<Element, number>();
  for (const el of els) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "link", "meta", "head", "title", "noscript"].includes(tag)) continue;
    const r = el.getBoundingClientRect();
    const area = inter(r);
    if (canvas.collectDesignStyles) {
      if (el instanceof SVGGeometryElement && cs.stroke !== "none" && parseFloat(cs.strokeWidth) > 0) {
        // Horizontal and vertical SVG rules paint even when their geometry has a zero-area box.
        const halfStroke = parseFloat(cs.strokeWidth) / 2;
        const painted = new DOMRect(r.x - halfStroke, r.y - halfStroke, r.width + halfStroke * 2, r.height + halfStroke * 2);
        if (inter(painted)) recordStyleColours(cs.stroke);
      }
      // SVG stops have no box of their own. Their computed colour supplies painted gradient stops.
      if (tag === "stop") recordStyleColours(cs.stopColor);
      if (area > 0) {
        if (el === document.body && Array.from(el.childNodes).some((node) => node.nodeType === 3 && node.textContent?.trim())) {
          styles.stacks.add(cs.fontFamily);
          styles.sizes.add(parseFloat(cs.fontSize));
          recordStyleColours(cs.color);
        }
        if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) recordStyleColours(cs.outlineColor);
        if (cs.textDecorationLine !== "none") recordStyleColours(cs.textDecorationColor);
        recordStyleColours(cs.textShadow, cs.boxShadow, cs.backgroundImage);
        for (const pseudo of ["::before", "::after"]) {
          const style = getComputedStyle(el, pseudo);
          if (style.content === "none" || style.content === "normal" || style.display === "none" || style.visibility === "hidden") continue;
          recordStyleColours(style.backgroundColor, style.backgroundImage);
          for (const side of ["top", "right", "bottom", "left"]) {
            if (parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0) recordStyleColours(style.getPropertyValue(`border-${side}-color`));
          }
          if (style.content !== '""' && !style.content.startsWith("url(")) {
            styles.stacks.add(style.fontFamily);
            styles.sizes.add(parseFloat(style.fontSize));
            recordStyleColours(style.color);
          }
        }
      }
    }
    if (el === document.documentElement || el === document.body) continue;
    if (area === 0) continue;
    if (!transparent(cs.backgroundColor)) out.colours.push({ value: cs.backgroundColor, kind: "bg", area });
    const bgi = cs.backgroundImage;
    if (bgi && bgi !== "none") {
      for (const m of bgi.match(/(rgba?|oklch|oklab|lab|lch|hsla?|color)\([^()]*\)/g) ?? []) if (!transparent(m)) out.colours.push({ value: m, kind: "gradient", area });
      const u = bgi.match(/url\("?([^")]+)"?\)/);
      if (u) out.images.push({ box: { x: r.left, y: r.top, w: r.width, h: r.height }, fit: cs.backgroundSize, filter: cs.filter, radius: parseFloat(cs.borderTopLeftRadius) || 0, src: u[1] });
    }
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      const w = parseFloat((cs as any)[`border${side}Width`]);
      const st = (cs as any)[`border${side}Style`];
      const c = (cs as any)[`border${side}Color`];
      if (w > 0 && st !== "none" && !transparent(c)) out.colours.push({ value: c, kind: "border", area: Math.max(r.width, r.height) * w });
    }
    if (cs.boxShadow && cs.boxShadow !== "none") {
      out.shadows++;
      for (const m of cs.boxShadow.match(/(rgba?|oklch|lab|hsla?)\([^()]*\)/g) ?? []) if (!transparent(m)) out.colours.push({ value: m, kind: "shadow", area: 0 });
    }
    const rad = parseFloat(cs.borderTopLeftRadius) || 0;
    if (rad > 0) out.radii.push({ px: Math.round(rad * 10) / 10, full: rad >= Math.min(r.width, r.height) / 2 - 0.5 });
    if (el instanceof SVGElement && tag !== "svg") {
      if (cs.fill && cs.fill !== "none" && !cs.fill.startsWith("url") && !transparent(cs.fill)) out.colours.push({ value: cs.fill, kind: "fill", area });
      if (cs.stroke && cs.stroke !== "none" && !cs.stroke.startsWith("url") && !transparent(cs.stroke)) out.colours.push({ value: cs.stroke, kind: "stroke", area: 0 });
    }
    if (["img", "video", "canvas", "picture"].includes(tag)) {
      out.images.push({ box: { x: r.left, y: r.top, w: r.width, h: r.height }, fit: cs.objectFit, filter: cs.filter, radius: rad, src: (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || tag });
    }
    const textNodes = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
    if (textNodes.length) {
      const range = document.createRange();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of textNodes) {
        range.selectNodeContents(n);
        // Limit fragment height to its line height or font size before testing for overlap.
        const fs = parseFloat(cs.fontSize);
        const lineH = cs.lineHeight === "normal" ? Infinity : parseFloat(cs.lineHeight);
        for (const rr of Array.from(range.getClientRects())) {
          if (rr.width === 0 || rr.height === 0) continue;
          const half = Math.min(rr.height, Math.max(lineH, fs)) / 2, cy = rr.top + rr.height / 2;
          x0 = Math.min(x0, rr.left); y0 = Math.min(y0, cy - half); x1 = Math.max(x1, rr.right); y1 = Math.max(y1, cy + half);
        }
      }
      if (x1 > x0) {
        const stack = cs.fontFamily;
        const family = stack.split(",")[0].trim().replace(/^["']|["']$/g, "");
        const size = parseFloat(cs.fontSize);
        const ls = cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing) / size;
        const lh = cs.lineHeight === "normal" ? 1.2 : parseFloat(cs.lineHeight) / size;
        // Clipped: an ancestor (or the element) hides overflow and the text extends past it.
        let clipped = false;
        for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
          const acs = getComputedStyle(a);
          if (/(hidden|clip)/.test(acs.overflow + acs.overflowX + acs.overflowY)) {
            const ar = a.getBoundingClientRect();
            if (x0 < ar.left - 1 || x1 > ar.right + 1 || y0 < ar.top - 1 || y1 > ar.bottom + 1) { clipped = true; break; }
          }
        }
        const text = textNodes.map((n) => n.textContent!.trim()).join(" ").replace(/\s+/g, " ");
        const within: number[] = [];
        for (let a = el.parentElement; a; a = a.parentElement) if (runOf.has(a)) within.push(runOf.get(a)!);
        runOf.set(el, out.texts.length);
        out.texts.push({ within, text, family, stack, loaded: fontLoaded(family), size, weight: parseInt(cs.fontWeight, 10), letterSpacingEm: Math.round(ls * 1000) / 1000, lineHeight: Math.round(lh * 100) / 100, transform: cs.textTransform, italic: cs.fontStyle !== "normal", align: cs.textAlign, color: cs.color, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, clipped });
        out.colours.push({ value: cs.color, kind: "text", area: (x1 - x0) * (y1 - y0) });
      }
    }
  }
  for (const d of Array.from(document.querySelectorAll("[data-device]"))) {
    const r = d.getBoundingClientRect();
    if (!inter(r)) continue;
    const cols = new Set<string>();
    for (const e of [d, ...Array.from(d.querySelectorAll("*"))]) {
      const cs = getComputedStyle(e);
      for (const c of [cs.backgroundColor, cs.color, cs.fill, cs.stroke, cs.borderTopColor]) if (c && !transparent(c) && !c.startsWith("url") && c !== "none") cols.add(c);
    }
    out.devices.push({ box: { x: r.left, y: r.top, w: r.width, h: r.height }, colours: [...cols], radius: parseFloat(getComputedStyle(d).borderTopLeftRadius) || 0, tag: d.tagName.toLowerCase() });
  }
  for (const l of Array.from(document.querySelectorAll('link[rel~="stylesheet"]'))) {
    const h = (l as HTMLLinkElement).href;
    if (/fonts\.(googleapis|bunny)|fontshare|typekit|fonts\.cdnfonts/.test(h)) out.fontLinks.push(h);
  }
  for (const s of Array.from(document.querySelectorAll("style"))) {
    for (const m of (s.textContent ?? "").matchAll(/@import\s+(?:url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])/g)) {
      const url = new URL(m[1] ?? m[2], document.baseURI);
      if (url.protocol === "https:" || url.protocol === "http:") out.fontLinks.push(url.href);
    }
  }
  const readFontFaces = (sheet: CSSStyleSheet) => {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // Preserve the exact link for cross-origin stylesheets whose CSSOM is unavailable.
      if (sheet.href && /^https?:\/\//i.test(sheet.href)) out.fontLinks.push(sheet.href);
      return;
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSImportRule && rule.styleSheet) readFontFaces(rule.styleSheet);
      if (rule instanceof CSSFontFaceRule) {
        const face = rule.cssText.replace(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/g, (_, quoted, single, plain) => {
          const url = new URL(quoted ?? single ?? plain.trim(), sheet.href ?? document.baseURI);
          return `url(${JSON.stringify(url.href)})`;
        });
        (out.fontFaces ??= []).push(face);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) readFontFaces(sheet);
  if (canvas.collectDesignStyles) out.designStyles = { colours: [...styles.colours], stacks: [...styles.stacks], sizes: [...styles.sizes] };
  return out;
}

const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function parseRgb(css: string): [number, number, number, number] | null {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

/** WCAG 2.x contrast of each text run against the median colour of a 1 px ring drawn 2 px outside its box
 * (2 px keeps the ring clear of the glyphs' anti-aliasing). */
function contrasts(png: PNG, texts: TextRun[]): Array<number | null> {
  return texts.map((t) => {
    const c = parseRgb(t.color);
    if (!c) return null;
    const x0 = Math.floor(t.box.x) - 2, y0 = Math.floor(t.box.y) - 2, x1 = Math.ceil(t.box.x + t.box.w) + 2, y1 = Math.ceil(t.box.y + t.box.h) + 2;
    const ls: number[] = [];
    const at = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
      const i = (y * png.width + x) * 4;
      ls.push(lum(png.data[i], png.data[i + 1], png.data[i + 2]));
    };
    for (let x = x0; x <= x1; x++) { at(x, y0); at(x, y1); }
    for (let y = y0; y <= y1; y++) { at(x0, y); at(x1, y); }
    if (!ls.length) return null;
    ls.sort((a, b) => a - b);
    const bg = ls[Math.floor(ls.length / 2)];
    const fg = lum(c[0], c[1], c[2]);
    const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  });
}

export class MissingChromiumError extends Error {
  constructor(cause: Error) {
    const { version } = createRequire(import.meta.url)("playwright/package.json");
    super(`Playwright Chromium is missing. Run: npx --yes playwright@${version} install chromium`, { cause });
  }
}

export async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Executable doesn't exist at ")) {
      throw new MissingChromiumError(error);
    }
    throw error;
  }
}

export class Renderer {
  private browser?: Browser;
  async open() { this.browser ??= await launchChromium(); return this; }
  async close() { await this.browser?.close(); this.browser = undefined; }

  /** Resolve CSS colour literals using the same serialization as the sample's computed styles. */
  async normalizeColours(values: string[]): Promise<string[]> {
    if (!values.length) return [];
    await this.open();
    const page = await this.browser!.newPage();
    try {
      return await page.evaluate((colours) => colours.map((colour) => {
        const element = document.body;
        element.style.color = "";
        element.style.color = colour;
        return element.style.color ? getComputedStyle(element).color : "";
      }), values);
    } finally {
      await page.close();
    }
  }

  /** Render at the format's size, or capture the full page at the website viewport when no format is specified. */
  async render(htmlPath: string, fmt: BoardFormat | undefined, pngPath = htmlPath.replace(/\.html?$/i, ".png"), collectDesignStyles = false, localAssets?: Set<string>, website?: WebsiteRender, inspect?: (page: Page) => Promise<void>): Promise<Rendered> {
    await this.open();
    const viewport = website?.viewport ?? fmt ?? formatById("hero");
    const { width } = viewport;
    const ctx = await this.browser!.newContext({ viewport: { width, height: viewport.height }, deviceScaleFactor: 1 });
    // tsx/esbuild wraps named functions in __name(); give the page a no-op so readPage can be serialised.
    await ctx.addInitScript("window.__name = (f) => f;");
    const page = await ctx.newPage();
    const source = website?.source ?? pathToFileURL(htmlPath).href;
    if (localAssets) page.on("request", (request) => {
      if (request.url() === source) return;
      const url = new URL(request.url());
      if (url.protocol !== "file:" || url.host) return;
      try {
        localAssets.add(fileURLToPath(url));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_INVALID_FILE_URL_PATH") throw error;
      }
    });
    try {
      const response = await page.goto(source, { waitUntil: website ? "load" : "networkidle", timeout: 60_000 });
      if (website && response && !response.ok()) throw new Error(`${source} returned HTTP ${response.status()}.`);
      if (website) {
        // Allow client-rendered content to settle without requiring polling apps to go idle.
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch((error) => {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
        });
      }
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      if (website?.captureHtml) website.captureHtml(await page.content());
      await inspect?.(page);
      const height = fmt?.height ?? await page.evaluate(() => Math.max(innerHeight, document.scrollingElement!.scrollHeight));
      const drawn = await page.evaluate(readPage, { width, height, collectDesignStyles, website: website !== undefined });
      const buf = await page.screenshot({ fullPage: !fmt, clip: { x: 0, y: 0, width, height } });
      writeFileSync(pngPath, buf);
      const png = PNG.sync.read(buf);
      return { ...drawn, png: pngPath, contrast: contrasts(png, drawn.texts) };
    } finally {
      await ctx.close();
    }
  }
}

/** Screenshot a whole page (contact sheets) at a fixed width. */
export async function screenshotFullPage(renderer: Renderer, htmlPath: string, pngPath: string, width: number, options: { verifyImages?: boolean } = {}) {
  await renderer.open();
  const ctx = await (renderer as any).browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle", timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (options.verifyImages) {
      const unreadable = await page.evaluate(async () => {
        const images = Array.from(document.images);
        const decoded = await Promise.allSettled(images.map((image) => image.decode()));
        return images.filter((_, index) => decoded[index].status === "rejected").map((image) => image.src);
      });
      if (unreadable.length) throw new Error(`Could not decode image: ${unreadable.join(", ")}`);
    }
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await ctx.close();
  }
}

export function readHtml(path: string) { return readFileSync(path, "utf8"); }
