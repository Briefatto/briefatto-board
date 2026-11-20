import { createReadStream, existsSync, mkdirSync, mkdtempDisposableSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { designTypographyFamilies } from "./design-validation.js";
import { checkImpeccable, impeccable, renderFaults, type SourceFloor } from "./floor.js";
import { type Renderer, type WebsiteRender } from "./render.js";
import { readBoard, readFrozenDesign } from "./versions.js";

const directory = (project: string) => join(project, ".briefatto", "adoption");
export const adoptionPath = (project: string) => join(directory(project), "pages.json");
const ignored = new Set(["node_modules", "board", "directions", "outputs", "refs", "coverage"]);
const isPage = (path: string) => /\.html?$/i.test(path);
const slashes = (path: string) => path.split(sep).join("/");
const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep);
};
const entries = (path: string) => readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"));
const string = z.string().min(1);
const manifestSchema = z.object({
  root: string.optional(),
  viewports: z.array(z.object({ width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(2160) })).min(1),
  pages: z.array(string).min(1),
});
type Adoption = z.infer<typeof manifestSchema>;

function localPath(root: string, name: string) {
  const path = realpathSync(resolve(root, name));
  if (!inside(root, path)) throw new Error("Choose a path inside the project or use an HTTP page URL.");
  return path;
}

function* projectFiles(root: string, skip: Set<string>): Generator<string> {
  for (const entry of entries(root)) {
    if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory() && !/^board\.v\d+$/.test(entry.name)) yield* projectFiles(path, skip);
    if (entry.isFile()) yield path;
  }
}

function websiteUrl(value: string) {
  if (!/^https?:\/\//i.test(value)) return undefined;
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Use a page URL without embedded credentials.");
  return url;
}

export function selectAdoption(project: string, options: { root?: string; pages: string[]; viewports: string[] }): Adoption {
  project = realpathSync(project);
  const live = options.pages.filter(websiteUrl);
  if (live.length && (options.root || live.length !== options.pages.length)) {
    throw new Error("Select either running-site URLs or built HTML files in one adoption.");
  }
  const screens = options.viewports.length ? options.viewports : ["1440x900", "390x844"];
  const viewports = screens.map((value) => {
    if (!/^\d+x\d+$/.test(value)) throw new Error("Use WIDTHxHEIGHT for --viewport.");
    const [width, height] = value.split("x").map(Number);
    return { width, height };
  });
  if (live.length) return manifestSchema.parse({ pages: [...new Set(live.map((page) => websiteUrl(page)!.href))], viewports });
  const guessedRoot = ["dist", "build", "out", ".", "public"].find((root) => existsSync(join(project, root, "index.html")));
  const root = localPath(project, options.root ?? (options.pages.length ? "." : guessedRoot ?? "."));
  const files = options.pages.length
    ? options.pages.map((file) => localPath(root, file))
    : root === project
      ? entries(root).filter((entry) => entry.isFile() && isPage(entry.name)).map(({ name }) => join(root, name))
      : [...projectFiles(root, ignored)].filter(isPage);
  if (!files.length) throw new Error("No built HTML pages found. Pass --page with an HTML file or a running-site URL.");
  if (!options.pages.length && files.length > 20) throw new Error("Select representative pages with repeated --page flags.");
  for (const file of files) {
    if (!isPage(file) || !statSync(file).isFile()) throw new Error("Each built page must be an HTML file.");
  }
  return manifestSchema.parse({ root: slashes(relative(project, root)) || ".", pages: [...new Set(files.map((file) => slashes(relative(root, file))))], viewports });
}

export function loadAdoption(project: string): Adoption {
  return manifestSchema.parse(JSON.parse(readFileSync(adoptionPath(project), "utf8")));
}

const types: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon",
  ".avif": "image/avif", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".wasm": "application/wasm",
};

