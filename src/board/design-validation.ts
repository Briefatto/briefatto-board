import { createHash } from "node:crypto";
import { isMap, parseDocument } from "yaml";
import type { Board } from "./freeze.js";
import type { Rendered, Renderer } from "./render.js";
import { validateDesignReferences, type DesignFinding } from "./design-references.js";

const frontMatter = /^\uFEFF?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|(?![\s\S]))/m;
const stamp = /^<!-- briefatto-board:freeze v[1-9]\d* \d{4}-\d{2}-\d{2} sha256:[0-9a-f]{64} -->(?:\r?\n|$)/;

function stampOffset(markdown: string): number {
  const match = frontMatter.exec(markdown);
  return match?.index === 0 ? match[0].length : Number(markdown.startsWith("\uFEFF"));
}

export function unsignedDesign(markdown: string): string {
  const offset = stampOffset(markdown);
  const existing = stamp.exec(markdown.slice(offset));
  if (!existing) return markdown;
  const before = markdown.slice(0, offset);
  return (existing[0].endsWith("\n") ? before : before.replace(/\r?\n$/, "")) + markdown.slice(offset + existing[0].length);
}

export const designHash = (markdown: string) => createHash("sha256").update(markdown).digest("hex");

export function stampDesign(markdown: string, board: { version: number; frozenAt: string; designHash: string }): string {
  const offset = stampOffset(markdown);
  const newline = markdown.match(/\r?\n/)?.[0] ?? "\n";
  const before = markdown.slice(0, offset);
  const comment = `<!-- briefatto-board:freeze v${board.version} ${board.frozenAt.slice(0, 10)} sha256:${board.designHash} -->`;
  if (offset > 1 && !before.endsWith("\n")) return before + newline + comment;
  return before + comment + newline + markdown.slice(offset);
}

