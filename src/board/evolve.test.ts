import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempDisposableSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { diffBoards } from "./diff.js";
import { loadEssentials } from "./essentials.js";
import { boardFromRenders, designMd, renderBoard, type Board } from "./freeze.js";
import type { Rendered } from "./render.js";
import { publishBoard, readBoard, readBoardVersion } from "./versions.js";
import { hashLocalAssets, SOURCE_ASSETS_FILE } from "./source-assets.js";

const launcher = fileURLToPath(new URL("../../skill/briefatto-board/board.mjs", import.meta.url));
const scratch = () => mkdtempDisposableSync(join(tmpdir(), "board-test-"));

function fixture(version = 1, note = ""): Board {
  const r: Rendered = {
    png: "", width: 1440, height: 900, contrast: [], family: null,
    colours: [{ value: "rgb(14, 26, 43)", kind: "bg", area: 1440 * 900 }],
    texts: [], radii: [], images: [], shadows: 0, fontLinks: [], devices: [],
  };
  return {
    ...boardFromRenders("Test board", { id: "pick", title: "Pick", text: "" }, [{ file: "directions/pick/hero.html", fmt: "hero", r }], "board"),
    version, note, type: {},
  };
}

function writeBoard(dir: string, b: Board) {
  mkdirSync(join(dir, "samples"), { recursive: true });
  writeFileSync(join(dir, "board.json"), JSON.stringify(b));
  writeFileSync(join(dir, b.samples[0].html), `sample ${b.version}`);
  writeFileSync(join(dir, b.samples[0].png), `picture ${b.version}`);
}

const runBoard = (project: string, ...args: string[]) =>
  execFileSync(process.execPath, [launcher, ...args], { cwd: project, encoding: "utf8" }).replace(/\r\n/g, "\n");

function failedBoard(project: string, ...args: string[]): string {
  const result = spawnSync(process.execPath, [launcher, ...args], { cwd: project, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stderr);
  return result.stdout + result.stderr;
}

function authoredFixture(project: string) {
  const dir = join(project, "directions", "pick");
  const refs = join(project, "refs");
  mkdirSync(dir, { recursive: true });
  mkdirSync(refs, { recursive: true });
  writeFileSync(join(refs, "notes.md"), "```approval pick\nYes, I approve this for production.\n```\n");
  writeFileSync(join(dir, "hero.html"), [
    '<!doctype html><html lang="en"><head><title>Fixture</title></head>',
    '<body style="margin:0;background:#0e1a2b;color:#fff"><h1 style="font:32px serif">Open Fridays.</h1><p style="font:32px serif">Pick it up</p>',
    '<svg width="100" height="8"><line x1="2" y1="4" x2="98" y2="4" stroke="#12345680" stroke-width="2"/></svg></body></html>',
  ].join("\n"));
  writeFileSync(join(project, "brief.md"), "# Test board\n\n**Who.** A bakery on the quay.\n\n- Brand: Test board\n- Headline: Open Fridays.\n- Call to action: Pick it up\n");
  return [
    "---", "name: Test board", "colors:", "  ground: '#0e1a2b'", "  ink: '#ffffff'", "  base-rule: '#12345680'",
    'typography:', '  headline: {fontFamily: serif, fontSize: 32px, fontWeight: 400}', "---", "",
    "## Overview", "", "### Brand facts", "", "> **Who.** A bakery on the quay.", "",
    "### Campaign copy", "", "| Role | Copy |", "| --- | --- |", "| Brand | Test board |",
    "| Headline | Open Fridays. |", "| Call to action | Pick it up |", "",
    "## Layout", "", "Set the headline on the ground. Keep the sign plain.", "",
  ].join("\n");
}

const freezeStamp = /^<!-- briefatto-board:freeze (v\d+) (\d{4}-\d{2}-\d{2}) sha256:([a-f\d]{64}) -->\r?\n/gm;
const generatedBlock = /\r?\n\r?\n<!-- briefatto-board:generated begin -->[\s\S]*?<!-- briefatto-board:generated end -->\r?\n$/;
const designHash = (markdown: string) => createHash("sha256").update(markdown).digest("hex");

test("the design guide declares secondary font families alongside its type roles", () => {
  const board = fixture();
  board.type.display = { family: "Space Grotesk", weight: 700, transform: "none", letterSpacingEm: 0, lineHeight: 1, italic: false };
  board.type.body = { ...board.type.display, weight: 400 };
  board.fonts = [
    { family: "Space Grotesk", weights: [400, 700], stack: '"Space Grotesk", sans-serif' },
    { family: "JetBrains Mono", weights: [400, 600], stack: '"JetBrains Mono", monospace' },
  ];
  const frontmatter = designMd(board).split("---\n")[1];
  assert.match(frontmatter, /  display:\n    fontFamily: "Space Grotesk"/);
  assert.match(frontmatter, /  body:\n    fontFamily: "Space Grotesk"/);
  assert.doesNotMatch(frontmatter, /  font-family-1:/);
  assert.match(frontmatter, /  font-family-2:\n    fontFamily: "JetBrains Mono"\n/);
});

test("pre-version boards read as v1 and keep their original date and sample provenance", () => {
  using project = scratch();
  const dir = join(project.path, "board");
  const b = fixture();
  writeBoard(dir, b);
  const { version, note, ...legacy } = b;
  const { source, ...sample } = legacy.samples[0];
  for (const version of [undefined, 0]) {
    writeFileSync(join(dir, "board.json"), JSON.stringify({ ...legacy, version, samples: [{ ...sample, html: source }] }));
    assert.deepEqual(readBoard(dir), b);
  }
});

test("freeze publication keeps each prior board and its sample files", async () => {
  using project = scratch();
  const dir = join(project.path, "board");
  mkdirSync(dir);
  const publish = async (note: string) => (await publishBoard(dir, async (stage, version) => {
    const b = fixture(version, note);
    writeBoard(stage, b);
    return b;
  })).board;

  const first = await publish("");
  const stylescape = '<img src="file:///old/project/board/samples/hero.png"><img src="file:///old/project/board/device-hero-0.png">';
  writeFileSync(join(dir, "stylescape.html"), stylescape);
  const second = await publish("warmer");
  const third = await publish("less corporate");

  assert.deepEqual([first.version, second.version, third.version], [1, 2, 3]);
  const current = readBoard(dir);
  assert.deepEqual(current, third);
  assert.deepEqual(readBoardVersion(dir, current, 1), first);
  assert.deepEqual(readBoardVersion(dir, current, 2), second);
  assert.equal(readFileSync(join(project.path, "board.v1", "samples", "hero.html"), "utf8"), "sample 1");
  assert.equal(readFileSync(join(project.path, "board.v2", "samples", "hero.html"), "utf8"), "sample 2");
  assert.equal(readFileSync(join(project.path, "board.v1", "stylescape.html"), "utf8"), '<img src="samples/hero.png"><img src="device-hero-0.png">');
  assert.match(runBoard(project.path, "log"), /v1 .*\(no note\)\nv2 .*"warmer"\nv3 .*"less corporate"  \(current\)/);
});

test("a failed freeze leaves the current board available and can be retried", async () => {
  using project = scratch();
  const dir = join(project.path, "board");
  const original = fixture();
  writeBoard(dir, original);
  await assert.rejects(publishBoard(dir, async (stage, version) => {
    writeBoard(stage, fixture(version));
    throw new Error("render failed");
  }), /render failed/);
  assert.deepEqual(readBoard(dir), original);
  assert.equal(existsSync(join(project.path, "board.v1")), false);
  const { board: current } = await publishBoard(dir, async (stage, version) => {
    const b = fixture(version);
    writeBoard(stage, b);
    return b;
  });
  assert.equal(current.version, 2);
});

test("a guidance failure leaves the last current board in place", async () => {
  using project = scratch();
  const dir = join(project.path, "board");
  const original = fixture();
  writeBoard(dir, original);
  await assert.rejects(publishBoard(dir, async (stage, version) => {
    const next = fixture(version);
    writeBoard(stage, next);
    return next;
  }, {
    prepareCurrent: () => () => { throw new Error("guide update failed"); },
  }), /guide update failed/);
  assert.deepEqual(readBoard(dir), original);
  assert.equal(existsSync(join(project.path, "board.v1")), false);
});

test("render noise keeps the board, note, sample files and history intact", async () => {
  using project = scratch();
  const dir = join(project.path, "board");
  const current = fixture(2, "original note");
  current.images.srcs = ["file:///original/project/assets/loaf.jpg"];
  writeBoard(dir, current);
  const originalAsset = join(project.path, "original.css");
  const alternateAsset = join(project.path, "alternate.css");
  writeFileSync(originalAsset, "/* original */");
  writeFileSync(alternateAsset, "/* alternate */");
  writeFileSync(join(dir, SOURCE_ASSETS_FILE), JSON.stringify(hashLocalAssets(project.path, [originalAsset])));
  const original = readFileSync(join(dir, "board.json"));
  const originalPng = readFileSync(join(dir, current.samples[0].png));
  let guidedVersion: number | undefined;
  const result = await publishBoard(dir, async (stage, version) => {
    const candidate = { ...current, version, note: "new note only", frozenAt: "2099-01-01T00:00:00.000Z" };
    candidate.images = { ...candidate.images, srcs: ["file:///moved/project/assets/loaf.jpg"] };
    candidate.radii = { ...current.radii, full: true };
    writeBoard(stage, candidate);
    writeFileSync(join(stage, candidate.samples[0].html), readFileSync(join(dir, current.samples[0].html)));
    writeFileSync(join(stage, SOURCE_ASSETS_FILE), JSON.stringify(hashLocalAssets(project.path, [alternateAsset])));
    assert.notDeepEqual(readFileSync(join(stage, candidate.samples[0].png)), originalPng);
    return candidate;
  }, {
    finishStage: async () => assert.fail("No stylescape is needed for identical samples"),
    prepareCurrent: (board) => () => { guidedVersion = board.version; },
  });
  assert.deepEqual(result, { board: current, changed: false });
  assert.equal(guidedVersion, 2);
  assert.deepEqual(readFileSync(join(dir, "board.json")), original);
  assert.deepEqual(readFileSync(join(dir, current.samples[0].png)), originalPng);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, SOURCE_ASSETS_FILE), "utf8")), hashLocalAssets(project.path, [originalAsset, alternateAsset]));
  assert.equal(existsSync(join(project.path, "board.v2")), false);
});

