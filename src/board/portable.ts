import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const mediaTypes: Record<string, string> = {
  ".avif": "image/avif", ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".otf": "font/otf", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2",
};

function projectMediaPath(project: string, path: string): string | undefined {
  try {
    const canonical = realpathSync(path);
    const within = relative(realpathSync(project), canonical);
    if (within && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within)) return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return undefined;
}

function dataUrl(path: string): string {
  return `data:${mediaTypes[extname(path).toLowerCase()]};base64,${readFileSync(path).toString("base64")}`;
}

export interface BriefAsset { name: string; url: string }

/** Prefer the supplied public source when the brief includes a license record. */
export function portableImages(project: string, assets: string[]): BriefAsset[] {
  const images: BriefAsset[] = [];
  for (const name of assets) {
    if (/^https?:\/\//i.test(name)) { images.push({ name, url: name }); continue; }
    const path = projectMediaPath(project, resolve(project, name));
    if (!path || !mediaTypes[extname(path).toLowerCase()]?.startsWith("image/")) continue;
    let source: string | undefined;
    try {
      const ledger: unknown = JSON.parse(readFileSync(join(dirname(path), "LICENSES.json"), "utf8"));
      if (Array.isArray(ledger)) {
        source = ledger.find((entry) => entry?.file === basename(path) &&
          typeof entry.source === "string" && /^https?:\/\//i.test(entry.source))?.source;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    images.push({ name, url: source ?? dataUrl(path) });
  }
  return images;
}

export function portableFontFaces(project: string, faces: string[]): string[] {
  return faces.map((face) => face.replace(/url\("(file:[^"]+)"\)/g, (original, url: string) => {
    const path = projectMediaPath(project, fileURLToPath(url));
    if (!path || !mediaTypes[extname(path).toLowerCase()]?.startsWith("font/")) return original;
    return `url(${JSON.stringify(dataUrl(path))})`;
  }));
}
