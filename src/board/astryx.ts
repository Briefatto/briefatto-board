import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Board } from "./freeze.js";
import { lockCurrentBoard, readBoard, versionLabel } from "./versions.js";

type ThemeBoard = Pick<Board, "version" | "name" | "palette" | "type" | "fonts" | "fontLinks" | "radii" | "composition">;

const midpoint = ([low, high]: [number, number]) => Math.round((low + high) / 2 * 1000) / 1000;
const shortSide = "min(100vw, 100vh)";

/** Produce an Astryx theme module without adding an Astryx dependency to the CLI. */
export function astryxThemeSource(board: ThemeBoard): string {
  const tokens: Record<string, string> = {};
  const ground = board.palette.find(({ role }) => role === "ground");
  const ink = board.palette.find(({ role, kinds }) => role === "ink" && kinds.includes("text"));
  const accent = board.palette.find(({ role }) => role === "accent");
  if (ground) {
    tokens["--color-background-body"] = ground.hex;
    tokens["--color-background-surface"] = ground.hex;
    tokens["--color-background-card"] = ground.hex;
  }
  if (ink) tokens["--color-text-primary"] = ink.hex;
  if (accent) tokens["--color-accent"] = accent.hex;

  const displayShare = midpoint(board.composition.displayShare);
  const sizeRatio = midpoint(board.composition.sizeRatio);
  for (const role of ["display", "body"] as const) {
    const type = board.type[role];
    if (!type) continue;
    const target = role === "display" ? "display-1" : "body";
    const family = role === "display" ? "heading" : "body";
    tokens[`--font-family-${family}`] = board.fonts.find(({ family }) => family === type.family)?.stack ?? JSON.stringify(type.family);
    tokens[`--text-${target}-weight`] = String(type.weight);
    tokens[`--text-${target}-leading`] = String(type.lineHeight);
    if (displayShare > 0 && (role === "display" || sizeRatio > 0)) {
      const size = role === "display" ? `${displayShare}` : `${displayShare} / ${sizeRatio}`;
      tokens[`--text-${target}-size`] = `calc(${shortSide} * ${size})`;
    }
  }

  const [radius] = board.radii.px;
  if (board.radii.px.length === 1) tokens["--radius-container"] = `${radius}px`;
  if (board.radii.full) tokens["--radius-full"] = "9999px";

  const slug = board.name.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const theme = {
    name: slug ? `briefatto-${slug}` : "briefatto-board",
    tokens,
    localTokens: {
      "--briefatto-canvas-margin": `calc(${shortSide} * ${midpoint(board.composition.marginShare)})`,
    },
  };
  return [
    `// Generated from frozen board ${versionLabel(board.version)} by board export astryx.`,
    '// Import Astryx CSS and render <Theme theme={boardTheme} mode="light">.',
    '// Load boardFontStylesheets in the document head.',
    'import { defineTheme } from "@astryxdesign/core/theme";',
    "",
    `export const boardFontStylesheets = ${JSON.stringify(board.fontLinks, null, 2)};`,
    "",
    `export const boardTheme = defineTheme(${JSON.stringify(theme, null, 2)});`,
    "",
  ].join("\n");
}

export function exportAstryx(boardDir: string): string {
  const lock = lockCurrentBoard(boardDir);
  const filename = "astryx.theme.ts";
  const next = join(lock.path, filename);
  try {
    const path = join(boardDir, filename);
    writeFileSync(next, astryxThemeSource(readBoard(boardDir)));
    renameSync(next, path);
    return path;
  } finally {
    rmSync(next, { force: true });
    lock.release();
  }
}
