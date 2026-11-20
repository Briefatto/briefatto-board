import assert from "node:assert/strict";
import { mkdirSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FORMATS, findProjectFormats, formatOfFile, loadProjectFormats } from "./formats.js";
import { boardFromRenders } from "./freeze.js";
import type { Rendered } from "./render.js";
import { sheetHtml, stylescapeHtml } from "./sheet.js";

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
  const kit = sheetHtml({ title: "Kit", rows: [{ items: [{ ...readme, png: "readme.png" }] }] });
  for (const html of [direction, kit]) assert.match(html, /<figcaption>README header <span>· 1280 × 360 px<\/span><\/figcaption>/);
});
