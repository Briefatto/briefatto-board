import type { Board } from "./freeze.js";
import type { Composition } from "./metrics.js";

type Value = string | number | boolean | null | undefined | readonly Value[];

function show(value: Value): string {
  if (Array.isArray(value)) return value.length ? value.map((item: Value) => Array.isArray(item) ? `[${show(item)}]` : show(item)).join(", ") : "none";
  if (value === null || value === undefined) return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

const compositionLabels = {
  displayShare: "display share of short side",
  sizeRatio: "display-to-body size ratio",
  marginShare: "margin share of short side",
  align: "text alignment",
  textCoverage: "text coverage",
  imageCoverage: "image coverage",
  imageBleeds: "image bleeds to edges",
} as const;

const sampleLabels: Record<keyof Composition, string> = {
  ...compositionLabels,
  anchor: "display centre (x, y)",
  imageBox: "largest image box (x, y, width, height)",
  deviceBoxes: "device boxes (x, y, width, height)",
};

const keys = <T extends object>(value: T) => Object.keys(value) as Array<keyof T>;
const sorted = (values?: Array<string | number | boolean>) => values && [...values].sort();
export const projectImageSource = (source: string) => source.replace(/^file:.*\/(assets\/)/i, "$1");
const imageSources = (sources: string[]) => sorted(sources.map(projectImageSource));

export function diffBoards(a: Board, b: Board): string[] {
  const changes: string[] = [];
  function compare(label: string, before: Value, after: Value) {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push(`${label}: ${show(before)} → ${show(after)}`);
  }

  for (const role of ["ground", "ink", "accent"] as const) {
    const before = a.palette.filter((colour) => colour.role === role);
    const after = b.palette.filter((colour) => colour.role === role);
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const label = `Colour ${role}${role === "accent" || i > 0 ? ` ${i + 1}` : ""}`;
      compare(label, before[i]?.hex, after[i]?.hex);
      if (!before[i] || !after[i]) continue;
      compare(`${label} area share`, before[i].share, after[i].share);
      compare(`${label} uses`, sorted(before[i].kinds), sorted(after[i].kinds));
    }
  }

  const typeLabels = { family: "font", weight: "weight", transform: "case", letterSpacingEm: "letter spacing (em)", lineHeight: "line height", italic: "italic" } as const;
  for (const role of ["display", "body"] as const) {
    for (const key of keys(typeLabels)) compare(`Type ${role} ${typeLabels[key]}`, a.type[role]?.[key], b.type[role]?.[key]);
  }
  for (const family of new Set([...a.fonts, ...b.fonts].map((font) => font.family))) {
    const before = a.fonts.find((font) => font.family === family);
    const after = b.fonts.find((font) => font.family === family);
    compare(`Font ${family} weights`, sorted(before?.weights), sorted(after?.weights));
    compare(`Font ${family} stack`, before?.stack, after?.stack);
  }
  compare("Font stylesheet links", sorted(a.fontLinks), sorted(b.fontLinks));
  if (JSON.stringify(a.fontFaces ?? []) !== JSON.stringify(b.fontFaces ?? [])) changes.push("Font face definitions changed");

  compare("Device present", a.device.present, b.device.present);
  compare("Device colours", sorted(a.device.colours), sorted(b.device.colours));
  compare("Device radii (px)", sorted(a.device.radii), sorted(b.device.radii));
  compare("Device elements", sorted(a.device.tags), sorted(b.device.tags));
  compare("Device size share of short side", a.device.sizeShare, b.device.sizeShare);
  compare("Images present", a.images.used, b.images.used);
  compare("Image fit", sorted(a.images.fits), sorted(b.images.fits));
  compare("Image filters", sorted(a.images.filters), sorted(b.images.filters));
  compare("Image corner radii (px)", sorted(a.images.radii), sorted(b.images.radii));
  compare("Image sources", imageSources(a.images.srcs), imageSources(b.images.srcs));
  compare("Corner radii (px)", sorted(a.radii.px), sorted(b.radii.px));
  compare("Full corner rounding", a.radii.full, b.radii.full);
  compare("Shadows present", a.shadows, b.shadows);

  for (const key of keys(compositionLabels)) {
    const unordered = key === "align" || key === "imageBleeds";
    compare(`Composition ${compositionLabels[key]}`, unordered ? sorted(a.composition[key]) : a.composition[key], unordered ? sorted(b.composition[key]) : b.composition[key]);
  }
  for (const format of new Set([...a.samples, ...b.samples].map((sample) => sample.format))) {
    const before = a.samples.find((sample) => sample.format === format);
    const after = b.samples.find((sample) => sample.format === format);
    if (!before || !after) {
      changes.push(`Composition sample ${format} ${after ? "added" : "removed"}`);
      continue;
    }
    compare(`Composition ${format} aspect ratio`, before.aspect, after.aspect);
    for (const key of keys(sampleLabels)) {
      compare(`Composition ${format} ${sampleLabels[key]}`, before.composition[key], after.composition[key]);
    }
  }
  compare("Remembered constraints", a.constraints ?? [], b.constraints ?? []);
  compare("Brand name", a.name, b.name);
  compare("Direction title", a.direction.title, b.direction.title);
  if (a.direction.text !== b.direction.text) changes.push("Direction guidance changed");
  if ((a.brief ?? "") !== (b.brief ?? "")) changes.push("Brief wording changed");
  compare("Required copy", a.essentials?.required ?? [], b.essentials?.required ?? []);
  compare("Offer terms", a.essentials?.terms ?? [], b.essentials?.terms ?? []);
  compare("Offer terms exemptions", a.essentials?.termsExempt ?? [], b.essentials?.termsExempt ?? []);
  compare("Body copy", a.essentials?.body ?? [], b.essentials?.body ?? []);
  compare("Brief assets", a.essentials?.assets ?? [], b.essentials?.assets ?? []);
  compare("Brief asset use", a.essentials?.assetUse ?? "optional", b.essentials?.assetUse ?? "optional");
  const assets = new Map(a.briefAssets?.map(({ name, url }) => [name, url]));
  const nextAssets = new Map(b.briefAssets?.map(({ name, url }) => [name, url]));
  const changedAssets = [...new Set([...assets.keys(), ...nextAssets.keys()])].filter((name) => assets.get(name) !== nextAssets.get(name));
  if (changedAssets.length) changes.push(`Brief asset sources changed: ${changedAssets.join(", ")}`);
  return changes;
}
