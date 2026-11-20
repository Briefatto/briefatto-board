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
import { norm, urlLike, type Essentials } from "./essentials.js";

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

export async function checkImpeccable(findings: FloorFault[], page: Page, brandFonts?: ReadonlySet<string>): Promise<SourceFloor> {
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
    if (family && brandFonts?.has(family.trim().toLowerCase())) {
      result.designNotes.push({ ...finding, detail: `${finding.detail} (declared in frozen DESIGN.md)` });
    } else {
      result.floor.push(finding);
    }
  }
  return result;
}

/** WCAG 2.x 1.4.3: 4.5:1, or 3:1 for large text (18 pt = 24 px, or 14 pt = 18.67 px bold). */
const contrastBar = (size: number, weight: number) => (size >= 24 || (size >= 18.67 && weight >= 700) ? 3 : 4.5);

/** Text over text: two text boxes sharing at least this part of the smaller one. Tight leading can make neighbouring lines touch. */
const OVERLAP_SHARE = 0.2;

export function renderFaults(r: Rendered, fmt: BoardFormat): FloorFault[] {
  const faults: FloorFault[] = [];
  const minPx = minTextPx(fmt);
  const t = r.texts;
  t.forEach((a, i) => {
    const b = a.box;
    if (b.x < -1 || b.y < -1 || b.x + b.w > r.width + 1 || b.y + b.h > r.height + 1) faults.push({ rule: "text-off-canvas", detail: a.text.slice(0, 60), source: "render" });
    if (a.size < minPx - 0.5) faults.push({ rule: "text-too-small", detail: `${a.size}px < ${minPx}px (${MIN_SEEN_TEXT_PX}px when seen ${fmt.seenWidth}px wide): "${a.text.slice(0, 40)}"`, source: "render" });
    if (a.clipped) faults.push({ rule: "text-clipped", detail: a.text.slice(0, 60), source: "render" });
    if (!a.loaded) faults.push({ rule: "font-not-loaded", detail: `${a.family}: "${a.text.slice(0, 40)}"`, source: "render" });
    const c = r.contrast[i];
    if (c != null && c < contrastBar(a.size, a.weight)) faults.push({ rule: "low-contrast", detail: `${c}:1 "${a.text.slice(0, 40)}"`, source: "render" });
    for (let j = i + 1; j < t.length; j++) {
      if (t[j].within.includes(i) || a.within.includes(j)) continue;
      const o = t[j].box;
      const w = Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x);
      const h = Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y);
      if (w > 0 && h > 0 && (w * h) / Math.min(b.w * b.h, o.w * o.h) >= OVERLAP_SHARE) faults.push({ rule: "text-over-text", detail: `"${a.text.slice(0, 30)}" / "${t[j].text.slice(0, 30)}"`, source: "render" });
    }
  });
  // One fault per rule and detail.
  const seen = new Set<string>();
  return faults.filter((f) => !seen.has(f.rule + f.detail) && (seen.add(f.rule + f.detail), true));
}

/** Identify body copy by shared words and a minimum run length. */
const BODY_WORD_SHARE = 0.5;
const BODY_MIN_WORDS = 4;
const words = (s: string) => norm(s).replace(/[^\p{L}\p{N}\s]/gu, " ").split(" ").filter(Boolean);

/** Check the brand name when visible and, for campaign pieces, the brief's strings, body text and images. */
export function briefFaults(r: Rendered, fmt: BoardFormat, e: Essentials | undefined, brand?: string): FloorFault[] {
  if (!e && !brand) return [];
  const faults: FloorFault[] = [];
  const minPx = minTextPx(fmt), bodyPx = bodyTextPx(fmt);
  const runs = r.texts.filter((t) => norm(t.text));
  const joined = runs.map((t) => norm(t.text)).join(" ");
  const brandNorm = (text: string) => norm(text).replace(/’/g, "'");
  const wanted = [
    ...(brand && brandNorm(joined).includes(brandNorm(brand)) ? [{ s: brand, rule: "brand" }] : []),
    ...(e?.required ?? []).map((s) => ({ s, rule: "essential" })),
    ...(e?.termsExempt?.includes(fmt.id) ? [] : (e?.terms ?? []).map((s) => ({ s, rule: "term" }))),
  ];
  for (const { s: req, rule } of wanted) {
    if (fmt.id === "hero" && urlLike(req)) continue;
    const normalize = rule === "brand" ? brandNorm : norm;
    const want = normalize(req);
    if (!normalize(joined).includes(want)) { faults.push({ rule: `${rule}-missing`, detail: `"${req}"`, source: "brief" }); continue; }
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
    const names = new Set(e.assets.map((a) => a.split("/").pop()!.toLowerCase()));
    const used = r.images.some((i) => {
      const name = decodeURIComponent(i.src.split(/[?#]/)[0].split("/").pop() ?? "").toLowerCase();
      return names.has(name);
    });
    // An image inlined as data (or fetched from elsewhere) cannot be traced to a brief file by name: say so instead
    // of calling it missing. A piece passes only with a linked brief file.
    const other = r.images.filter((i) => /^(data:|https?:)/.test(i.src));
    if (!used) faults.push(other.length
      ? { rule: "asset-unproven", detail: `${other.length} image(s) inlined or remote; link one of ${[...names].join(", ")} by its file`, source: "brief" }
      : { rule: "asset-missing", detail: `none of the brief's images (${[...names].join(", ")})`, source: "brief" });
  }
  return faults;
}
