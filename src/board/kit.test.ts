import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadEssentials, requiredCampaignCopy } from "./essentials.js";
import { boardFromRenders } from "./freeze.js";
import { declareCampaign, readPiece } from "./pieces.js";
import type { Rendered } from "./render.js";

const launcher = fileURLToPath(new URL("../../skill/briefatto-board/board.mjs", import.meta.url));

test("kit stamps and checks launch deliverables while leaving review proofs and one-offs outside the receipt", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-kit-"));
  const outputs = join(project.path, "outputs");
  const boardDir = join(project.path, "board");
  const direction = join(project.path, "directions", "chosen");
  for (const dir of [boardDir, direction, join(outputs, "hero-review")]) mkdirSync(dir, { recursive: true });
  const brief = "# Workbench\n\nKeep the example commands on the launch page. Give the announcement a readable 6 April 2027 date and its web address, workbench.example. The repository card keeps its web address and is evergreen.\n";
  writeFileSync(join(project.path, "brief.md"), brief);
  writeFileSync(join(project.path, "essentials.json"), JSON.stringify({ requiredByFormat: {
    announcement: ["6 April 2027", "workbench.example"], github: ["workbench.example"],
    "hero-desktop": ["workbench record", "workbench check"], "hero-mobile": ["workbench record", "workbench check"],
  } }));
  const formats = ["announcement", "github", "hero-desktop", "hero-mobile"].map((id) => ({
    id, label: id, width: 480, height: 300, seenWidth: 390, source: "launch kit",
  }));
  writeFileSync(join(project.path, "formats.json"), JSON.stringify(formats));
  const render: Rendered = {
    png: "", width: 480, height: 300, contrast: [], family: null,
    colours: [{ value: "rgb(14, 26, 43)", kind: "bg", area: 480 * 300 }],
    texts: [], radii: [], images: [], shadows: 0, fontLinks: [], devices: [],
  };
  const board = boardFromRenders("Workbench", { id: "chosen", title: "Chosen", text: "" }, [{
    file: join(direction, "announcement.html"), fmt: "announcement", r: render, canvas: formats[0],
  }], boardDir);
  board.essentials = loadEssentials(project.path);
  board.brief = brief;
  writeFileSync(join(boardDir, "board.json"), JSON.stringify(board));
  writeFileSync(join(boardDir, "DESIGN.md"), "# Workbench\n");

  const piece = (copy: string, purpose = "") => [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="board-version" content="v1">', purpose, '<title>Workbench</title></head>',
    '<body style="margin:0;background:#0e1a2b;color:#fff;font:20px serif"><main style="margin:32px">',
    `<h1>Workbench</h1><p>${copy}</p></main></body></html>`,
  ].join("\n");
  const preview = piece("File example pending.");
  const markedReview = piece("File example pending.", '<meta name="board-purpose" content="review">');
  writeFileSync(join(outputs, "announcement.html"), piece("workbench.example"));
  writeFileSync(join(outputs, "github.html"), piece("workbench.example"));
  writeFileSync(join(outputs, "hero-desktop.html"), markedReview);
  writeFileSync(join(outputs, "hero-review", "hero-mobile.html"), preview);
  writeFileSync(join(direction, "announcement.html"), preview);
  const oneOff = join(outputs, "holiday-announcement.html");
  writeFileSync(oneOff, piece("Closed on 24 December."));

  const run = (expected: number, ...args: string[]) => {
    const result = spawnSync(process.execPath, [launcher, ...args], { cwd: project.path, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  };
  assert.match(run(1, "kit", ".", "--dir", "directions/chosen"), /Use the delivery directory/);
  assert.match(run(1, "kit", ".", "--dir", "outputs/hero-review"), /Use the delivery directory/);
  assert.match(run(1, "kit", ".", "--campaign", "Workbench launch"), /campaign: Workbench launch, checked against brief\.md/);
  const receipt = join(outputs, "kit-check.json");
  const saved = readFileSync(receipt, "utf8");
  const rows = JSON.parse(saved);
  const entries = rows.filter((entry: { kind?: string }) => !entry.kind);
  const exports = rows.filter((entry: { kind?: string }) => entry.kind === "png");
  assert.deepEqual(exports.map((entry: { file: string }) => basename(entry.file)), ["announcement.png", "github.png"]);
  assert.ok(exports.every((entry: { pass: boolean; sha256: string }) => entry.pass && /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.deepEqual(entries.map((entry: { file: string }) => basename(entry.file)), ["announcement.html", "github.html"]);
  for (const entry of entries) {
    assert.equal(entry.briefApplied, true);
    assert.equal(entry.briefScope, "campaign: Workbench launch, checked against brief.md");
    assert.ok(entry.checks.ran.includes("campaign copy"));
    assert.equal(readPiece(entry.file).campaign, "Workbench launch");
  }
  assert.equal(entries[0].pass, false);
  assert.deepEqual(entries[0].brief, [{ rule: "essential-missing", detail: '"6 April 2027"', source: "brief" }]);
  assert.equal(entries[1].pass, true, JSON.stringify({ floor: entries[1].floor, brief: entries[1].brief }));
  const sheet = readFileSync(join(outputs, "kit-sheet.html"), "utf8");
  assert.doesNotMatch(sheet, /hero-desktop|hero-mobile|holiday-announcement/);
  assert.equal(readFileSync(join(outputs, "hero-desktop.html"), "utf8"), markedReview);
  assert.equal(readFileSync(join(outputs, "hero-review", "hero-mobile.html"), "utf8"), preview);
  assert.equal(existsSync(join(outputs, "hero-desktop.png")), false);
  assert.equal(readPiece(oneOff).campaign, undefined);
  assert.match(run(0, "check", ".", "outputs/holiday-announcement.html"), /not a campaign piece/);
  assert.equal(JSON.parse(readFileSync(join(outputs, "check.json"), "utf8"))[0].briefScope, "not a campaign piece");
  assert.equal(readFileSync(receipt, "utf8"), saved);

  board.essentials = { ...board.essentials!, requiredByFormat: undefined };
  writeFileSync(join(boardDir, "board.json"), JSON.stringify(board));
  assert.match(run(1, "kit", "."), /campaign-requirements-missing/);
  for (const entry of JSON.parse(readFileSync(receipt, "utf8")).filter((entry: { kind?: string }) => !entry.kind)) {
    assert.equal(entry.pass, false);
    assert.equal(entry.briefScope, "campaign: Workbench launch, checked against brief.md");
    assert.equal(entry.brief[0].rule, "campaign-requirements-missing");
  }
});

test("campaign stamping is idempotent, respects the HTML head and preserves existing campaigns", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-piece-"));
  const file = join(project.path, "hero.html");
  writeFileSync(file, '<!doctype html><!-- <head> --><html><head data-note=">"><title>Board</title></head><body></body></html>');
  const campaign = 'Tools & "Docs"';
  declareCampaign(file, campaign);
  const stamped = readFileSync(file, "utf8");
  assert.match(stamped, /<head data-note=">">\n<meta name="board-campaign" content="Tools &amp; &quot;Docs&quot;">/);
  assert.equal(readPiece(file).campaign, campaign);
  declareCampaign(file, campaign);
  assert.equal(readFileSync(file, "utf8"), stamped);
  assert.throws(() => declareCampaign(file, "Another launch"), /declares campaign/);
  assert.equal(readFileSync(file, "utf8"), stamped);
});

test("an explicit hero address is checked while the shared address keeps its hero exemption", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-essentials-"));
  writeFileSync(join(project.path, "essentials.json"), "\uFEFF" + JSON.stringify({
    required: ["workbench.example"], requiredByFormat: { hero: ["docs.example"] },
  }));
  const essentials = loadEssentials(project.path);
  assert.deepEqual(requiredCampaignCopy(essentials, "hero").required, ["docs.example"]);
  assert.deepEqual(requiredCampaignCopy(essentials, "announcement").required, ["workbench.example"]);
});
