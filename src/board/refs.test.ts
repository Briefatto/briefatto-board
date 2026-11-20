import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempDisposableSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";
import { captureReference, writeReferenceSheet } from "./refs.js";

test("captures a live URL as a local PNG and keeps the capture on a failed retry", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "refs-capture-"));
  await using server = createServer((request, response) => {
    if (request.url === "/reference") {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><body style="background:#ed3520">Reference example</body>');
    } else {
      response.writeHead(404).end();
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const site = `http://127.0.0.1:${address.port}`;

  await assert.rejects(captureReference(project.path, "file:///image", "example.png"), /HTTP or HTTPS/);
  await assert.rejects(captureReference(project.path, site, "../example.png"), /PNG filename in refs/);
  const output = await captureReference(project.path, `${site}/reference`, "example.png");
  assert.equal(output, join(project.path, "refs", "example.png"));
  const capture = readFileSync(output);
  const screenshot = PNG.sync.read(capture);
  assert.deepEqual([screenshot.width, screenshot.height], [1440, 900]);
  assert.deepEqual([...screenshot.data.subarray(0, 4)], [237, 53, 32, 255]);

  await assert.rejects(captureReference(project.path, `${site}/missing`, "example.png"), /HTTP 404/);
  assert.deepEqual(readFileSync(output), capture);
  assert.deepEqual(readdirSync(join(project.path, "refs")), ["example.png"]);
});

test("renders image and words references in manifest order as one PNG", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "refs-project-"));
  const refs = join(project.path, "refs");
  mkdirSync(refs);
  const image = new PNG({ width: 40, height: 40 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data.set([237, 53, 32, 255], i);
  }
  writeFileSync(join(refs, "visual sample #1.png"), PNG.sync.write(image));
  const manifest = JSON.stringify([
    { image: "visual sample #1.png", source: "https://example.com/original", note: "A red square" },
    { note: "Neon & black, with <large> type" },
  ]);
  writeFileSync(join(refs, "manifest.json"), manifest);

  const output = await writeReferenceSheet(project.path);
  assert.equal(output, join(refs, "sheet.png"));
  assert.equal(readFileSync(join(refs, "manifest.json"), "utf8"), manifest);
  assert.deepEqual(readdirSync(refs).sort(), ["manifest.json", "sheet.png", "visual sample #1.png"]);
  const sheet = PNG.sync.read(readFileSync(output));
  const pixel = (x: number, y: number) => [...sheet.data.subarray((y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 4)];
  assert.deepEqual(pixel(Math.floor(sheet.width / 4), 230), [237, 53, 32, 255]);
  assert.notDeepEqual(pixel(Math.floor(sheet.width * 3 / 4), 230), [237, 53, 32, 255]);
});

test("rejects missing source attribution and image paths outside refs", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "refs-manifest-"));
  const refs = join(project.path, "refs");
  mkdirSync(refs);
  const manifest = join(refs, "manifest.json");
  writeFileSync(manifest, JSON.stringify([{ image: "photo.png", note: "One line" }]));
  await assert.rejects(writeReferenceSheet(project.path), /Reference 1.*needs a source URL/);
  writeFileSync(manifest, JSON.stringify([{ image: "../photo.png", source: "https://example.com/photo.png", note: "One line" }]));
  await assert.rejects(writeReferenceSheet(project.path), /Reference 1.*needs an image inside refs/);
  writeFileSync(manifest, JSON.stringify([{ note: "Two\nlines" }]));
  await assert.rejects(writeReferenceSheet(project.path), /Reference 1.*needs a one-line note/);
  assert.deepEqual(readdirSync(refs), ["manifest.json"]);
});

test("reports an unreadable image and preserves the prior sheet", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "refs-unreadable-"));
  const refs = join(project.path, "refs");
  mkdirSync(refs);
  const manifest = join(refs, "manifest.json");
  writeFileSync(manifest, JSON.stringify([{ note: "Large black type on paper" }]));
  const output = await writeReferenceSheet(project.path);
  const prior = readFileSync(output);
  writeFileSync(join(refs, "failed-download.png"), "<html>Download failed</html>");
  writeFileSync(manifest, JSON.stringify([{ image: "failed-download.png", source: "https://example.com/photo.png", note: "Image" }]));
  await assert.rejects(writeReferenceSheet(project.path), /Could not decode image:.*failed-download\.png/);
  assert.deepEqual(readFileSync(output), prior);
  assert.deepEqual(readdirSync(refs).sort(), ["failed-download.png", "manifest.json", "sheet.png"]);
});
