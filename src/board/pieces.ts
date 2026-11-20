import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Board } from "./freeze.js";

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

export function readPiece(file: string) {
  const bytes = readFileSync(file);
  const sourceHash = digest(bytes);
  let boardVersion: string | undefined;
  let campaign: string | undefined;
  // Read whole tags so quoted attributes and inert markup cannot declare metadata.
  const markup = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(script|style|title|template|noscript)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>|<(\/?[a-z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/gi;
  for (const [, , tag, attributes, plain] of bytes.toString("utf8").matchAll(markup)) {
    if (plain?.trim()) break;
    if (!tag) continue;
    const tagName = tag.toLowerCase();
    if (["html", "head", "base", "link"].includes(tagName)) continue;
    if (tagName !== "meta") break;
    const values = new Map<string, string>();
    for (const [, name, doubleQuoted, singleQuoted, unquoted] of attributes.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)) {
      const key = name.toLowerCase();
      if (!values.has(key)) values.set(key, doubleQuoted ?? singleQuoted ?? unquoted);
    }
    const label = values.get("content")?.trim() ?? "";
    const name = values.get("name")?.toLowerCase();
    if (name === "board-version" && /^v[1-9]\d*$/.test(label) && Number.isSafeInteger(Number(label.slice(1)))) boardVersion ??= label;
    if (name === "board-campaign" && label) campaign ??= label;
  }
  return { sourceHash, boardVersion, campaign };
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