const families = (value: string) => [...value.matchAll(/\s*(?:"([^"]+)"|'([^']+)'|([^,]+))/g)]
  .map(([, double, single, rest]) => (double ?? single ?? rest).trim()).filter(Boolean);
const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, "$2");
const literalColour = /(?<![\w/#])#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()\n]*\)/gi;
const declaration = /^\s*(?:-\s+)?([\w-]+):[ \t]*(.*)$/;
const property = /\b(font-?family|font-?size|(?:background-|border-|text-decoration-|outline-)?color|fill|stroke)\s*:\s*([^;}`\n]+?)(?=,\s*[\w-]+\s*:|[;}`]|$)/gi;
const px = /^(\d+(?:\.\d+)?|\.\d+)px$/i;

type StyleClaim = { rule: "colour" | "font-family" | "font-size"; value: string; line: number };

function* styleClaims(lines: string[]): Generator<StyleClaim> {
  let inColours = false;
  let inTypography = false;
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/https?:\/\/[^\s"'`>]+|data:[^\s"'`>]+|\]\([^)]*\)/gi, "");
    const field = line.match(declaration);
    if (/^\S/.test(line)) inColours = /^colors:\s*(?:#.*)?$/.test(line);
    if (/^##\s/.test(line)) inTypography = /^##\s+Typography\s*$/.test(line);
    const values = [...line.matchAll(literalColour)].map(([value]) => value);
    if (inColours && field?.[2].trim()) values.push(unquote(field[2].replace(/\s+#\s.*$/, "").trim()));
    if (/^colors:\s*\{/.test(line)) {
      for (const [, value] of line.matchAll(/[\w-]+:\s*([^{}]+?)(?=,\s*[\w-]+\s*:|})/g)) values.push(unquote(value.trim()));
    }
    for (const match of line.matchAll(property)) {
      const value = match[2].replace(/\s+#\s.*$/, "").trim();
      if (/^\{[^{}]+$/.test(value)) continue;
      if (/family$/i.test(match[1])) {
        // A quoted YAML scalar may contain the full CSS list; CSS also quotes each name independently.
        const stack = /^(["'])(?:(?!\1).)*\1$/.test(value) && value.includes(",") ? unquote(value) : value;
        for (const family of families(stack)) yield { rule: "font-family", value: family, line: index + 1 };
      } else if (/size$/i.test(match[1])) {
        yield { rule: "font-size", value: unquote(value), line: index + 1 };
      } else if (/^(?:[a-z]+|#[a-f\d]+|[a-z0-9-]+\([^()]+\))$/i.test(value) && !/^(?:none|currentcolor|inherit|initial|unset|revert(?:-layer)?)$/i.test(value)) {
        values.push(value);
      }
    }
    if (inTypography && line.trimStart().startsWith("|")) {
      for (const cell of line.trim().split("|").slice(2, -1)) {
        for (const part of cell.trim().split(/\s*\/\s*/)) {
          if (px.test(part)) yield { rule: "font-size", value: part, line: index + 1 };
        }
      }
    }
    for (const value of values) {
      if (/^\{[^{}]+\}$/.test(value)) continue; // References name tokens, not new values.
      yield { rule: "colour", value, line: index + 1 };
    }
  }
}

export function designColourClaims(markdown: string): string[] {
  return [...new Set([...styleClaims(markdown.split(/\r?\n/))]
    .filter(({ rule }) => rule === "colour").map(({ value }) => value))];
}

export function designTypographyFamilies(markdown: string): Set<string> {
  const fonts = new Set<string>();
  const header = frontMatter.exec(markdown);
  if (header?.index !== 0) return fonts;
  const guide = parseDocument(header[1], { logLevel: "silent" });
  if (guide.errors.length) return fonts;
  const typography = guide.get("typography", true);
  if (!isMap(typography)) return fonts;
  for (const { value: role } of typography.items) {
    if (!isMap(role)) continue;
    const stack = role.get("fontFamily") ?? role.get("font-family");
    const family = typeof stack === "string" ? families(stack)[0] : undefined;
    if (family) fonts.add(family.toLowerCase());
  }
  return fonts;
}

async function styleFindings(lines: string[], renders: Rendered[], renderer: Renderer): Promise<DesignFinding[]> {
  const colours = new Set(renders.flatMap((r) => [...r.colours.map((c) => c.value), ...(r.designStyles?.colours ?? [])]));
  const stacks = renders.flatMap((r) => [...r.texts.map((t) => t.stack), ...(r.designStyles?.stacks ?? [])]);
  const fonts = new Set(stacks.flatMap(families).map((family) => family.toLowerCase()));
  const sizes = new Set(renders.flatMap((r) => [...r.texts.map((t) => t.size), ...(r.designStyles?.sizes ?? [])]));
  const findings: DesignFinding[] = [];
  const seen = new Set<string>();
  function check(rule: string, value: string, present: boolean, line: number) {
    const key = `${rule}\0${value.toLowerCase()}`;
    if (present || seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, detail: `Line ${line}: ${JSON.stringify(value)} has no match in the chosen samples' computed styles.` });
  }
  const colourClaims = new Map<string, number>();
  for (const { rule, value, line } of styleClaims(lines)) {
    if (rule === "colour") {
      if (!colourClaims.has(value)) colourClaims.set(value, line);
    } else if (rule === "font-family") {
      check(rule, value, fonts.has(value.toLowerCase()), line);
    } else {
      const matchPx = value.match(px);
      check(rule, value, !!matchPx && sizes.has(Number(matchPx[1])), line);
    }
  }
  const claims = [...colourClaims.keys()];
  const normalized = await renderer.normalizeColours(claims);
  for (const [index, value] of claims.entries()) check("colour", value, colours.has(normalized[index]), colourClaims.get(value)!);
  return findings;
}

function section(lines: string[], heading: string): string[] {
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^#{1,3}\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

function quotes(lines: string[]): string[] {
  return lines.join("\n").match(/(?:^>[^\n]*\n?)+/gm)?.map((quote) => quote.replace(/\n$/, "").replace(/^> ?/gm, "")) ?? [];
}

function briefFindings(lines: string[], board: Board): DesignFinding[] {
  const findings: DesignFinding[] = [];
  const brief = (board.brief ?? "").replace(/\r\n/g, "\n");
  const facts: string[] = [];
  const constraints = (board.constraints ?? []).map((quote) => quote.replace(/\r\n/g, "\n"));
  const constraintLabel = /^(?:avoid|images|musts?|must[ -]nots?|constraints?|requirements?)$/i;
  for (const match of brief.matchAll(/^\*\*([^*\n]+)\.\*\*[ \t]+([^\n]+(?:\n(?!\s*$|[-*#])[^\n]+)*)/gm)) {
    const [quote, label] = match;
    if (/^copy\b/i.test(label)) continue;
    (constraintLabel.test(label) ? constraints : facts).push(quote);
  }
  for (const [quote, label] of brief.matchAll(/^[ \t]*[-*][ \t]+([^:\n]+):[ \t]*\S[^\n]*$/gm)) {
    if (constraintLabel.test(label.trim())) constraints.push(quote);
  }
  function compare(rule: string, expected: string[], actual: string[], otherSource: string[] = []) {
    for (const value of new Set(expected)) {
      if (!actual.includes(value)) findings.push({ rule, detail: `Missing verbatim: ${JSON.stringify(value)}.` });
    }
    for (const value of new Set(actual)) {
      if (!expected.includes(value) && !otherSource.includes(value)) findings.push({ rule, detail: `No exact source match for ${JSON.stringify(value)}.` });
    }
  }
  if (board.brief !== undefined || constraints.length) {
    compare("client-constraint", constraints, quotes(section(lines, "Client musts and must-nots")));
  }
  if (board.brief === undefined) return findings;
  const prose = brief.split(/\n[ \t]*\n/).filter((paragraph) => paragraph && !/^(?:#|[-*])/.test(paragraph));
  compare("brand-fact", facts, quotes(section(lines, "Brand facts")), prose);

  const copyStart = brief.match(/^(?:\*\*(?:Campaign )?Copy\b[^\n]*\*\*|#{2,6}[ \t]+(?:Campaign )?Copy\b[^\n]*)$/im);
  const sourceCopy = copyStart ? brief.slice(copyStart.index! + copyStart[0].length).trimStart().split(/\n\s*\n/, 1)[0] : brief;
  const expected = [...sourceCopy.matchAll(/^[ \t]*[-*][ \t]+([^:\n]+):[ \t]*(\S[^\n]*)$/gm)]
    .map(([, role, copy]) => [role.trim(), copy.trimEnd()]).filter(([role]) => !constraintLabel.test(role));
  const essentials = board.essentials;
  const extra = [["Required copy", essentials?.required], ["Body copy", essentials?.body], ["Offer terms", essentials?.terms]] as const;
  for (const [role, copies] of extra) {
    for (const copy of copies ?? []) {
      if (!expected.some(([, text]) => text.includes(copy))) expected.push([role, copy]);
    }
  }
  const actual: string[][] = [];
  for (const row of section(lines, "Campaign copy")) {
    if (!row.trim().startsWith("|")) continue;
    const cells = row.trim().split(/(?<!\\)\|/);
    if (cells.length !== 4 || cells[3] !== "" || !cells[1].trim() || !cells[2].trim()) {
      findings.push({ rule: "truncated-line", detail: `Incomplete campaign copy row: ${JSON.stringify(row)}.` });
      continue;
    }
    const entry = cells.slice(1, 3).map((cell) => cell.trim().replace(/\\\|/g, "|"));
    if (entry[0] === "Role" && entry[1] === "Copy" || entry.every((cell) => /^:?-+:?$/.test(cell))) continue;
    actual.push(entry);
  }
  const hasEntry = (entries: string[][], [role, copy]: string[]) => entries.some(([r, c]) => role === r && copy === c);
  for (const entry of expected) {
    if (!hasEntry(actual, entry)) findings.push({ rule: "campaign-copy", detail: `Missing verbatim ${entry[0]}: ${JSON.stringify(entry[1])}.` });
  }
  for (const entry of actual) {
    if (!hasEntry(expected, entry)) findings.push({ rule: "campaign-copy", detail: `No exact source match for ${entry[0]}: ${JSON.stringify(entry[1])}.` });
  }
  return findings;
}

function structureFindings(lines: string[], markdown: string): DesignFinding[] {
  const findings: DesignFinding[] = [];
  const incomplete = (detail: string) => findings.push({ rule: "truncated-line", detail });
  if (/^\uFEFF?---(?:\r?\n|$)/.test(markdown) && stampOffset(markdown) <= 1) {
    incomplete("YAML front matter has no closing delimiter.");
  }
  const header = frontMatter.exec(markdown);
  if (header?.index === 0) {
    for (const [index, line] of header[0].split(/\r?\n/).entries()) {
      const scalar = line.match(/^\s*[\w-]+:\s*(["'])(.*)$/);
      if (scalar && !(scalar[1] === '"' ? /(?<!\\)"/ : /(?:^|[^'])'(?!')/).test(scalar[2])) {
        incomplete(`Line ${index + 1}: unclosed YAML string.`);
      }
    }
  }
  let fence: { marker: string; line: number } | undefined;
  let inline: { marker: string; line: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (marker?.startsWith(fence.marker) && line.trim() === marker) fence = undefined;
    } else if (marker) {
      if (inline) incomplete(`Line ${inline.line}: unclosed inline code.`);
      inline = undefined;
      fence = { marker, line: index + 1 };
    } else {
      if (inline && !line.trim()) {
        incomplete(`Line ${inline.line}: unclosed inline code.`);
        inline = undefined;
      }
      for (const [run] of line.matchAll(/(?<![\\`])`+/g)) {
        if (run === inline?.marker) inline = undefined;
        else inline ??= { marker: run, line: index + 1 };
      }
    }
    if (line.includes("\u0000") || line.includes("\uFFFD")) incomplete(`Line ${index + 1}: contains an invalid text marker.`);
  }
  if (fence) incomplete(`Line ${fence.line}: unclosed fenced block.`);
  if (inline) incomplete(`Line ${inline.line}: unclosed inline code.`);
  return findings;
}

export async function validateDesign(markdown: string, project: string, board: Board, renders: Rendered[], renderer: Renderer, localAssets?: Set<string>): Promise<DesignFinding[]> {
  const lines = markdown.split(/\r?\n/);
  const [styles, references] = await Promise.all([styleFindings(lines, renders, renderer), validateDesignReferences(markdown, project, localAssets)]);
  return [
    ...structureFindings(lines, markdown),
    ...styles,
    ...briefFindings(lines, board),
    ...references,
  ];
}
