// Values read from a rendered page: the palette it paints, its type roles and its composition. The same reader feeds
// the freeze (from the chosen samples) and the consistency check (from each output), so both sides are measured alike.

import { parse, formatHex, differenceCie76 } from "culori";
import type { Rendered, TextRun } from "./render.js";

/** One just-noticeable difference in CIELAB (ΔE*ab 2.3; Mahy et al. 1994, used by Sharma, Digital Color Imaging Handbook, 2003). */
export const JND_DE76 = 2.3;
const de = differenceCie76();

export function toHex(css: string): string | null {
  const c = parse(css);
  return c ? formatHex(c) : null;
}

export function deltaE(a: string, b: string): number {
  const ca = parse(a), cb = parse(b);
  return ca && cb ? de(ca, cb) : Infinity;
}

export interface PaletteEntry { hex: string; role: "ground" | "ink" | "accent"; share: number; kinds: string[] }

/** Group painted colours into clusters one JND wide, weighted by painted area; name the largest background the ground
 * and the colour with the most text area the ink. */
export function palette(r: Rendered): PaletteEntry[] {
  const total = r.width * r.height;
  const clusters: Array<{ hex: string; area: number; textArea: number; bgArea: number; kinds: Set<string> }> = [];
  for (const c of r.colours) {
    if (c.kind === "shadow") continue;
    const hex = toHex(c.value);
    if (!hex) continue;
    let k = clusters.find((x) => de(parse(x.hex)!, parse(hex)!) <= JND_DE76);
    if (!k) clusters.push((k = { hex, area: 0, textArea: 0, bgArea: 0, kinds: new Set() }));
    k.area += c.area;
    if (c.kind === "text") k.textArea += c.area;
    if (c.kind === "bg") k.bgArea += c.area;
    k.kinds.add(c.kind);
  }
  const ground = [...clusters].sort((a, b) => b.bgArea - a.bgArea)[0];
  const ink = [...clusters].filter((c) => c !== ground).sort((a, b) => b.textArea - a.textArea)[0];
  return clusters
    .sort((a, b) => b.area - a.area)
    .map((c) => ({ hex: c.hex, role: c === ground ? "ground" : c === ink ? "ink" : "accent", share: Math.round((Math.min(c.area, total) / total) * 1000) / 1000, kinds: [...c.kinds] }));
}

export interface Composition {
  /** Largest type size over the canvas's short side. */
  displayShare: number;
  /** Largest type size over the size that sets the most characters (the body). */
  sizeRatio: number;
  /** Nearest distance of any text to a canvas edge, over the short side. */
  marginShare: number;
  /** Alignment that sets the most characters. */
  align: string;
  textCoverage: number;
  imageCoverage: number;
  /** Whether an image touches at least two canvas edges (bleeds). */
  imageBleeds: boolean;
  /** Centre of the display text, as a share of width and height. */
  anchor: [number, number];
  /** Boxes as shares of the canvas [x, y, w, h]: the largest image and each graphic device. */
  imageBox: [number, number, number, number] | null;
  deviceBoxes: Array<[number, number, number, number]>;
}

export interface TypeRole { family: string; weight: number; transform: string; letterSpacingEm: number; lineHeight: number; italic: boolean }

const role = (t: TextRun): TypeRole => ({ family: t.family, weight: t.weight, transform: t.transform, letterSpacingEm: t.letterSpacingEm, lineHeight: t.lineHeight, italic: t.italic });

export function typeRoles(r: Rendered): { display?: TypeRole; body?: TypeRole; families: Array<{ family: string; weights: number[]; chars: number; loaded: boolean }> } {
  const texts = r.texts;
  if (!texts.length) return { families: [] };
  const display = [...texts].sort((a, b) => b.size - a.size)[0];
  const bySize = new Map<number, number>();
  for (const t of texts) if (t !== display) bySize.set(t.size, (bySize.get(t.size) ?? 0) + t.text.length);
  const bodySize = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const body = texts.filter((t) => t.size === bodySize && t !== display).sort((a, b) => b.text.length - a.text.length)[0];
  const fams = new Map<string, { family: string; weights: Set<number>; chars: number; loaded: boolean }>();
  for (const t of texts) {
    const f = fams.get(t.family) ?? { family: t.family, weights: new Set<number>(), chars: 0, loaded: t.loaded };
    f.weights.add(t.weight);
    f.chars += t.text.length;
    f.loaded &&= t.loaded;
    fams.set(t.family, f);
  }
  return {
    display: role(display),
    body: body ? role(body) : undefined,
    families: [...fams.values()].map((f) => ({ family: f.family, weights: [...f.weights].sort((a, b) => a - b), chars: f.chars, loaded: f.loaded })).sort((a, b) => b.chars - a.chars),
  };
}

export function composition(r: Rendered): Composition {
  const short = Math.min(r.width, r.height);
  const area = r.width * r.height;
  const texts = r.texts;
  const display = texts.length ? Math.max(...texts.map((t) => t.size)) : 0;
  const chars = new Map<number, number>();
  for (const t of texts) chars.set(t.size, (chars.get(t.size) ?? 0) + t.text.length);
  const body = [...chars.entries()].filter(([s]) => s !== display).sort((a, b) => b[1] - a[1])[0]?.[0] ?? display;
  const margin = texts.length ? Math.min(...texts.map((t) => Math.min(t.box.x, t.box.y, r.width - t.box.x - t.box.w, r.height - t.box.y - t.box.h))) : 0;
  const alignChars = new Map<string, number>();
  for (const t of texts) {
    const a = t.align === "start" || t.align === "justify" ? "left" : t.align === "end" ? "right" : t.align;
    alignChars.set(a, (alignChars.get(a) ?? 0) + t.text.length);
  }
  const clip = (b: { x: number; y: number; w: number; h: number }) => Math.max(0, Math.min(r.width, b.x + b.w) - Math.max(0, b.x)) * Math.max(0, Math.min(r.height, b.y + b.h) - Math.max(0, b.y));
  const touches = (b: { x: number; y: number; w: number; h: number }) => [b.x <= 0.5, b.y <= 0.5, b.x + b.w >= r.width - 0.5, b.y + b.h >= r.height - 0.5].filter(Boolean).length;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const norm = (b: { x: number; y: number; w: number; h: number }): [number, number, number, number] => [r3(b.x / r.width), r3(b.y / r.height), r3(b.w / r.width), r3(b.h / r.height)];
  return {
    displayShare: r3(display / short),
    sizeRatio: r3(body ? display / body : 1),
    marginShare: r3(margin / short),
    align: [...alignChars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "left",
    textCoverage: r3(Math.min(1, texts.reduce((s, t) => s + clip(t.box), 0) / area)),
    imageCoverage: r3(Math.min(1, r.images.reduce((s, i) => s + clip(i.box), 0) / area)),
    imageBleeds: r.images.some((i) => touches(i.box) >= 2),
    anchor: (() => { const d = [...texts].sort((a, b) => b.size - a.size)[0]; return d ? [r3((d.box.x + d.box.w / 2) / r.width), r3((d.box.y + d.box.h / 2) / r.height)] as [number, number] : [0.5, 0.5] as [number, number]; })(),
    imageBox: (() => { const i = [...r.images].sort((a, b) => clip(b.box) - clip(a.box))[0]; return i ? norm(i.box) : null; })(),
    deviceBoxes: r.devices.map((d) => norm(d.box)),
  };
}
