import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const SOURCE_ASSETS_FILE = "source-assets.json";
type SourceAssets = Record<string, string | null>;

const within = (name: string) => name && !isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`);

/** Record local dependencies under project-relative names that survive moving the project. */
export function hashLocalAssets(project: string, paths: Iterable<string>): SourceAssets {
  const root = realpathSync(project);
  const files = new Map<string, string | null>();
  for (const path of paths) {
    const local = relative(project, path);
    const name = within(local) ? local : relative(root, path);
    if (!within(name)) continue;
    const key = name.replaceAll("\\", "/");
    let hash = null;
    try {
      const canonical = realpathSync(path);
      if (within(relative(root, canonical)) && statSync(canonical).isFile()) {
        hash = createHash("sha256").update(readFileSync(canonical)).digest("hex");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    files.set(key, hash);
  }
  return Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b, "en")));
}

const readAssets = (path: string): SourceAssets => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};

export function compareSourceAssets(boardDir: string, stage: string): { changed: boolean; updateBaseline: boolean } {
  const current = join(boardDir, SOURCE_ASSETS_FILE);
  const next = join(stage, SOURCE_ASSETS_FILE);
  const prior = readAssets(current);
  const observed = readAssets(next);
  const project = dirname(boardDir);
  // Recheck known dependencies even when the browser did not request them in this render.
  const missing = Object.keys(prior).filter((name) => !Object.hasOwn(observed, name));
  const assets = { ...hashLocalAssets(project, missing.map((name) => join(project, name))), ...observed };
  if (existsSync(next) && missing.length) writeFileSync(next, JSON.stringify(assets));
  return {
    changed: Object.keys(prior).some((name) => assets[name] !== prior[name]),
    updateBaseline: existsSync(next) && (!existsSync(current) || !isDeepStrictEqual(prior, assets)),
  };
}
