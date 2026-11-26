// The shared floor ("no AI smell"), the same for every brand: Impeccable's deterministic detector on the source, plus
// faults only a rendered picture shows (text past the canvas or clipped, text over text, a font that never loaded,
// text below the WCAG 2.x contrast bar).

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { env, execPath, platform } from "node:process";
import type { Page } from "playwright";
import type { Rendered } from "./render.js";
import { bodyTextPx, minTextPx, MIN_SEEN_TEXT_PX, type BoardFormat } from "./formats.js";
import { toHex } from "./metrics.js";
import { copyWhitespace, isSuppliedImage, matchesCampaignCopy, norm, requiredCampaignCopy, urlLike, type Essentials } from "./essentials.js";

export interface FloorFault { rule: string; detail: string; source: "impeccable" | "render" | "brief" }
export interface DismissedFloorFault extends FloorFault { reason: string }
export interface SourceFloor { floor: FloorFault[]; dismissed: DismissedFloorFault[]; designNotes: FloorFault[] }

/** Impeccable 4.10.0 (Apache-2.0). `BOARD_IMPECCABLE` may point to a native executable; otherwise npx fetches the pinned version. */
export function impeccable(htmlPath: string): FloorFault[] {
  const commandArgs = ["detect", "--json", htmlPath];
  const bin = env.BOARD_IMPECCABLE;
  let out = "";
  try {
    const options: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 };
    if (bin) {
      out = execFileSync(bin, commandArgs, options);
    } else {
      const npxArgs = ["-y", "impeccable@4.10.0", ...commandArgs];
      if (platform === "win32") {
        // The Windows npx shim is a batch script. Call its Node entry point directly.
        const npmRoots = [dirname(execPath), ...(env.PATH ?? "").split(delimiter).filter(Boolean)];
        const npx = npmRoots.map((dir) => join(dir, "node_modules", "npm", "bin", "npx-cli.js")).find(existsSync);
        if (!npx) throw new Error("Could not find npm's npx CLI. Install npm or set BOARD_IMPECCABLE to a native Impeccable executable.");
        out = execFileSync(execPath, [npx, ...npxArgs], options);
      } else {
        out = execFileSync("npx", npxArgs, options);
      }
    }
  } catch (e: any) {
    // Exit 2 means findings; stdout still carries the JSON.
    if (e.status !== 2) return [{ rule: "impeccable-failed", detail: String(e.stderr ?? e.message).slice(0, 300), source: "impeccable" }];
    out = e.stdout;
  }
  const seen = new Set<string>();
  const faults: FloorFault[] = [];
  for (const f of JSON.parse(out || "[]") as Array<{ antipattern: string; snippet: string; severity: string }>) {
    const key = f.antipattern + f.snippet;
    if (seen.has(key) || f.severity === "advisory") continue;
    seen.add(key);
    faults.push({ rule: f.antipattern, detail: f.snippet, source: "impeccable" });
  }
  return faults;
}

const wrapperPadding = /^<([\w-]+)>(?: "([^"]+)")?: children flush against .+ on (?:all sides|(?:top|right|bottom|left)(?:\/(?:top|right|bottom|left))*) \(no inset\)$/;

const systemFont = /^(\S+) "([^"]*)" uses (.+?); (not declared in DESIGN\.md typography)$/;

/**
 * Impeccable reads a CSS `font:` shorthand by splitting on spaces, so `font: 600 32px/1 "JetBrains Mono",monospace` comes back
 * as the family `Mono",monospace`. The browser has already parsed the shorthand (style, variant, weight, size, line height,
 * then the family list), so ask it for each element's first family. A first family the guide declares was never a finding.
 */
async function cleanFontFindings(findings: FloorFault[], page: Page, brandFonts?: ReadonlySet<string>): Promise<FloorFault[]> {
  const asked = findings.flatMap(({ rule, detail }) => {
    const match = rule === "design-system-font" ? systemFont.exec(detail) : null;
    return match ? [{ detail, tag: match[1], text: match[2] }] : [];
  });
  if (!asked.length) return findings;
  const read = new Map(await page.evaluate((asked) => asked.map(({ detail, tag, text }) => {
    const families: string[] = [];
    for (const element of document.getElementsByTagName(tag)) {
      if (!(element.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(text)) continue;
      const stack = getComputedStyle(element).fontFamily;
      const first = (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]+)/.exec(stack)?.[0] ?? stack).trim();
      families.push(first.replace(/^["']|["']$/g, "").replace(/\\(["'\\])/g, "$1"));
    }
    return [detail, families] as const;
  }), asked));
  return findings.flatMap((finding) => {
    const families = read.get(finding.detail);
    const match = finding.rule === "design-system-font" ? systemFont.exec(finding.detail) : null;
    if (!families?.length || !match) return [finding];
    const undeclared = families.find((family) => !brandFonts?.has(family.toLowerCase()));
    return undeclared === undefined ? [] : [{ ...finding, detail: `${match[1]} "${match[2]}" uses ${undeclared}; ${match[4]}` }];
  });
}

