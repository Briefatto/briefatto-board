// What a brief requires its campaign pieces to carry: requested strings (call to action, price or date, URL or address) and
// the body copy, plus the brief's own assets (product photos, logo). These are the brief's words and files, so a
// program can prove them: a requested string is in the piece's visible text or it is not.
//
// Source: `essentials.json` in the project when the agent wrote one; otherwise read from the brief's copy list
// ("- Call to action: ...", "- URL: ...", "- Subline: ...", a price such as "EUR 9" in the subline or details).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface Essentials {
  /** Strings every piece must show (whitespace and case are ignored). URL-like strings are not required on the website hero. */
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
const IMAGE = /\.(?:jpe?g|png|webp|avif|gif|svg)$/i;

function images(dir: string, root: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) images(p, root, out);
    else if (IMAGE.test(f)) out.push(relative(root, p).replace(/\\/g, "/"));
  }
  return out;
}

export function loadEssentials(project: string): Essentials {
  const assets = images(join(project, "assets"), project);
  const own = join(project, "essentials.json");
  if (existsSync(own)) {
    const e = JSON.parse(readFileSync(own, "utf8").replace(/^\uFEFF/, ""));
    if (e.requiredByFormat !== undefined && (
      !e.requiredByFormat || typeof e.requiredByFormat !== "object" || Array.isArray(e.requiredByFormat) ||
      Object.values(e.requiredByFormat).some((copies) => !Array.isArray(copies) || copies.some((copy) => typeof copy !== "string" || !copy.trim()))
    )) throw new Error(`${own}: requiredByFormat must map format IDs to arrays of non-empty strings.`);
    return { required: e.required ?? [], requiredByFormat: e.requiredByFormat, body: e.body ?? [], terms: e.terms ?? [], termsExempt: e.termsExempt ?? [], bodyFloor: e.bodyFloor ?? "minimum", assets: e.assets ?? assets, assetUse: e.assetUse ?? (assets.length ? "required" : "optional"), source: "essentials.json" };
  }
  const briefPath = join(project, "brief.md");
  if (!existsSync(briefPath)) return { required: [], body: [], terms: [], termsExempt: [], bodyFloor: "minimum", assets, assetUse: assets.length ? "required" : "optional", source: "none" };
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
  // The brief may release its images explicitly; otherwise supplied images are used.
  const optional = /images?[^.\n]*(?:optional|may be left out|not required)|do not use (?:the|our) (?:photos|images)/i.test(brief);
  return { required, body, terms: [], termsExempt: [], bodyFloor: "minimum", assets, assetUse: assets.length && !optional ? "required" : "optional", source: "brief.md" };
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
