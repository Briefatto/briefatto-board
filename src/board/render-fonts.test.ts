import assert from "node:assert/strict";
import { copyFileSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatById } from "./formats.js";
import { Renderer } from "./render.js";

test("font checks follow each rendered weight and style despite a closer unused face", async () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), "board-font-"));
  const font = new URL("../../resources/fonts/work-sans-latin-wght-normal.woff2", import.meta.url);
  copyFileSync(font, join(fixture.path, "unused.woff2"));
  const file = join(fixture.path, "hero.html");
  writeFileSync(file, `<!doctype html><style>
    @font-face { font-family: Fixture; font-weight: 500; src: url("unused.woff2"); }
    @font-face { font-family: Fixture; font-weight: 700; src: url("${font.href}"); }
    @font-face { font-family: Fixture; font-weight: 800; src: url("absent.woff2"); }
    @font-face { font-family: Fixture; font-weight: 700; font-style: italic; src: url("absent.woff2"); }
    @font-face { font-family: "Quoted, Family"; font-weight: 700; src: url("${font.href}"); }
    p { font: 700 36px Fixture, sans-serif; }
    .missing-weight { font-weight: 800; }
    .missing-style { font-style: italic; }
    .quoted-family { font-family: "Quoted, Family", sans-serif; }
  </style><p>Loaded bold</p><p class="missing-weight">Missing weight</p><p class="missing-style">Missing style</p>
  <p class="quoted-family">Quoted family</p>`);
  const renderer = new Renderer();
  try {
    const rendered = await renderer.render(file, formatById("hero"));
    assert.deepEqual(rendered.texts.map(({ text, family, loaded }) => [text, family, loaded]), [
      ["Loaded bold", "Fixture", true], ["Missing weight", "Fixture", false], ["Missing style", "Fixture", false],
      ["Quoted family", "Quoted, Family", true],
    ]);
  } finally {
    await renderer.close();
  }
});
