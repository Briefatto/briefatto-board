import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { checkDeliverables, loadDeliverables, type DeliverableCheck } from "./deliverables.js";
import { Renderer } from "./render.js";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
const viewport = { width: 480, height: 300 };
const art = (content: string) => `<!doctype html><title>Fair wordmark</title><style>
  html,body{margin:0}body{font:24px serif} .block{background:#eb581d;width:260px;padding:30px} p{margin:0}
  *{print-color-adjust:exact}</style>${content}`;

test("both receipts reject the missing-image wordmark exports and retain the original bytes", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-exports-"));
  const { path } = project;
  for (const folder of ["board", "outputs"]) mkdirSync(join(path, folder));
  writeFileSync(join(path, "board", "DESIGN.md"), "# Fair\n");
  writeFileSync(join(path, "board", "board.json"), JSON.stringify({ version: 1, name: "Fair", direction: { title: "Fair" }, palette: [], fonts: [], samples: [] }));
  writeFileSync(join(path, "formats.json"), JSON.stringify([{ id: "hero", label: "Hero", ...viewport, seenWidth: 480, source: "Website" }]));
  const renderer = new Renderer();
  const entries = [];
  const broken: Buffer[] = [];
  const fixed: Buffer[] = [];
  const page = await renderer.newPage({ viewport });
  try {
    for (const [index, colour] of ["black", "white"].entries()) {
      const svg = join(path, "outputs", `${colour}.svg`);
      writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300"><path fill="${colour}" d="M40 40h300l45 40v145H40z"/></svg>`);
      const html = `outputs/${index ? "wordmark-white" : "hero"}.html`;
      const file = html.replace(".html", ".png");
      const source = (src: string) => art(`<img src="${src}" width="480" height="300" style="display:block">`);
      writeFileSync(join(path, html), source(`${colour}.svg`));
      // Reproduce the exporter that used setContent with file URLs and waited only for .complete.
      await page.setContent(source(pathToFileURL(svg).href));
      await page.waitForFunction(() => document.images[0].complete);
      assert.equal(await page.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth), 0);
      const bytes = await page.locator("img").screenshot({ omitBackground: true });
      writeFileSync(join(path, file), bytes);
      broken.push(bytes);
      const reference = await renderer.newPage({ viewport });
      try {
        await reference.goto(pathToFileURL(join(path, html)).href);
        await reference.locator("img").evaluate((img) => (img as HTMLImageElement).decode());
        fixed.push(await reference.screenshot({ omitBackground: true }));
      } finally { await reference.close(); }
      entries.push({ file, html, ...viewport, transparent: true });
    }
  } finally { await renderer.close(); }
  assert.deepEqual(broken[0], broken[1]);
  writeFileSync(join(path, "deliverables.json"), JSON.stringify(entries));
  const run = (status: number, command: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, command, ".", ...args], { cwd: path, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stdout + result.stderr);
    return (JSON.parse(readFileSync(join(path, "outputs", command === "kit" ? "kit-check.json" : "check.json"), "utf8")) as DeliverableCheck[])
      .filter(({ kind }) => kind === "png");
  };
  for (const result of [run(1, "check", "outputs/hero.html"), run(1, "kit")]) {
    assert.equal(result.length, 2);
    for (const [index, entry] of result.entries()) {
      assert.equal(entry.pass, false);
      assert.match(entry.detail!, /Export pixels differ/);
      assert.deepEqual(readFileSync(join(path, entries[index].file)), broken[index]);
    }
  }
  entries.forEach(({ file }, index) => writeFileSync(join(path, file), fixed[index]));
  for (const entry of run(0, "kit")) {
    assert.equal(entry.pass, true);
    assert.equal(entry.comparison?.mean, 0);
    assert.match(entry.sha256!, /^[\da-f]{64}$/);
  }
});

