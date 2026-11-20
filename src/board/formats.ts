// Built-in canvases and optional project canvases from formats.json. Each piece is an HTML page at its canvas size.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

export interface BoardFormat {
  id: string;
  label: string;
  width: number;
  height: number;
  /** Where the size comes from. */
  source: string;
  /** Width in CSS px at which people see it: a phone feed or story is about 390 px wide (iPhone 12 to 16 viewport);
   * the banner and the website hero are seen at their native size. */
  seenWidth: number;
}

/** Apple Human Interface Guidelines: 11 pt is the smallest text size; on iOS 1 pt = 1 CSS px. */
export const MIN_SEEN_TEXT_PX = 11;

/** Body copy (the brief's running text) at the platform's default reading size where the piece is seen: Apple HIG
 * Dynamic Type default Body 17 pt for pieces seen on a phone; the CSS default font size (HTML rendering, "medium"
 * = 16 px) for pieces seen at native size on the web (the website hero, the 300x250 banner). */
export const BODY_SEEN_PHONE_PX = 17;
export const BODY_SEEN_WEB_PX = 16;
export function bodyTextPx(f: BoardFormat): number {
  const seen = f.seenWidth === f.width ? BODY_SEEN_WEB_PX : BODY_SEEN_PHONE_PX;
  return Math.ceil((seen * f.width) / f.seenWidth);
}

/** The smallest font size (canvas px) that is still at least MIN_SEEN_TEXT_PX where the piece is seen. */
export function minTextPx(f: BoardFormat): number {
  return Math.ceil((MIN_SEEN_TEXT_PX * f.width) / f.seenWidth);
}

export const FORMATS: BoardFormat[] = [
  { id: "hero", label: "Website hero", width: 1440, height: 900, source: "first screen of a 1440x900 laptop viewport", seenWidth: 1440 },
  { id: "post", label: "Square post 1080x1080", width: 1080, height: 1080, source: "Instagram / LinkedIn square feed image", seenWidth: 390 },
  { id: "story", label: "Story 1080x1920", width: 1080, height: 1920, source: "Instagram / TikTok story, 9:16", seenWidth: 390 },
  { id: "link", label: "Link ad 1200x628", width: 1200, height: 628, source: "Facebook / LinkedIn link-ad image", seenWidth: 390 },
  { id: "mrec", label: "Banner 300x250", width: 300, height: 250, source: "IAB medium rectangle", seenWidth: 300 },
  { id: "poster", label: "A4 poster", width: 1240, height: 1754, source: "ISO 216 A4 (210x297 mm) at 150 dpi", seenWidth: 390 },
  { id: "og", label: "OG image 1200x630", width: 1200, height: 630, source: "Open Graph share image", seenWidth: 390 },
];

export const KIT_IDS = FORMATS.map((f) => f.id);

const projectFormatsSchema = z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).refine((id) => id !== "kit-sheet"),
  label: z.string().trim().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  seenWidth: z.number().int().positive(),
  source: z.string().trim().min(1),
}).refine((f) => f.seenWidth <= f.width, "seenWidth must be at most width"))
  .nonempty().refine((formats) => new Set(formats.map((f) => f.id)).size === formats.length, "format ids must be unique");

export function loadProjectFormats(project: string): BoardFormat[] {
  const path = join(project, "formats.json");
  if (!existsSync(path)) return FORMATS;
  try {
    return projectFormatsSchema.parse(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")));
  } catch (error) {
    throw new Error(`Invalid board formats in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Find a piece's project without depending on the shell's working directory. */
export function findProjectFormats(file: string): BoardFormat[] {
  let dir = dirname(resolve(file));
  while (true) {
    if (existsSync(join(dir, "formats.json"))) return loadProjectFormats(dir);
    const parent = dirname(dir);
    if (parent === dir || existsSync(join(dir, "brief.md"))) return FORMATS;
    dir = parent;
  }
}

function outputFormat(base: string, formats: BoardFormat[]): BoardFormat | undefined {
  return formats.find((f) => base === f.id) ?? formats.filter((f) => base.endsWith(`-${f.id}`))
    .sort((a, b) => b.id.length - a.id.length)[0];
}

export function isFormatFile(file: string, formats = FORMATS): boolean {
  return /\.html?$/i.test(file) && outputFormat(basename(file).replace(/\.html?$/i, ""), formats) !== undefined;
}

export function formatFiles(dir: string, { namedOutputs = false, formats = FORMATS } = {}): string[] {
  const ids = new Set(formats.map((f) => f.id));
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
    .filter((entry) => namedOutputs ? isFormatFile(entry.name, formats) : ids.has(entry.name.replace(/\.html?$/i, "")))
    .map((entry) => join(dir, entry.name))
    .sort();
}

export function formatById(id: string, formats = FORMATS): BoardFormat {
  const f = formats.find((x) => x.id === id);
  if (!f) throw new Error(`unknown format "${id}"; known: ${formats.map((f) => f.id).join(", ")}`);
  return f;
}

/** Both `post.html` and `march-post.html` are drawn at the post size. */
export function formatOfFile(path: string, formats = FORMATS): BoardFormat {
  const base = path.replace(/\\/g, "/").split("/").pop()!.replace(/\.html?$/i, "");
  const prefix = base.split(".")[0];
  return formats.find((f) => f.id === prefix) ?? outputFormat(base, formats) ?? formatById(prefix, formats);
}
