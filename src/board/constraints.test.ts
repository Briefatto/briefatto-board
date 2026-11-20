import assert from "node:assert/strict";
import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConstraints } from "./constraints.js";

test("loads only marked constraint quotes, keeping the client's wording and whitespace", () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), "board-notes-"));
  const path = join(dir.path, "notes.md");
  assert.deepEqual(readConstraints(path), []);

  const first = "  Show the bread.  ";
  const second = "nothing that looks clickable\r\nEven the `labels`.";
  writeFileSync(path, [
    "\uFEFF# Client replies",
    "````text",
    "This is what I typed yesterday:",
    "```constraint", "this example stays in the transcript", "```",
    "````",
    "```constraint", first, "```",
    "~~~constraint", second, "~~~",
    "```constraint", "```",
  ].join("\r\n"));
  assert.deepEqual(readConstraints(path), [first, second]);

  writeFileSync(path, "```constraint\nKeep this");
  assert.throws(() => readConstraints(path), /Unclosed constraint quote/);
});

test("reads BOM-marked Windows notes without changing Unicode quotes", () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), "board-notes-"));
  const path = join(dir.path, "notes.md");
  const quote = "Keep ‘Limón’ in the footer.";
  const bytes = Buffer.from(`\uFEFF\`\`\`constraint\r\n${quote}\r\n\`\`\``, "utf16le");
  writeFileSync(path, bytes);
  assert.deepEqual(readConstraints(path), [quote]);
  writeFileSync(path, bytes.swap16());
  assert.deepEqual(readConstraints(path), [quote]);

  writeFileSync(path, Buffer.concat([Buffer.from("```constraint\n"), Buffer.of(0xff), Buffer.from("\n```\n")]));
  assert.throws(() => readConstraints(path), /not valid for encoding utf-8/i);
});
