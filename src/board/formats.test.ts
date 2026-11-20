import assert from "node:assert/strict";
import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { check } from "./check.js";
import { loadEssentials } from "./essentials.js";
import { briefFaults, renderFaults } from "./floor.js";
import { loadProjectFormats, type BoardFormat } from "./formats.js";
import { Renderer } from "./render.js";

const base: BoardFormat = { id: "sample", label: "Sample", source: "Client brief", width: 480, height: 400, seenWidth: 480 };
const story: BoardFormat = { ...base, id: "story", kind: "story", safeZones: { top: 70, right: 20, bottom: 60, left: 20 } };
const print: BoardFormat = { ...base, id: "poster", kind: "print", print: { widthMm: 420, heightMm: 594, bleedMm: 3 } };

test("loads legacy, print, and story declarations and validates their units and bounds", () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-formats-"));
  const file = join(project.path, "formats.json");
  writeFileSync(file, JSON.stringify([base, print, { ...story, safeZones: { top: 70 } }]));
  assert.deepEqual(loadProjectFormats(project.path), [base, print, { ...story, safeZones: { top: 70, right: 0, bottom: 0, left: 0 } }]);

  writeFileSync(file, JSON.stringify([{ ...story, safeZones: { top: 400 } }]));
  assert.throws(() => loadProjectFormats(project.path), /non-empty safe area/);
  writeFileSync(file, JSON.stringify([{ ...print, kind: "web" }]));
  assert.throws(() => loadProjectFormats(project.path), /print dimensions require kind print/);
  writeFileSync(file, JSON.stringify([{ ...print, print: { ...print.print, bleedMm: -1 } }]));
  assert.throws(() => loadProjectFormats(project.path), /Invalid board formats/);
});

test("checks actual text fragments and CTA bounds on each canvas", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-copy-"));
  const file = join(project.path, "sample.html");
  writeFileSync(file, `<!doctype html><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
    body { background: white; color: black; font: 20px/1.25 sans-serif; }
    .nested { position: absolute; top: 70px; left: 32px; }
    .child { position: absolute; top: 0; left: 75px; white-space: nowrap; }
    .wrap { position: absolute; top: 120px; left: 32px; }
    .other { position: absolute; top: 145px; left: 150px; }
    .route { position: absolute; top: 180px; left: 32px; font-family: monospace; }
    .route span + span { position: absolute; top: 0; left: calc(17ch - 4px); white-space: nowrap; }
    .clip { position: relative; margin: 210px 32px 0; width: 60px; white-space: nowrap; overflow-x: clip; overflow-y: visible; }
    .inset { position: absolute; top: 275px; left: 32px; width: max-content; clip-path: inset(0 50% 0 0); }
    .a11y { clip-path: inset(50%); }
    .cta { position: absolute; left: 32px; top: 368px; height: 50px; padding: 4px 12px; background: black; color: white; }
    .url { position: absolute; left: 32px; top: 430px; }
    .hidden { opacity: 0; position: absolute; top: 500px; }
  </style>
  <p style="margin: 0 32px">Join <strong>the</strong> <i>club</i> today</p>
  <p style="margin: 0 32px">Open <strong>Fri</strong>days. Go<strong>live</strong></p>
  <div class="nested">Parent label <span class="child">Child label</span></div>
  <div class="wrap">A wide first line in the sample<br>Second</div><span class="other">Separate label</span>
  <div class="route"><span>First route label</span><span>Second route label</span></div>
  <div class="clip">Clipped details</div>
  <div class="inset">Incomplete copy</div><span class="a11y">Assistive text</span>
  <div class="cta">Join now</div><div class="url">example.com/offer</div>
  <div class="hidden"><span>Hidden accessibility aid</span></div>`);
  writeFileSync(join(project.path, "brief.md"), "- Call to action: Join the club today\n- URL: example.com/offer\n");
  const renderer = new Renderer();
  try {
    const narrow = await renderer.render(file, base);
    const faults = renderFaults(narrow, base);
    const has = (rule: string, copy: string) => faults.some((f) => f.rule === rule && f.detail.includes(copy));
    assert.ok(has("text-off-canvas", "example.com/offer"));
    assert.ok(has("text-clipped", "Clipped details"));
    assert.ok(has("text-clipped", "Incomplete copy"));
    assert.ok(has("cta-clipped", "Join now"));
    assert.ok(has("text-over-text", "Parent label"));
    assert.ok(has("text-over-text", '"First route label" / "Second route label"'));
    assert.ok(!has("text-over-text", "Separate label"));
    assert.ok(!faults.some((f) => /Hidden accessibility aid|Assistive text/.test(f.detail)));
    const brief = loadEssentials(project.path);
    brief.required.push("Open Fridays.", "Go live", "Incomplete copy");
    assert.deepEqual(briefFaults(narrow, base, brief).map((f) => f.detail), ['"example.com/offer"', '"Go live"', '"Incomplete copy"']);
    const tallFormat = { ...base, height: 600 };
    const tall = await renderer.render(file, tallFormat);
    assert.ok(!renderFaults(tall, tallFormat).some((f) => f.rule === "text-off-canvas" || f.rule === "cta-clipped"));
    assert.deepEqual(briefFaults(tall, tallFormat, brief).map((f) => f.detail), ['"Go live"', '"Incomplete copy"']);
  } finally {
    await renderer.close();
  }
});

test("check notes a button on print and fails copy inside a declared story zone", async () => {
  using project = mkdtempDisposableSync(join(tmpdir(), "board-channels-"));
  writeFileSync(join(project.path, "formats.json"), JSON.stringify([story, print]));
  const poster = join(project.path, "poster.html");
  const storyFile = join(project.path, "story.html");
  writeFileSync(poster, `<!doctype html><style>
    body { background: white; color: black; font: 20px sans-serif; padding: 40px; }
    .btn { display: inline-block; color: white; background: black; padding: 12px; }
    button { all: unset; }
  </style><p>Available from the shop</p><span class="btn">Order a copy</span><p><a href="https://example.com/">example.com</a></p><button>Plain text control</button>`);
  writeFileSync(storyFile, `<!doctype html><style>
    body { background: white; color: black; font: 20px sans-serif; padding: 20px 40px; }
    .safe { margin-top: 80px; }
    .safe::after { content: " *"; }
  </style><p>Top interface copy</p><p class="safe">Inside the safe area</p>`);
  const [printResult, storyResult] = await check(null, [poster, storyFile]);
  assert.deepEqual(printResult.designNotes.filter((f) => f.rule === "print-web-cta").map((f) => f.detail), ['Button treatment on print copy: "Order a copy"']);
  assert.ok(!printResult.floor.some((f) => f.rule === "print-web-cta"));
  assert.equal(storyResult.pass, false);
  assert.deepEqual(storyResult.floor.filter((f) => f.rule === "story-unsafe-copy").map((f) => f.detail), ['"Top interface copy" in top unsafe zone']);
  assert.deepEqual(storyResult.checks.skipped.filter((entry) => entry.check === "CSS-generated copy geometry"), [
    { check: "CSS-generated copy geometry", reason: "1 pseudo-element(s) with text have no DOM text range" },
  ]);
});
