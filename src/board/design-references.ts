import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface DesignFinding {
  rule: string;
  detail: string;
}

const cssUrl = String.raw`url\(\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^"'()\s]+))\s*\)`;
const fontImport = String.raw`@import\s+(?:${cssUrl}|"([^"\r\n]+)"|'([^'\r\n]+)')`;
const fontFace = /@font-face\s*\{([^{}]*)\}/gi;
const htmlTag = /<\/?[a-z][\w:-]*(?=\s|\/?>)(?:[^<>"']|"[^"\r\n]*"|'[^'\r\n]*')*>/gi;
const fileExtension = /[.\w-]+\.(?:avif|css|csv|gif|html?|ico|jpe?g|js|json|md|mjs|otf|pdf|png|svg|tiff?|ts|ttf|txt|webp|woff2?|ya?ml)(?![\w.])/i;
const drivePath = /^[a-z]:[\\/]/i;
const external = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;
const pathCharacters = String.raw`[^\s<>"'()\x60|]+`;
const barePath = new RegExp(String.raw`\bfile:${pathCharacters}|(?<![\w:/\\])(?:[a-z]:[\\/]|\.{1,2}[\\/]|[\\/])${pathCharacters}|(?<![\w:/\\])(?:[\w.-]+[\\/])*${fileExtension.source}|(?<![\w:/\\])(?:[\w.-]+[\\/])+(?=\s|[\x60,;)]|$)`, "gi");

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;
const quote = (value: string) => /^data:/i.test(value) ? "embedded data URL" : JSON.stringify(value);
const cssUrls = (text: string) => [...text.matchAll(new RegExp(cssUrl, "gi"))].map((match) => match[1] ?? match[2] ?? match[3]);
const unescapeDestination = (value: string) => value.trim().replace(/^<|>$/g, "").replace(/\\([()<>\[\]])/g, "$1");

function htmlValue(value: string) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39);/g, (entity) => ({
    "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&#39;": "'",
  }[entity]!));
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const [, name, doubleQuoted, singleQuoted, plain] of tag.matchAll(/\s+([-\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result.set(name.toLowerCase(), htmlValue(doubleQuoted ?? singleQuoted ?? plain));
  }
  return result;
}

function inside(root: string, path: string) {
  const location = relative(root, path);
  return !isAbsolute(location) && location !== ".." && !location.startsWith(".." + sep);
}

async function localPath(root: string, url: URL) {
  const path = fileURLToPath(url);
  if (!inside(root, path)) throw new Error("outside the project");
  const canonical = await realpath(path).catch(() => { throw new Error("missing from the project"); });
  if (!inside(root, canonical)) throw new Error("outside the project through a filesystem link");
  return canonical;
}

function destination(value: string, base: URL) {
  // A drive letter in a Windows path is not a URL protocol.
  if (drivePath.test(value)) {
    if (!isAbsolute(value)) throw new Error("outside the project");
    return pathToFileURL(value);
  }
  return new URL(value.replaceAll("\\", "/"), base);
}

function isFont(bytes: Buffer) {
  const signature = bytes.toString("ascii", 0, 4);
  // WOFF1 and WOFF2 put the complete file length at byte 8 of their fixed headers.
  if (signature === "wOFF" || signature === "wOF2") {
    const header = signature === "wOFF" ? 44 : 48;
    return bytes.length >= header && bytes.readUInt32BE(8) === bytes.length;
  }
  return bytes.length >= 12 && (["OTTO", "true", "typ1", "ttcf"].includes(signature) || bytes.readUInt32BE(0) === 0x00010000);
}

function fontResolver(root: string, base: URL, localAssets?: Set<string>) {
  const requests = new Map<string, Promise<{ bytes: Buffer; url: URL; media?: string }>>();
  async function read(url: URL): Promise<{ bytes: Buffer; url: URL; media?: string }> {
    if (url.protocol === "file:") {
      const path = await localPath(root, url);
      if (!(await stat(path)).isFile()) throw new Error("expected a file");
      localAssets?.add(path);
      return { bytes: await readFile(path), url };
    }
    if (!["http:", "https:", "data:"].includes(url.protocol)) throw new Error("unsupported font URL protocol");
    const response = await fetch(url, {
      // Use the same network deadline as the board sample renderer.
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      bytes: Buffer.from(await response.arrayBuffer()), url: new URL(response.url || url.href),
      media: response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase(),
    };
  }
  function load(value: string, parent: URL) {
    const url = destination(value, parent);
    const existing = requests.get(url.href);
    if (existing) return existing;
    const pending = read(url);
    requests.set(url.href, pending);
    return pending;
  }
  async function font(value: string, parent: URL) {
    try {
      const { bytes } = await load(value, parent);
      if (!isFont(bytes)) throw new Error("did not return a font file");
    } catch (error) {
      throw new Error(`${quote(value)}: ${(error as Error).message}`, { cause: error });
    }
  }
  async function face(body: string, parent = base) {
    const source = body.match(/(?:^|;)\s*src\s*:\s*([\s\S]+)/i)?.[1];
    if (!/(?:^|;)\s*font-family\s*:\s*[^;\s]/i.test(body) || !source) throw new Error("expected font-family and src in @font-face");
    const urls = cssUrls(source);
    if (!urls.length) throw new Error("expected a resolvable URL in @font-face src");
    if ([...source.matchAll(/\burl\s*\(/gi)].length !== urls.length) throw new Error("unfinished @font-face URL");
    await Promise.all(urls.map((url) => font(url, parent)));
  }
  async function stylesheet(value: string, parent = base, visiting = new Set<string>()): Promise<void> {
    const { bytes, url, media } = await load(value, parent);
    if (visiting.has(url.href)) throw new Error(`${quote(value)} imports itself through a stylesheet cycle`);
    if (media && media !== "text/css") throw new Error(`${quote(value)} returned ${media} instead of text/css`);
    const css = bytes.toString("utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const imports = [...css.matchAll(new RegExp(fontImport, "gi"))];
    const faces = [...css.matchAll(fontFace)];
    if (!imports.length && !faces.length) throw new Error(`${quote(value)} did not return a stylesheet with font faces`);
    const seen = new Set([...visiting, url.href]);
    await Promise.all([
      ...imports.map((match) => stylesheet(match.slice(1).find(Boolean)!, url, seen)),
      ...faces.map((match) => face(match[1], url)),
    ]);
  }
  return { face, stylesheet };
}

export async function validateDesignReferences(markdown: string, project: string, localAssets?: Set<string>): Promise<DesignFinding[]> {
  const root = await realpath(resolve(project));
  const base = pathToFileURL(root + sep);
  const fonts = fontResolver(root, base, localAssets);
  const findings: DesignFinding[] = [];
  const references = new Map<string, { value: string; line: number }>();
  const loads: Array<{ line: number; label: string; load: () => Promise<void> }> = [];
  const add = (rule: string, line: number, detail: string) => findings.push({ rule, detail: `line ${line}: ${detail}` });
  const reference = (target: string, line: number) => {
    const value = unescapeDestination(target);
    if (!value || value.startsWith("#")) return;
    if (external.test(value) && !drivePath.test(value) && !/^file:/i.test(value)) return;
    references.set(JSON.stringify([value, line]), { value, line });
  };

  // Mark consumed spans before checking plain paths so URLs and link titles are not mistaken for local files.
  const withoutTags = markdown.replace(htmlTag, (tag: string, index: number) => {
    const line = lineAt(markdown, index);
    const attrs = attributes(tag);
    for (const name of ["src", "href", "poster"]) {
      if (attrs.has(name)) reference(attrs.get(name)!, line);
    }
    for (const url of cssUrls(attrs.get("style") ?? "")) reference(url, line);
    if (/^<link\b/i.test(tag) && attrs.get("rel")?.split(/\s+/).some((rel) => rel.toLowerCase() === "stylesheet")) {
      const href = attrs.get("href");
      if (href) loads.push({ line, label: quote(href), load: () => fonts.stylesheet(href) });
      else add("font-load", line, "stylesheet link has no href");
    }
    return tag.replace(/[^\n]/g, " ");
  });
  for (const match of withoutTags.matchAll(/<link\b[^\n]*/gi)) {
    if (/\b(?:href|rel)\s*=/i.test(match[0])) add("truncated-line", lineAt(markdown, match.index), "unclosed <link> tag");
  }

  for (const match of withoutTags.matchAll(new RegExp(fontImport, "gi"))) {
    const url = match.slice(1).find(Boolean)!;
    loads.push({ line: lineAt(markdown, match.index), label: quote(url), load: () => fonts.stylesheet(url) });
  }
  const withoutImports = withoutTags.replace(new RegExp(fontImport, "gi"), (text) => text.replace(/[^\n]/g, " "));
  for (const match of withoutImports.matchAll(/@import\s+(?:url\s*\(|["'])/gi)) {
    add("truncated-line", lineAt(markdown, match.index), "unclosed @import URL");
  }
  for (const match of withoutTags.matchAll(fontFace)) {
    const line = lineAt(markdown, match.index);
    loads.push({ line, label: "@font-face", load: () => fonts.face(match[1]) });
    if ([...match[1].matchAll(/\burl\s*\(/gi)].length !== cssUrls(match[1]).length) {
      add("truncated-line", line, "unclosed @font-face URL");
    }
  }
  const withoutFaces = withoutTags.replace(fontFace, (text) => text.replace(/[^\n]/g, " "));
  for (const match of withoutFaces.matchAll(/@font-face\s*\{/gi)) {
    add("truncated-line", lineAt(markdown, match.index), "unclosed @font-face rule");
  }

  for (const [index, line] of withoutTags.split("\n").entries()) {
    const lineNumber = index + 1;
    let plain = line.replace(new RegExp(cssUrl, "gi"), (text, doubleQuoted, singleQuoted, bare) => {
      reference(doubleQuoted ?? singleQuoted ?? bare, lineNumber);
      return " ".repeat(text.length);
    });
    const importMatch = line.match(new RegExp(fontImport, "i"));
    if (importMatch) reference(importMatch.slice(1).find(Boolean)!, lineNumber);
    const markdownLink = /!?\[[^\]\r\n]*\]\(\s*(<[^>\r\n]*>|(?:\\.|[^\s()\\]|\((?:\\.|[^()\\\r\n])*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
    const definition = /^\s{0,3}\[[^\]\r\n]+\]:\s*(<[^>\r\n]+>|\S+).*$/;
    for (const pattern of [markdownLink, definition]) {
      plain = plain.replace(pattern, (text, value) => {
        reference(value, lineNumber);
        return " ".repeat(text.length);
      });
    }
    plain = plain.replace(/`+([^`\r\n]+)`+/g, (text, code: string) => {
      const value = code.trim();
      if (/^file:/i.test(value) || drivePath.test(value) || /^(?:\.{1,2}[\\/]|[\\/]|[\w.-]+[\\/])[\w. /\\%()-]+[/?#\w.-]*$/.test(value) || fileExtension.test(value) && !/[<>:"'|]/.test(value)) {
        reference(value, lineNumber);
        return " ".repeat(text.length);
      }
      return text;
    });
    plain = plain.replace(/\b(?:https?:\/\/|data:)[^\s<>"'`]+/gi, "");
    for (const match of plain.matchAll(barePath)) reference(match[0].replace(/[.,:!?;]+$/, ""), lineNumber);
  }

  const results = await Promise.all([
    ...[...references.values()].sort((a, b) => a.line - b.line).map(async ({ value, line }) => {
      try {
        const url = destination(value, base);
        if (url.protocol === "file:") {
          const path = await localPath(root, url);
          localAssets?.add(path);
        }
      } catch (error) {
        return { rule: "file-reference", detail: `line ${line}: ${quote(value)}: ${(error as Error).message}` };
      }
    }),
    ...loads.sort((a, b) => a.line - b.line).map(async ({ line, label, load }) => {
      try {
        await load();
      } catch (error) {
        return { rule: "font-load", detail: `line ${line}: ${label}: ${(error as Error).message}` };
      }
    }),
  ]);
  return [...findings, ...results.filter((finding) => finding !== undefined)];
}
