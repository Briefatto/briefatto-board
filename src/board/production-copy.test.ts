import assert from "node:assert/strict";
import { mkdirSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { campaignEssentials, loadEssentials } from "./essentials.js";
import { briefFaults, renderFaults } from "./floor.js";
import type { BoardFormat } from "./formats.js";
import { Renderer } from "./render.js";

const format: BoardFormat = { id: "poster", label: "Poster", width: 640, height: 480, seenWidth: 640, source: "Client brief" };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24"/></svg>';

test("a newly drawn mascot and wordmark do not become brief images", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-intake-"));
  const file = join(project.path, "poster.html");
  const manifest = join(project.path, "essentials.json");
  const generated = "assets/drawn";
  const supplied = "assets/intake";
  mkdirSync(join(project.path, generated), { recursive: true });
  mkdirSync(join(project.path, supplied), { recursive: true });
  for (const name of [`${generated}/mascot.svg`, `${generated}/wordmark.svg`, `${supplied}/wordmark.svg`]) {
    writeFileSync(join(project.path, name), svg);
  }
  writeFileSync(join(project.path, "brief.md"), "A character may be drawn for the new identity.\n");
  const essentials = loadEssentials(project.path);
  assert.deepEqual(essentials.assets, []);
  assert.deepEqual(essentials.assetOrigins, {});
  assert.equal(essentials.assetUse, "optional");
  const oldFreeze = { ...essentials, assetUse: "required" as const, assetOrigins: undefined,
    assets: [`${generated}/mascot.svg`, `${generated}/wordmark.svg`, `${supplied}/wordmark.svg`] };
  assert.deepEqual(campaignEssentials(oldFreeze, project.path)?.assets, []);
  writeFileSync(manifest, JSON.stringify({ assets: [{ path: `${supplied}/wordmark.svg`, origin: "client" }] }));
  const recorded = loadEssentials(project.path);
  assert.deepEqual(recorded.assets, [`${supplied}/wordmark.svg`]);
  assert.deepEqual(recorded.assetOrigins, { [`${supplied}/wordmark.svg`]: "client" });
  assert.deepEqual(campaignEssentials(oldFreeze, project.path)?.assets, recorded.assets);
  const renderer = new Renderer();
  try {
    writeFileSync(file, `<!doctype html><img src="${generated}/wordmark.svg" alt="Logo">`);
    assert.equal(briefFaults(await renderer.render(file, format), format, recorded, undefined, project.path)[0]?.rule, "asset-missing");
    writeFileSync(file, `<!doctype html><img src="${supplied}/wordmark.svg" alt="Logo">`);
    assert.deepEqual(briefFaults(await renderer.render(file, format), format, recorded, undefined, project.path), []);
  } finally { await renderer.close(); }
});

test("stacked offer details keep approved words and omit standalone separator dots at the break", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-stacked-copy-"));
  const file = join(project.path, "poster.html");
  const date = "Saturday 17 April 2027 · 10:00–16:00";
  const place = "Old Market, Ghent · Free entry";
  const offer = "Any three used scores for €12.";
  writeFileSync(join(project.path, "essentials.json"), JSON.stringify({ required: [date, place, offer] }));
  const essentials = loadEssentials(project.path);
  const html = (copy: string) => `<!doctype html><style>body{font:26px sans-serif}.details span{display:block}</style>
    <h1>Any three <br> used scores <br> for <strong>€12.</strong></h1>${copy}`;
  const stacked = '<p class="details"><span>Saturday 17 April 2027</span><span>10:00–16:00</span></p><p>Old Market, Ghent<br>Free entry</p>';
  const renderer = new Renderer();
  try {
    const render = (copy: string) => {
      writeFileSync(file, html(copy));
      return renderer.render(file, format);
    };
    assert.deepEqual(briefFaults(await render(stacked), format, essentials), []);
    assert.deepEqual(briefFaults(await render(stacked.replace("Free entry", "Free entries")), format, essentials).map(({ detail }) => detail), [`"${place}"`]);
    assert.deepEqual(briefFaults(await render(stacked.replace("10:00–16:00", "10:00-16:00")), format, essentials).map(({ detail }) => detail), [`"${date}"`]);
    const inline = '<p>Saturday 17 April 2027\n10:00–16:00</p><p>Old Market, Ghent · Free entry</p>';
    assert.deepEqual(briefFaults(await render(inline), format, essentials).map(({ detail }) => detail), [`"${date}"`]);
  } finally { await renderer.close(); }
});

test("wrapped fragments of one tightly set offer do not overlap themselves", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-tight-copy-"));
  const file = join(project.path, "poster.html");
  writeFileSync(file, `<!doctype html><style>
    h1 { width: 3.7em; font: bold 80px/.7 sans-serif; margin: 70px 20px; }
    p { position: absolute; top: 400px; left: 20px; font: 32px sans-serif; }
    p + p { left: 80px; }
    </style><h1>Any three used scores for €12.</h1><p>First label</p><p>Second label</p>`);
  const renderer = new Renderer();
  try {
    const r = await renderer.render(file, format);
    const fragments = r.copy?.find(({ text }) => text === "Any three used scores for €12.")?.fragments ?? [];
    assert.ok(fragments.some((a, index) => fragments.slice(index + 1).some((b) =>
      a.y + a.h - b.y > 1 && Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1)));
    const overlaps = renderFaults(r, format).filter(({ rule }) => rule === "text-over-text").map(({ detail }) => detail);
    assert.deepEqual(overlaps, ['"First label" / "Second label"']);
  } finally { await renderer.close(); }
});