async function serve(root: string, assets?: Set<string>) {
  const server = createServer((req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") throw new Error();
      const path = decodeURIComponent(new URL(req.url!, "http://localhost").pathname);
      if (path.split(/[\\/]/).some((part) => part.startsWith(".") || ignored.has(part))) throw new Error();
      let file = localPath(root, "." + path);
      if (statSync(file).isDirectory()) file = localPath(root, join(file, "index.html"));
      const type = types[extname(file).toLowerCase()];
      if (!type || !statSync(file).isFile()) throw new Error();
      assets?.add(file);
      res.writeHead(200, { "Content-Type": type });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const port = (server.address() as { port: number }).port;
  return { origin: "http://127.0.0.1:" + port, close: () => { server.close(); server.closeAllConnections(); } };
}

export async function withAdoptedPages<T>(project: string, adoption: Adoption, assets: Set<string> | undefined, run: (pages: Array<{
  id: string; source: string; website: WebsiteRender; file?: string; origin?: string; root?: string;
}>) => Promise<T>) {
  const root = adoption.root === undefined ? undefined : localPath(realpathSync(project), adoption.root);
  const server = root ? await serve(root, assets) : undefined;
  try {
    const pages = adoption.pages.flatMap((page, index) => {
      const file = root ? localPath(root, page) : undefined;
      const source = file ? slashes(relative(project, file)) : websiteUrl(page)?.href;
      if (!source || (file && !isPage(file))) throw new Error("Invalid adoption page.");
      const route = page.replace(/(^|\/)index\.html$/i, "$1");
      const url = file ? server!.origin + "/" + route.split("/").map(encodeURIComponent).join("/") : source;
      return adoption.viewports.map((viewport, screen) => ({
        id: "page-" + (index + 1) + (screen ? "-" + (screen + 1) : ""),
        source, website: { source: url, viewport }, file, origin: server?.origin, root,
      }));
    });
    return await run(pages);
  } finally {
    server?.close();
  }
}

/** Convert temporary preview URLs back to files before storing font sources. */
export function localAdoptionAssets<T extends { fontLinks: string[]; fontFaces?: string[]; images: Array<{ src: string }> }>(r: T, origin?: string, root?: string): T {
  if (!origin || !root) return r;
  const localize = (url: string) => {
    const path = decodeURIComponent(new URL(url).pathname);
    return pathToFileURL(resolve(root, "." + path)).href;
  };
  return {
    ...r,
    fontLinks: r.fontLinks.filter((url) => !url.startsWith(origin + "/")),
    fontFaces: r.fontFaces?.map((face) => face.replace(/url\("(http:\/\/[^"]+)"\)/g,
      (match, url: string) => url.startsWith(origin + "/") ? "url(" + JSON.stringify(localize(url)) + ")" : match)),
    images: r.images.map((image) => image.src.startsWith(origin + "/") ? { ...image, src: localize(image.src) } : image),
  };
}

export async function adopt(project: string, adoption: Adoption, renderer: Renderer, check: boolean) {
  const output = directory(project);
  mkdirSync(output, { recursive: true });
  using stage = mkdtempDisposableSync(join(output, "capture-"));
  const assets = new Set<string>();
  const boardDir = join(project, "board");
  const board = check && existsSync(join(boardDir, "board.json")) ? readBoard(boardDir) : undefined;
  const design = board && readFrozenDesign(boardDir, board, board);
  const brandFonts = design === undefined ? undefined : designTypographyFamilies(design);
  const evidence = await withAdoptedPages(project, adoption, assets, async (pages) => {
    const captures = [];
    for (const { id, source, website, file, origin, root } of pages) {
      const image = id + ".png";
      const png = join(stage.path, image);
      const html = join(stage.path, id + ".html");
      const staticFindings = check && file ? impeccable(file) : undefined;
      let sourceFloor: SourceFloor | undefined;
      const rendered = await renderer.render(html, undefined, png, true, undefined, {
        ...website, captureHtml: (content) => writeFileSync(html, content),
      }, check ? async (page) => { sourceFloor = await checkImpeccable(staticFindings ?? impeccable(html), page, brandFonts); } : undefined);
      const r = localAdoptionAssets(rendered, origin, root);
      const { width, height, colours, texts, radii, images, designStyles, siteStyles, fontLinks, fontFaces } = r;
      const findings = sourceFloor ? [
        ...sourceFloor.floor,
        ...renderFaults(r, { id, label: source, width, height, seenWidth: width, source }),
      ] : undefined;
      captures.push({ source, viewport: website.viewport, png: image, colours, texts, radii, images, designStyles, siteStyles, fontLinks, fontFaces,
        findings, dismissed: sourceFloor?.dismissed, designNotes: sourceFloor?.designNotes });
    }
    return captures;
  });
  const styleSources = [...new Set([...projectFiles(project, new Set([...ignored, "dist", "build", "out", "vendor"])), ...assets])]
    .filter((file) => /(?:\.css|\.s[ac]ss|\.less|[\\/](?:tailwind\.config|[^\\/]*(?:theme|logo)[^\\/.]*)\.[^\\/]+)$/i.test(file))
    .map((file) => slashes(relative(project, file))).sort();
  writeFileSync(join(stage.path, "evidence.json"), JSON.stringify({ styleSources, pages: evidence }, null, 2));
  writeFileSync(join(stage.path, "pages.json"), JSON.stringify(adoption, null, 2));
  for (const capture of evidence) renameSync(join(stage.path, capture.png), join(output, capture.png));
  renameSync(join(stage.path, "evidence.json"), join(output, "evidence.json"));
  renameSync(join(stage.path, "pages.json"), adoptionPath(project));
  return { output, evidence };
}
