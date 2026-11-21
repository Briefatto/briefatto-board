import { createHash } from "node:crypto";
import { isMap, parseDocument } from "yaml";
import type { Board } from "./freeze.js";
import type { Rendered, Renderer } from "./render.js";
import { validateDesignReferences, type DesignFinding } from "./design-references.js";
import { deltaE, toHex } from "./metrics.js";

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

export const generatedStart = "<!-- briefatto-board:generated begin -->";
export const generatedEnd = "<!-- briefatto-board:generated end -->";

/** Keep line numbers from the published guide when checking its authored material. */
function authoredLines(markdown: string): string[] {
  let generated = false;
  return markdown.split(/\r?\n/).map((line) => {
    if (line === generatedStart) generated = true;
    if (line === generatedEnd) {
      generated = false;
      return "";
    }
    return generated ? "" : line;
  });
}

function measuredBlock(markdown: string): string {
  return markdown.split(generatedStart)[1]?.split(generatedEnd)[0] ?? "";
}

type StyleClaim = { rule: "colour" | "font-family" | "font-size"; value: string; line: number; role?: string };

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
    for (const [, value] of line.matchAll(/\bfont size(?:\s+(?:is|of|to))?\s+(\d+(?:\.\d+)?)\s*px\b/gi)) {
      yield { rule: "font-size", value: value + "px", line: index + 1 };
    }
    for (const value of values) {
      if (/^\{[^{}]+\}$/.test(value)) continue; // References name tokens, not new values.
      yield { rule: "colour", value, line: index + 1 };
    }
  }
}

