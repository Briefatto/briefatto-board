import { mkdirSync, mkdtempDisposableSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { launchChromium, Renderer, screenshotFullPage } from "./render.js";

interface Reference {
  note: string;
  source?: string;
  imageUrl?: string;
}

function sourceUrl(value: unknown): value is string {
  return typeof value === "string" && /^(https?|file):\/\//i.test(value) && URL.canParse(value);
}

export async function captureReference(project: string, url: string, image: string) {
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) {
    throw new Error("Reference capture needs an HTTP or HTTPS URL.");
  }
  if (/[<>:"/\\|?*\x00-\x1f]/.test(image) || !/\.png$/i.test(image) || /^sheet\.png$/i.test(image)) {
    throw new Error("Reference capture needs a PNG filename in refs/ other than sheet.png.");
  }
  const directory = resolve(project, "refs");
  mkdirSync(directory, { recursive: true });
  using temporary = mkdtempDisposableSync(join(directory, ".capture-"));
  const capture = join(temporary.path, "capture.png");
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const response = await page.goto(url, { waitUntil: "load" });
    if (!response?.ok()) throw new Error(`Reference page returned HTTP ${response?.status() ?? "no response"}.`);
    await page.screenshot({ path: capture, animations: "disabled" });
  } finally {
    await browser.close();
  }
  const output = join(directory, image);
  renameSync(capture, output);
  return output;
}

function inside(directory: string, path: string) {
  const local = relative(directory, path);
  return local !== "" && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function readReferences(directory: string): Reference[] {
  const manifest = join(directory, "manifest.json");
  const json = readFileSync(manifest, "utf8").replace(/^\uFEFF/, "");
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
