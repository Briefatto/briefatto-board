// The two pictures a person sees: the comparison of the directions (one row each) and the kit at handover. Both
// show the real pieces at one shared scale, in a quiet neutral frame, with plain words only: no measurements,
// scores or check results. The stylescape at the end of this file is a different thing: freeze's record of the
// measured board, kept in board/ for the agent and never shown to the person.

import { mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { FORMATS, type BoardFormat } from "./formats.js";
import type { Board } from "./freeze.js";
import { Renderer, screenshotFullPage } from "./render.js";
import { directionNotesHtml, escapeHtml as esc } from "./sheet-markdown.js";

/** A picture on a sheet, captioned with its format label. */
export interface SheetItem { label: string; png: string; width: number; height: number }
/** One row: a direction (mark, name and one sentence), or a group of kit pieces with no heading. */
export interface SheetRow { mark?: string; title?: string; note?: string; items: SheetItem[] }
/** `line` is one quiet line under the title, such as what was delivered. */
export interface SheetOptions { title: string; line?: string; rows: SheetRow[] }

/** The screen a sheet is laid out for: the 1440x900 laptop viewport the built-in website hero is drawn for. */
const SCREEN = FORMATS.find((f) => f.id === "hero")!;
export const SHEET_MAX_WIDTH = SCREEN.width;
// Frame sizes in CSS px, used both in the stylesheet and to work out how much of the screen the pieces get.
const PAD = 32, GAP = 20, HEAD = 240;
const TITLE = Math.ceil(28 * 1.25) + GAP, LINE = Math.ceil(14 * 1.45) + GAP, CAPTION = Math.ceil(13 * 1.4) + 6;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const headed = (r: SheetRow) => !!(r.mark || r.title || r.note);
const rowWidth = (r: SheetRow, height: number) =>
  (headed(r) ? HEAD + GAP : 0) + sum(r.items.map((i) => Math.floor((i.width / i.height) * height))) + GAP * Math.max(0, r.items.length - 1);

/** Every piece on a sheet shares one height, so the rows line up and compare at a glance. The height is the largest
 * that fits every row on the SCREEN: across, each row's heading column and pieces within its width; down, the title,
 * the optional line and all rows with their captions within its height. No piece is shown above its native size.
 * Three directions in hero, post and story come out at 208 px a piece on a 1021 x 898 canvas. The canvas is as wide
 * as its widest row. */
export function sheetLayout(o: Pick<SheetOptions, "rows" | "line">): { height: number; width: number } {
  const rows = o.rows.filter((r) => r.items.length);
  if (!rows.length) return { height: 0, width: SCREEN.width };
  const down = (SCREEN.height - 2 * PAD - TITLE - (o.line ? LINE : 0) - rows.length * CAPTION - 2 * GAP * (rows.length - 1)) / rows.length;
  const across = rows.map((r) => (SCREEN.width - 2 * PAD - (headed(r) ? HEAD + GAP : 0) - GAP * (r.items.length - 1)) /
    sum(r.items.map((i) => i.width / i.height)));
  const height = Math.floor(Math.min(down, ...across, ...rows.flatMap((r) => r.items.map((i) => i.height))));
  return { height, width: 2 * PAD + Math.max(...rows.map((r) => rowWidth(r, height))) };
}

/** A format's plain name: "Square post 1080x1080" reads as "Square post". */
const formatName = (label: string) => label.replace(/\s+\d+\s*[x×]\s*\d+$/, "");

function canvasCaption(label: string, width: number, height: number): string {
  return `${esc(formatName(label))} <span>· ${width} × ${height} px</span>`;
}

/** A direction's mark and name from its id and the heading of direction.md: "A — Slipway", "Direction A: Thaw" and
 * "Slipway" in directions/a all read as mark A and name Slipway. */
export function directionLabel(id: string, title: string): { mark: string; name: string } {
  const t = title.trim();
  const lettered = t.match(/^(?:direction\s+)?([A-Za-z0-9])\s*[—–:.)-]\s+(.+)$/i);
  if (lettered) return { mark: lettered[1].toUpperCase(), name: lettered[2].trim() };
  const mark = /^[A-Za-z0-9]$/.test(id) ? id.toUpperCase() : "";
  const bare = t.match(/^(?:direction\s+)?([A-Za-z0-9])$/i);
  if (bare && (!mark || bare[1].toUpperCase() === mark)) return { mark: bare[1].toUpperCase(), name: "" };
  return { mark, name: t === id ? "" : t };
}

