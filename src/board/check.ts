// Check the shared floor, the brief's literal requirements, and consistency with the frozen board.
// Composition comparisons are informational.

import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { designColourClaims, designTypographyFamilies } from "./design-validation.js";
import { briefBrand, campaignEssentials, requiredCampaignCopy, type Essentials } from "./essentials.js";
import type { Board } from "./freeze.js";
import { findProjectFormats, formatById, formatOfFile, isFormatFile, type BoardFormat } from "./formats.js";
import { briefFaults, checkImpeccable, formatNotes, impeccable, renderFaults, type DismissedFloorFault, type FloorFault, type SourceFloor } from "./floor.js";
import { composition, deltaE, JND_DE76, toHex, typeRoles, type Composition } from "./metrics.js";
import { readPiece } from "./pieces.js";
import { Renderer, type Rendered } from "./render.js";
import { versionLabel } from "./versions.js";

interface OutsideValue {
  kind: "colour" | "font";
  value: string;
  previousVersion?: string;
  previousRole?: string;
}

interface CheckCoverage {
  ran: string[];
  skipped: Array<{ check: string; reason: string }>;
}

const campaignChecks = {
  copy: "campaign copy", body: "campaign body reading size", images: "campaign images",
};

interface FloorCheckResult {
  file: string;
  format: string;
  png: string;
  pass: boolean;
  floor: FloorFault[];
  dismissed: DismissedFloorFault[];
  checks: CheckCoverage;
  designNotes: FloorFault[];
}

export interface DefaultCheckResult extends FloorCheckResult {
  /** The brief's requested strings, body size and images (essentials.ts). */
  brief: FloorFault[];
  briefApplied: boolean;
  briefScope: string;
  outsideValues: OutsideValue[];
}

export interface CheckResult extends DefaultCheckResult {
  consistency: {
    offPalette: Array<{ hex: string; kind: string; nearest: string; deltaE: number; areaShare: number }>;
    offFonts: string[];
    deviceMissing: boolean;
    /** Informational: samples of another shape whose arrangement this piece repeats. */
    resizedFrom: string[];
    display: { family: boolean; weight: boolean; case: boolean };
  };
  /** Informational: the family this piece is composed in and its values beside that sample's. */
  family: { name: string; declared: boolean; beside: string[] };
  /** Informational: the output's composition beside the board's sample range. */
  composition: Composition & { outside: string[] };
  radiiOutside: number[];
}

/** A piece repeats a sample's arrangement when the display text's centre, the largest image's centre and the first
 * device's centre fall in the same rule-of-thirds cells (a 3x3 grid over the canvas) as in that sample, on a canvas
 * whose aspect differs from the sample's by more than RESIZE_ASPECT (10%). */
const RESIZE_ASPECT = Math.log(1.1);
const third = (v: number) => Math.min(2, Math.max(0, Math.floor(v * 3)));
const cell = (c: [number, number] | null) => (c ? `${third(c[0])}${third(c[1])}` : "-");
const centre = (b: number[] | null | undefined): [number, number] | null => (b ? [b[0] + b[2] / 2, b[1] + b[3] / 2] : null);
export function arrangement(c: Composition): string {
  return [cell(c.anchor), cell(centre(c.imageBox)), cell(centre(c.deviceBoxes[0]))].join("/");
}
export function sameArrangement(a: Composition, b: Composition): boolean {
  return arrangement(a) === arrangement(b);
}

async function frozenColours(renderer: Renderer, designs: ReadonlyMap<number, string>) {
  const claims = [...designs].flatMap(([version, design]) => designColourClaims(design).map((value) => ({ version, value })));
  const normalized = await renderer.normalizeColours(claims.map(({ value }) => value));
  const colours = new Map<number, Set<string>>();
  for (const [index, { version }] of claims.entries()) {
    const values = colours.get(version) ?? new Set<string>();
    if (normalized[index]) values.add(normalized[index]);
    colours.set(version, values);
  }
  return colours;
}

function boardValueNotes(board: Board, r: Rendered, previous: Board[], frozen: ReadonlyMap<number, Set<string>>): OutsideValue[] {
  const colours = new Set(board.palette.map((p) => toHex(p.hex)));
  const fonts = new Set(board.fonts.map((f) => f.family.toLowerCase()));
  const painted = new Set(r.colours.filter((c) => c.kind !== "shadow").map((c) => c.value));
  const notes: OutsideValue[] = [];
  const reported = new Set<string>();
  for (const value of painted) {
    const hex = toHex(value);
    if (!hex || colours.has(hex) || frozen.get(board.version)?.has(value) || reported.has(hex)) continue;
    reported.add(hex);
    const note: OutsideValue = { kind: "colour", value: hex.toUpperCase() };
    for (const old of previous) {
      const entry = old.palette.find((p) => toHex(p.hex) === hex);
      if (!entry && !frozen.get(old.version)?.has(value)) continue;
      note.previousVersion = versionLabel(old.version);
      if (entry) note.previousRole = entry.role;
      break;
    }
    notes.push(note);
  }
  const usedFonts = new Map(r.texts.map((t) => [t.family.toLowerCase(), t.family]));
  for (const [key, value] of usedFonts) {
    if (fonts.has(key)) continue;
    const old = previous.find((b) => b.fonts.some((f) => f.family.toLowerCase() === key));
    notes.push({ kind: "font", value, previousVersion: old && versionLabel(old.version) });
  }
  return notes;
}

