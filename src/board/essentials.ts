// What a brief requires its campaign pieces to carry: requested strings (call to action, price or date, URL or address) and
// the body copy, plus the brief's own assets (product photos, logo). These are the brief's words and files, so a
// program can prove them: a requested string is in the piece's visible text or it is not.
//
// Source: `essentials.json` in the project when the agent wrote one; otherwise read from the brief's copy list
// ("- Call to action: ...", "- URL: ...", "- Subline: ...", a price such as "EUR 9" in the subline or details).

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type AssetOrigin = "brief" | "client" | "legacy";

export interface Essentials {
  /** Strings every piece must show verbatim, allowing layout whitespace. URL-like strings are not required on the website hero. */
  required: string[];
  /** Extra literal requirements for an individual format. */
  requiredByFormat?: Record<string, string[]>;
  /** Body copy: where a piece sets it, it must be at body size (see floor.ts). */
  body: string[];
  /** The offer's terms the reader needs, quoted from the brief's copy ("until March", "Pick it up"): every piece keeps
   * them, so cutting words to meet a size floor cannot drop them. Formats in termsExempt (e.g. the 300x250 banner)
   * need not carry them. */
  terms: string[];
  termsExempt: string[];
  /** Body-copy floor: "minimum" (default) = only the minimum for any text. The "reading" setting uses the platform's default reading size. */
  bodyFloor: "reading" | "minimum";
  /** The brief's images (paths relative to the project). */
  assets: string[];
  /** Recorded intake origin by path. Older frozen guides may have no origins. */
  assetOrigins?: Record<string, AssetOrigin>;
  /** "required": every piece shows at least one of them; "optional": the brief said they may be left out. */
  assetUse: "required" | "optional";
  source: "essentials.json" | "brief.md" | "none";
}

const field = (brief: string, key: string) => brief.match(new RegExp(`^\\s*[-*]\\s*${key}\\s*:\\s*(.+)$`, "im"))?.[1].trim();
export const briefBrand = (brief: string | undefined, boardName: string) =>
  field(brief ?? "", "Brand(?: name)?") ?? boardName.split(/:\s/, 1)[0];
/** A price ("EUR 9", "€12", "$49.00") or a day-and-month date ("1 March", "12 May", "7–10 August"). */
const PRICE = /(?:EUR|USD|GBP|€|\$|£)\s?\d+(?:[.,]\d{2})?/;
const DATE = /\b\d{1,2}(?:\s?[–-]\s?\d{1,2})?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/;
const remote = /^https?:\/\//i;

function intakeAssets(value: unknown, file: string) {
  const origins = new Map<string, AssetOrigin>();
  if (value !== undefined) {
    const invalid = () => new Error(`${file}: assets must list supplied images as {"path":"assets/image.png","origin":"brief"} or use origin "client".`);
    if (!Array.isArray(value)) throw invalid();
    for (const entry of value) {
      const legacy = typeof entry === "string";
      const origin = legacy ? "legacy" : entry?.origin;
      const source = legacy ? entry : entry?.path;
      if ((!legacy && origin !== "brief" && origin !== "client") || typeof source !== "string" || !source.trim()) throw invalid();
      const path = remote.test(source) ? new URL(source).href : source.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!remote.test(path) && (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.split("/").includes(".."))) throw invalid();
      if (origins.has(path) && origins.get(path) !== origin) throw new Error(`${file}: conflicting origins for ${path}.`);
      origins.set(path, origin);
    }
  }
  return { assets: [...origins.keys()], assetOrigins: Object.fromEntries(origins) };
}

