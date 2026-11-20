import type { Board } from "./freeze.js";
import { quotedConstraints } from "./constraints.js";
import { diffBoards } from "./diff.js";
import type { TypeRole } from "./metrics.js";

const quote = (value: string) => JSON.stringify(value);
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

export function describeChange(previous: Board | undefined, current: Board): string {
  if (!previous) return current.note ? `First freeze. ${oneLine(current.note)}` : "First freeze.";
  if (current.note.trim()) return oneLine(current.note);
  const changes = diffBoards(previous, current);
  const topics = ([
    ["brand identity", /^(Brand name|Direction)/],
    ["brief and copy", /^(Brief|Required copy|Offer terms|Body copy)/],
    ["client constraints", /^Remembered constraints/],
    ["palette", /^Colour/],
    ["typography", /^(Type|Font)/],
    ["graphic device", /^Device/],
    ["imagery", /^Image/],
    ["layout and samples", /^Composition/],
    ["shapes and depth", /^(Corner|Full corner|Shadows)/],
  ] as const).filter(([, pattern]) => changes.some((change) => pattern.test(change))).map(([topic]) => topic);
  return topics.length ? `Updated ${topics.join(", ")}.` : "Updated the frozen samples and file.";
}

function nestedMarkdown(text: string, level: number, title: string): string {
  const [first, ...rest] = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const lines = first.match(/^#\s+(.+)$/)?.[1] === title ? rest : [first, ...rest];
  let fence: string | undefined;
  return lines.map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (marker?.startsWith(fence) && line.trim() === marker) fence = undefined;
      return line;
    }
    if (marker) fence = marker;
    return line.replace(/^#{1,6}(?= )/, "#".repeat(level));
  }).join("\n").trim();
}

function fallbackStack(stack: string): string {
  return stack.includes(",") || /^(?:(?:sans-|ui-)?serif|(?:ui-)?monospace|ui-sans-serif|system-ui|cursive|fantasy|math|fangsong)$/i.test(stack)
    ? stack : `${stack}, sans-serif`;
}