export async function checkImpeccable(detected: FloorFault[], page: Page, brandFonts?: ReadonlySet<string>, brandColours?: ReadonlySet<string>): Promise<SourceFloor> {
  const findings = await cleanFontFindings(detected, page, brandFonts);
  const wrappers = findings.flatMap(({ rule, detail }) => {
    const match = rule === "cramped-padding" ? wrapperPadding.exec(detail) : null;
    if (!match) return [];
    const [, tag, firstClass] = match;
    return [{ detail, tag, firstClass }];
  });
  const measured = wrappers.length ? await page.evaluate((wrappers) => wrappers.map(({ detail, tag, firstClass }) => {
    let minimum = Infinity;
    // The detector labels wrappers by tag and first class, so every matching instance must clear the check.
    const candidates = firstClass === undefined ? document.getElementsByTagName(tag) : document.getElementsByClassName(firstClass);
    for (const element of candidates) {
      if (element.localName !== tag || (element.classList.item(0) ?? undefined) !== firstClass || !element.getClientRects().length) continue;
      const { paddingTop, paddingRight, paddingBottom, paddingLeft } = getComputedStyle(element);
      minimum = Math.min(minimum, ...[paddingTop, paddingRight, paddingBottom, paddingLeft].map(Number.parseFloat));
    }
    return [detail, Number.isFinite(minimum) ? minimum : null] as const;
  }), wrappers) : [];
  const padding = new Map(measured);
  const result: SourceFloor = { floor: [], dismissed: [], designNotes: [] };
  for (const finding of findings) {
    const inset = finding.rule === "cramped-padding" ? padding.get(finding.detail) : undefined;
    // The detector flags insets at 2 CSS pixels or less. The cascade can change which side is tight.
    if (inset != null && inset > 2) {
      result.dismissed.push({ ...finding, reason: `dismissed: rendered padding ${inset} px` });
      continue;
    }
    const family = finding.rule === "overused-font" ? /^Primary font: (.+)$/.exec(finding.detail)?.[1] : undefined;
    // A page colour the client chose and froze is the brand's palette, not a default the model fell into.
    const ground = finding.rule === "cream-palette" ? /rgba?\([^)]*\)/.exec(finding.detail)?.[0] : undefined;
    const groundHex = ground ? toHex(ground) : null;
    if ((family && brandFonts?.has(family.trim().toLowerCase())) || (groundHex && brandColours?.has(groundHex))) {
      result.designNotes.push({ ...finding, detail: `${finding.detail} (declared in frozen DESIGN.md)` });
    } else {
      result.floor.push(finding);
    }
  }
  return result;
}

/** WCAG 2.x 1.4.3: 4.5:1, or 3:1 for large text (18 pt = 24 px, or 14 pt = 18.67 px bold). */
const contrastBar = (size: number, weight: number) => (size >= 24 || (size >= 18.67 && weight >= 700) ? 3 : 4.5);

export function formatNotes(r: Rendered, fmt: BoardFormat): FloorFault[] {
  if (fmt.kind !== "print") return [];
  return [...new Set((r.actions ?? []).filter((a) => a.buttonTreatment && a.fragments.length).map((a) => a.text))].map((text) => ({
    rule: "print-web-cta", detail: `Button treatment on print copy: "${text}"`, source: "render",
  }));
}

export function renderFaults(r: Rendered, fmt: BoardFormat): FloorFault[] {
  const faults: FloorFault[] = [];
  const minPx = minTextPx(fmt);
  r.texts.forEach((a, i) => {
    if (a.size < minPx - 0.5) faults.push({ rule: "text-too-small", detail: `${a.size}px < ${minPx}px (${MIN_SEEN_TEXT_PX}px when seen ${fmt.seenWidth}px wide): "${a.text.slice(0, 40)}"`, source: "render" });
    if (!a.loaded) faults.push({ rule: "font-not-loaded", detail: `${a.family}: "${a.text.slice(0, 40)}"`, source: "render" });
    const c = r.contrast[i];
    if (c != null && c < contrastBar(a.size, a.weight)) faults.push({ rule: "low-contrast", detail: `${c}:1 "${a.text.slice(0, 40)}"`, source: "render" });
  });
  const copy = r.copy ?? [];
  const zones = fmt.kind === "story" ? fmt.safeZones : undefined;
  for (const a of copy) {
    const detail = a.text.slice(0, 60);
    if (a.offCanvas) faults.push({ rule: "text-off-canvas", detail, source: "render" });
    else if (a.clipped) faults.push({ rule: "text-clipped", detail, source: "render" });
    if (zones) {
      const edges = [
        zones.top && a.fragments.some((b) => b.y < zones.top) ? "top" : "",
        zones.right && a.fragments.some((b) => b.x + b.w > r.width - zones.right) ? "right" : "",
        zones.bottom && a.fragments.some((b) => b.y + b.h > r.height - zones.bottom) ? "bottom" : "",
        zones.left && a.fragments.some((b) => b.x < zones.left) ? "left" : "",
      ].filter(Boolean);
      if (edges.length) faults.push({ rule: "story-unsafe-copy", detail: `"${detail}" in ${edges.join(", ")} unsafe zone`, source: "render" });
    }
  }
  for (const a of r.actions ?? []) {
    if (a.offCanvas || a.clipped) faults.push({ rule: "cta-clipped", detail: a.text.slice(0, 60), source: "render" });
  }
  const fragments = copy.flatMap(({ text, fragments }, run) => fragments.map((box) => ({ text, box, run }))).sort((a, b) => a.box.y - b.box.y);
  for (const [i, a] of fragments.entries()) {
    const b = a.box;
    for (let j = i + 1; j < fragments.length; j++) {
      const o = fragments[j].box;
      // Use the same one-CSS-pixel tolerance as edge clipping, for range rounding.
      if (o.y >= b.y + b.h - 1) break;
      if (a.run === fragments[j].run) continue;
      const w = Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x);
      const h = Math.min(b.y + b.h, o.y + o.h) - o.y;
      if (w > 1 && h > 1) faults.push({ rule: "text-over-text", detail: `"${a.text.slice(0, 30)}" / "${fragments[j].text.slice(0, 30)}"`, source: "render" });
    }
  }
  // One fault per rule and detail.
  const seen = new Set<string>();
  return faults.filter((f) => !seen.has(f.rule + f.detail) && (seen.add(f.rule + f.detail), true));
}

