import { existsSync, lstatSync, mkdtempDisposableSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockCurrentBoard } from "./versions.js";

const start = "<!-- briefatto-board:start -->";
const end = "<!-- briefatto-board:end -->";
const frozenLines = [
  "Read `DESIGN.md` before any visual work.",
  "Brand changes go through `board freeze`.",
  "Run `board check` on every piece before handing it over.",
];
const installLines = [
  "This project uses Briefatto Board for design work. Read `.claude/skills/briefatto-board/SKILL.md` and run board commands with `npx briefatto-board`.",
  "No frozen design yet.",
];

function withBlock(text: string, lines: readonly string[]): string {
  const starts = [...text.matchAll(/(?:^|(?<=\n))\uFEFF?<!-- briefatto-board:start -->(?=\r?\n|$)/g)];
  const ends = [...text.matchAll(/(?:^|(?<=\n))<!-- briefatto-board:end -->(?=\r?\n|$)/g)];
  if (starts.length !== ends.length || starts.length > 1 || (starts.length && starts[0].index >= ends[0].index)) {
    throw new Error("Expected one complete Briefatto board instruction block.");
  }
  const newline = text.match(/\r?\n/)?.[0] ?? "\n";
  const block = [start, ...lines, end].join(newline);
  if (starts.length) {
    const from = starts[0].index + Number(starts[0][0].startsWith("\uFEFF"));
    return text.slice(0, from) + block + text.slice(ends[0].index + end.length);
  }
  const content = text.replace(/^\uFEFF/, "");
  const gap = !content || /\r?\n\r?\n$/.test(content) ? "" : content.endsWith("\n") ? newline : newline + newline;
  return text + gap + block + newline;
}

function editBlock(original: Buffer, lines: readonly string[]): Buffer {
  const utf16le = original[0] === 0xff && original[1] === 0xfe;
  const utf16be = original[0] === 0xfe && original[1] === 0xff;
  const encoding = utf16le || utf16be ? "utf16le" : "utf8";
  const decode = (bytes: Buffer) => (utf16be ? Buffer.from(bytes).swap16() : bytes).toString(encoding);
  const encode = (text: string) => utf16be ? Buffer.from(text, encoding).swap16() : Buffer.from(text, encoding);
  const text = decode(original);
  if (!original.equals(encode(text))) throw new Error("Expected valid UTF-8 or BOM-marked UTF-16 Markdown.");
  return encode(withBlock(text, lines));
}

export function prepareStandingInstructions(project: string, design?: string, expectedDraft?: Buffer): () => void {
  return prepareInstructions(project, frozenLines, "freeze", design, expectedDraft);
}

export function installStandingInstructions(project: string): void {
  const boardDir = join(project, "board");
  const lock = lockCurrentBoard(boardDir);
  try {
    const lines = existsSync(join(boardDir, "board.json")) ? frozenLines : installLines;
    prepareInstructions(project, lines, "install")();
  } finally {
    lock.release();
  }
}

function prepareInstructions(project: string, lines: readonly string[], command: "install" | "freeze", design?: string, expectedDraft?: Buffer): () => void {
  const files: Array<{ file: string; contents?: string }> = [{ file: "AGENTS.md" }, { file: "CLAUDE.md" }];
  const [agents, claude] = files.map(({ file }) => join(project, file));
  // A link to the other instruction file already sees updates to its target.
  if (existsSync(agents) && existsSync(claude) && realpathSync(agents) === realpathSync(claude)) {
    const agentsLinked = lstatSync(agents).isSymbolicLink();
    const claudeLinked = lstatSync(claude).isSymbolicLink();
    if (agentsLinked !== claudeLinked) files.splice(agentsLinked ? 0 : 1, 1);
  }
  if (design !== undefined) files.push({ file: "DESIGN.md", contents: design });
  const updates = files.map(({ file, contents }) => {
    const path = join(project, file);
    const original = existsSync(path) ? readFileSync(path) : undefined;
    if (file === "DESIGN.md" && expectedDraft && !original?.equals(expectedDraft)) {
      throw new Error(`${path} changed during freeze. Retry to preserve its latest text.`);
    }
    try {
      const updated = contents === undefined ? editBlock(original ?? Buffer.alloc(0), lines) : Buffer.from(contents, "utf8");
      return { path, file, original, updated };
    } catch (error) {
      throw new Error(`${path}: ${(error as Error).message}`, { cause: error });
    }
  }).filter(({ original, updated }) => !original?.equals(updated));

  return () => {
    if (!updates.length) return;
    using stage = mkdtempDisposableSync(join(project, ".board-guides-"));
    const changes = updates.map(({ path, file, original, updated }) => {
      const next = join(stage.path, file);
      const backup = `${next}.previous`;
      const mode = original ? statSync(path).mode : undefined;
      writeFileSync(next, updated, { mode });
      if (original) writeFileSync(backup, original, { mode });
      return { path, next, original, backup: original ? backup : undefined };
    });
    const applied: typeof changes = [];
    try {
      for (const change of changes) {
        const current = existsSync(change.path) ? readFileSync(change.path) : undefined;
        if (current ? !change.original?.equals(current) : change.original !== undefined) {
          throw new Error(`${change.path} changed during ${command}. Retry to preserve its latest text.`);
        }
        renameSync(change.next, change.path);
        applied.push(change);
      }
    } catch (error) {
      for (const { path, backup } of applied.reverse()) {
        if (backup) renameSync(backup, path);
        else unlinkSync(path);
      }
      throw error;
    }
  };
}