/** The direction's idea in one plain sentence: the first sentence of the first prose paragraph of direction.md, with
 * code, colour values and markdown taken out. Empty when the notes have no prose. */
export function directionIdea(markdown: string): string {
  let fenced = false;
  const para: string[] = [];
  for (const raw of markdown.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(`{3,}|~{3,})/.test(line)) {
      if (para.length) break;
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!line || /^(#|[-+*]\s|\d+[.)]\s|>|\||<|`)/.test(line)) {
      if (para.length) break;
      continue;
    }
    para.push(line);
  }
  const text = para.join(" ")
    .replace(/`[^`]*`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/\s*\([^)]*#[0-9a-fA-F]{3,8}\b[^)]*\)/g, "")
    .replace(/#[0-9a-fA-F]{3,8}\b/g, "")
    .replace(/\s+([,;.])/g, "$1").replace(/([,;])[,;]+/g, "$1").replace(/\s{2,}/g, " ").trim();
  return (text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text).trim();
}

/** The brand as a person names it, for the pictures they see: the brief's heading without a "Brief:" label. */
export const brandName = (briefHeading: string, fallback: string) =>
  briefHeading.replace(/^brief\b\s*[:—–-]?\s*/i, "").trim() || fallback;

/** A direction's row on the comparison sheet: mark, name, its idea in one sentence, and the samples rendered into
 * directions/<id>/_values. */
export function directionRow(dir: string, b: Pick<Board, "samples">, formats: BoardFormat[]): SheetRow {
  const text = readFileSync(join(dir, "direction.md"), "utf8");
  const id = basename(dir);
  const { mark, name } = directionLabel(id, (text.match(/^#\s+(.+)$/m)?.[1] ?? id).trim());
  return {
    mark, title: name, note: directionIdea(text),
    items: b.samples.map((s) => {
      const f = s.canvas ?? formats.find((x) => x.id === s.format) ?? FORMATS.find((x) => x.id === s.format);
      if (!f) throw new Error(`Unknown canvas in direction ${id}: ${s.format}.`);
      return { label: f.label, png: join(dir, "_values", s.png), width: f.width, height: f.height };
    }),
  };
}

export function sheetHtml(o: SheetOptions): string {
  const { height, width } = sheetLayout(o);
  const fig = (i: SheetItem) => {
    const w = Math.floor((i.width / i.height) * height);
    return `<figure style="width:${w}px"><img src="${pathToFileURL(i.png).href}" style="width:${w}px;height:${height}px" alt="${esc(i.label)}"><figcaption>${esc(formatName(i.label))}</figcaption></figure>`;
  };
  const row = (r: SheetRow) => {
    const header = headed(r)
      ? `<header>${r.mark || r.title ? `<h2>${r.mark ? `<b>${esc(r.mark)}</b>` : ""}${r.title ? `<span>${esc(r.title)}</span>` : ""}</h2>` : ""}${r.note ? `<p>${esc(r.note)}</p>` : ""}</header>`
      : "";
    return `<section>${header}<div class="line">${r.items.map(fig).join("")}</div></section>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.title)}</title><style>
