import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { FORMATS, findProjectFormats, formatOfFile, loadProjectFormats } from "./formats.js";
import { boardFromRenders } from "./freeze.js";
import type { Rendered } from "./render.js";
import { brandName, directionIdea, directionLabel, directionRow, sheetHtml, sheetLayout, stylescapeHtml } from "./sheet.js";

const launcher = fileURLToPath(new URL("../../skill/briefatto-board/board.mjs", import.meta.url));
const readme = { id: "readme", label: "README header", width: 1280, height: 360, seenWidth: 900, source: "Repository page" };

test("a project canvas resolves by exact and prefixed names, including absolute paths", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-formats-"));
  const { path } = project;
  assert.equal(loadProjectFormats(path), FORMATS);
  assert.equal(formatOfFile(join(path, "post.proof-hero.html")).id, "post");
  const card = { ...readme, id: "card" };
  const linkCard = { ...readme, id: "link-card" };
  const outputs = join(path, "outputs");
  mkdirSync(outputs);
  const manifest = join(path, "formats.json");
  writeFileSync(manifest, JSON.stringify([card, linkCard, readme]));
  const file = join(outputs, "launch-link-card.html");
  const formats = findProjectFormats(file);
  assert.deepEqual(formats, [card, linkCard, readme]);
  assert.equal(formatOfFile(file, formats).id, linkCard.id);
  assert.equal(formatOfFile(join(outputs, "readme.html"), formats).id, readme.id);
  writeFileSync(manifest, JSON.stringify([readme, readme]));
  assert.throws(() => loadProjectFormats(path), /format ids must be unique/);
});

test("direction notes render through their last line with escaped declarations and canvas captions", () => {
  const note = ["# Direction", "## Formats ###", "### Using C#", "- **README** with `font-family: \"Example\", monospace;`.",
    "", "```html", '<link rel="stylesheet" href="https://example.com/font.css">', "```", "", "Full description. ".repeat(90), "", "Last sentence."];
  const render: Rendered = {
    png: "", width: readme.width, height: readme.height, contrast: [], family: null,
    colours: [], texts: [], radii: [], images: [], shadows: 0, fontLinks: [], devices: [],
  };
  const board = boardFromRenders("Test", { id: "example", title: "Direction", text: note.join("\n") }, [
    { file: "directions/example/readme.html", fmt: readme.id, canvas: readme, r: render },
  ], "board");
  const direction = stylescapeHtml(board, "board", "Direction");
  assert.match(direction, /<h2>Formats<\/h2>/);
  assert.match(direction, /<h3>Using C#<\/h3>/);
  assert.match(direction, /<li><strong>README<\/strong> with <code>font-family: &quot;Example&quot;, monospace;<\/code>\.<\/li>/);
  assert.match(direction, /<pre><code>&lt;link rel=.*&gt;<\/code><\/pre>/);
  assert.match(direction, /<p>Last sentence\.<\/p>/);
  assert.doesNotMatch(direction, /<link rel="stylesheet"/);
  assert.match(direction, /<figcaption>README header <span>· 1280 × 360 px<\/span><\/figcaption>/);
  const kit = sheetHtml({ title: "Kit", rows: [{ items: [{ ...readme, label: "Square post 1080x1080", png: "readme.png" }] }] });
  assert.match(kit, /<figcaption>Square post<\/figcaption>/);
});

test("a direction reads as one mark, one name and one plain sentence", () => {
  assert.deepEqual(directionLabel("a", "A — Slipway"), { mark: "A", name: "Slipway" });
  assert.deepEqual(directionLabel("b", "Direction B: Plow"), { mark: "B", name: "Plow" });
  assert.deepEqual(directionLabel("c", "Bay"), { mark: "C", name: "Bay" });
  assert.deepEqual(directionLabel("c", "Direction C"), { mark: "C", name: "" });
  assert.deepEqual(directionLabel("x-ray", "X-Ray Vision"), { mark: "", name: "X-Ray Vision" });
  assert.equal(brandName("Brief: Tidewater Tea Bar", "walk"), "Tidewater Tea Bar");
  assert.equal(brandName("Brief", "walk"), "walk");
  assert.equal(directionIdea([
    "# B — Soundings", "",
    "Warm sea-glass ground (#E8E5D6, a sage-cream), deep green ink (#23403B), **warm** brass accent. A harbour-chart feel.", "",
    "## Fonts", '`<link rel="stylesheet" href="https://fonts.example/css">`',
  ].join("\n")), "Warm sea-glass ground, deep green ink, warm brass accent.");
  assert.equal(directionIdea("# A\n\n## Fonts\n```html\n<link rel=\"stylesheet\" href=\"x.css\">\n```\n"), "");
});

test("pieces share one height, as large as fits the 1440 x 900 laptop screen", () => {
  const items = FORMATS.filter((f) => ["hero", "post", "story"].includes(f.id)).map((f) => ({ ...f, png: `${f.id}.png` }));
  const directions = ["A", "B", "C"].map((mark) => ({ mark, title: "Name", note: "One idea.", items }));
  assert.deepEqual(sheetLayout({ rows: directions }), { height: 208, width: 1021 });
  assert.deepEqual(sheetLayout({ rows: [directions[0]] }), { height: 340, width: 1439 });
  assert.deepEqual(sheetLayout({ rows: [{ items }], line: "delivery/hero.png" }), { height: 422, width: 1438 });
  const many = FORMATS.map((f) => ({ ...f, png: `${f.id}.png` }));
  assert.ok(sheetLayout({ rows: [{ mark: "A", items: many }] }).width <= 1440);
  assert.equal(sheetLayout({ rows: [{ items: [{ label: "Banner", png: "", width: 300, height: 250 }] }] }).height, 250);
});

test("the one stop is one comparison sheet: a row per direction under the brand's name", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-compare-"));
  const names = { a: "# A — Slipway\n\nWarm paper ground, navy ink, one rust note. More.\n",
    b: "# Direction B: Soundings\n\nSage ground (#E8E5D6), deep green ink.\n", c: "# Signal\n\nDeep harbour navy.\n" };
  const rows = Object.entries(names).map(([id, text]) => {
    const dir = join(project.path, "directions", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "direction.md"), text);
    return directionRow(dir, { samples: [{ format: "readme", canvas: readme, aspect: 1, html: "", png: "samples/readme.png", source: "", composition: {} as never }] }, [readme]);
  });
  const html = sheetHtml({ title: brandName("Brief: Tidewater Tea Bar", "x"), rows });
  assert.match(html, /<h1>Tidewater Tea Bar<\/h1>/);
  assert.doesNotMatch(html, /Brief:|direction [abc]\b|#E8E5D6|\d px/i);
  assert.equal(html.match(/<figcaption>README header<\/figcaption>/g)?.length, 3);
  assert.equal(html.match(/<section/g)?.length, 3);
  for (const [mark, name] of [["A", "Slipway"], ["B", "Soundings"], ["C", "Signal"]]) {
    assert.match(html, new RegExp(`<h2><b>${mark}</b><span>${name}</span></h2>`));
  }
  assert.match(html, /<p>Warm paper ground, navy ink, one rust note\.<\/p>/);
  assert.match(html, /<p>Sage ground, deep green ink\.<\/p>/);
});

