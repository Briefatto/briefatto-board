import assert from "node:assert/strict";
import { test } from "node:test";
import { astryxThemeSource } from "./astryx.js";

const board: Parameters<typeof astryxThemeSource>[0] = {
  name: "Møller Bread",
  version: 2,
  palette: [
    { role: "ground", hex: "#c8371f", kinds: ["bg"], share: 1 },
    { role: "ink", hex: "#fff7f2", kinds: ["bg", "text"], share: 0.26 },
    { role: "accent", hex: "#7d1f10", kinds: ["text"], share: 0.01 },
    { role: "accent", hex: "#a08524", kinds: ["text"], share: 0.01 },
  ],
  fonts: [{ family: "DM Serif Display", stack: '"DM Serif Display", serif', weights: [400] }],
  fontLinks: ["https://example.org/fonts.css"],
  type: {
    display: { family: "DM Serif Display", weight: 400, lineHeight: 1.02, letterSpacingEm: 0, transform: "none", italic: false },
    body: { family: "Work Sans", weight: 400, lineHeight: 1.5, letterSpacingEm: 0, transform: "none", italic: false },
  },
  composition: {
    displayShare: [0.104, 0.167], sizeRatio: [3.294, 5.769], marginShare: [0.056, 0.08],
    align: ["left"], textCoverage: [0.235, 0.256], imageCoverage: [0.323, 0.398], imageBleeds: [true],
  },
  radii: { px: [12], full: true },
};

test("Astryx export uses semantic theme tokens and preserves the canvas margin for layout", () => {
  const source = astryxThemeSource(board);
  assert.match(source, /frozen board v2/);
  assert.match(source, /defineTheme\(/);
  assert.match(source, /https:\/\/example\.org\/fonts\.css/);
  assert.match(source, /"--color-background-body": "#c8371f"/);
  assert.match(source, /"--color-text-primary": "#fff7f2"/);
  assert.match(source, /"--color-accent": "#7d1f10"/);
  assert.match(source, /"--font-family-heading": "\\"DM Serif Display\\", serif"/);
  assert.match(source, /"--text-display-1-leading": "1\.02"/);
  assert.match(source, /"--text-body-size": "calc\(min\(100vw, 100vh\) \* 0\.136 \/ 4\.532\)"/);
  assert.match(source, /"--radius-container": "12px"/);
  assert.match(source, /"--radius-full": "9999px"/);
  assert.match(source, /"--briefatto-canvas-margin": "calc\(min\(100vw, 100vh\) \* 0\.068\)"/);
  assert.doesNotMatch(source, /--color-on-accent|--spacing-|#a08524/);
});

test("Astryx export leaves absent roles and ambiguous radii to the defaults", () => {
  const source = astryxThemeSource({ ...board, palette: [], type: {}, radii: { px: [4, 12], full: false } });
  assert.doesNotMatch(source, /--color-|--font-family-|--text-|--radius-/);
});
