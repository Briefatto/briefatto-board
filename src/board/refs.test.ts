import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempDisposableSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { captureReferences, writeReferenceSheet } from "./refs.js";

test("queues reference URLs in one browser, loads lazy images and removes fixed chrome", async (t) => {
  using project = mkdtempDisposableSync(join(tmpdir(), "refs-capture-"));
  const launches = t.mock.method(chromium, "launch");
  const visits: string[] = [];
  await using server = createServer((request, response) => {
    visits.push(request.url ?? "");
    if (request.url === "/art") {
      response.setHeader("Content-Type", "image/svg+xml");
      setTimeout(() => response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900"><path fill="#ed3520" d="M0 0h1440v900H0z"/></svg>'), 100);
    } else if (request.url === "/reference") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><style>
        body { margin: 0; min-height: 1800px; }
        header, #cookie-consent { position: fixed; inset: 0 0 auto; height: 80px; background: blue; }
        #cookie-consent { inset: auto 0 0; background: green; }
      </style><body>
        <header>Site header</header><div id="cookie-consent">Accept cookies</div>
        <main><img id="art" width="1440" height="900" alt="Reference art"></main>
        <script>addEventListener('scroll', () => {
          if (scrollY) document.getElementById('art').src = '/art';
        }, { once: true });</script>
      </body>`);
    } else if (request.url === "/mostly-chrome") {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><nav style="height:70vh">Site navigation</nav><main>Page content</main>');
    } else if (request.url === "/sparse-reference") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><style>
        body { margin: 0; font: 18px system-ui; }
        main { width: 720px; margin: 120px auto; }
        h1 { font-size: 54px; }
        pre { background: #f7f4ed; padding: 24px; }
      </style><main><h1>One file for every editor</h1>
      <p>Check a shared config into your project.</p>
      <pre>root = true\n\n[*]\nindent_style = space\nindent_size = 2</pre></main>`);
    } else if (request.url === "/mostly-empty") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><style>
        body { margin: 0; background-image: url('/missing-background'); }
        iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
        .top, .bottom { position: absolute; z-index: 1; }
        .top { top: 0; left: 0; } .bottom { bottom: 0; right: 0; }
      </style><main><iframe title="Empty frame" src="about:blank"></iframe>
      <span class="top">Top corner</span><span class="bottom">Bottom corner</span>
      <img src="/missing-image" width="300" height="250" alt="Unloaded art"></main>`);
    } else if (request.url === "/anchored") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><style>
        body { margin: 0; } section { height: 100vh; background: blue; }
        #artwork { background: #ed3520; }
      </style><section></section><section id="artwork"></section>`);
    } else {
      response.writeHead(404).end();
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const site = `http://127.0.0.1:${address.port}`;

  await assert.rejects(captureReferences(project.path, [{ url: "file:///image", image: "example.png" }]), /HTTP or HTTPS/);
  await assert.rejects(captureReferences(project.path, [{ url: site, image: "../example.png" }]), /PNG filename in refs/);
  await assert.rejects(captureReferences(project.path, [{ url: site, image: "example.png" }, { url: site, image: "EXAMPLE.PNG" }]), /listed more than once/);
  assert.equal(launches.mock.callCount(), 0);

  const [reference, missing, chrome, sparse, empty, anchored] = await captureReferences(project.path, [
    { url: `${site}/reference`, image: "example.png" },
    { url: `${site}/missing`, image: "missing.png" },
    { url: `${site}/mostly-chrome`, image: "chrome.png" },
    { url: `${site}/sparse-reference`, image: "sparse.png" },
    { url: `${site}/mostly-empty`, image: "empty.png" },
    { url: `${site}/anchored#artwork`, image: "anchored.png" },
  ]);
  assert.equal(launches.mock.callCount(), 1);
  const expectedNavigation = ["/reference", "/art", "/missing", "/mostly-chrome", "/sparse-reference", "/mostly-empty", "/anchored"];
  assert.deepEqual(visits.filter((path) => expectedNavigation.includes(path)), expectedNavigation);
  assert.ok(visits.includes("/missing-image"));
  assert.ok(visits.includes("/missing-background"));

  const output = join(project.path, "refs", "example.png");
  assert.deepEqual(reference, { url: `${site}/reference`, output, warnings: [] });
  assert.match("error" in missing ? missing.error : "", /HTTP 404/);
  assert.match("warnings" in chrome ? chrome.warnings.join("\n") : "", /mostly page chrome.*Retake/);
  assert.deepEqual(sparse, { url: `${site}/sparse-reference`, output: join(project.path, "refs", "sparse.png"), warnings: [] });
  assert.match("warnings" in empty ? empty.warnings.join("\n") : "", /mostly empty.*Retake/);
  assert.match("warnings" in empty ? empty.warnings.join("\n") : "", /visible image.*did not load/);
  const capture = readFileSync(output);
  const screenshot = PNG.sync.read(capture);
  assert.deepEqual([screenshot.width, screenshot.height], [1440, 900]);
  assert.deepEqual([...screenshot.data.subarray(0, 4)], [237, 53, 32, 255]);
  assert.deepEqual([...screenshot.data.subarray(-4)], [237, 53, 32, 255]);
  assert.ok("output" in anchored);
  const anchorScreenshot = PNG.sync.read(readFileSync(anchored.output));
  assert.deepEqual([...anchorScreenshot.data.subarray(0, 4)], [237, 53, 32, 255]);

  const [retry] = await captureReferences(project.path, [{ url: `${site}/missing`, image: "example.png" }]);
  assert.match("error" in retry ? retry.error : "", /HTTP 404/);
  assert.deepEqual(readFileSync(output), capture);
  assert.deepEqual(readdirSync(join(project.path, "refs")).sort(), ["anchored.png", "chrome.png", "empty.png", "example.png", "sparse.png"]);
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
