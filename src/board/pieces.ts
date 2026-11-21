import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Board } from "./freeze.js";
import { escapeHtml } from "./sheet-markdown.js";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function isPieceFile(file: string): boolean {
  return /\.html?$/i.test(file) && !/^kit-sheet\.html?$/i.test(basename(file));
}

export function outputFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && isPieceFile(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

const entities = { amp: "&", quot: '"', lt: "<", gt: ">", apos: "'" };

function pieceMetadata(html: string) {
  let boardVersion: string | undefined;
  let campaign: string | undefined;
  let reviewOnly = false;
  let headStart = html.startsWith("\uFEFF") ? 1 : 0;
  // Read whole tags so quoted attributes and inert markup cannot declare metadata.
  const markup = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(script|style|title|template|noscript)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>|<(\/?[a-z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/gi;
  for (const match of html.matchAll(markup)) {
    const [source, , tag, attributes, plain] = match;
    if (plain?.trim()) break;
    if (/^<!doctype\b/i.test(source)) headStart = match.index + source.length;
    if (!tag) continue;
    const tagName = tag.toLowerCase();
    if (tagName === "html" || tagName === "head") headStart = match.index + source.length;
    if (["html", "head", "base", "link"].includes(tagName)) continue;
    if (tagName !== "meta") break;
    const values = new Map<string, string>();
    for (const [, name, doubleQuoted, singleQuoted, unquoted] of attributes.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)) {
      const key = name.toLowerCase();
      if (!values.has(key)) values.set(key, doubleQuoted ?? singleQuoted ?? unquoted);
    }
    const label = values.get("content")?.replace(/&(amp|quot|lt|gt|apos);/g, (_, key: keyof typeof entities) => entities[key]).trim() ?? "";
    const name = values.get("name")?.toLowerCase();
    if (name === "board-version" && /^v[1-9]\d*$/.test(label) && Number.isSafeInteger(Number(label.slice(1)))) boardVersion ??= label;
    if (name === "board-campaign" && label) campaign ??= label;
    if (name === "board-purpose" && label.toLowerCase() === "review") reviewOnly = true;
  }
  return { boardVersion, campaign, reviewOnly, headStart };
}

export function readPiece(file: string) {
  const bytes = readFileSync(file);
  const { boardVersion, campaign, reviewOnly } = pieceMetadata(bytes.toString("utf8"));
  return { sourceHash: digest(bytes), boardVersion, campaign, reviewOnly };
}

export function declareCampaign(file: string, name: string) {
  const bytes = readFileSync(file);
  const html = bytes.toString("utf8");
  const { campaign, headStart, reviewOnly } = pieceMetadata(html);
  if (reviewOnly) throw new Error(`${file} is marked for review.`);
  if (campaign === name) return;
  if (campaign) throw new Error(`${file} declares campaign ${JSON.stringify(campaign)}; expected ${JSON.stringify(name)}.`);
  if (!bytes.equals(Buffer.from(html, "utf8"))) throw new Error(`${file} must be saved as UTF-8 to stamp its campaign.`);
  const eol = html.includes("\r\n") ? "\r\n" : "\n";
  const meta = `<meta name="board-campaign" content="${escapeHtml(name)}">`;
  // Use a sibling temporary file so readers see either the old or the complete stamped source.
  const temp = join(dirname(file), `${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, html.slice(0, headStart) + eol + meta + eol + html.slice(headStart));
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function pieceVersion(boardVersion: string | undefined, current: number) {
  return { boardVersion, stale: boardVersion === undefined ? undefined : Number(boardVersion.slice(1)) < current };
}

export function pieceVersionText({ boardVersion, stale }: ReturnType<typeof pieceVersion>) {
  return boardVersion ? `made under ${boardVersion}${stale ? " (stale)" : ""}` : "made-under version unrecorded";
}

export function pieceStatusText(boardVersion: string | undefined, current: number | undefined): string {
  if (!boardVersion) return "made-under version unrecorded";
  const version = Number(boardVersion.slice(1));
  if (current === undefined || version > current) return `declares ${boardVersion} (unrecorded)`;
  return version === current ? `made under ${boardVersion} (current)` : `made under ${boardVersion} (stale)`;
}

interface ValueObservation {
  sourceHash: string;
  usesOutsideValues: boolean;
}

// Keep observations per piece and include the guide hash because guide colours affect drift.
export const boardValueKey = (board: Board) =>
  digest(JSON.stringify([board.version, board.palette, board.fonts, board.designHash]));
const observationPath = (file: string, boardKey: string) =>
  join(dirname(file), ".board-check", `${basename(file)}.${boardKey}.json`);

export function recordValueObservation(file: string, boardKey: string, observation: ValueObservation) {
  const path = observationPath(file, boardKey);
  if (readPiece(file).sourceHash !== observation.sourceHash) return;
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(observation));
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function hasOutsideValues(file: string, boardKey: string, sourceHash: string): boolean {
  try {
    const observation: ValueObservation = JSON.parse(readFileSync(observationPath(file, boardKey), "utf8"));
    return observation.sourceHash === sourceHash && observation.usesOutsideValues === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
