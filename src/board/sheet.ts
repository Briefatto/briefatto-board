// Contact sheets for people: one per direction, one per kit, one side-by-side per brief. Pictures are shown scaled to a
// common row height (the 300x250 banner at its native size); the native PNGs sit next to the sheet.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { FORMATS } from "./formats.js";
import type { Board } from "./freeze.js";
import { Renderer, screenshotFullPage } from "./render.js";
import { directionNotesHtml, escapeHtml as esc } from "./sheet-markdown.js";

export interface SheetItem { label: string; png: string; width: number; height: number; note?: string }
export interface SheetRow { title?: string; items: SheetItem[] }

function canvasCaption(label: string, width: number, height: number): string {
  const suffix = ` ${width}x${height}`;
  const title = label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
  return `${esc(title)} <span>· ${width} × ${height} px</span>`;
}

export function sheetHtml(o: { title: string; sub?: string; swatches?: string[]; fonts?: string[]; rows: SheetRow[]; rowHeight?: number }): string {
  const H = o.rowHeight ?? 520;
  const item = (i: SheetItem) => {
    const h = i.width <= 300 ? i.height : H;
    const w = Math.round((i.width / i.height) * h);
    return `<figure style="width:${w}px"><img src="${pathToFileURL(i.png).href}" width="${i.width}" height="${i.height}" alt="${esc(i.label)}"><figcaption>${canvasCaption(i.label, i.width, i.height)}${i.note ? `<br><span>${esc(i.note)}</span>` : ""}</figcaption></figure>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:48px;background:#e9e9e6;font:16px/1.4 system-ui,sans-serif;color:#161616}
h1{font-size:32px;margin:0 0 8px} .sub{max-width:1400px;color:#444;margin:0 0 20px;white-space:pre-wrap}
.sw{display:flex;gap:8px;margin:0 0 8px} .sw i{display:block;width:56px;height:56px;border:1px solid #0002}
.fonts{color:#444;margin:0 0 24px} h2{font-size:22px;margin:32px 0 12px}
.row{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-end}
figure{margin:0;max-width:100%} img{display:block;width:100%;height:auto;box-shadow:0 0 0 1px #0002;background:#fff} figcaption{font-size:14px;margin-top:6px} figcaption span{color:#666}
</style></head><body><h1>${esc(o.title)}</h1>${o.sub ? `<p class="sub">${esc(o.sub)}</p>` : ""}${o.swatches?.length ? `<div class="sw">${o.swatches.map((c) => `<i style="background:${c}" title="${c}"></i>`).join("")}</div>` : ""}${o.fonts?.length ? `<p class="fonts">${esc(o.fonts.join(" · "))}</p>` : ""}${o.rows.map((r) => `${r.title ? `<h2>${esc(r.title)}</h2>` : ""}<div class="row">${r.items.map(item).join("")}</div>`).join("")}</body></html>`;
}

export async function writeSheet(htmlPath: string, pngPath: string, o: Parameters<typeof sheetHtml>[0], width = 2600, renderer?: Renderer) {
  writeFileSync(htmlPath, sheetHtml(o));
  const r = renderer ?? new Renderer();
  try {
    await screenshotFullPage(r, htmlPath, pngPath, width);
  } finally {
    if (!renderer) await r.close();
  }
}

// ---- Stylescape: a direction shown as a brand, not a swatch sheet: palette, type specimen, the graphic device,
// image treatment, and the real applications (the samples).

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
