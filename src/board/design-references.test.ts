import assert from "node:assert/strict";
import { mkdtempDisposableSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { validateDesignReferences } from "./design-references.js";

test("DESIGN.md resolves supplied assets without reading file references outside the project", async () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), "design-references-"));
  const project = join(fixture.path, "project");
  const assets = join(project, "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "bread (cut).svg"), "");
  const outside = join(fixture.path, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "loaf.svg"), "");
  symlinkSync(outside, join(project, "outside-link"), process.platform === "win32" ? "junction" : "dir");

  const markdown = [
    "![Bread](<assets/bread (cut).svg> \"A loaf.\")",
    "The supplied photos are in `assets/`.",
    "Use `assets/bread (cut).svg`.",
    '<a href="#layout">Layout</a> · <img src="https://example.test/bread.jpg">',
    "| URL | mollerbread.nl |",
    "[sample]: samples/hero.html",
    "The old sample is `samples/story.html`.",
    "![Secret](%2e%2e/outside/loaf.svg)",
    '<img src="outside-link/loaf.svg">',
    `[absolute](${pathToFileURL(join(outside, "loaf.svg")).href})`,
    '<div style="background-image: url(../outside/loaf.svg)"></div>',
  ].join("\n");
  const findings = await validateDesignReferences(markdown, project);
  assert.deepEqual(findings.map(({ rule, detail }) => [rule, detail.match(/^line \d+/)?.[0]]), [
    ["file-reference", "line 6"], ["file-reference", "line 7"], ["file-reference", "line 8"],
    ["file-reference", "line 9"], ["file-reference", "line 10"], ["file-reference", "line 11"],
  ]);
  assert.match(findings[3].detail, /outside the project through a filesystem link/);
});

test("load lines resolve a stylesheet and the font payloads it uses", async () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), "design-fonts-"));
  const font = readFileSync(new URL("../../resources/fonts/work-sans-latin-wght-normal.woff2", import.meta.url));
  const face = (url: string) => `@font-face { font-family: "Work Sans"; src: url("${url}") format("woff2"); }`;
  const server = createServer((req, res) => {
    if (req.url === "/good.css") {
      res.setHeader("content-type", "text/css");
      res.end('@import "nested/family.css";');
    } else if (req.url === "/nested/family.css") {
      res.setHeader("content-type", "text/css");
      res.end(face("../work.woff2"));
    } else if (req.url === "/bad.css") {
      res.setHeader("content-type", "text/css");
      res.end(face("bad.woff2"));
    } else if (req.url === "/bad.woff2") {
      res.end("HTML returned instead of font bytes");
    } else if (req.url === "/work.woff2") {
      res.end(font);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    writeFileSync(join(fixture.path, "local.woff2"), font);
    const findings = await validateDesignReferences([
      `<link rel="stylesheet" href="${url}/good.css">`,
      "@import url('" + url + "/bad.css');",
      face("local.woff2"),
      face(url + "/missing.woff2"),
    ].join("\n"), fixture.path);
    assert.deepEqual(findings.map(({ rule }) => rule), ["font-load", "font-load"]);
    assert.match(findings[0].detail, /line 2: .*bad\.woff2.*did not return a font file/);
    assert.match(findings[1].detail, /line 4: .*missing\.woff2.*HTTP 404/);
  } finally {
    await new Promise<void>((done, reject) => { server.close((error) => error ? reject(error) : done()); });
  }
});

test("a visibly unfinished link, import and font-face rule each report truncation", async () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), "design-truncated-"));
  const markdown = [
    '<link rel="stylesheet" href="https://fonts.example.test/css?',
    '@import url("https://fonts.example.test/css";',
    '@font-face { font-family: "Work Sans";',
  ].join("\n");
  const findings = await validateDesignReferences(markdown, fixture.path);
  assert.deepEqual(findings, [
    { rule: "truncated-line", detail: "line 1: unclosed <link> tag" },
    { rule: "truncated-line", detail: "line 2: unclosed @import URL" },
    { rule: "truncated-line", detail: "line 3: unclosed @font-face rule" },
  ]);
});