html,body{margin:0;background:#f3f3f1;width:${width}px}
body{box-sizing:border-box;padding:${PAD}px;font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b1b1b}
h1{font-size:28px;line-height:1.25;font-weight:600;letter-spacing:-.01em;margin:0 0 ${GAP}px}
.line-note{color:#666;font-size:14px;line-height:1.45;margin:-${GAP / 2}px 0 ${GAP}px;overflow-wrap:anywhere}
section{display:flex;gap:${GAP}px;padding:${GAP}px 0;border-top:1px solid #00000021}
section:first-of-type{border-top:0;padding-top:0} section:last-of-type{padding-bottom:0}
header{flex:0 0 ${HEAD}px}
h2{display:flex;align-items:baseline;gap:12px;margin:0;font-weight:600} h2 b{font-size:44px;line-height:1;font-weight:700} h2 span{font-size:22px;line-height:1.2}
header p{margin:10px 0 0;color:#4a4a4a;font-size:15px;line-height:1.4}
.line{display:flex;gap:${GAP}px;align-items:flex-end}
figure{margin:0} img{display:block;box-shadow:0 0 0 1px #00000014;background:#fff}
figcaption{font-size:13px;line-height:1.4;margin-top:6px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body><h1>${esc(o.title)}</h1>${o.line ? `<p class="line-note">${esc(o.line)}</p>` : ""}${o.rows.filter((r) => r.items.length).map(row).join("")}</body></html>`;
}

/** Write the sheet's HTML to `htmlPath` (a temporary file when undefined) and its picture to `pngPath`. */
export async function writeSheet(htmlPath: string | undefined, pngPath: string, o: SheetOptions, renderer?: Renderer) {
  using temporary = htmlPath ? undefined : mkdtempDisposableSync(join(tmpdir(), "board-sheet-"));
  const html = htmlPath ?? join(temporary!.path, "sheet.html");
  writeFileSync(html, sheetHtml(o));
  const r = renderer ?? new Renderer();
  try {
    // A short viewport, so the picture ends where the sheet does.
    await screenshotFullPage(r, html, pngPath, sheetLayout(o).width, { verifyImages: true, viewportHeight: 1 });
  } finally {
    if (!renderer) await r.close();
  }
}

// ---- Stylescape: the frozen board's own record of what it measured: palette, type specimen, the graphic device,
// image treatment and the samples. Freeze keeps it in board/ for the agent; it is never the person's picture.

/** Cut a box (shares of the canvas) out of a PNG, with a little air around it. */
export function cropPng(src: string, box: [number, number, number, number], out: string) {
  const img = PNG.sync.read(readFileSync(src));
  const pad = 0.02;
  const x0 = Math.max(0, Math.floor((box[0] - pad) * img.width)), y0 = Math.max(0, Math.floor((box[1] - pad) * img.height));
  const x1 = Math.min(img.width, Math.ceil((box[0] + box[2] + pad) * img.width)), y1 = Math.min(img.height, Math.ceil((box[1] + box[3] + pad) * img.height));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const dst = new PNG({ width: w, height: h });
  PNG.bitblt(img, dst, x0, y0, w, h, 0, 0);
  writeFileSync(out, PNG.sync.write(dst));
  return { w, h };
}

export function stylescapeHtml(b: Board, boardDir: string, heading: string): string {
  const d = b.type.display, body = b.type.body;
  const stackOf = (fam?: string) => b.fonts.find((f) => f.family === fam)?.stack ?? "serif";
  const H = 520;
  const apps = b.samples.map((s) => {
    const f = s.canvas ?? FORMATS.find((x) => x.id === s.format);
    if (!f) throw new Error(`Unknown canvas in direction sheet: ${s.format}.`);
    const w = Math.round((f.width / f.height) * H);
    return `<figure style="width:${w}px"><img src="${esc(s.png)}" width="${f.width}" height="${f.height}" alt="${esc(f.label)}"><figcaption>${canvasCaption(f.label, f.width, f.height)}</figcaption></figure>`;
  }).join("");
  const devices: string[] = [];
  b.samples.forEach((s) => s.composition.deviceBoxes.slice(0, 2).forEach((box, i) => {
    const file = `device-${s.format}-${i}.png`;
    const { w, h } = cropPng(join(boardDir, s.png), box, join(boardDir, file));
    const sc = Math.min(1, 220 / h, 340 / w);
    devices.push(`<img src="${file}" style="width:${Math.round(w * sc)}px;height:${Math.round(h * sc)}px">`);
  }));
  const notes = directionNotesHtml(b.direction.text);
  const swatches = b.palette.slice(0, 8).map((p) => `<div class="sw" style="flex:${Math.max(p.share, 0.06)}"><i style="background:${p.hex}"></i><span>${p.hex}<br>${p.role} · ${(p.share * 100).toFixed(1)}%</span></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8">${b.fontLinks.map((l) => `<link rel="stylesheet" href="${esc(l)}">`).join("")}<style>
${(b.fontFaces ?? []).join("\n").replace(/<\/style/gi, "<\\/style")}
body{margin:0;padding:48px;background:#e9e9e6;font:16px/1.45 system-ui,sans-serif;color:#161616;width:2700px;box-sizing:border-box}
h1{font-size:30px;margin:0 0 24px}
.notes{max-width:1050px;color:#3a3a3a;margin:28px 0 0;font-size:17px;overflow-wrap:anywhere}
.notes pre{white-space:pre-wrap} .notes h2,.notes h3,.notes h4,.notes h5,.notes h6{font-size:20px;margin:24px 0 8px}
.notes p,.notes ul,.notes ol,.notes blockquote{margin:0 0 12px}
.grid{display:grid;grid-template-columns:780px minmax(0,1fr);gap:40px;align-items:start}
.panel{background:#fff;padding:28px;margin-bottom:24px;box-shadow:0 0 0 1px #0001} .panel h3{font:600 13px system-ui;letter-spacing:.08em;text-transform:uppercase;color:#777;margin:0 0 16px}
.sws{display:flex;gap:10px} .sw{display:flex;flex-direction:column;min-width:96px} .sw i{display:block;height:120px;box-shadow:inset 0 0 0 1px #0002} .sw span{font-size:13px;color:#444;margin-top:6px}
.disp{font-family:${stackOf(d?.family)};font-weight:${d?.weight ?? 700};text-transform:${d?.transform ?? "none"};letter-spacing:${d?.letterSpacingEm ?? 0}em;line-height:${d?.lineHeight ?? 1};font-style:${d?.italic ? "italic" : "normal"};font-size:84px;margin:0 0 14px}
.aa{font-family:${stackOf(d?.family)};font-weight:${d?.weight ?? 700};font-size:40px;color:#555;margin:0 0 18px}
.body{font-family:${stackOf(body?.family)};font-weight:${body?.weight ?? 400};font-size:22px;line-height:${body?.lineHeight ?? 1.4};margin:0 0 10px}
.meta{font-size:13px;color:#666} .dev,.imgs{display:flex;gap:16px;flex-wrap:wrap;align-items:center}
.imgs img{width:220px;height:220px;object-fit:cover} .apps{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-end}
figure{margin:0;max-width:100%} figure img{display:block;width:100%;height:auto;box-shadow:0 0 0 1px #0002} figcaption{font-size:14px;margin-top:6px;color:#444}
</style></head><body><h1>${esc(heading)}</h1>
<div class="grid"><div>
<div class="panel"><h3>Colour</h3><div class="sws">${swatches}</div></div>
<div class="panel"><h3>Type</h3><p class="disp">${esc(b.specimen.display || "Display")}</p><p class="aa">Aa Bb Cc Gg Rr 0123</p><p class="body">${esc(b.specimen.body || "Body text")}</p>
<p class="meta">${esc(b.fonts.map((f) => `${f.family} ${f.weights.join("/")}`).join(" · "))}${d ? ` · display ${d.weight}, ${d.transform}, tracking ${d.letterSpacingEm}em` : ""}</p></div>
<div class="panel"><h3>Graphic device</h3><div class="dev">${devices.join("") || "<span class=meta>none marked</span>"}</div></div>
<div class="panel"><h3>Image treatment</h3>${b.images.used ? `<div class="imgs">${b.images.srcs.slice(0, 3).map((s) => `<img src="${s}" style="filter:${b.images.filters[0] ?? "none"};border-radius:${b.images.radii[0] ?? 0}px">`).join("")}</div><p class="meta">fit ${esc(b.images.fits.join(", "))} · filter ${esc(b.images.filters.join(", "))} · ${b.composition.imageBleeds.includes(true) ? "bleeds to the edge" : "framed"}</p>` : `<span class="meta">no photographs; ${b.composition.imageCoverage[1] ? "" : "type and drawn shapes only"}</span>`}</div>
</div><div><div class="apps">${apps}</div>${notes ? `<div class="notes">${notes}</div>` : ""}</div></div></body></html>`;
}

export async function writeStylescape(b: Board, boardDir: string, heading: string, pngPath: string, renderer?: Renderer) {
  const html = join(boardDir, "stylescape.html");
  writeFileSync(html, stylescapeHtml(b, boardDir, heading));
  const r = renderer ?? new Renderer();
  try { await screenshotFullPage(r, html, pngPath, 2700); } finally { if (!renderer) await r.close(); }
}