test("export checks decode PDFs and reject blank, corrupt, wrong-sized and visually different files", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-export-pdf-"));
  const { path } = project;
  const html = join(path, "poster.html");
  const other = join(path, "other.html");
  writeFileSync(html, art('<main class="block"><h1>Music Fair</h1><p>Saturday at 10</p><svg width="160" height="40"><circle cx="25" cy="20" r="18"/></svg></main>'));
  writeFileSync(other, art('<main class="block"><h1>Wrong page</h1><p>Different artwork</p></main>'));
  const renderer = new Renderer();
  const page = await renderer.newPage({ viewport });
  try {
    const pdf = async (file: string) => page.pdf({ path: join(path, file), printBackground: true, width: "480px", height: "300px" });
    await page.goto(pathToFileURL(html).href);
    await pdf("ok.pdf");
    await page.screenshot({ path: join(path, "circular.png") });
    writeFileSync(join(path, "circular.html"), art('<img src="circular.png" style="display:block">'));
    await page.goto(pathToFileURL(other).href);
    await pdf("different.pdf");
    await page.setContent("<!doctype html>");
    await pdf("blank.pdf");
    writeFileSync(join(path, "bad.pdf"), "bad PDF");
    writeFileSync(join(path, "bad.png"), "bad PNG");
    writeFileSync(join(path, "wrong.png"), PNG.sync.write(new PNG({ width: 1, height: 1 })));
    writeFileSync(join(path, "blank.png"), PNG.sync.write(new PNG({ ...viewport })));
    copyFileSync(join(path, "ok.pdf"), join(path, "wrong-page.pdf"));
    writeFileSync(join(path, "deliverables.json"), JSON.stringify([
      ...["ok.pdf", "different.pdf", "blank.pdf", "bad.pdf", "bad.png", "wrong.png", "blank.png", "missing.png"].map((file) => ({ file, html: "poster.html", ...viewport })),
      { file: "wrong-page.pdf", html: "poster.html", ...viewport, pageSizeMm: { width: 210, height: 297 } },
      { file: "circular.png", html: "circular.html", ...viewport },
    ]));
    const [ok, ...bad] = await checkDeliverables(renderer, loadDeliverables(path)!);
    assert.ok(ok.pass, ok.detail ?? "PDF failed");
    assert.ok(ok.comparison && ok.comparison.mean <= ok.comparison.tolerance.meanLimit, JSON.stringify(ok.comparison));
    const expected = [/pixels differ/, /Export is blank/, /PDF/i, /PNG|signature/i, /Export is 1x1/, /Export is blank/, /Export the listed file/, /expected 210x297 mm/, /loads the deliverable itself/];
    bad.forEach((entry, index) => {
      assert.equal(entry.pass, false, entry.file);
      assert.match(entry.detail ?? "", expected[index]);
    });
  } finally { await renderer.close(); }
});

test("an otherwise matching print export fails when only the fair date goes missing", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-export-details-"));
  const { path } = project;
  const size = { width: 1212, height: 1704 };
  const html = join(path, "poster.html");
  const file = join(path, "poster.pdf");
  const poster = (date: string) => art(`<div style="background:#000;width:100%;height:90px"></div>
    <p style="margin:80px;font:36px serif">${date}</p>`);
  writeFileSync(html, poster("Saturday 17 April 2027"));
  const renderer = new Renderer();
  try {
    const page = await renderer.newPage({ viewport: size });
    await page.setContent(poster(""));
    await page.pdf({ path: file, printBackground: true, width: `${size.width}px`, height: `${size.height}px` });
    const [result] = await checkDeliverables(renderer, [{ file, html, ...size }]);
    assert.equal(result.pass, false, JSON.stringify(result.comparison));
    assert.ok(result.comparison);
    const { mean, changedShare, maxTileMean, tolerance } = result.comparison;
    assert.ok(mean <= tolerance.meanLimit && changedShare <= tolerance.changedShareLimit);
    assert.ok(maxTileMean > tolerance.tileMeanLimit, JSON.stringify(result.comparison));
  } finally { await renderer.close(); }
});