test("a freeze creates a version when the sample HTML changes", async () => {
  using project = scratch();
  const dir = join(project.path, "board");
  const current = fixture();
  writeBoard(dir, current);
  const { board, changed } = await publishBoard(dir, async (stage, version) => {
    const candidate = { ...current, version };
    writeBoard(stage, candidate);
    writeFileSync(join(stage, candidate.samples[0].png), readFileSync(join(dir, current.samples[0].png)));
    return candidate;
  });
  assert.equal(changed, true);
  assert.equal(board.version, 2);
  assert.deepEqual(readBoard(join(project.path, "board.v1")), current);
});

test("a freeze versions changes to linked sample and guide assets at the same paths", () => {
  using project = scratch();
  const current = join(project.path, "board");
  const direction = join(project.path, "directions", "pick");
  const hero = join(direction, "hero.html");
  const draft = authoredFixture(project.path) + "\n[Print copy](copy.txt)\n";
  writeFileSync(join(project.path, "DESIGN.md"), draft);
  writeFileSync(join(project.path, "copy.txt"), "first copy");
  writeFileSync(hero, readFileSync(hero, "utf8").replace("</head>", '<link rel="stylesheet" href="sample.css"></head>'));
  writeFileSync(join(direction, "sample.css"), '@import "nested.css";');
  const css = join(direction, "nested.css");
  writeFileSync(css, "/* first */");
  runBoard(project.path, "freeze", ".", "pick");
  const guideHash = readBoard(current).designHash;

  const fingerprint = join(current, SOURCE_ASSETS_FILE);
  const original = readFileSync(fingerprint);
  unlinkSync(fingerprint);
  assert.match(runBoard(project.path, "freeze", ".", "pick"), /no change \(board v1\)/);
  assert.deepEqual(readFileSync(fingerprint), original);
  assert.equal(existsSync(join(project.path, "board.v1")), false);

  writeFileSync(css, "/* second */");
  runBoard(project.path, "freeze", ".", "pick");
  assert.equal(readBoard(current).version, 2);
  assert.notDeepEqual(readFileSync(fingerprint), original);

  writeFileSync(join(project.path, "copy.txt"), "second copy");
  runBoard(project.path, "freeze", ".", "pick");
  assert.equal(readBoard(current).version, 3);
  assert.equal(readBoard(current).designHash, guideHash);
  assert.match(runBoard(project.path, "freeze", ".", "pick"), /no change \(board v3\)/);
});

test("duplicate formats cannot overwrite a frozen sample", async () => {
  using project = scratch();
  const directionDir = project.path;
  writeFileSync(join(directionDir, "hero.html"), "");
  writeFileSync(join(directionDir, "hero.htm"), "");
  await assert.rejects(renderBoard({ directionDir, boardDir: join(project.path, "board"), name: "Test board" }), /Multiple sample files for the same format/);
});

test("install writes both instruction files and the first freeze replaces only their marked blocks", () => {
  using project = scratch();
  const agents = join(project.path, "AGENTS.md");
  const claude = join(project.path, "CLAUDE.md");
  const design = join(project.path, "DESIGN.md");
  const start = "<!-- briefatto-board:start -->";
  const end = "<!-- briefatto-board:end -->";
  const before = "\uFEFF# Project instructions\r\n\r\n";
  const after = "\r\n\r\nKeep this text.  ";
  writeFileSync(claude, before + [start, "Old pointer", end].join("\r\n") + after);
  const draft = authoredFixture(project.path);
  writeFileSync(design, draft);

  const checkInstructions = (lines: string[]) => {
    const block = [start, ...lines, end];
    assert.deepEqual(readFileSync(agents), Buffer.from(block.join("\n") + "\n"));
    assert.deepEqual(readFileSync(claude), Buffer.from(before + block.join("\r\n") + after));
  };
  const setup = [
    "This project uses Briefatto Board for design work. Read `.claude/skills/briefatto-board/SKILL.md` and run board commands with `npx briefatto-board`.",
    "No frozen design yet.",
  ];
  runBoard(project.path, "install");
  checkInstructions(setup);
  runBoard(project.path, "install");
  checkInstructions(setup);
  assert.equal(readFileSync(design, "utf8"), draft);

  runBoard(project.path, "freeze", ".", "pick");
  const frozen = [
    "Read `DESIGN.md` before any visual work.",
    "Brand changes go through `board freeze`.",
    "Run `board check` on every piece before handing it over.",
  ];
  checkInstructions(frozen);
  runBoard(project.path, "install");
  checkInstructions(frozen);
});

