import { mkdirSync, mkdtempDisposableSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Page, Request } from "playwright";
import { launchChromium, Renderer, screenshotFullPage } from "./render.js";

interface Reference {
  note: string;
  source?: string;
  imageUrl?: string;
}

function sourceUrl(value: unknown): value is string {
  return typeof value === "string" && /^(https?|file):\/\//i.test(value) && URL.canParse(value);
}

interface CaptureRequest {
  url: string;
  image: string;
}

type CaptureResult = { url: string; output: string; warnings: string[] } | { url: string; error: string };

function hideCaptureOverlays() {
  for (const element of document.querySelectorAll<HTMLElement>("*")) {
    const { position } = getComputedStyle(element);
    if (position !== "fixed" && position !== "sticky") continue;
    const name = `${element.id} ${element.getAttribute("class") ?? ""} ${element.getAttribute("aria-label") ?? ""}`;
    const cookiePrompt = /cookie|consent|onetrust/i.test(name) ||
      (element.matches('dialog, [role="dialog"], [aria-modal="true"]') && /\bcookies?\b/i.test(element.textContent ?? ""));
    const header = element.matches('header, nav, [role="banner"], [role="navigation"]') ||
      /(?:^|[\s_-])(?:header|navbar)(?:$|[\s_-])/i.test(name);
    if (cookiePrompt || header) element.style.setProperty("display", "none", "important");
  }
}

function captureQuality() {
  const chromeSelector = 'header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"], [role="toolbar"]';
  function chromeOf(element: Element) {
    const chrome = element.closest(chromeSelector);
    if (chrome?.matches('header:not([role]), footer:not([role])') && chrome.closest('main, article, section')) return null;
    return chrome;
  }

  function visibleBounds(element: Element) {
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return undefined;
    return inViewport(element.getBoundingClientRect());
  }

  function inViewport(rect: DOMRect) {
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right);
    const bottom = Math.min(innerHeight, rect.bottom);
    return right > left && bottom > top ? { left, top, right, bottom } : undefined;
  }

  type Bounds = NonNullable<ReturnType<typeof inViewport>>;
  const chrome: Bounds[] = [];
  const content: Bounds[] = [];

  // Sweep the rectangle edges so overlapping boxes count once and empty gaps stay empty.
  function coveredArea(rectangles: Bounds[]) {
    const edges = [...new Set(rectangles.flatMap(({ left, right }) => [left, right]))].sort((a, b) => a - b);
    let area = 0;
    for (let index = 1; index < edges.length; index++) {
      const left = edges[index - 1];
      const right = edges[index];
      const spans = rectangles.filter((rect) => rect.left <= left && rect.right >= right).sort((a, b) => a.top - b.top);
      let bottom = 0;
      for (const span of spans) {
        area += (right - left) * Math.max(0, span.bottom - Math.max(span.top, bottom));
        bottom = Math.max(bottom, span.bottom);
      }
    }
    return area;
  }

  const undecodedImages = Array.from(document.images).filter((image) => visibleBounds(image) && !image.naturalWidth).length;
  for (const element of document.querySelectorAll("*")) {
    const bounds = visibleBounds(element);
    if (!bounds) continue;
    const landmark = chromeOf(element);
    if (landmark) {
      if (landmark === element) chrome.push(bounds);
    } else if ((element instanceof HTMLImageElement && element.naturalWidth) ||
      (element instanceof HTMLVideoElement && element.readyState >= element.HAVE_CURRENT_DATA) ||
      element instanceof SVGGeometryElement || element instanceof SVGUseElement) {
      // An iframe, canvas or CSS background box can exist without any artwork inside it.
      content.push(bounds);
    }
  }

  const text = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = text.nextNode(); node; node = text.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim() || chromeOf(parent) ||
        !parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    range.selectNode(node);
    for (const rect of range.getClientRects()) {
      const bounds = inViewport(rect);
      if (bounds) content.push(bounds);
    }
  }

  const halfViewport = innerWidth * innerHeight / 2;
  const contentArea = coveredArea(content);
  const chromeCoverage = coveredArea(chrome);
  return {
    mostlyChrome: chromeCoverage > halfViewport || (contentArea === 0 && chromeCoverage > 0),
    // Text bounds are tight. A legible headline or code example can occupy very
    // little of an intentional layout, so warn only when visible content is negligible.
    mostlyEmpty: contentArea < innerWidth * innerHeight * 0.02,
    undecodedImages,
  };
}

