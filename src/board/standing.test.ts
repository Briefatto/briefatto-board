import assert from "node:assert/strict";
import { mkdtempDisposableSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installStandingInstructions, prepareStandingInstructions } from "./standing.js";

const start = "<!-- briefatto-board:start -->";
const end = "<!-- briefatto-board:end -->";
const block = (newline = "\n") => [
  start,
  "Read `DESIGN.md` before any visual work.",
  "Brand changes go through `board freeze`.",
  "Run `board check` on every piece before handing it over.",
  end,
].join(newline);
const writeStandingInstructions = (project: string) => prepareStandingInstructions(project)();

test("creates both instruction files and repeats the same freeze byte for byte", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-guides-"));
  const agents = join(project.path, "AGENTS.md");
  const claude = join(project.path, "CLAUDE.md");
  const expected = block() + "\n";
  writeStandingInstructions(project.path);
  assert.equal(readFileSync(agents, "utf8"), expected);
  assert.equal(readFileSync(claude, "utf8"), expected);
  writeStandingInstructions(project.path);
  assert.equal(readFileSync(agents, "utf8"), expected);
  assert.equal(readFileSync(claude, "utf8"), expected);
});

test("updates an existing block while preserving the rest of each file and its line endings", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-guides-"));
  for (const [file, newline] of [["AGENTS.md", "\r\n"], ["CLAUDE.md", "\n"]]) {
    const before = `\uFEFF# Project${newline}Keep this.${newline}${newline}`;
    const after = `${newline}${newline}Keep this too.  `;
    const path = join(project.path, file);
    writeFileSync(path, [before + start, "Old block", end + after].join(newline));
  }
  writeStandingInstructions(project.path);
  for (const [file, newline] of [["AGENTS.md", "\r\n"], ["CLAUDE.md", "\n"]]) {
    const text = readFileSync(join(project.path, file), "utf8");
    assert.ok(text.startsWith(`\uFEFF# Project${newline}Keep this.${newline}${newline}${start}${newline}`));
    assert.ok(text.endsWith(`${newline}${end}${newline}${newline}Keep this too.  `));
    assert.ok(text.includes(block(newline)));
    assert.equal(text.split(start).length, 2);
    assert.equal(text.split(end).length, 2);
    assert.equal(text.includes("Old block"), false);
  }
});

test("appends to existing instructions and leaves malformed blocks alone", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-guides-"));
  const agents = join(project.path, "AGENTS.md");
  const claude = join(project.path, "CLAUDE.md");
  writeFileSync(agents, "Keep this with no final newline.  ");
  writeFileSync(claude, start);
  assert.throws(() => writeStandingInstructions(project.path), /CLAUDE\.md: Expected one complete/);
  assert.equal(readFileSync(agents, "utf8"), "Keep this with no final newline.  ");
  assert.equal(readFileSync(claude, "utf8"), start);
  writeFileSync(claude, "Keep this too.\r\n");
  writeStandingInstructions(project.path);
  assert.ok(readFileSync(agents, "utf8").startsWith(`Keep this with no final newline.  \n\n${start}\n`));
  assert.ok(readFileSync(claude, "utf8").startsWith(`Keep this too.\r\n\r\n${start}\r\n`));
});

test("preserves Windows PowerShell UTF-16 files and their original bytes", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-guides-"));
  const path = join(project.path, "CLAUDE.md");
  const original = Buffer.from("\uFEFF# Bakery café\r\n", "utf16le");
  writeFileSync(path, original);
  writeStandingInstructions(project.path);
  const updated = readFileSync(path);
  assert.deepEqual(updated.subarray(0, original.length), original);
  assert.ok(updated.toString("utf16le").endsWith(block("\r\n") + "\r\n"));
  writeStandingInstructions(project.path);
  assert.deepEqual(readFileSync(path), updated);
});

test("updates a shared instruction file while preserving the symlink", (t) => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-guides-"));
  const agents = join(project.path, "AGENTS.md");
  const claude = join(project.path, "CLAUDE.md");
  writeFileSync(agents, "# Project\n");
  try {
    symlinkSync("AGENTS.md", claude, "file");
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("This Windows session cannot create symlinks.");
    return;
  }

  installStandingInstructions(project.path);
  assert.match(readFileSync(claude, "utf8"), /No frozen design yet\./);
  prepareStandingInstructions(project.path, "# Design\n")();
  assert.equal(readFileSync(claude, "utf8"), "# Project\n\n" + block() + "\n");
  assert.equal(readlinkSync(claude), "AGENTS.md");
});

test("keeps client words containing standing block markers in DESIGN.md across retries", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-guides-"));
  const path = join(project.path, "AGENTS.md");
  const designPath = join(project.path, "DESIGN.md");
  const design = `# Bakery\n\n> Keep these words:\n> ${start}\u2028${end}\n`;
  prepareStandingInstructions(project.path, design)();
  const first = readFileSync(path, "utf8");
  assert.equal(first, block() + "\n");
  assert.equal(readFileSync(designPath, "utf8"), design);
  prepareStandingInstructions(project.path, design)();
  assert.equal(readFileSync(path, "utf8"), first);
  assert.equal(readFileSync(designPath, "utf8"), design);
});

test("keeps external edits made before replacement and rolls back earlier writes", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-guides-"));
  const agents = join(project.path, "AGENTS.md");
  const claude = join(project.path, "CLAUDE.md");
  const design = join(project.path, "DESIGN.md");
  writeFileSync(agents, "Original AGENTS text.");
  writeFileSync(claude, "Original Claude text.");
  writeFileSync(design, "Original design.");
  const apply = prepareStandingInstructions(project.path, "Frozen design.");
  writeFileSync(claude, "New Claude text.");
  assert.throws(apply, /changed during freeze/);
  assert.equal(readFileSync(agents, "utf8"), "Original AGENTS text.");
  assert.equal(readFileSync(claude, "utf8"), "New Claude text.");
  assert.equal(readFileSync(design, "utf8"), "Original design.");

  const applyWithDesignEdit = prepareStandingInstructions(project.path, "Frozen design.");
  writeFileSync(design, "New design.");
  assert.throws(applyWithDesignEdit, /DESIGN\.md changed during freeze/);
  assert.equal(readFileSync(agents, "utf8"), "Original AGENTS text.");
  assert.equal(readFileSync(claude, "utf8"), "New Claude text.");
  assert.equal(readFileSync(design, "utf8"), "New design.");
});