export function designColourClaims(markdown: string): string[] {
  const measured = [...measuredBlock(markdown).matchAll(/^\| [^\n]+ \| `colour: ([^`\n]+)` \|$/gm)].map(([, value]) => value);
  const authored = [...styleClaims(authoredLines(markdown))].filter(({ rule }) => rule === "colour").map(({ value }) => value);
  return [...new Set([...measured, ...authored])];
}

export function designTypographyFamilies(markdown: string): Set<string> {
  const fonts = new Set<string>();
  for (const [, stack] of measuredBlock(markdown).matchAll(/^\| [^\n]+ \| `font-family: ([^`\n]+)` \|/gm)) {
    const primary = families(stack)[0];
    if (primary) fonts.add(primary.toLowerCase());
  }
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

type StyleRule = StyleClaim["rule"];

export function computedSample(source: string, r: Rendered) {
  const colours = [...new Set([...r.colours.map((c) => c.value), ...(r.designStyles?.colours ?? [])])];
  const stacks = [...new Set([...r.texts.map((t) => t.stack), ...(r.designStyles?.stacks ?? [])])];
  const sizes = [...new Set([...r.texts.map((t) => t.size), ...(r.designStyles?.sizes ?? [])])].sort((a, b) => a - b);
  const typography = new Map<string, {
    role: string; colour: string;
    fontFamily: string; fontSize: string; fontWeight: number; fontStyle: string;
    textTransform: string; letterSpacingEm: number; lineHeight: number;
  }>();
  for (const t of r.texts) {
    const style = { role: t.role ?? "other text", colour: t.color, fontFamily: t.stack, fontSize: `${t.size}px`, fontWeight: t.weight, fontStyle: t.fontStyle ?? (t.italic ? "italic" : "normal"),
      textTransform: t.transform, letterSpacingEm: t.letterSpacingEm, lineHeight: t.lineHeight };
    typography.set(JSON.stringify(style), style);
  }
  const paintedColours = [...new Map(r.colours.map(({ kind, value }) => [kind + "\0" + value, { kind, value }])).values()];
  return { source, width: r.width, height: r.height, colours, paintedColours, fontFamilies: [...new Set(stacks.flatMap(families))],
    fontStacks: stacks, fontSizes: sizes.map((size) => `${size}px`), typography: [...typography.values()], radii: r.radii };
}

type ComputedSample = ReturnType<typeof computedSample>;

function describeExpectedStyles(rule: StyleRule, claim: string, available: ReadonlyMap<string, string[]>): string {
  const claimedHex = rule === "colour" ? toHex(claim) : null;
  const distance = (value: string) => {
    if (rule === "font-size" && px.test(claim)) return Math.abs(parseFloat(value) - parseFloat(claim));
    const hex = claimedHex && toHex(value);
    return hex && claimedHex ? deltaE(claimedHex, hex) : Infinity;
  };
  let nearest = Infinity;
  let choices: string[] = [];
  for (const value of available.keys()) {
    const d = distance(value);
    if (d < nearest) {
      nearest = d;
      choices = [];
    }
    if (d === nearest) choices.push(value);
  }
  return choices.length
    ? `Use ${choices.map((value) => `${JSON.stringify(value)} from ${available.get(value)!.join(", ")}`).join("; ")}.`
    : "The chosen samples contain no values for this property.";
}

async function styleFindings(lines: string[], samples: ComputedSample[], renderer: Renderer): Promise<DesignFinding[]> {
  const byRule: Record<StyleRule, Map<string, string[]>> = { colour: new Map(), "font-family": new Map(), "font-size": new Map() };
  for (const { source, colours, fontFamilies, fontSizes } of samples) {
    for (const [rule, values] of [["colour", colours], ["font-family", fontFamilies], ["font-size", fontSizes]] as const) {
      for (const value of values) {
        const sources = byRule[rule].get(value) ?? [];
        sources.push(source);
        byRule[rule].set(value, sources);
      }
    }
  }
  const fonts = new Set([...byRule["font-family"].keys()].map((value) => value.toLowerCase()));
  const sizes = new Set([...byRule["font-size"].keys()].map(parseFloat));
  const findings: DesignFinding[] = [];
  const seen = new Set<string>();
  function check({ rule, value, line, role }: StyleClaim, present: boolean, normalized = value,
    expected = byRule[rule]) {
    const general = `${rule}\0${value.toLowerCase()}`;
    const key = role ? general + "\0" + role : general;
    if (present || seen.has(key)) return;
    seen.add(general);
    seen.add(key);
    const context = role ? ` for ${JSON.stringify(role)}` : "";
    findings.push({ rule, detail: `DESIGN.md:${line} contradicts the computed samples with ${JSON.stringify(value)}${context}. ${describeExpectedStyles(rule, normalized || value, expected)}` });
  }
  const byRole = new Map<string, Record<"colour" | "font-size", Map<string, string[]>>>();
  for (const { source, typography } of samples) {
    for (const { role, fontSize, colour } of typography) {
      const name = role.toLowerCase();
      const values = byRole.get(name) ?? { colour: new Map(), "font-size": new Map() };
      for (const [rule, value] of [["colour", colour], ["font-size", fontSize]] as const) {
        const sources = values[rule].get(value) ?? [];
        if (!sources.includes(source)) sources.push(source);
        values[rule].set(value, sources);
      }
      byRole.set(name, values);
    }
  }
  const claims = [...roleClaims(lines, byRole.keys()), ...styleClaims(lines)];
  const colourValues = [...new Set(claims.filter(({ rule }) => rule === "colour").map(({ value }) => value))];
  const normalizedColours = new Map((await renderer.normalizeColours(colourValues)).map((value, index) => [colourValues[index], value]));
  for (const claim of claims) {
    const { rule, value, role } = claim;
    if (rule === "colour") {
      const normalized = normalizedColours.get(value) ?? "";
      const expected = role ? byRole.get(role)!.colour : byRule.colour;
      check(claim, expected.has(normalized), normalized, expected);
    } else if (rule === "font-family") {
      check(claim, fonts.has(value.toLowerCase()));
    } else {
      const matchPx = value.match(px);
      const expected = role ? byRole.get(role)!["font-size"] : byRule["font-size"];
      const allowed = role ? new Set([...expected.keys()].map(parseFloat)) : sizes;
      check(claim, !!matchPx && allowed.has(Number(matchPx[1])), value, expected);
    }
  }
  return findings;
}

function* roleClaims(lines: string[], roles: Iterable<string>): Generator<StyleClaim> {
  const names = [...roles].sort((a, b) => b.length - a.length).map((role) => role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!names.length) return;
  const role = `(${names.join("|")})`;
  const colour = `(${literalColour.source})`;
  const afterRole = new RegExp(`\\b${role} font size (?:is |of )?(\\d+(?:\\.\\d+)?)\\s*px\\b`, "gi");
  const beforeRole = new RegExp(`\\b(?:use|set) (?:an? )?(\\d+(?:\\.\\d+)?)\\s*px ${role}(?=[.!?,;]|\\s*$)`, "gi");
  const colourRole = new RegExp(`\\buse \`?${colour}\`? for (?:the )?${role}(?: text)?(?=[.!?,;]|\\s*$)`, "gi");
  for (const [index, line] of lines.entries()) {
    for (const [, name, size] of line.matchAll(afterRole)) {
      yield { rule: "font-size", value: size + "px", line: index + 1, role: name.toLowerCase() };
    }
    for (const [, size, name] of line.matchAll(beforeRole)) {
      yield { rule: "font-size", value: size + "px", line: index + 1, role: name.toLowerCase() };
    }
    for (const [, value, name] of line.matchAll(colourRole)) {
      yield { rule: "colour", value, line: index + 1, role: name.toLowerCase() };
    }
  }
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

export interface SourceQuote { value: string; source: string }
interface CampaignRow { role: string; copy: string; source: string }

export function briefExpectations(board: Pick<Board, "brief" | "essentials">, remembered: SourceQuote[], rawBrief = board.brief) {
  const original = (rawBrief ?? "").replace(/\r\n/g, "\n");
  const brief = original.trim();
  const briefStart = original.length - original.trimStart().length;
  const sourceAt = (index: number) => `brief.md:${original.slice(0, briefStart + index).split("\n").length}`;
  const brandFacts: SourceQuote[] = [];
  const clientConstraints = remembered.map(({ value, source }) => ({ value: value.replace(/\r\n/g, "\n"), source }));
  const constraintLabel = /^(?:avoid|images|musts?|must[ -]nots?|constraints?|requirements?)$/i;
  for (const match of brief.matchAll(/^\*\*([^*\n]+)\.\*\*[ \t]+([^\n]+(?:\n(?!\s*$|[-*#])[^\n]+)*)/gm)) {
    const [value, label] = match;
    if (/^copy\b/i.test(label)) continue;
    (constraintLabel.test(label) ? clientConstraints : brandFacts).push({ value, source: sourceAt(match.index) });
  }
  for (const match of brief.matchAll(/^[ \t]*[-*][ \t]+([^:\n]+):[ \t]*\S[^\n]*$/gm)) {
    if (constraintLabel.test(match[1].trim())) clientConstraints.push({ value: match[0], source: sourceAt(match.index) });
  }
  const uniqueConstraints = [...new Map(clientConstraints.map((quote) => [quote.value, quote])).values()];
  if (rawBrief === undefined) return { clientConstraints: uniqueConstraints };
  const acceptedBrandFacts: SourceQuote[] = [];
  let offset = 0;
  for (const value of brief.split(/\n[ \t]*\n/)) {
    const index = brief.indexOf(value, offset);
    if (value && !/^(?:#|[-*] |\*\*)/.test(value) && !/^Make (?:our|the) brand and launch kit\.?$/i.test(value)) {
      acceptedBrandFacts.push({ value, source: sourceAt(index) });
    }
    offset = index + value.length;
  }
  const copyStart = brief.match(/^(?:\*\*(?:Campaign )?Copy\b[^\n]*\*\*|#{2,6}[ \t]+(?:Campaign )?Copy\b[^\n]*)$/im);
  const afterHeading = copyStart ? brief.slice(copyStart.index! + copyStart[0].length) : brief;
  const sourceCopy = copyStart ? afterHeading.trimStart().split(/\n\s*\n/, 1)[0] : brief;
  const copyOffset = copyStart ? brief.length - afterHeading.trimStart().length : 0;
  const campaignCopy: CampaignRow[] = [];
  for (const match of sourceCopy.matchAll(/^[ \t]*[-*][ \t]+([^:\n]+):[ \t]*(\S[^\n]*)$/gm)) {
    const role = match[1].trim();
    if (!constraintLabel.test(role)) campaignCopy.push({ role, copy: match[2].trimEnd(), source: sourceAt(copyOffset + match.index) });
  }
  const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
  const quotedCopy = /"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`/g;
  for (const { value, source } of acceptedBrandFacts) {
    // Sentence punctuation inside approved copy does not end the surrounding instruction.
    const text = value.replace(quotedCopy, (quote) => quote.replace(/[.!?]/g, "·"));
    const startLine = Number(source.slice("brief.md:".length));
    for (const { segment, index } of sentences.segment(text)) {
      const original = value.slice(index, index + segment.length);
      const wording = original.trim();
      const line = startLine + value.slice(0, index + original.length - original.trimStart().length).split("\n").length - 1;
      const sentenceSource = `brief.md:${line}`;
      if (/^(?:please (?:avoid|don't|do not|steer clear|use|work with|keep|include)|don't|do not|no|keep|put|use|include)\b/i.test(wording)) {
        uniqueConstraints.push({ value: wording, source: sentenceSource });
      }
      const list = wording.match(/^(?:please use|the words (?:we['’]ve|we have) signed off are|the exact [^\n.!?]*? commands are)\s+(.+)/i)?.[1];
      if (!list) continue;
      for (const match of list.matchAll(quotedCopy)) {
        const copy = match[1] ?? match[2] ?? match[3];
        if (!campaignCopy.some((entry) => entry.copy === copy)) campaignCopy.push({ role: "Approved copy", copy, source: sentenceSource });
      }
    }
  }
  const extra = [["Required copy", "required"], ["Body copy", "body"], ["Offer terms", "terms"]] as const;
  for (const [role, field] of extra) {
    const e = board.essentials;
    for (const [index, copy] of (e?.[field] ?? []).entries()) {
      if (campaignCopy.some((entry) => entry.copy.includes(copy))) continue;
      const source = e?.source === "essentials.json" ? `essentials.json ${field}[${index}]` : "brief.md";
      campaignCopy.push({ role, copy, source });
    }
  }
  for (const [format, required] of Object.entries(board.essentials?.requiredByFormat ?? {})) {
    for (const copy of new Set(required)) {
      const index = brief.indexOf(copy);
      if (index >= 0) campaignCopy.push({ role: `Required on ${format}`, copy, source: sourceAt(index) });
    }
  }
  return { brandFacts, acceptedBrandFacts, clientConstraints: [...new Map(uniqueConstraints.map((quote) => [quote.value, quote])).values()], campaignCopy };
}

function briefFindings(lines: string[], expectations: ReturnType<typeof briefExpectations>): DesignFinding[] {
  const findings: DesignFinding[] = [];
  function compare(rule: string, heading: string, expected: SourceQuote[], accepted: SourceQuote[] = []) {
    const actual = quotes(section(lines, heading));
    for (const value of new Set(actual)) {
      const sources = [...expected, ...accepted];
      if (sources.some((quote) => quote.value === value)) continue;
      const alternatives = sources.map((quote) => `${JSON.stringify(quote.value)} from ${quote.source}`);
      const hint = alternatives.length ? ` Use ${alternatives.join("; ")} verbatim.` : "";
      findings.push({ rule, detail: `No exact source match for ${JSON.stringify(value)} under "### ${heading}".${hint}` });
    }
  }
  const { brandFacts, acceptedBrandFacts, clientConstraints, campaignCopy } = expectations;
  if (brandFacts || clientConstraints.length) {
    compare("client-constraint", "Client musts and must-nots", clientConstraints);
  }
  if (!brandFacts || !campaignCopy) return findings;
  compare("brand-fact", "Brand facts", brandFacts, acceptedBrandFacts);

  const actual: Array<Pick<CampaignRow, "role" | "copy">> = [];
  for (const row of section(lines, "Campaign copy")) {
    if (!row.trim().startsWith("|")) continue;
    const cells = row.trim().split(/(?<!\\)\|/);
    if (cells.length !== 4 || cells[3] !== "" || !cells[1].trim() || !cells[2].trim()) {
      findings.push({ rule: "truncated-line", detail: `Incomplete campaign copy row: ${JSON.stringify(row)}.` });
      continue;
    }
    const [role, copy] = cells.slice(1, 3).map((cell) => cell.trim().replace(/\\\|/g, "|"));
    if (role === "Role" && copy === "Copy" || [role, copy].every((cell) => /^:?-+:?$/.test(cell))) continue;
    actual.push({ role, copy });
  }
  const hasEntry = (entries: Array<Pick<CampaignRow, "role" | "copy">>, { role, copy }: Pick<CampaignRow, "role" | "copy">) =>
    entries.some((entry) => role === entry.role && copy === entry.copy);
  for (const entry of actual) {
    if (hasEntry(campaignCopy, entry)) continue;
    const roles = campaignCopy.filter(({ role }) => role === entry.role);
    const choices = roles.length ? roles : campaignCopy;
    const alternatives = choices.map(({ role, copy, source }) => `${JSON.stringify(role)} with ${JSON.stringify(copy)} from ${source}`);
    const hint = alternatives.length ? ` Use ${alternatives.join("; ")} verbatim.` : "";
    findings.push({ rule: "campaign-copy", detail: `No exact source match for ${JSON.stringify(entry.role)} with ${JSON.stringify(entry.copy)}.${hint}` });
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

export interface GuideInputs {
  brief: ReturnType<typeof briefExpectations>; samples: ComputedSample[];
}

export async function validateDesign(markdown: string, project: string, inputs: GuideInputs,
  renderer: Renderer, localAssets?: Set<string>): Promise<DesignFinding[]> {
  const lines = authoredLines(markdown);
  const prose = lines.join("\n");
  const [styles, references] = await Promise.all([styleFindings(lines, inputs.samples, renderer), validateDesignReferences(prose, project, localAssets)]);
  return [
    ...structureFindings(lines, prose),
    ...styles,
    ...briefFindings(lines, inputs.brief),
    ...references,
  ];
}