function checkRendered(board: Board, r: Rendered, result: DefaultCheckResult, approved: ReadonlySet<string> | undefined): CheckResult {
  const area = r.width * r.height;
  const off = new Map<string, CheckResult["consistency"]["offPalette"][number]>();
  for (const c of r.colours) {
    if (c.kind === "shadow" || approved?.has(c.value)) continue;
    const hex = toHex(c.value);
    if (!hex) continue;
    let best = { hex: "", d: Infinity };
    for (const p of board.palette) { const d = deltaE(hex, p.hex); if (d < best.d) best = { hex: p.hex, d }; }
    if (best.d > JND_DE76) {
      const k = off.get(hex) ?? { hex, kind: c.kind, nearest: best.hex, deltaE: Math.round(best.d * 10) / 10, areaShare: 0 };
      k.areaShare = Math.round(Math.min(1, k.areaShare + c.area / area) * 1000) / 1000;
      off.set(hex, k);
    }
  }
  const families = new Set(board.fonts.map((f) => f.family.toLowerCase()));
  const roles = typeRoles(r);
  const offFonts = roles.families.filter((f) => !families.has(f.family.toLowerCase())).map((f) => f.family);
  const d = roles.display, bd = board.type.display;
  const comp = composition(r);
  const bc = board.composition;
  const outside: string[] = [];
  for (const k of ["displayShare", "sizeRatio", "marginShare", "textCoverage", "imageCoverage"] as const) {
    const [lo, hi] = bc[k];
    if (comp[k] < lo || comp[k] > hi) outside.push(`${k} ${comp[k]} (samples ${lo} to ${hi})`);
  }
  if (!bc.align.includes(comp.align)) outside.push(`align ${comp.align} (samples ${bc.align.join(", ")})`);
  const radiiOutside = [...new Set(r.radii.filter((x) => !x.full && !board.radii.px.some((p) => Math.abs(p - x.px) <= 0.5)).map((x) => x.px))];
  const aspect = r.width / r.height;
  const declared = board.samples.find((s) => s.format === r.family);
  const fam = declared ?? [...board.samples].sort((a, b) => Math.abs(Math.log(a.aspect / aspect)) - Math.abs(Math.log(b.aspect / aspect)))[0];
  const fc = fam.composition;
  const beside = [
    `display share ${comp.displayShare} vs ${fc.displayShare}`,
    `anchor ${comp.anchor.join(",")} vs ${fc.anchor.join(",")}`,
    `margin ${comp.marginShare} vs ${fc.marginShare}`,
    `align ${comp.align} vs ${fc.align}`,
    `image ${comp.imageBox ? comp.imageBox.join(",") : "none"} vs ${fc.imageBox ? fc.imageBox.join(",") : "none"}`,
  ];
  // Report cross-shape matches only for pieces whose shape has no matching sample.
  const ownShape = board.samples.some((s) => Math.abs(Math.log(s.aspect / aspect)) <= RESIZE_ASPECT);
  const resizedFrom = ownShape ? [] : board.samples.filter((s) => Math.abs(Math.log(s.aspect / aspect)) > RESIZE_ASPECT && sameArrangement(comp, s.composition)).map((s) => s.format);
  const consistency = {
    resizedFrom,
    offPalette: [...off.values()].sort((a, b) => b.areaShare - a.areaShare),
    offFonts,
    deviceMissing: board.device.present && r.devices.length === 0,
    display: { family: !!d && !!bd && d.family === bd.family, weight: !!d && !!bd && d.weight === bd.weight, case: !!d && !!bd && d.transform === bd.transform },
  };
  return {
    ...result, pass: result.pass && !consistency.deviceMissing,
    consistency, family: { name: fam.format, declared: !!declared, beside }, composition: { ...comp, outside }, radiiOutside,
  };
}