test("default freeze preserves the authored guide and archives a prose-only edit", () => {
  using project = scratch();
  const current = join(project.path, "board");
  const archive = join(project.path, "board.v1");
  const design = join(project.path, "DESIGN.md");
  const draft = authoredFixture(project.path);
  writeFileSync(design, draft);

  assert.match(runBoard(project.path, "freeze", ".", "pick"), /PASS DESIGN\.md/);
  const first = readFileSync(design, "utf8");
  const [boardStamp] = [...first.matchAll(freezeStamp)];
  assert.ok(boardStamp, "the published guide carries its version, date and content hash");
  assert.equal(boardStamp[1], "v1");
  assert.equal(boardStamp[2], readBoard(current).frozenAt.slice(0, 10));
  const unsigned = first.replace(freezeStamp, "");
  assert.equal(boardStamp[3], designHash(unsigned));
  assert.equal(readBoard(current).designHash, designHash(unsigned));
  assert.equal(unsigned.replace(generatedBlock, ""), draft, "stamping preserves every authored byte");
  assert.equal(readFileSync(join(current, "DESIGN.md"), "utf8"), first);

  assert.match(runBoard(project.path, "freeze", ".", "pick"), /no change \(board v1\)/);
  assert.equal(readFileSync(design, "utf8"), first, "re-freezing keeps one original stamp");
  assert.equal(existsSync(archive), false);

  const freshInstruction = "Leave room for the price beside the headline.";
  writeFileSync(design, first.replace("Keep the sign plain.", freshInstruction));
  assert.match(runBoard(project.path, "freeze", ".", "pick"), /PASS DESIGN\.md/);
  const nextDraft = draft.replace("Keep the sign plain.", freshInstruction);
  const second = readFileSync(design, "utf8");
  const nextUnsigned = second.replace(freezeStamp, "");
  assert.deepEqual([...second.matchAll(freezeStamp)].map((stamp) => [stamp[1], stamp[3]]), [["v2", designHash(nextUnsigned)]]);
  assert.equal(nextUnsigned.replace(generatedBlock, ""), nextDraft);
  assert.equal(readFileSync(join(current, "DESIGN.md"), "utf8"), second);
  assert.equal(readFileSync(join(archive, "DESIGN.md"), "utf8"), first, "the archive carries the old prose and stamp");
  assert.deepEqual(readFileSync(join(archive, "samples", "hero.html")), readFileSync(join(current, "samples", "hero.html")));
  assert.match(runBoard(project.path, "log"), /^v2 .*\(current\)$/m);
  assert.match(runBoard(project.path, "diff", "v1", "v2"), /No extracted values changed\./);
});

test("default freeze names the missing project guide", () => {
  using project = scratch();
  authoredFixture(project.path);
  assert.match(failedBoard(project.path, "freeze", ".", "pick"), /DESIGN\.md/);
  assert.equal(existsSync(join(project.path, "board")), false);
});

test("freeze preview shows the exact claims and their sources before a guide exists", () => {
  using project = scratch();
  const dir = join(project.path, "directions", "pick");
  const brief = join(project.path, "brief.md");
  const notes = join(project.path, "refs", "notes.md");
  const draft = authoredFixture(project.path);
  writeFileSync(brief, "\r\n" + readFileSync(brief, "utf8").replace(/\n/g, "\r\n") + "- Website: bakery.example/friday\r\n");
  writeFileSync(notes, "# Approval\n\n```constraint\nKeep the Friday headline.\n```\n\n" + readFileSync(notes, "utf8"));
  const hero = join(dir, "hero.html");
  writeFileSync(hero, readFileSync(hero, "utf8").replace(/32px/g, "32.125px"));
  const tree = readdirSync(project.path, { recursive: true });

  const preview = JSON.parse(runBoard(project.path, "freeze", ".", "pick", "--dry-run"));
  assert.deepEqual(preview.brief.brandFacts, [{ value: "**Who.** A bakery on the quay.", source: "brief.md:4" }]);
  assert.deepEqual(preview.brief.clientConstraints, [{ value: "Keep the Friday headline.", source: "refs/notes.md:4" }]);
  assert.deepEqual(preview.brief.campaignCopy[2], { role: "Call to action", copy: "Pick it up", source: "brief.md:8" });
  assert.deepEqual(preview.campaignRequirements.required, ["Pick it up", "bakery.example/friday"]);
  assert.deepEqual(preview.campaignFindings, []);
  const [sample] = preview.samples;
  assert.equal(sample.source, "directions/pick/hero.html");
  assert.ok(sample.colours.includes("rgb(14, 26, 43)"));
  assert.ok(sample.fontFamilies.includes("serif"));
  assert.ok(sample.fontSizes.includes("32.125px"));
  assert.match(preview.design, /> Keep the Friday headline\./);
  assert.match(preview.design, /\| headline \| `font-family: serif` \| 32\.125px \|/);
  assert.deepEqual(readdirSync(project.path, { recursive: true }), tree);

  writeFileSync(join(project.path, "DESIGN.md"), draft);
  const output = failedBoard(project.path, "freeze", ".", "pick");
  assert.match(output, /font-size:.*"32\.125px" from directions\/pick\/hero\.html/);
  assert.doesNotMatch(output, /client-constraint:/);
});