test("board directions writes the one comparison sheet, and a named direction alone after a revision", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-directions-"));
  const card = { id: "card", label: "Card", width: 480, height: 300, seenWidth: 390, source: "test" };
  writeFileSync(join(project.path, "brief.md"), "# Brief: Harbour Bakery\n\nBread by the water.\n");
  writeFileSync(join(project.path, "formats.json"), JSON.stringify([card]));
  for (const [id, ground] of [["a", "#f3eee2"], ["b", "#14283a"], ["c", "#e8e5d6"]]) {
    const dir = join(project.path, "directions", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "direction.md"), `# ${id.toUpperCase()} — Name ${id}\n\nOne idea for ${id}.\n`);
    writeFileSync(join(dir, "card.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Harbour Bakery</title></head><body style="margin:0;background:${ground};font:32px serif"><h1 style="margin:40px">Harbour Bakery</h1></body></html>`);
  }
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [launcher, ...args], { cwd: project.path, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim().split(/\r?\n/);
  };
  const root = join(project.path, "directions");
  const sheets = () => ["a", "b", "c"].filter((id) => existsSync(join(root, id, "sheet.png")));
  assert.deepEqual(run("directions", "."), [join(root, "sheet.png")]);
  assert.deepEqual(sheets(), []);
  const png = PNG.sync.read(readFileSync(join(root, "sheet.png")));
  assert.equal(png.width, sheetLayout({ rows: ["A", "B", "C"].map((mark) => ({ mark, items: [{ ...card, png: "" }] })) }).width);
  assert.deepEqual(run("directions", ".", "b"), [join(root, "sheet.png"), join(root, "b", "sheet.png")]);
  assert.deepEqual(sheets(), ["b"]);
  run("directions", ".");
  assert.deepEqual(sheets(), []);
});