function checkCoverage(fmt: BoardFormat, r: Rendered, detectorFailure: FloorFault | undefined, board: Board | null, e: Essentials | undefined, campaign: boolean, consistency: boolean): CheckCoverage {
  const checks: CheckCoverage = { ran: [], skipped: [] };
  const record = (check: string, reason?: string) => {
    if (reason) checks.skipped.push({ check, reason });
    else checks.ran.push(check);
  };
  const floorOnly = board ? undefined : "floor-only mode has no frozen board";
  record("source floor", detectorFailure ? `source detector failed: ${detectorFailure.detail}` : undefined);
  checks.ran.push("text clipping", "text overlap", "text size and contrast", "font loading");
  if (r.generatedCopy) record("CSS-generated copy geometry", `${r.generatedCopy} pseudo-element(s) with text have no DOM text range`);
  record("print CTA treatment", fmt.kind === "print" ? undefined : "format is not declared print");
  record("story safe zones", fmt.kind === "story" && fmt.safeZones ? undefined : "format declares no story safe zones");
  record("brand name when visible", floorOnly);
  const campaignSkipped = floorOnly ?? (campaign ? undefined : "piece has no board-campaign meta and --brief was not supplied");
  const { required, terms } = requiredCampaignCopy(e, fmt.id);
  record(campaignChecks.copy, campaignSkipped ?? (!required.length && !terms.length ? "brief defines no required copy for this format" : undefined));
  record(campaignChecks.body, campaignSkipped ?? (!(e?.body.length && e.bodyFloor === "reading") ? "brief defines no body copy with a reading-size floor" : undefined));
  record(campaignChecks.images, campaignSkipped ?? (!(e?.assetUse === "required" && e.assets.length) ? "brief defines no required images" : undefined));
  record("frozen value drift", floorOnly);
  record("frozen consistency and composition", floorOnly ?? (consistency ? undefined : "--consistency was not supplied"));
  return checks;
}

export async function check(board: Board | null, files: string[], opts: {
  renderer?: Renderer; out?: string; consistency?: boolean; formats?: BoardFormat[]; previous?: Board[]; brief?: boolean;
  designs?: ReadonlyMap<number, string>; requireBriefCoverage?: boolean; project?: string;
  previewDir?: string;
} = {}) {
  const renderer = opts.renderer ?? new Renderer();
  const results: Array<DefaultCheckResult | CheckResult | (FloorCheckResult & { composition: Composition })> = [];
  try {
    const colours = opts.designs?.size ? await frozenColours(renderer, opts.designs) : new Map<number, Set<string>>();
    const currentDesign = board ? opts.designs?.get(board.version) : undefined;
    const brandFonts = currentDesign === undefined ? undefined : designTypographyFamilies(currentDesign);
    const essentials = campaignEssentials(board?.essentials, opts.project);
    for (const f of files) {
      const campaign = board ? readPiece(f).campaign ?? (opts.brief ? board.name : undefined) : undefined;
      const briefApplied = campaign !== undefined;
      const formats = opts.formats ?? findProjectFormats(f);
      const kit = opts.consistency || !board || isFormatFile(f, formats) ? formatOfFile(f, formats) : undefined;
      const findings = impeccable(f);
      // Keep the custom preview separate from a piece's deliverable PNG.
      let source!: SourceFloor;
      const preview = opts.previewDir ? join(opts.previewDir, `${results.length}-${basename(f).replace(/\.html?$/i, "")}.png`)
        : kit ? undefined : f.replace(/\.html?$/i, ".check.png");
      const r = await renderer.render(f, kit, preview, false, undefined, undefined, async (page) => {
        source = await checkImpeccable(findings, page, brandFonts);
      });
      // Custom HTML is read at its native screen size, using the existing native-size text floor.
      const fmt = kit ?? { ...formatById("hero"), id: "html", height: r.height };
      const isDesignNote = (fault: FloorFault) => board && fault.rule === "design-system-font";
      const designNotes = [...source.designNotes, ...source.floor.filter(isDesignNote), ...formatNotes(r, fmt)];
      const floor = [...source.floor.filter((fault) => !isDesignNote(fault)), ...renderFaults(r, fmt)];
      const format = kit?.id ?? basename(f);
      const checks = checkCoverage(fmt, r, findings.find((fault) => fault.rule === "impeccable-failed"), board, essentials, briefApplied, !!opts.consistency);
      const base = { file: f, format, png: r.png, floor, dismissed: source.dismissed, checks, designNotes };
      if (!board) {
        results.push({ ...base, pass: floor.length === 0, composition: composition(r) });
        continue;
      }
      const brief = briefFaults(r, fmt, briefApplied ? essentials : undefined, briefBrand(board.brief, board.name), opts.project);
      if (opts.requireBriefCoverage && !Object.values(campaignChecks).some((name) => checks.ran.includes(name))) {
        brief.push({ rule: "campaign-requirements-missing", source: "brief",
          detail: `No campaign requirements could be checked for ${format}. Record the brief's requirements in essentials.json and freeze again.` });
      }
      const result = {
        ...base, pass: floor.length === 0 && brief.length === 0, brief, briefApplied,
        briefScope: campaign === undefined ? "not a campaign piece" : `campaign: ${campaign}, checked against brief.md`,
        outsideValues: boardValueNotes(board, r, opts.previous ?? [], colours),
      };
      results.push(opts.consistency ? checkRendered(board, r, result, colours.get(board.version)) : result);
    }
  } finally {
    if (!opts.renderer) await renderer.close();
  }
  if (opts.out) writeFileSync(opts.out, JSON.stringify(results, null, 2));
  return results;
}