export function loadEssentials(project: string): Essentials {
  const own = join(project, "essentials.json");
  if (existsSync(own)) {
    const e = JSON.parse(readFileSync(own, "utf8").replace(/^\uFEFF/, ""));
    if (e.requiredByFormat !== undefined && (
      !e.requiredByFormat || typeof e.requiredByFormat !== "object" || Array.isArray(e.requiredByFormat) ||
      Object.values(e.requiredByFormat).some((copies) => !Array.isArray(copies) || copies.some((copy) => typeof copy !== "string" || !copy.trim()))
    )) throw new Error(`${own}: requiredByFormat must map format IDs to arrays of non-empty strings.`);
    const intake = intakeAssets(e.assets, own);
    return { required: e.required ?? [], requiredByFormat: e.requiredByFormat, body: e.body ?? [], terms: e.terms ?? [], termsExempt: e.termsExempt ?? [], bodyFloor: e.bodyFloor ?? "minimum", ...intake, assetUse: e.assetUse ?? (intake.assets.length ? "required" : "optional"), source: "essentials.json" };
  }
  const briefPath = join(project, "brief.md");
  const intake = { assets: [], assetOrigins: {}, assetUse: "optional" } as const satisfies Pick<Essentials, "assets" | "assetOrigins" | "assetUse">;
  if (!existsSync(briefPath)) return { required: [], body: [], terms: [], termsExempt: [], bodyFloor: "minimum", ...intake, source: "none" };
  const brief = readFileSync(briefPath, "utf8");
  const required: string[] = [];
  const cta = field(brief, "Call to action");
  if (cta) required.push(cta);
  const offerText = [field(brief, "Subline"), field(brief, "Details"), field(brief, "Offer")].filter(Boolean).join(" ");
  const when = offerText.match(PRICE)?.[0] ?? offerText.match(DATE)?.[0];
  if (when) required.push(when);
  const url = field(brief, "URL") ?? field(brief, "Website") ?? field(brief, "Address");
  if (url) required.push(url);
  const body = [field(brief, "Subline")].filter((x): x is string => !!x);
  return { required, body, terms: [], termsExempt: [], bodyFloor: "minimum", ...intake, source: "brief.md" };
}

/** Old freezes mixed inferred assets with actual attachments. Preserve lists that can be traced to intake. */
export function campaignEssentials(essentials: Essentials | undefined, project?: string): Essentials | undefined {
  if (!essentials?.assets.length || essentials.assetOrigins) return essentials;
  const manifest = project && join(project, "essentials.json");
  const confirmed = manifest && existsSync(manifest)
    ? intakeAssets(JSON.parse(readFileSync(manifest, "utf8").replace(/^\uFEFF/, "")).assets, manifest)
    : undefined;
  return { ...essentials, assets: essentials.assets.filter((name) => confirmed && Object.hasOwn(confirmed.assetOrigins, name)) };
}

export function isSuppliedImage(name: string, src: string, project?: string): boolean {
  if (remote.test(name)) return name === src;
  if (!src.startsWith("file:")) return false;
  try {
    const actual = fileURLToPath(src);
    return project ? relative(resolve(project, name), actual) === "" : actual.replaceAll("\\", "/").endsWith(`/${name}`);
  } catch {
    return false;
  }
}

export const copyWhitespace = (s: string) => s.replace(/\s+/g, " ").trim();

/** A line break can serve the layout role of a standalone middle dot. Keep the words and all other punctuation. */
export function matchesCampaignCopy(text: string, approved: string, exact = false): boolean {
  const copy = copyWhitespace(approved);
  if (!copy) return false;
  const word = "[\\p{L}\\p{N}\\p{M}_]";
  const pattern = copy.split(" · ").map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(" ", "\\s+"))
    .join("(?:\\s+·\\s+|\\s*\\n\\s*)");
  const start = exact ? "^" : new RegExp(`^${word}`, "u").test(copy) ? `(?<!${word})` : "";
  const end = exact ? "$" : new RegExp(`${word}$`, "u").test(copy) ? `(?!${word})` : "";
  return new RegExp(start + pattern + end, "u").test(text.trim());
}

export const norm = (s: string) => s.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
export const urlLike = (s: string) => /^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(s.trim());

export function requiredCampaignCopy(essentials: Essentials | undefined, format: string) {
  const shared = essentials?.required ?? [];
  const terms = essentials?.termsExempt?.includes(format) ? [] : essentials?.terms ?? [];
  const byFormat = essentials?.requiredByFormat;
  const specific = byFormat && Object.hasOwn(byFormat, format) ? byFormat[format] : [];
  const applies = (copy: string) => format !== "hero" || !urlLike(copy);
  return {
    required: [...new Set([...shared.filter(applies), ...specific])],
    terms: terms.filter(applies),
  };
}