async function capturePage(page: Page, url: string, path: string) {
  const pending = new Set<Request>();
  let lastActivity = Date.now();
  page.on("request", (request) => { pending.add(request); lastActivity = Date.now(); });
  const finish = (request: Request) => { pending.delete(request); lastActivity = Date.now(); };
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);

  // Recheck activity after scrolling. Playwright's networkidle load state can already
  // have fired during navigation. Use its 500 ms idle interval and the site renderer's 3 s wait.
  async function waitForIdle() {
    const idleInterval = 500;
    const deadline = Date.now() + 3_000;
    lastActivity = Date.now();
    while (Date.now() < deadline) {
      await delay(idleInterval);
      if (pending.size === 0 && Date.now() - lastActivity >= idleInterval) return true;
    }
    return false;
  }

  const response = await page.goto(url, { waitUntil: "load" });
  if (!response?.ok()) throw new Error(`Reference page returned HTTP ${response?.status() ?? "no response"}.`);
  await page.evaluate(hideCaptureOverlays);
  const origin = await page.evaluate(() => {
    const left = scrollX, top = scrollY;
    const bottom = (document.scrollingElement?.scrollHeight ?? innerHeight) - innerHeight;
    const step = Math.min(top + innerHeight, bottom);
    window.scrollTo({ left, top: step > top ? step : Math.max(0, top - innerHeight), behavior: "instant" });
    return { left, top };
  });
  const scrolledIdle = await waitForIdle();
  await page.evaluate(hideCaptureOverlays);
  await page.evaluate((position) => window.scrollTo({ ...position, behavior: "instant" }), origin);
  const captureIdle = await waitForIdle();
  const quality = await page.evaluate(captureQuality);
  await page.screenshot({ path, animations: "disabled" });

  const warnings: string[] = [];
  if (!scrolledIdle || !captureIdle) warnings.push("Page requests did not settle. Inspect the capture and retake it if images or styles are missing.");
  if (quality.mostlyChrome) warnings.push("Capture is mostly page chrome. Retake it at the intended content or pick another source.");
  else if (quality.mostlyEmpty) warnings.push("Capture is mostly empty. Retake it at the intended content or pick another source.");
  if (quality.undecodedImages) warnings.push(`${quality.undecodedImages} visible image(s) did not load. Retake the capture or pick another source.`);
  return warnings;
}

