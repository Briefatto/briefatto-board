import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { z } from "zod";
import { type Renderer } from "./render.js";

const size = { width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384) };
const entries = z.array(z.strictObject({
  file: z.string().min(1).regex(/\.(?:png|pdf)$/i),
  html: z.string().min(1).regex(/\.html?$/i),
  ...size,
  viewport: z.strictObject(size).optional(),
  transparent: z.boolean().optional(),
  fullPage: z.boolean().optional(),
  pageSizeMm: z.strictObject({ width: z.number().positive(), height: z.number().positive() }).optional(),
})).nonempty();

export type Deliverable = z.infer<typeof entries>[number];

function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function loadDeliverables(project: string): Deliverable[] | undefined {
  const manifest = join(project, "deliverables.json");
  if (!existsSync(manifest)) return undefined;
  const realProject = realpathSync(project);
  const files = new Set<string>();
  const path = (value: string) => {
    const absolute = resolve(project, value);
    if (isAbsolute(value) || !within(project, absolute) || (existsSync(absolute) && !within(realProject, realpathSync(absolute)))) {
      throw new Error(`Use a project-relative path inside the project for ${JSON.stringify(value)}.`);
    }
    return absolute;
  };
  try {
    const parsed = entries.safeParse(JSON.parse(readFileSync(manifest, "utf8").replace(/^\uFEFF/, "")));
    if (!parsed.success) throw new Error(parsed.error.issues.map(({ path, message }) => `${path.join(".") || "entries"} ${message}`).join("; "));
    return parsed.data.map((entry) => {
      const file = path(entry.file);
      const key = existsSync(file) ? realpathSync(file) : file;
      const identity = process.platform === "win32" ? key.toLowerCase() : key;
      if (files.has(identity)) throw new Error(`Duplicate deliverable ${JSON.stringify(entry.file)}.`);
      if ([relative(project, file), relative(realProject, key)].some((value) =>
        value.split(sep).some((part) => /^(?:\.board-previews|kit-sheet\.png)$/i.test(part)))) {
        throw new Error(`Choose a delivery path for ${JSON.stringify(entry.file)} outside Board's preview locations.`);
      }
      const pdf = extname(file).toLowerCase() === ".pdf";
      if ((pdf && (entry.transparent || entry.fullPage)) || (!pdf && entry.pageSizeMm)) {
        throw new Error(`${entry.file} uses options for another export type.`);
      }
      if (entry.width * entry.height > 64_000_000) throw new Error(`${entry.file} exceeds 64 million comparison pixels.`);
      files.add(identity);
      return { ...entry, file, html: path(entry.html) };
    });
  } catch (error) {
    throw new Error(`Invalid deliverables.json. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

const PDF_ORIGIN = "https://board-pdf.invalid/";
const PDF_ROOT = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

async function rasterPdf(renderer: Renderer, bytes: Buffer, entry: Deliverable): Promise<PNG> {
  const page = await renderer.newPage();
  try {
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (!url.startsWith(PDF_ORIGIN)) return route.abort();
      const name = new URL(url).pathname.slice(1);
      if (!name) return route.fulfill({ contentType: "text/html", body: "<!doctype html>" });
      if (name === "input.pdf") return route.fulfill({ contentType: "application/pdf", body: bytes });
      if (!/^(?:build\/pdf(?:\.worker)?\.mjs|(?:cmaps|standard_fonts|wasm)\/[\w.-]+)$/.test(name)) return route.abort();
      const contentType = name.endsWith(".mjs") ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
      return route.fulfill({ contentType, path: join(PDF_ROOT, name) });
    });
    await page.goto(PDF_ORIGIN);
    const base64 = await page.evaluate(async ({ origin, width, height, pageSizeMm }) => {
      const pdfjs: typeof import("pdfjs-dist") = await import(`${origin}build/pdf.mjs`);
      pdfjs.GlobalWorkerOptions.workerSrc = `${origin}build/pdf.worker.mjs`;
      const pdf = await pdfjs.getDocument({
        url: `${origin}input.pdf`, cMapUrl: `${origin}cmaps/`, standardFontDataUrl: `${origin}standard_fonts/`,
        wasmUrl: `${origin}wasm/`, stopAtErrors: true,
      }).promise;
      if (pdf.numPages !== 1) throw new Error(`Expected one PDF page, found ${pdf.numPages}.`);
      const sheet = await pdf.getPage(1);
      const units = sheet.getViewport({ scale: 1 });
      // PDF generators can round the page box. Allow at most one comparison pixel on either axis.
      const scale = Math.min(width / units.width, height / units.height);
      if (Math.abs(units.width * scale - width) > 1 || Math.abs(units.height * scale - height) > 1) {
        throw new Error(`PDF page aspect does not match ${width}x${height}.`);
      }
      if (pageSizeMm) {
        const mm = { width: units.width * 25.4 / 72, height: units.height * 25.4 / 72 };
        if (Math.abs(mm.width - pageSizeMm.width) > 0.1 || Math.abs(mm.height - pageSizeMm.height) > 0.1) {
          throw new Error(`PDF page is ${mm.width.toFixed(2)}x${mm.height.toFixed(2)} mm, expected ${pageSizeMm.width}x${pageSizeMm.height} mm.`);
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      await sheet.render({ canvas, viewport: sheet.getViewport({ scale }), background: "#fff" }).promise;
      return canvas.toDataURL("image/png").split(",")[1];
    }, { origin: PDF_ORIGIN, width: entry.width, height: entry.height, pageSizeMm: entry.pageSizeMm });
    return PNG.sync.read(Buffer.from(base64, "base64"));
  } finally {
    await page.close();
  }
}

async function renderHtml(renderer: Renderer, entry: Deliverable, pdf: boolean): Promise<PNG> {
  const viewport = entry.viewport ?? { width: entry.width, height: entry.height };
  const page = await renderer.newPage({ viewport, deviceScaleFactor: entry.width / viewport.width });
  const failedImages = new Set<string>();
  const output = pathToFileURL(realpathSync(entry.file)).href;
  let usesExport = false;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "file:" || url.host) return;
    try {
      const path = fileURLToPath(url);
      if (existsSync(path) && pathToFileURL(realpathSync(path)).href === output) usesExport = true;
    } catch { /* An invalid or unavailable file URL cannot supply the export. */ }
  });
  page.on("requestfailed", (request) => {
    if (request.resourceType() === "image") failedImages.add(request.url());
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && response.request().resourceType() === "image") failedImages.add(response.url());
  });
  try {
    if (pdf) await page.emulateMedia({ media: "print" });
    await page.goto(pathToFileURL(entry.html).href, { waitUntil: "networkidle", timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const unreadable = await page.evaluate(async (fullPage) => {
      const images = Array.from(document.images).filter((image) => {
        const box = image.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && (fullPage || (box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth));
      });
      const decoded = await Promise.allSettled(images.map((image) => image.decode()));
      return images.filter((_, i) => decoded[i].status === "rejected").map((image) => image.currentSrc || image.src);
    }, entry.fullPage);
    if (usesExport) throw new Error("Reference HTML loads the deliverable itself. Use its editable source.");
    const broken = [...new Set([...failedImages, ...unreadable])];
    if (broken.length) throw new Error(`Reference HTML has an unreadable image (${broken[0]}).`);
    return PNG.sync.read(await page.screenshot({ fullPage: entry.fullPage, omitBackground: entry.transparent, animations: "disabled" }));
  } finally {
    await page.close();
  }
}

// Ignore RGB under fully transparent pixels. Everywhere else, alpha and source colours both contribute.
function uniform(image: PNG): boolean {
  const { data } = image;
  for (let i = 4; i < data.length; i += 4) {
    if (data[i + 3] !== data[3] || (data[3] && (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]))) return false;
  }
  return true;
}

const TILE = 64;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_LIMIT = { channelThreshold: 0, meanLimit: 0, changedShareLimit: 0, tileMeanLimit: 0, registrationPx: 0 };
const PDF_LIMIT = { channelThreshold: 32, meanLimit: 2, changedShareLimit: 0.02, tileMeanLimit: 5, registrationPx: 1 };

function pixelDelta(a: Buffer, b: Buffer, i: number, j: number) {
  if (!a[i + 3] && !b[j + 3]) return 0;
  return Math.max(Math.abs(a[i + 3] - b[j + 3]), Math.abs(a[i] - b[j]),
    Math.abs(a[i + 1] - b[j + 1]), Math.abs(a[i + 2] - b[j + 2]));
}

// Nearby, matching ink can explain a rasterizer's edge placement. Test both directions to catch missing and extra ink.
function registeredDelta(a: Buffer, b: Buffer, i: number, x: number, y: number, width: number, height: number, delta: number) {
  let forward = delta, reverse = delta;
  for (let row = Math.max(0, y - 1); row <= Math.min(height - 1, y + 1); row++) {
    for (let col = Math.max(0, x - 1); col <= Math.min(width - 1, x + 1); col++) {
      const j = (row * width + col) * 4;
      forward = Math.min(forward, pixelDelta(a, b, i, j));
      reverse = Math.min(reverse, pixelDelta(a, b, j, i));
      if (!forward && !reverse) return 0;
    }
  }
  return Math.max(forward, reverse);
}

function compare(actual: PNG, expected: PNG, tolerance: typeof PNG_LIMIT) {
  let sum = 0;
  let changed = 0;
  const columns = Math.ceil(actual.width / TILE), rows = Math.ceil(actual.height / TILE);
  const tiles = new Float64Array(columns * rows);
  const a = actual.data, b = expected.data;
  for (let y = 0, i = 0; y < actual.height; y++) {
    const row = Math.floor(y / TILE) * columns;
    for (let x = 0; x < actual.width; x++, i += 4) {
      const delta = pixelDelta(a, b, i, i);
      if (!delta) continue;
      sum += delta;
      tiles[row + Math.floor(x / TILE)] += tolerance.registrationPx
        ? registeredDelta(a, b, i, x, y, actual.width, actual.height, delta) : delta;
      if (delta > tolerance.channelThreshold) changed++;
    }
  }
  let maxTileMean = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const area = Math.min(TILE, actual.width - x * TILE) * Math.min(TILE, actual.height - y * TILE);
      maxTileMean = Math.max(maxTileMean, tiles[y * columns + x] / area);
    }
  }
  const pixels = actual.width * actual.height;
  return { mean: sum / pixels, changedShare: changed / pixels, maxTileMean, tileSizePx: TILE };
}

export interface DeliverableCheck {
  file: string;
  html: string;
  kind: "png" | "pdf";
  width: number;
  height: number;
  pass: boolean;
  sha256?: string;
  checks: { ran: string[] };
  comparison?: ReturnType<typeof compare> & { tolerance: typeof PNG_LIMIT };
  detail?: string;
}

export async function checkDeliverables(renderer: Renderer, entries: Deliverable[]): Promise<DeliverableCheck[]> {
  const results: DeliverableCheck[] = [];
  for (const entry of entries) {
    const pdf = extname(entry.file).toLowerCase() === ".pdf";
    const { file, html, width, height } = entry;
    const result: DeliverableCheck = { file, html, width, height, kind: pdf ? "pdf" : "png", pass: false, checks: { ran: [] } };
    results.push(result);
    try {
      result.checks.ran.push("export decode and dimensions");
      if (!existsSync(file)) throw new Error("Export the listed file, then rerun the check.");
      const bytes = readFileSync(file);
      result.sha256 = createHash("sha256").update(bytes).digest("hex");
      if (!pdf) {
        if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Could not decode the PNG. Invalid or truncated header.");
        const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
        if (w !== width || h !== height) throw new Error(`Export is ${w}x${h}, expected ${width}x${height}.`);
      }
      const actual = pdf ? await rasterPdf(renderer, bytes, entry) : PNG.sync.read(bytes);
      result.checks.ran.push("export non-blank pixels");
      if (uniform(actual)) throw new Error("Export is blank (uniform or fully transparent).");
      result.checks.ran.push("HTML pixel comparison");
      const expected = await renderHtml(renderer, entry, pdf);
      if (expected.width !== width || expected.height !== height) throw new Error(`Reference HTML rendered at ${expected.width}x${expected.height}, expected ${width}x${height}.`);
      if (uniform(expected)) throw new Error("Reference HTML renders blank.");
      const tolerance = pdf ? PDF_LIMIT : PNG_LIMIT;
      const metrics = compare(actual, expected, tolerance);
      result.comparison = { ...metrics, tolerance };
      if (metrics.mean > tolerance.meanLimit || metrics.changedShare > tolerance.changedShareLimit || metrics.maxTileMean > tolerance.tileMeanLimit) {
        throw new Error(`Export pixels differ from the HTML render (mean ${metrics.mean.toFixed(3)}, ${(100 * metrics.changedShare).toFixed(3)}% above channel threshold ${tolerance.channelThreshold}, worst ${TILE}px tile mean ${metrics.maxTileMean.toFixed(3)}).`);
      }
      result.pass = true;
    } catch (error) {
      result.detail = (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0];
    }
  }
  return results;
}
