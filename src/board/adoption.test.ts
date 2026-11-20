import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readBoard } from "./versions.js";

const launcher = fileURLToPath(new URL("../../skill/briefatto-board/board.mjs", import.meta.url));
const execute = promisify(execFile);
const run = (cwd: string, ...args: string[]) => execute(process.execPath, [launcher, ...args], { cwd });
const adoption = (project: string, file: string) => join(project, ".briefatto", "adoption", file);
const guide = (ink: string) => [
  "---", "name: Ferry route", "colors:", "  ink: '" + ink + "'",
  "typography:", "  headline: {fontFamily: serif, fontSize: 32px}", "---",
  "", "# Ferry route", "", "Open with the departure time.", "",
  "### Brand facts", "", "> Board at ten.", "",
  "### Campaign copy", "", "| Role | Copy |", "| --- | --- |", "| Headline | Board at ten. |", "",
].join("\n");

test("adopt serves built pages and revalidates their CSS before freezing", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-adoption-"));
  const cwd = project.path;
  mkdirSync(join(cwd, "dist", "boardings"), { recursive: true });
  const html = [
    '<!doctype html><title>Ferry route</title><link rel="stylesheet" href="/route.css"><h1></h1>',
    '<script>document.querySelector("h1").textContent = location.pathname === "/" ? "Board at ten." : "Missing";</script>',
  ].join("");
  writeFileSync(join(cwd, "dist", "index.html"), html);
  writeFileSync(join(cwd, "dist", "boardings", "index.html"), html.replace('=== "/"', '=== "/boardings/"').replace("Board at ten.", "Board at eleven."));
  writeFileSync(join(cwd, "tailwind.config.mjs"), "export default {};");
  const css = join(cwd, "dist", "route.css");
  const paint = (ink: string, additions = "") => writeFileSync(css,
    ":root{--ink:" + ink + "}h1{font:32px serif;color:var(--ink);" + additions + "}");
  paint("#123456");

  await run(cwd, "adopt", ".", "--viewport", "800x600");
  const capture = JSON.parse(readFileSync(adoption(cwd, "evidence.json"), "utf8"));
  assert.ok(capture.styleSources.includes("tailwind.config.mjs"));
  assert.ok(capture.styleSources.includes("dist/route.css"));
  assert.equal(capture.pages.length, 2);
  for (const page of capture.pages) {
    assert.equal(page.siteStyles.variables["--ink"], "#123456");
    assert.equal(page.texts[0].color, "rgb(18, 52, 86)");
    assert.match(page.texts[0].text, /^Board at /);
    assert.ok(existsSync(adoption(cwd, page.png)));
  }
  assert.match((await run(cwd, "status")).stdout, /Adoption recorded/);

  const draft = join(cwd, "DESIGN.md");
  writeFileSync(draft, guide("#123456"));
  paint("#345678");
  const failure = spawnSync(process.execPath, [launcher, "freeze", "."], { cwd, encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /FAIL DESIGN.md[\s\S]*colour/);
  assert.ok(!existsSync(join(cwd, "board")));

  writeFileSync(draft, guide("#345678"));
  assert.match((await run(cwd, "freeze", ".")).stdout, /PASS DESIGN.md/);
  assert.match(readFileSync(draft, "utf8"), /briefatto-board:freeze v1 /);
  const boardDir = join(cwd, "board");
  assert.equal(readBoard(boardDir).name, "Ferry route");
  assert.match((await run(cwd, "freeze", ".")).stdout, /no change \(board v1\)/);
  paint("#345678", "border-bottom:2px solid #234567;");
  await run(cwd, "freeze", ".");
  assert.equal(readBoard(boardDir).version, 2);
  assert.ok(existsSync(join(cwd, "board.v1", "samples", "page-1.png")));
});

test("adopt captures a running route and freezes against its rendered DOM", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-adoption-"));
  let request = 0;
  const server = createServer((req, res) => {
    if (req.url !== "/sailing") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/html" }).end([
      '<!doctype html><title>Sailing</title><style>h1 {font: 32px serif; color: #123456}</style>',
      '<main></main><script nonce="' + ++request + '">document.querySelector("main").innerHTML = "<h1>Depart at ten.</h1>"</script>',
    ].join(""));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    const port = (server.address() as { port: number }).port;
    const url = "http://127.0.0.1:" + port + "/sailing";
    await run(project.path, "adopt", ".", "--page", url, "--viewport", "800x600");
    const evidence = readFileSync(adoption(project.path, "evidence.json"), "utf8");
    assert.match(evidence, /Depart at ten\./);
    writeFileSync(join(project.path, "DESIGN.md"), guide("#123456"));
    await run(project.path, "freeze", ".");
    const board = readBoard(join(project.path, "board"));
    assert.equal(board.samples[0].source, url);
    assert.equal(board.version, 1);
    assert.match((await run(project.path, "freeze", ".")).stdout, /no change \(board v1\)/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