export async function captureReferences(project: string, captures: CaptureRequest[]): Promise<CaptureResult[]> {
  if (!captures.length) throw new Error("Provide at least one URL and PNG filename to capture.");
  const seen = new Set<string>();
  for (const { url, image } of captures) {
    if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) {
      throw new Error("Reference capture needs an HTTP or HTTPS URL.");
    }
    if (/[<>:"/\\|?*\x00-\x1f]/.test(image) || !/\.png$/i.test(image) || /^sheet\.png$/i.test(image)) {
      throw new Error("Reference capture needs a PNG filename in refs/ other than sheet.png.");
    }
    const name = image.toLowerCase();
    if (seen.has(name)) throw new Error(`Reference capture filename ${image} is listed more than once.`);
    seen.add(name);
  }

  const directory = resolve(project, "refs");
  mkdirSync(directory, { recursive: true });
  using temporary = mkdtempDisposableSync(join(directory, ".capture-"));
  const path = join(temporary.path, "capture.png");
  const browser = await launchChromium();
  const results: CaptureResult[] = [];
  try {
    for (const { url, image } of captures) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      try {
        const warnings = await capturePage(page, url, path);
        const output = join(directory, image);
        renameSync(path, output);
        results.push({ url, output, warnings });
      } catch (error) {
        results.push({ url, error: error instanceof Error ? error.message : String(error) });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

function inside(directory: string, path: string) {
  const local = relative(directory, path);
  return local !== "" && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function readReferences(directory: string): Reference[] {
  const manifest = join(directory, "manifest.json");
  let json: string;
  try {
    json = readFileSync(manifest, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error("Create refs/manifest.json with your references, then run board refs .");
  }
  let entries: unknown;
  try {
    entries = JSON.parse(json);
  } catch (error) {
    throw new Error(`${manifest} is not valid JSON.`, { cause: error });
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${manifest} must contain a non-empty array of references.`);
  }
  const realDirectory = realpathSync(directory);
  return entries.map((entry, index) => {
    const label = `Reference ${index + 1} in ${manifest}`;
    if (!entry || typeof entry !== "object" || typeof entry.note !== "string" || !entry.note.trim() || /[\r\n]/.test(entry.note)) {
      throw new Error(`${label} needs a one-line note.`);
    }
    if ((entry.image !== undefined || entry.source !== undefined) && !sourceUrl(entry.source)) {
      throw new Error(`${label} needs a source URL (http:, https:, or file:).`);
    }
    if (entry.image === undefined) return { note: entry.note, source: entry.source };
    if (typeof entry.image !== "string" || !entry.image.trim() || isAbsolute(entry.image)) {
      throw new Error(`${label} needs an image path relative to refs/.`);
    }
    const path = resolve(directory, entry.image);
    if (!inside(directory, path) || path === join(directory, "sheet.png")) {
      throw new Error(`${label} needs an image inside refs/ other than the generated sheet.`);
    }
    const realPath = realpathSync(path);
    if (!inside(realDirectory, realPath) || !statSync(realPath).isFile() || relative(realPath, join(realDirectory, "sheet.png")) === "") {
      throw new Error(`${label} needs an image file inside refs/.`);
    }
    return { note: entry.note, source: entry.source, imageUrl: pathToFileURL(realPath).href };
  });
}

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function referenceSheetHtml(references: Reference[]) {
  const cards = references.map(({ note, source, imageUrl }, index) => `
<li>
  <div class="number">${index + 1}</div>
  ${imageUrl ? `<img alt="" src="${escapeHtml(imageUrl)}">` : '<div class="fallback">Text-only fallback</div>'}
  <div class="${imageUrl ? "caption" : "words"}">${escapeHtml(note)}</div>
  ${source ? `<div class="source">${escapeHtml(source)}</div>` : ""}
</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'">
<title>References</title><style>
body{margin:0;padding:32px;background:#efefed;color:#161616;font:20px/1.4 system-ui,sans-serif}
h1{margin:0 0 20px;font-size:34px}
ol{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(${Math.min(references.length, 2)},minmax(0,1fr));gap:20px;align-items:start}
li{min-width:0;padding:16px;background:white;overflow-wrap:anywhere}
.number{margin-bottom:8px;font-size:28px;font-weight:700}
img{display:block;width:100%;height:380px;object-fit:contain;background:#f4f4f2}
.caption,.source,.words{margin-top:10px}.source,.fallback{font-size:16px}.words{font-size:26px}
.fallback{font-weight:650}
</style></head><body><h1>References</h1><ol>${cards}</ol></body></html>`;
}

export async function writeReferenceSheet(project: string) {
  const directory = resolve(project, "refs");
  const references = readReferences(directory);
  const output = join(directory, "sheet.png");
  using temporary = mkdtempDisposableSync(join(directory, ".sheet-"));
  const html = join(temporary.path, "sheet.html");
  const png = join(temporary.path, "sheet.png");
  writeFileSync(html, referenceSheetHtml(references));
  const renderer = new Renderer();
  try {
    await screenshotFullPage(renderer, html, png, Math.min(references.length, 2) * 650 + 64, { verifyImages: true });
  } finally {
    await renderer.close();
  }
  renameSync(png, output);
  return output;
}