/** Identify body copy by shared words and a minimum run length. */
const BODY_WORD_SHARE = 0.5;
const BODY_MIN_WORDS = 4;
const words = (s: string) => norm(s).replace(/[^\p{L}\p{N}\s]/gu, " ").split(" ").filter(Boolean);

/** Check the brand name when visible and, for campaign pieces, the brief's strings, body text and images. */
export function briefFaults(r: Rendered, fmt: BoardFormat, e: Essentials | undefined, brand?: string, project?: string): FloorFault[] {
  if (!e && !brand) return [];
  const faults: FloorFault[] = [];
  const minPx = minTextPx(fmt), bodyPx = bodyTextPx(fmt);
  const runs = r.texts.filter((t) => !t.clipped && norm(t.text));
  const joined = r.visibleText ?? runs.map((t) => t.text).join(" ");
  const brandNorm = (text: string) => norm(text).replace(/’/g, "'");
  const { required, terms } = requiredCampaignCopy(e, fmt.id);
  const wanted = [
    ...(brand && !(fmt.id === "hero" && urlLike(brand)) && brandNorm(joined).includes(brandNorm(brand)) ? [{ s: brand, rule: "brand" }] : []),
    ...required.map((s) => ({ s, rule: "essential" })),
    ...terms.map((s) => ({ s, rule: "term" })),
  ];
  for (const { s: req, rule } of wanted) {
    const normalize = rule === "brand" ? brandNorm : copyWhitespace;
    const want = normalize(req);
    const present = rule === "brand" ? brandNorm(joined).includes(want) : matchesCampaignCopy(joined, req);
    if (!present) { faults.push({ rule: `${rule}-missing`, detail: `"${req}"`, source: "brief" }); continue; }
    const parts = runs.filter((t) => { const n = normalize(t.text); return n.length > 1 && (want.includes(n) || n.includes(want)); });
    const small = parts.filter((t) => t.size < minPx - 0.5);
    if (small.length) faults.push({ rule: `${rule}-too-small`, detail: `"${req}" at ${Math.min(...small.map((t) => t.size))}px < ${minPx}px`, source: "brief" });
  }
  if (!e) return faults;
  const bodyWords = e.body.map((b) => new Set(words(b)));
  for (const t of runs) {
    const w = words(t.text);
    if (w.length < BODY_MIN_WORDS) continue;
    const isBody = bodyWords.some((bw) => w.filter((x) => bw.has(x)).length / w.length >= BODY_WORD_SHARE);
    if (isBody && e.bodyFloor !== "minimum" && t.size < bodyPx - 0.5) faults.push({ rule: "body-too-small", detail: `${t.size}px < ${bodyPx}px (body size where seen): "${t.text.slice(0, 50)}"`, source: "brief" });
  }
  if (e.assetUse === "required" && e.assets.length) {
    const used = r.images.some((image) => e.assets.some((name) => isSuppliedImage(name, image.src, project)));
    const names = e.assets.join(", ");
    // Unlisted URLs and data URLs cannot be traced to a supplied file.
    const other = r.images.filter((i) => /^(data:|https?:)/.test(i.src));
    if (!used) faults.push(other.length
      ? { rule: "asset-unproven", detail: `${other.length} image(s) inlined or remote; link one of ${names} by its recorded path`, source: "brief" }
      : { rule: "asset-missing", detail: `none of the brief's images (${names})`, source: "brief" });
  }
  return faults;
}
