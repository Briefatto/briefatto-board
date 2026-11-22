import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readBoard } from "./versions.js";

const launcher = fileURLToPath(new URL("../../skill/briefatto-board/board.mjs", import.meta.url));

function run(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [launcher, ...args], { cwd, encoding: "utf8" });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd() };
}

test("each subcommand offers help before reading project state", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-help-"));
  for (const command of ["install", "adopt", "render", "refs", "directions", "freeze", "log", "diff", "status", "export", "check", "kit"]) {
    const result = run(project.path, command, "--help");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, new RegExp(`^Usage: briefatto-board ${command}(?: |$)`));
  }
  assert.equal(existsSync(join(project.path, ".claude")), false);
});

test("a direct render followed by handoff requires a frozen guide, including when the brief was only in chat", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-handoff-"));
  mkdirSync(join(project.path, "outputs"));
  writeFileSync(join(project.path, "outputs", "hero.html"), "<!doctype html><title>Launch</title><h1>See why the cache missed.</h1>");
  function failsWith(expected: string, ...args: string[]) {
    assert.deepEqual(run(project.path, ...args), { status: 1, stdout: "", stderr: expected });
  }
  failsWith("No frozen guide. Run board freeze before board check.", "check", ".", "outputs/hero.html");
  failsWith("No frozen guide. Run board freeze before board kit.", "kit", ".");
  failsWith("Create refs/manifest.json with your references, then run board refs .", "refs", ".");
  assert.equal(existsSync(join(project.path, "outputs", "kit-check.json")), false);
  assert.equal(existsSync(join(project.path, "outputs", "kit-sheet.png")), false);

  writeFileSync(join(project.path, "brief.md"), "# Launch\n\nSee why the cache missed.\n");
  failsWith("Run board directions to prepare a direction for client approval, then run board freeze . <direction>.", "freeze", ".");
  failsWith("No frozen guide. Run board freeze before board kit.", "kit", ".");
  mkdirSync(join(project.path, "board"));
  writeFileSync(join(project.path, "board", "board.json"), "{}");
  failsWith("No frozen guide. Run board freeze before board kit.", "kit", ".");
});

test("the original missing format source names the field and its array index", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-format-field-"));
  const formats = join(project.path, "formats.json");
  writeFileSync(formats, JSON.stringify([{
    id: "announcement", label: "Launch announcement", width: 1080, height: 1350, seenWidth: 405, kind: "social",
  }]));
  assert.deepEqual(run(project.path, "render", "announcement.html"), {
    status: 1, stdout: "", stderr: `Invalid board formats in ${formats}: formats.json[0].source is required.`,
  });
});

function greenfield(project: string) {
  const direction = join(project, "directions", "fellow");
  mkdirSync(direction, { recursive: true });
  writeFileSync(join(project, "brief.md"), "# Launch\n\nClient launch guide.\n");
  writeFileSync(join(direction, "hero.html"), "<!doctype html><title>Launch</title><h1>Client launch guide.</h1>");
  writeFileSync(join(project, "DESIGN.md"), "# Launch\n\n## Layout\n\nLead with the headline.\n");
}

test("the first freeze needs the marked verbatim production approval for the selected direction", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-approval-"));
  greenfield(project.path);
  const boardDir = join(project.path, "board");
  const refs = join(project.path, "refs");
  const notes = join(refs, "notes.md");
  const reply = "**Yes, I approve Fellow as shown for production.** Please go ahead and build the files.";
  const assertBlocked = (...flags: string[]) => {
    assert.deepEqual(run(project.path, "freeze", ".", "fellow", ...flags), {
      status: 1, stdout: "",
      stderr: "Record the client's verbatim approval in a fenced approval fellow block in refs/notes.md, or use --self-approved for your own project, or --agent-picked \"<reason>\" when the person delegated the choice. Then run board freeze . fellow with the chosen option.",
    });
    assert.equal(existsSync(boardDir), false);
  };
  assertBlocked("--check", "--force", "--extract");
  const adoption = join(project.path, ".briefatto", "adoption");
  mkdirSync(adoption, { recursive: true });
  writeFileSync(join(adoption, "pages.json"), "{}");
  assertBlocked();
  mkdirSync(refs);
  writeFileSync(notes, `**I'm going with Fellow.**\n\n${reply}\n\n\`\`\`approval shout\n${reply}\n\`\`\`\n\n\`\`\`approval fellow\n\n\`\`\`\n`);
  assertBlocked();

  writeFileSync(notes, `\`\`\`approval fellow\n${reply}\n\`\`\`\n`);
  const frozen = run(project.path, "freeze", ".", "fellow");
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.equal(readBoard(boardDir).version, 1);
  assert.deepEqual(readBoard(boardDir).initialApproval, { method: "client" });
  assert.match(run(project.path, "log").stdout, /^v1 .*\(client-approved\)  \(current\)$/);
});

test("a solo developer can explicitly self-approve v1 and the log keeps the decision", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-self-approval-"));
  greenfield(project.path);
  const frozen = run(project.path, "freeze", ".", "fellow", "--self-approved", "--note", "First launch");
  assert.equal(frozen.status, 0, frozen.stderr);
  const retry = run(project.path, "freeze", ".", "fellow");
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /no change \(board v1\)/);
  assert.equal(existsSync(join(project.path, "refs")), false);
  assert.deepEqual(readBoard(join(project.path, "board")).initialApproval, { method: "self" });
  assert.match(run(project.path, "log").stdout, /^v1 .*"First launch"  \(self-approved\)  \(current\)$/);
});

test("a delegated first freeze records the agent's reason, refuses bad flag use, and a later switch freezes the other direction", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-agent-picked-"));
  greenfield(project.path);
  const other = join(project.path, "directions", "plain");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "hero.html"), "<!doctype html><title>Launch</title><h1>Client launch guide.</h1>");
  const boardDir = join(project.path, "board");
  const blocked = (message: string, ...args: string[]) => {
    assert.deepEqual(run(project.path, "freeze", ".", "fellow", ...args), { status: 1, stdout: "", stderr: message });
    assert.equal(existsSync(boardDir), false);
  };
  blocked("--agent-picked requires a non-empty reason.", "--agent-picked", "  ");
  blocked("Missing value for --agent-picked.", "--agent-picked");
  blocked("Use either --self-approved or --agent-picked, not both.", "--self-approved", "--agent-picked", "closest to the brand");
  blocked("Use either --self-approved or --agent-picked, not both.", "--check", "--self-approved", "--agent-picked", "closest to the brand");

  const dry = run(project.path, "freeze", ".", "--agent-picked", "closest to the brand", "--dry-run", "fellow");
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(existsSync(boardDir), false);

  const reason = "closest to the brand";
  const frozen = run(project.path, "freeze", "--agent-picked", reason, ".", "fellow", "--note", "First launch");
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.deepEqual(readBoard(boardDir).initialApproval, { method: "agent", reason });
  assert.equal(readBoard(boardDir).direction.id, "fellow");
  assert.match(run(project.path, "log").stdout, /^v1 .*"First launch"  \(agent-picked: closest to the brand\)  \(current\)$/);

  const switched = run(project.path, "freeze", ".", "plain", "--note", "Switch to direction plain");
  assert.equal(switched.status, 0, switched.stderr);
  const board = readBoard(boardDir);
  assert.equal(board.version, 2);
  assert.equal(board.direction.id, "plain");
  const log = run(project.path, "log").stdout.split("\n");
  assert.match(log[0], /^v1 .*\(agent-picked: closest to the brand\)$/);
  assert.match(log[1], /^v2 .*"Switch to direction plain"  \(current\)$/);
});