test("prose-only freeze records a plain brief and refreshes CSS measurements and confirmed quotes", () => {
  using project = scratch();
  authoredFixture(project.path);
  const guide = join(project.path, "DESIGN.md");
  const hero = join(project.path, "directions", "pick", "hero.html");
  const notes = join(project.path, "refs", "notes.md");
  writeFileSync(join(project.path, "brief.md"), [
    "We're launching a small version-checking CLI. It reports what's out of line.",
    "",
    "The exact example commands are `tool record` and `tool check`. Please use “Know your tools. Get to work.” and “Read the quickstart”. Don't promise automatic repairs.",
    "",
    'The words we\'ve signed off are "Two films. Home by seven.", "Book a seat" and "Open Fridays.".',
  ].join("\n"));
  writeFileSync(join(project.path, "essentials.json"), JSON.stringify({ requiredByFormat: { hero: ["Open Fridays."] } }));
  appendFileSync(notes, "```constraint\nKeep the commands beside the diagram.\n```\n");
  const prose = "# Workbench\r\n\r\n## Layout\r\nKeep the layout in two parts.\r\n\r\n## Voice\r\nWrite like a teammate who reads the docs.\r\n";
  writeFileSync(guide, prose);
  const source = readFileSync(hero, "utf8").replace("<h1 ", '<h1 data-board-role="launch headline" ');
  writeFileSync(hero, source);

  const preview = JSON.parse(runBoard(project.path, "freeze", ".", "pick", "--dry-run"));
  assert.equal(readFileSync(guide, "utf8"), prose);
  assert.deepEqual(preview.designFindings, []);
  assert.match(preview.design, /> We're launching a small version-checking CLI\. It reports what's out of line\./);
  for (const copy of ["Know your tools. Get to work.", "tool record", "tool check", "Read the quickstart", "Two films. Home by seven.", "Book a seat"]) {
    assert.ok(preview.design.includes(`| Approved copy | ${copy} |`), copy);
  }
  assert.match(preview.design, /\| Required on hero \| Open Fridays\. \| brief\.md:5 \|/);
  assert.match(preview.design, /> Don't promise automatic repairs\./);
  assert.match(preview.design, /> Keep the commands beside the diagram\./);
  assert.match(preview.design, /\| launch headline \| `font-family: serif` \| 32px \|/);
  assert.match(preview.design, /\| bg \| `colour: rgb\(14, 26, 43\)` \|/);

  assert.match(runBoard(project.path, "freeze", ".", "pick"), /PASS DESIGN\.md/);
  const first = readFileSync(guide, "utf8");
  assert.equal(first.replace(freezeStamp, ""), preview.design);
  assert.equal(preview.design.replace(generatedBlock, ""), prose);

  writeFileSync(guide, first.replace("32px | 400 normal", "999px | 400 normal"));
  writeFileSync(hero, source.replace("32px serif", "35.5px serif").replace("#0e1a2b", "#102030"));
  appendFileSync(notes, "\n```constraint\nKeep the two commands legible.\n```\n");
  assert.match(runBoard(project.path, "freeze", ".", "pick"), /PASS DESIGN\.md/);
  const second = readFileSync(guide, "utf8");
  assert.equal(second.replace(freezeStamp, "").replace(generatedBlock, ""), prose);
  assert.match(second, /\| launch headline \| `font-family: serif` \| 35\.5px \|/);
  assert.match(second, /> Keep the two commands legible\./);
  assert.doesNotMatch(second, /999px|rgb\(14, 26, 43\)/);

  writeFileSync(guide, second.replace("Keep the layout in two parts.", "Use #000000 for the approved ground."));
  assert.match(failedBoard(project.path, "freeze", ".", "pick"), /colour:.*contradicts.*"#000000".*Use "rgb\(16, 32, 48\)"/);

  writeFileSync(guide, second.replace("Keep the layout in two parts.", "The launch headline font size is 32px."));
  assert.match(failedBoard(project.path, "freeze", ".", "pick"), /font-size:.*"32px" for "launch headline".*Use "35\.5px"/);
});

test("freeze blocks missing campaign copy in selected samples and tagged outputs", () => {
  using project = scratch();
  const draft = authoredFixture(project.path);
  const guide = join(project.path, "DESIGN.md");
  writeFileSync(guide, draft);
  const hero = join(project.path, "directions", "pick", "hero.html");
  const complete = readFileSync(hero, "utf8");
  const missing = complete.replace("Pick it up", "Come by some time");
  writeFileSync(hero, missing);
  assert.match(failedBoard(project.path, "freeze", ".", "pick"), /directions\/pick\/hero\.html: essential-missing: "Pick it up" from brief\.md/);
  const campaign = '<meta name="board-campaign" content="opening">';
  writeFileSync(hero, missing.replace("<head>", "<head>" + campaign));
  assert.match(failedBoard(project.path, "freeze", ".", "pick", "--extract", "--force"), /directions\/pick\/hero\.html: essential-missing/);
  assert.equal(existsSync(join(project.path, "board")), false);
  assert.equal(readFileSync(guide, "utf8"), draft);

  writeFileSync(hero, complete.replace("<head>", "<head>" + campaign));
  runBoard(project.path, "freeze", ".", "pick");
  writeFileSync(guide, draft + "\nKeep this layout on holidays.\n");
  runBoard(project.path, "freeze", ".", "pick");
  const outputs = join(project.path, "outputs");
  mkdirSync(outputs);
  const piece = join(outputs, "hero.html");
  const outputWithVersion = (version: string) =>
    missing.replace("<head>", `<head>${campaign}<meta name="board-version" content="${version}">`);
  writeFileSync(piece, outputWithVersion("v1"));
  assert.match(failedBoard(project.path, "freeze", ".", "pick"), /outputs\/hero\.html: essential-missing: "Pick it up" from brief\.md/);
  writeFileSync(piece, outputWithVersion("v2"));
  assert.match(failedBoard(project.path, "freeze", ".", "pick"), /outputs\/hero\.html: essential-missing: "Pick it up" from brief\.md/);
  assert.equal(readBoard(join(project.path, "board")).version, 2);
});

test("failed authored validation reports each field and leaves the current version intact", () => {
  using project = scratch();
  const current = join(project.path, "board");
  const archive = join(project.path, "board.v1");
  const design = join(project.path, "DESIGN.md");
  const draft = authoredFixture(project.path);
  writeFileSync(design, draft);
  runBoard(project.path, "freeze", ".", "pick");
  const lastBoard = readFileSync(join(current, "board.json"));
  const lastDesign = readFileSync(join(current, "DESIGN.md"));

  const invalid = draft
    .replace("#0e1a2b", "#0e1a2c")
    .replace("fontFamily: serif", "fontFamily: Bogus Typeface")
    .replace("fontSize: 32px", "fontSize: 31px")
    .replace("A bakery on the quay.", "A bakery in the park.")
    .replace("| Headline | Open Fridays. |", "| Headline | Open Saturdays. |")
    + "\n[Absent sample](samples/hero.png)\n\nAn unfinished `load line.\n";
  writeFileSync(design, invalid);

  const output = failedBoard(project.path, "freeze", ".", "pick", "--force");
  for (const name of ["colour", "font-family", "font-size", "brand-fact", "campaign-copy", "file-reference", "truncated-line"]) {
    assert.match(output, new RegExp(`\\b${name}\\b`));
  }
  assert.match(output, /colour:.*"rgb\(14, 26, 43\)" from directions\/pick\/hero\.html/);
  assert.match(output, /font-family:.*"serif" from directions\/pick\/hero\.html/);
  assert.match(output, /font-size:.*"32px" from directions\/pick\/hero\.html/);
  assert.match(output, /brand-fact:.*"\*\*Who\.\*\* A bakery on the quay\." from brief\.md:3 verbatim/);
  assert.match(output, /campaign-copy:.*"Headline" with "Open Fridays\." from brief\.md:6/);
  assert.deepEqual(readFileSync(join(current, "board.json")), lastBoard);
  assert.deepEqual(readFileSync(join(current, "DESIGN.md")), lastDesign);
  assert.equal(readFileSync(design, "utf8"), invalid, "a failed draft stays available for correction without a stamp");
  assert.equal(existsSync(archive), false);
});

test("freeze remembers client quotes, versions new quotes alone and keeps both records available", () => {
  using project = scratch();
  const dir = join(project.path, "directions", "pick");
  const refs = join(project.path, "refs");
  const current = join(project.path, "board");
  const archive = join(project.path, "board.v1");
  const notes = join(refs, "notes.md");
  const design = join(project.path, "DESIGN.md");
  mkdirSync(dir, { recursive: true });
  mkdirSync(refs);
  writeFileSync(join(dir, "hero.html"), '<!doctype html><html lang="en"><head><title>Fixture</title></head><body style="margin:0;background:#0e1a2b"><p>EUR 12</p></body></html>');
  const subline = "A long line about the bakery and the full offer, including all the words at the end of the original sentence.";
  writeFileSync(join(project.path, "brief.md"), `# Test board\n\n- Brand: Test Bakery\n- Subline: ${subline}\n- Details: EUR 12, Friday collection only\n- URL: test.example\n`);
  mkdirSync(join(project.path, "assets"));
  const logo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>';
  writeFileSync(join(project.path, "assets", "brand.svg"), logo);
  writeFileSync(join(project.path, "essentials.json"), JSON.stringify({
    required: ["EUR 12", "test.example"], body: [subline], assets: [{ path: "assets/brand.svg", origin: "client" }],
  }));
  const before = ["Show the bread.", "nothing that looks clickable"];
  const added = "Always say ‘Friday’.";
  const quote = (text: string) => `\`\`\`constraint\n${text}\n\`\`\`\n`;
  writeFileSync(notes, "# Client replies\n\nI like number two more.\n\n```approval pick\nYes, I approve this for production.\n```\n\n" + before.map(quote).join("\n"));

  // This test covers the measured guide, including its generated asset embedding and prose.
  runBoard(project.path, "freeze", ".", "pick", "--extract");
  assert.deepEqual(readBoard(current).constraints, before);
  // The standalone file and its snapshot carry the facts, assets and quotes.
  for (const path of [design, join(current, "DESIGN.md")]) {
    const body = readFileSync(path, "utf8");
    assert.ok(body.includes("### Client musts and must-nots"));
    for (const fact of ["Test Bakery", subline, "EUR 12, Friday collection only", "test.example"]) assert.ok(body.includes(fact));
    assert.ok(body.includes(`data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`));
    for (const text of before) assert.ok(body.includes(`> ${text}`));
    assert.ok(!body.includes("I like number two more."));
  }
  assert.doesNotMatch(readFileSync(join(project.path, "AGENTS.md"), "utf8"), /Show the bread/);

  appendFileSync(notes, `\n${quote(added)}\n${quote(before[0])}`);
  runBoard(project.path, "freeze", ".", "pick", "--extract", "--note", added);
  assert.deepEqual(readBoard(current).constraints, [...before, added]);
  assert.deepEqual(readBoard(archive).constraints, before);
  assert.ok(!readFileSync(join(archive, "DESIGN.md"), "utf8").includes(added));
  for (const path of [design, join(current, "DESIGN.md")]) {
    const body = readFileSync(path, "utf8");
    for (const text of [...before, added]) assert.equal(body.split(`> ${text}`).length, 2);
    assert.match(body, /Board v2 · \d{4}-\d{2}-\d{2}\.\*\* Changed since v1/);
    assert.ok(body.includes(added));
  }
  assert.ok(runBoard(project.path, "diff", "v1", "v2").includes(`Remembered constraints: ${before.join(", ")} → ${[...before, added].join(", ")}`));

  unlinkSync(notes);
  assert.match(runBoard(project.path, "freeze", ".", "pick", "--extract"), /no change \(board v2\)/);
  assert.deepEqual(readBoard(current).constraints, [...before, added]);
});

test("diff reports exact extracted values including composition for each sample", () => {
  const before = fixture();
  before.type.display = { family: "Serif", weight: 400, italic: false, letterSpacingEm: 0, lineHeight: 1, transform: "none" };
  before.images.srcs = ["file:///old/project/assets/loaf.jpg"];
  const after = structuredClone(before);
  after.version = 2;
  after.note = "warmer";
  after.frozenAt = "2026-11-19T00:00:00.000Z";
  after.images.srcs = ["file:///copy/assets/loaf.jpg"];
  assert.deepEqual(diffBoards(before, after), []);

  after.palette[0].hex = "#352015";
  after.type.display = { ...before.type.display, family: "Slab", weight: 500 };
  after.device.colours = ["#b45624"];
  after.images.filters = ["grayscale(1)"];
  after.composition.marginShare = [0.1, 0.2];
  after.samples[0].composition.anchor = [0.4, 0.5];
  assert.deepEqual(diffBoards(before, after), [
    "Colour ground: #0e1a2b → #352015",
    "Type display font: Serif → Slab",
    "Type display weight: 400 → 500",
    "Device colours: none → #b45624",
    "Image filters: none → grayscale(1)",
    "Composition margin share of short side: 0, 0 → 0.1, 0.2",
    "Composition hero display centre (x, y): 0.5, 0.5 → 0.4, 0.5",
  ]);
});

test("status reports existing pieces before the first freeze", () => {
  using project = scratch();
  const outputs = join(project.path, "outputs");
  mkdirSync(outputs);
  writeFileSync(join(outputs, "flyer.html"), "<head><title>Flyer</title></head>");
  writeFileSync(join(outputs, "poster.html"), '<head><meta name="board-version" content="v1"></head>');

  assert.equal(runBoard(project.path, "status").trimEnd(), [
    "No frozen board.",
    "outputs/flyer.html: made-under version unrecorded",
    "outputs/poster.html: declares v1 (unrecorded)",
  ].join("\n"));
});

test("status finds newly made pieces and reads their declared versions after a move", () => {
  using project = scratch();
  using moved = scratch();
  const outputs = join(project.path, "outputs");
  mkdirSync(outputs);
  for (const file of ["hero.html", "post.html", "story.htm", "kit-sheet.html"]) writeFileSync(join(outputs, file), "");
  writeBoard(join(project.path, "board"), fixture(3));
  writeFileSync(join(outputs, "board-versions.json"), JSON.stringify({ "hero.html": "v3", "story.htm": "v2", "mrec.html": "v1" }));
  // A new format must appear even when it has no explicit version declaration.
  writeFileSync(join(outputs, "flyer.html"), '<head><!-- <meta name="board-version" content="v3"> --></head>');
  mkdirSync(join(outputs, "print"));
  writeFileSync(join(outputs, "print", "flyer-back.html"), `<head><meta content='v3' name='board-version'></head>`);
  writeFileSync(join(outputs, "proof.html"), `<head><meta content='v4' name='board-version'></head>`);
  // The old check receipt does not establish when a piece was made.
  writeFileSync(join(outputs, "story.htm"), '<head><meta name="board-version" content="v1"></head>');

  const expected = [
    "Current board: v3",
    "outputs/flyer.html: made-under version unrecorded",
    "outputs/hero.html: made-under version unrecorded",
    // A piece with unknown provenance cannot truthfully be called v1 or stale.
    "outputs/post.html: made-under version unrecorded",
    "outputs/print/flyer-back.html: made under v3 (current)",
    "outputs/proof.html: declares v4 (unrecorded)",
    "outputs/story.htm: made under v1 (stale)",
  ].join("\n");
  assert.equal(runBoard(project.path, "status").trimEnd(), expected);
  renameSync(join(project.path, "board"), join(moved.path, "board"));
  renameSync(outputs, join(moved.path, "outputs"));
  assert.equal(runBoard(moved.path, "status").trimEnd(), expected);
});

test("the yellow bike banner reports the v1 accent and keeps its made-under claim", () => {
  using project = scratch();
  const outputs = join(project.path, "outputs");
  mkdirSync(outputs);
  const current = fixture(2);
  const old = fixture(1);
  old.palette.push({ hex: "#ffc93c", role: "accent", share: 0.2, kinds: ["bg"] });
  current.palette.push({ hex: "#ff6a1f", role: "accent", share: 0.2, kinds: ["bg"] });
  writeBoard(join(project.path, "board"), current);
  writeBoard(join(project.path, "board.v1"), old);
  const page = '<!doctype html><html lang="en"><head><meta name="board-version" content="v2"><title>Bram\'s Bike Clinic</title></head><body style="margin:0;background:#FFC93C"></body></html>';
  writeFileSync(join(outputs, "banner.html"), page);
  writeFileSync(join(outputs, "hero.html"), page.replace('<meta name="board-version" content="v2">', "").replace("#FFC93C", "#0e1a2b"));

  const log = runBoard(project.path, "check", ".", "outputs/banner.html", "--verbose");
  assert.match(log, /^PASS banner\.html: floor 0; made under v2; brief 0; note: uses #FFC93C, which is v1's accent, outside v2; checks ran: .*checks skipped: .*campaign copy \(piece has no board-campaign meta/m);
  const [banner] = JSON.parse(readFileSync(join(outputs, "check.json"), "utf8"));
  assert.equal(banner.boardVersion, "v2");
  assert.equal(banner.checkedAgainst, "v2");
  assert.deepEqual(banner.outsideValues, [{ kind: "colour", value: "#FFC93C", previousVersion: "v1", previousRole: "accent" }]);
  assert.match(runBoard(project.path, "check", ".", "outputs/hero.html"), /^PASS hero: floor 0; made-under version unrecorded;/m);
  const [hero] = JSON.parse(readFileSync(join(outputs, "check.json"), "utf8"));
  assert.equal("boardVersion" in hero, false);
  assert.equal(existsSync(join(outputs, "board-versions.json")), false);
  assert.equal(readFileSync(join(outputs, "banner.html"), "utf8"), page);
  assert.match(runBoard(project.path, "status"), /^outputs\/banner.html: made under v2 \(current\), uses values outside v2 \(last checked\)$/m);
  writeFileSync(join(outputs, "banner.html"), page.replace("#FFC93C", "#FF6A1F"));
  assert.match(runBoard(project.path, "status"), /^outputs\/banner.html: made under v2 \(current\)$/m);
});

test("a frozen guide's exact colours remain valid after palette clustering", () => {
  using project = scratch();
  const dir = join(project.path, "directions", "pick");
  const outputs = join(project.path, "outputs");
  mkdirSync(dir, { recursive: true });
  mkdirSync(outputs);
  const page = (colour: string) => `<!doctype html><title>Notice</title><body style="margin:0;background:${colour}"></body>`;
  const sample = join(dir, "hero.html");
  writeFileSync(sample, page("#f4f4f2").replace("</body>",
    '<div style="height:40px;background:#faf9f7;outline:2px solid #2456a8"></div></body>'));
  const draft = join(project.path, "DESIGN.md");
  const guide = (colour: string) => `---\nname: Notice\ncolors:\n  paper: "${colour}"\n---\n`;
  writeFileSync(draft, guide("#FAF9F7").replace("\n---\n", '\n  rule: "#2456a8"\n---\n'));
  runBoard(project.path, "freeze", ".", "pick");
  assert.deepEqual(readBoard(join(project.path, "board")).palette.map((entry) => entry.hex), ["#f4f4f2"]);

  // A draft edit must not grant an exemption for another nearby, undeclared colour.
  writeFileSync(draft, guide("#fdfcfb"));
  writeFileSync(join(outputs, "notice.html"), page("rgb(250, 249, 247)"));
  writeFileSync(join(outputs, "draft.html"), page("#fdfcfb"));
  assert.match(runBoard(project.path, "check", ".", "outputs/notice.html", "outputs/draft.html", "--verbose"), /^PASS notice\.html:[^\n]*\nPASS draft\.html:.*uses #FDFCFB, outside v1; checks ran:/m);
  const [approved, undeclared] = JSON.parse(readFileSync(join(outputs, "check.json"), "utf8"));
  assert.deepEqual(approved.outsideValues, []);
  assert.deepEqual(undeclared.outsideValues, [{ kind: "colour", value: "#FDFCFB" }]);

  writeFileSync(join(outputs, "hero.html"), page("#2456a8"));
  assert.match(runBoard(project.path, "check", ".", "outputs/hero.html", "--consistency"), /^PASS hero:.*off-palette 0/m);

  writeFileSync(draft, guide("#F4F4F2"));
  writeFileSync(sample, page("#f4f4f2"));
  runBoard(project.path, "freeze", ".", "pick");
  assert.match(runBoard(project.path, "check", ".", "outputs/notice.html"), /uses #FAF9F7, a colour in v1, outside v2/);
});

test("the floor dismisses logical and clamped padding only when the rendered sides clear the detector threshold", () => {
  using project = scratch();
  const file = join(project.path, "hero.html");
  const receipt = join(project.path, "check.json");
  const html = `<!doctype html><html lang="en"><title>Padding</title><style>
    body, p { margin: 0; }
    section { background: #222; color: #fff; font: 20px serif; }
    .logical { padding-block: 24px; padding-inline: clamp(16px, 5vw, 40px); }
    .clamped { padding: clamp(16px, 5vw, 40px); }
    .shorthand { padding: 24px 40px; }
    .different-side { padding: 24px 0 24px 24px; padding-inline-end: 24px; padding-block-start: 0; }
  </style>
  <section class="logical panel"><p>Logical inset</p></section>
  <section class="clamped"><p>Clamped inset</p></section>
  <section class="shorthand"><p>Shorthand inset</p></section>`;
  writeFileSync(file, html);
  assert.match(runBoard(project.path, "check", "--floor-only", file), /^PASS hero: floor 0/m);
  const [passed] = JSON.parse(readFileSync(receipt, "utf8"));
  assert.deepEqual(passed.floor, []);
  assert.deepEqual(passed.dismissed.map(({ rule, detail, reason }: { rule: string; detail: string; reason: string }) => [rule, detail, reason]), [
    ["cramped-padding", '<section> "logical": children flush against bg on all sides (no inset)', "dismissed: rendered padding 24 px"],
    ["cramped-padding", '<section> "clamped": children flush against bg on all sides (no inset)', "dismissed: rendered padding 40 px"],
  ]);

  writeFileSync(file, html + '<section class="logical compact" style="padding-inline-end: 2px"><p>Tight second instance</p></section>' +
    '<section class="different-side"><p>The top is tight</p></section>');
  assert.match(failedBoard(project.path, "check", "--floor-only", file), /^FAIL hero: floor 2 \(cramped-padding: <section> "logical"/m);
  const [failed] = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(failed.dismissed.length, 1);
  assert.match(failed.floor[1].detail, /^<section> "different-side"/);

  writeFileSync(file, html.replace("clamp(16px, 5vw, 40px)", "clamp(2px, 0.5vw, 40px)"));
  runBoard(project.path, "adopt", ".", "--root", ".", "--page", "hero.html", "--viewport", "1000x600", "--viewport", "400x600", "--check");
  const { pages: [wide, narrow] } = JSON.parse(readFileSync(join(project.path, ".briefatto", "adoption", "evidence.json"), "utf8"));
  assert.deepEqual(wide.findings, []);
  assert.equal(wide.dismissed[0].reason, "dismissed: rendered padding 5 px");
  assert.equal(narrow.findings[0].rule, "cramped-padding");
  assert.equal(narrow.dismissed.length, 1);
});

test("only a primary typeface declared by the current frozen guide turns an overused font into a note", () => {
  using project = scratch();
  const currentDir = join(project.path, "board");
  const archivedDir = join(project.path, "board.v1");
  const file = join(project.path, "hero.html");
  const report = join(project.path, "check.json");
  const guide = (typeface: string) => [
    "---", "name: Test board", "typography:", '  # fontFamily: "Geist Mono"',
    `  headline: {fontFamily: '${typeface}, sans-serif', fontSize: 24px}`,
    "  body:", "    guidance: |", "      fontFamily: Geist Mono", "---",
    "", "## Notes", "Example to avoid: `font-family: Geist Mono`.", "",
  ].join("\n");
  const current = guide('"Geist", "Geist Mono"');
  const draft = guide('"Geist Mono"');
  writeBoard(currentDir, { ...fixture(2), designHash: designHash(current) });
  writeFileSync(join(currentDir, "DESIGN.md"), current);
  writeBoard(archivedDir, { ...fixture(), designHash: designHash(draft) });
  writeFileSync(join(archivedDir, "DESIGN.md"), draft);
  writeFileSync(join(project.path, "DESIGN.md"), draft);
  copyFileSync(new URL("../../resources/fonts/work-sans-latin-wght-normal.woff2", import.meta.url), join(project.path, "brand.woff2"));
  const html = `<!doctype html><html lang="en"><title>Typeface</title><style>
    @font-face { font-family: Geist; src: url(brand.woff2); }
    @font-face { font-family: "Geist Mono"; src: url(brand.woff2); }
    h1 { font-family: Geist, sans-serif; font-size: 24px; }
    p { font-family: "Geist Mono", monospace; font-size: 24px; }
  </style><h1>Headline in the declared family</h1>`;
  writeFileSync(file, html);
  assert.match(runBoard(project.path, "check", ".", file), /^PASS hero: floor 0;.*note: overused-font: Primary font: geist \(declared in frozen DESIGN\.md\)/m);
  assert.match(failedBoard(project.path, "check", "--floor-only", file), /^FAIL hero:.*overused-font: Primary font: geist[;)]/m);

  writeFileSync(file, html + "<p>Second family</p>");
  assert.match(failedBoard(project.path, "check", ".", file), /^FAIL hero:.*overused-font: Primary font: geist mono/m);
  const [checked] = JSON.parse(readFileSync(report, "utf8"));
  assert.deepEqual(checked.floor, [{ rule: "overused-font", detail: "Primary font: geist mono", source: "impeccable" }]);
  assert.ok(checked.designNotes.some(({ rule }: { rule: string }) => rule === "overused-font"));

  writeFileSync(join(currentDir, "DESIGN.md"), draft);
  assert.match(failedBoard(project.path, "check", ".", file), /^FAIL hero:.*overused-font: Primary font: geist[;)]/m);
  const [tampered] = JSON.parse(readFileSync(report, "utf8"));
  assert.ok(tampered.designNotes.every(({ rule }: { rule: string }) => rule !== "overused-font"));
});

test("board check retains the floor, optional consistency and separate custom preview", () => {
  using project = scratch();
  const outputs = join(project.path, "outputs");
  mkdirSync(outputs);
  const board = fixture(2);
  board.samples.push({ ...board.samples[0], format: "post", aspect: 1 });
  board.fonts = [{ family: "Hanken Grotesk", weights: [400], stack: '"Hanken Grotesk", sans-serif' }];
  writeBoard(join(project.path, "board"), board);
  writeFileSync(join(project.path, "DESIGN.md"), designMd(board));
  const page = (color: string) => `<!doctype html><html lang="en"><head><title>Fixture</title></head><body style="margin:0;background:${color}"></body></html>`;
  writeFileSync(join(outputs, "hero.html"), page("#0e1a2b"));
  writeFileSync(join(outputs, "march-post.html"), page("#0e1a2b"));
  writeFileSync(join(outputs, "link.html"), page("#0e1a2b"));
  writeFileSync(join(outputs, "post.html"), page("#fff"));
  const manifest = join(outputs, "board-versions.json");
  writeFileSync(manifest, JSON.stringify({ "post.html": "v1", "story.html": "v1" }));

  assert.match(runBoard(project.path, "check", "--floor-only", "outputs/hero.html"), /PASS hero:/);
  assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), { "post.html": "v1", "story.html": "v1" });
  const output = runBoard(project.path, "check", ".", "outputs/*.html", "--consistency");
  assert.match(output, /^PASS hero:.*made-under version unrecorded;/m);
  assert.match(output, /^PASS link:.*note: same thirds arrangement as hero, post on a different shape/m);
  assert.match(output, /^PASS post:.*note: uses #FFFFFF, outside v2; off-palette 1/m);
  assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), { "post.html": "v1", "story.html": "v1" });
  const receipts = JSON.parse(readFileSync(join(outputs, "check.json"), "utf8"));
  assert.equal(receipts.find((receipt: { file: string }) => receipt.file.endsWith("march-post.html")).format, "post");
  const link = receipts.find((receipt: { file: string }) => receipt.file.endsWith("link.html"));
  assert.equal(link.pass, true);
  assert.deepEqual(link.consistency.resizedFrom, ["hero", "post"]);
  assert.match(runBoard(project.path, "status"), /outputs\/post.html: made-under version unrecorded, uses values outside v2/);

  mkdirSync(join(project.path, "assets"));
  writeFileSync(join(project.path, "assets", "brief.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  writeFileSync(join(project.path, "essentials.json"), JSON.stringify({ required: ["test.example"] }));
  writeBoard(join(project.path, "board"), { ...board, essentials: loadEssentials(project.path) });
  writeFileSync(join(outputs, "post.html"), page("#fff")
    .replace("</head>", "<style>.unused { font-family: Georgia; }</style></head>")
    .replace("</body>", '<p style="font:44px serif">test.example</p><img src="../assets/brief.svg" alt="Brief image"></body>'));
  writeFileSync(join(outputs, "flyer.html"), page("#fff").replace("</body>", '<p style="margin-top:1000px;font-size:10px">Below the first screen</p></body>'));
  const flyerPng = join(outputs, "flyer.png");
  writeFileSync(flyerPng, "authored PNG");
  writeFileSync(join(outputs, "kit-sheet.html"), page("#fff"));

  const defaults = failedBoard(project.path, "check", ".", "outputs/*.html", "--verbose");
  assert.match(defaults, /^PASS post: floor 0; made-under version unrecorded; brief 0; note: uses #FFFFFF, outside v2.*note: uses serif, outside v2.*note: design-system-font: font-family: Georgia/m);
  assert.match(defaults, /^FAIL flyer\.html:.*text-too-small.*Below the first screen.*brief 0;.*checks ran: .*checks skipped: .*campaign copy/m);
  assert.doesNotMatch(defaults, /essential-missing|asset-missing/);
  assert.doesNotMatch(defaults, /off-palette|off-fonts|; family |kit-sheet/);
  const defaultReceipts = JSON.parse(readFileSync(join(outputs, "check.json"), "utf8"));
  const post = defaultReceipts.find((receipt: { file: string }) => basename(receipt.file) === "post.html");
  const flyer = defaultReceipts.find((receipt: { file: string }) => basename(receipt.file) === "flyer.html");
  assert.equal(post.pass, true);
  assert.equal(flyer.pass, false);
  for (const key of ["consistency", "family", "composition", "radiiOutside"]) assert.ok(!(key in post));
  assert.equal(flyer.png, join(outputs, "flyer.check.png"));
  assert.equal(readFileSync(flyerPng, "utf8"), "authored PNG");
  assert.equal(JSON.parse(readFileSync(manifest, "utf8"))["post.html"], "v1");
  assert.match(runBoard(project.path, "status"), /outputs\/flyer.html: made-under version unrecorded/);

  writeFileSync(join(outputs, "hero.html"), page("#fff").replace("</body>", '<p style="font-size:10px">Tiny label</p></body>'));
  assert.match(failedBoard(project.path, "check", "--floor-only", "outputs/hero.html", "--verbose"), /^FAIL hero:.*text-too-small.*Tiny label.*campaign copy \(floor-only mode has no frozen board\)/m);
});

test("the bakery closure needs no subscription pitch or photo unless opted into the campaign", () => {
  using project = scratch();
  const outputs = join(project.path, "outputs");
  mkdirSync(outputs);
  const board = fixture(2);
  board.name = "Moller Bread: weekly sourdough subscription";
  board.brief = "- Brand: Moller Bread";
  writeFileSync(join(project.path, "essentials.json"), JSON.stringify({
    required: ["Start your subscription", "EUR 9"],
    terms: ["Starts 1 March"],
    assets: ["assets/photos/loaf-rustic.jpg"],
    assetUse: "required",
  }));
  board.essentials = loadEssentials(project.path);
  writeBoard(join(project.path, "board"), board);
  const closure = join(outputs, "24-december-closure.html");
  const notice = `<!doctype html><html lang="en"><head><title>Closure</title>
    <link data-example='<meta name="board-campaign" content="sourdough-subscription">'>
    <!-- <meta name="board-campaign" content="sourdough-subscription"> -->
    </head><body><h1 style="font-size:48px">Closed on 24 December</h1><p style="font-size:36px">Moller Bread</p></body></html>`;
  writeFileSync(closure, notice);
  writeFileSync(join(outputs, "subscription-post.html"), notice
    .replace("<head><title>", "<meta content='sourdough-subscription' name='board-campaign'><title>")
    .replace("</head>", ""));

  const defaults = failedBoard(project.path, "check", ".", "outputs/*.html", "--verbose");
  assert.match(defaults, /^PASS 24-december-closure\.html: floor 0;.*brief 0;.*checks ran: .*checks skipped: .*campaign copy \(piece has no board-campaign meta/m);
  assert.match(defaults, /^FAIL post:.*essential-missing: "Start your subscription".*term-missing: "Starts 1 March".*asset-missing:.*loaf-rustic.jpg/m);
  const receipts = JSON.parse(readFileSync(join(outputs, "check.json"), "utf8"));
  const noticeReceipt = receipts.find((x: { format: string }) => x.format === "24-december-closure.html");
  assert.equal(noticeReceipt.briefApplied, false);
  assert.deepEqual(noticeReceipt.checks.skipped.find(({ check }: { check: string }) => check === "campaign copy"), {
    check: "campaign copy", reason: "piece has no board-campaign meta and --brief was not supplied",
  });
  const campaignReceipt = receipts.find((x: { format: string }) => x.format === "post");
  assert.equal(campaignReceipt.briefApplied, true);
  assert.ok(campaignReceipt.checks.ran.includes("campaign copy"));
  assert.ok(campaignReceipt.checks.ran.includes("text clipping"));
  assert.ok(campaignReceipt.checks.ran.includes("text overlap"));
  const forced = failedBoard(project.path, "check", ".", "outputs/24-december-closure.html", "--brief");
  assert.match(forced, /^FAIL 24-december-closure\.html:.*essential-missing: "Start your subscription".*term-missing: "Starts 1 March".*asset-missing:.*loaf-rustic.jpg/m);
  assert.doesNotMatch(forced, /campaign copy \(/);

  writeFileSync(closure, notice.replace("font-size:36px", "font-size:10px"));
  const smallBrand = failedBoard(project.path, "check", ".", "outputs/24-december-closure.html");
  assert.match(smallBrand, /^FAIL 24-december-closure\.html:.*brand-too-small: "Moller Bread"/m);
  assert.doesNotMatch(smallBrand, /essential-missing|asset-missing/);
});

test("only a page colour in the current frozen board turns a cream palette into a note", () => {
  using project = scratch();
  const currentDir = join(project.path, "board");
  const base = fixture();
  const r: Rendered = { ...base.samples[0] as unknown as Rendered, png: "", width: 1440, height: 900, contrast: [], family: null,
    colours: [{ value: "rgb(245, 239, 227)", kind: "bg", area: 1440 * 900 }],
    texts: [], radii: [], images: [], shadows: 0, fontLinks: [], devices: [] };
  const board = { ...boardFromRenders("Test board", { id: "pick", title: "Pick", text: "" }, [{ file: "directions/pick/hero.html", fmt: "hero", r }], "board"), version: 1, note: "", type: {} };
  const guide = ["---", "name: Test board", "---", "", "## Colour", "The page is warm paper, #F5EFE3.", ""].join("\n");
  writeBoard(currentDir, { ...board, designHash: designHash(guide) });
  writeFileSync(join(currentDir, "DESIGN.md"), guide);
  writeFileSync(join(project.path, "DESIGN.md"), guide);
  const file = join(project.path, "hero.html");
  copyFileSync(new URL("../../resources/fonts/work-sans-latin-wght-normal.woff2", import.meta.url), join(project.path, "brand.woff2"));
  const page = (ground: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Paper</title><style>
    @font-face { font-family: Brand; src: url(brand.woff2); }
    body { margin: 0; background: ${ground}; color: #1d1a16; font: 32px Brand, sans-serif; } main { padding: 48px; }
  </style></head><body><main><h1>Warm paper headline</h1><p>Some body copy for the page.</p></main></body></html>`;
  writeFileSync(file, page("#F5EFE3"));
  assert.match(runBoard(project.path, "check", ".", file), /^PASS hero: floor 0;.*note: cream-palette: .*\(declared in frozen DESIGN\.md\)/m);
  writeFileSync(file, page("#EFE8DA"));
  assert.match(failedBoard(project.path, "check", ".", file), /^FAIL hero:.*cream-palette/m);
});

function checkProject() {
  const project = scratch();
  const outputs = join(project.path, "outputs");
  mkdirSync(outputs);
  const board = fixture(2);
  board.fonts = [{ family: "Brand Sans", weights: [400], stack: '"Brand Sans", sans-serif' }];
  writeBoard(join(project.path, "board"), board);
  writeFileSync(join(project.path, "DESIGN.md"), designMd(board));
  copyFileSync(new URL("../../resources/fonts/work-sans-latin-wght-normal.woff2", import.meta.url), join(outputs, "brand.woff2"));
  return { project, outputs };
}
const runIn = (cwd: string, ...args: string[]) =>
  execFileSync(process.execPath, [launcher, ...args], { cwd, encoding: "utf8" }).replace(/\r\n/g, "\n");
const monoPage = (family: string) => `<!doctype html><html lang="en"><head><title>Fixture</title><style>
  @font-face { font-family: "Brand Sans"; src: url(brand.woff2); }
  @font-face { font-family: "Other Mono"; src: url(brand.woff2); }
  body { margin: 0; background: #0e1a2b; color: #fff; }
  .pb { font: 600 32px/1 ${family}, monospace; }
</style></head><body><span class="pb">Pb</span></body></html>`;

test("board check prints the result file relative to the working directory, with forward slashes", () => {
  const { project, outputs } = checkProject();
  using _ = project;
  writeFileSync(join(outputs, "hero.html"), '<!doctype html><html lang="en"><head><title>Fixture</title></head><body style="margin:0;background:#0e1a2b"></body></html>');
  const inside = runIn(project.path, "check", ".", "outputs/hero.html").trimEnd().split("\n");
  assert.equal(inside.at(-1), "outputs/check.json");
  const outside = runIn(join(project.path, ".."), "check", basename(project.path), join(basename(project.path), "outputs", "hero.html")).trimEnd().split("\n");
  assert.equal(outside.at(-1), `${basename(project.path)}/outputs/check.json`);
  const floorOnly = runIn(project.path, "check", "--floor-only", "outputs/hero.html").trimEnd().split("\n");
  assert.equal(floorOnly.at(-1), "outputs/check.json");
  for (const text of [...inside, ...outside, ...floorOnly]) assert.doesNotMatch(text, /[A-Za-z]:\|\|\/tmp\/|\/var\//);
});

test("board check keeps a passing run to the verdict, notes and result file; --verbose lists every check", () => {
  const { project, outputs } = checkProject();
  using _ = project;
  writeFileSync(join(outputs, "hero.html"), monoPage('"Brand Sans"'));
  const quiet = runIn(project.path, "check", ".", "outputs/hero.html");
  assert.match(quiet, /^PASS hero: floor 0;/m);
  assert.doesNotMatch(quiet, /checks ran:|checks skipped:|source floor|story safe zones/);
  assert.equal(quiet.trimEnd().split("\n").length, 2);
  const verbose = runIn(project.path, "check", ".", "outputs/hero.html", "--verbose");
  assert.match(verbose, /^PASS hero:.*checks ran: source floor.*checks skipped: .*campaign copy/m);
  // The receipt is the same either way.
  const [receipt] = JSON.parse(readFileSync(join(outputs, "check.json"), "utf8"));
  assert.ok(receipt.checks.ran.includes("source floor"));
  assert.ok(receipt.checks.skipped.some(({ check }: { check: string }) => check === "campaign copy"));
  assert.match(runIn(project.path, "check", "--help"), /--verbose/);
});

test("a CSS font shorthand reports its first family cleanly, and a declared family raises no note", () => {
  const { project, outputs } = checkProject();
  using _ = project;
  const guide = ["---", "name: Test board", "typography:", "  body:", '    fontFamily: "Brand Sans, sans-serif"', "---", "", "## Typography", "Brand Sans.", ""].join("\n");
  writeFileSync(join(project.path, "board", "DESIGN.md"), guide);
  writeFileSync(join(project.path, "DESIGN.md"), guide);
  writeBoard(join(project.path, "board"), { ...fixture(2), designHash: designHash(guide) });
  writeFileSync(join(outputs, "hero.html"), monoPage('"Other Mono"'));
  const undeclared = runIn(project.path, "check", ".", "outputs/hero.html");
  assert.match(undeclared, /note: design-system-font: span "Pb" uses Other Mono; not declared in DESIGN\.md typography/);
  assert.doesNotMatch(undeclared, /mono",|"monospace|uses mono/i);
  const [receipt] = JSON.parse(readFileSync(join(outputs, "check.json"), "utf8"));
  assert.ok(receipt.designNotes.every(({ detail }: { detail: string }) => !/["']/.test(detail.replace(/span "Pb"/, ""))));
  writeFileSync(join(outputs, "hero.html"), monoPage('"Brand Sans"'));
  assert.doesNotMatch(runIn(project.path, "check", ".", "outputs/hero.html"), /span "Pb"/);
  writeFileSync(join(outputs, "hero.html"), monoPage("'Other Mono'"));
  assert.match(runIn(project.path, "check", ".", "outputs/hero.html"), /span "Pb" uses Other Mono; not declared/);
});