export function designMd(b: Board): string {
  const ground = b.palette.find((p) => p.role === "ground");
  const ink = b.palette.find((p) => p.role === "ink");
  const accents = b.palette.filter((p) => p.role === "accent");
  const colors: Array<[string, string]> = [];
  const primary = accents[0] ?? ink ?? ground;
  if (primary) colors.push(["primary", primary.hex]);
  if (ground) colors.push(["neutral", ground.hex]);
  if (ink) colors.push(["on-neutral", ink.hex]);
  accents.slice(1).forEach((p, i) => colors.push([`accent-${i + 2}`, p.hex]));
  const hero = b.samples.find((s) => s.format === "hero") ?? b.samples[0];
  const short = hero.canvas ? Math.min(hero.canvas.width, hero.canvas.height) : hero.format === "hero" ? 900 : 1080;
  const displaySize = hero.composition.displayShare * short;
  const roles = Object.entries(b.type) as Array<[string, TypeRole | undefined]>;
  const typo = roles.flatMap(([k, t]) => t ? [
    `  ${k}:`, `    fontFamily: ${quote(t.family)}`,
    `    fontSize: ${Math.round(k === "display" ? displaySize : displaySize / hero.composition.sizeRatio)}px`,
    `    fontWeight: ${t.weight}`, `    lineHeight: ${t.lineHeight}`, `    letterSpacing: ${t.letterSpacingEm}em`,
  ] : []);
  const declaredFamilies = new Set(roles.flatMap(([, role]) => role ? [role.family.toLowerCase()] : []));
  for (const [index, { family }] of b.fonts.entries()) {
    const normalized = family.toLowerCase();
    if (declaredFamilies.has(normalized)) continue;
    declaredFamilies.add(normalized);
    typo.push(`  font-family-${index + 1}:`, `    fontFamily: ${quote(family)}`);
  }
  const margin = b.composition.marginShare;
  const brief = nestedMarkdown(b.brief ?? "", 4, b.name);
  const essentials = b.essentials;
  const extraBody = essentials?.body.filter((copy) => !brief.includes(copy)) ?? [];
  const direction = nestedMarkdown(b.direction.text, 3, b.direction.title);
  const assets = b.briefAssets ?? [];
  const linked = assets.filter(({ url }) => !url.startsWith("data:"));
  const embedded = assets.filter(({ url }) => url.startsWith("data:"));
  const date = b.frozenAt.slice(0, 10);
  const change = b.changeSummary ?? (b.version === 1 ? "First freeze." : oneLine(b.note));

  return [
    "---",
    "version: alpha",
    `name: ${quote(b.name)}`,
    `description: ${quote(`Board v${b.version} · ${date} · ${b.direction.title}`)}`,
    ...(colors.length ? ["colors:", ...colors.map(([k, v]) => `  ${k}: ${quote(v)}`)] : []),
    ...(typo.length ? ["typography:", ...typo] : []),
    ...(b.radii.px.length || b.radii.full ? ["rounded:", ...b.radii.px.map((r, i) => `  r${i + 1}: ${r}px`), ...(b.radii.full ? ["  full: 9999px"] : [])] : []),
    "spacing:",
    `  margin: ${Math.round(Math.round((margin[0] + margin[1]) * 500) * short / 1000)}px`,
    "---",
    "",
    "## Overview",
    "",
    `**Board v${b.version} · ${date}.** ${b.version === 1 ? "" : `Changed since v${b.version - 1} — `}${change}`,
    ...(direction ? ["", direction] : []),
    ...(brief || essentials?.required.length || essentials?.terms?.length || extraBody.length || essentials?.assets.length ? [
      "", "### Brand facts and brief",
      ...(brief ? ["", brief] : []),
      ...(essentials?.required.length ? ["", `For this campaign, keep the required copy verbatim (${essentials.required.map(quote).join(", ")}).`] : []),
      ...(essentials?.terms?.length ? [`For this campaign, keep the offer terms verbatim (${essentials.terms.map(quote).join(", ")})${essentials.termsExempt?.length ? ` (optional on ${essentials.termsExempt.join(", ")})` : ""}.`] : []),
      ...extraBody.map((copy) => `Body copy: ${quote(copy)}`),
      ...(essentials?.assets.length ? [`Campaign assets (${essentials.assetUse}): ${essentials.assets.join(", ")}.`] : []),
      ...linked.map(({ name, url }) => `- [${name}](<${url}>)`),
      ...(embedded.length ? ["Extract embedded asset data from the end of this file as needed."] : []),
    ] : []),
    ...(b.constraints?.length ? ["", "### Client musts and must-nots", ...quotedConstraints(b.constraints)] : []),
    ...(colors.length ? ["", "## Colors", "", `Use ${[ground && `\`${ground.hex}\` as ground`, ink && `\`${ink.hex}\` as ink`, accents.length && "the other colours as accents"].filter(Boolean).join(", ")}.`] : []),
    "",
    "## Typography",
    "",
    ...b.fonts.map((f) => `- ${f.family} (${f.weights.join(", ")}) uses \`font-family: ${fallbackStack(f.stack)};\`.`),
    ...b.fontLinks.map((l) => `- Load with \`<link rel="stylesheet" href="${l.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">\`.`),
    ...(b.fontFaces ?? []).map((face) => `- Load with \`${face}\`.`),
    ...(b.type.display ? [`- Display size is ${b.composition.displayShare.join(" to ")} of the canvas's short side. ${b.type.display.transform === "none" ? "Use the copy's case" : `Use ${b.type.display.transform}`}${b.type.display.italic ? " and italic" : ""}.`] : []),
    ...(b.type.body ? [`- Display is ${b.composition.sizeRatio.join(" to ")} times the body size${b.type.body.italic ? ". Use italic body text" : ""}.`] : []),
    "",
    "## Layout",
    "",
    `- Use ${b.composition.align.join(" or ")} alignment and leave ${margin.join(" to ")} of the short side as breathing room.`,
    "- Consider a side-by-side layout for wide space or a vertical sequence for tall space. Recompose for each format's shape and each side's purpose. Never repeat one frame.",
    ...(b.device.present ? [`- Redraw the graphic device on each piece. Use ${b.device.colours.join(", ")} with a longest side of ${b.device.sizeShare.join(" to ")} of the canvas's short side as a starting point.`] : []),
    "",
    "## Elevation & Depth",
    "",
    b.shadows ? "Use shadows." : "Keep surfaces flat.",
    "",
    "## Shapes",
    "",
    `- ${b.radii.px.length || b.radii.full ? `Use ${[...b.radii.px.map((r) => `${r}px`), ...(b.radii.full ? ["full"] : [])].join(" or ")} corner rounding` : "Keep corners square"}.`,
    ...(b.images.used ? [`- For imagery use ${b.images.fits.join(" or ")} fit, ${b.images.filters.join(" or ")} filter and ${b.images.radii.join(" or ")}px corners.`] : []),
    ...(embedded.length ? ["", "### Supplied assets", "", "```jsonl", ...embedded.map((asset) => JSON.stringify(asset)), "```"] : []),
    "",
  ].join("\n");
}
