import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { designHash, stampDesign, unsignedDesign } from "./design-validation.js";
import type { Board } from "./freeze.js";
import { compareSourceAssets, SOURCE_ASSETS_FILE } from "./source-assets.js";

export const versionLabel = (version: number) => `v${version}`;

export function parseVersion(label: string): number {
  const version = Number(label.slice(1));
  if (!/^v[1-9]\d*$/.test(label) || !Number.isSafeInteger(version)) {
    throw new Error(`Invalid board version "${label}". Use v1, v2, and so on.`);
  }
  return version;
}

const archive = (boardDir: string, version: number) => `${boardDir}.${versionLabel(version)}`;

function localizeLegacyStylescape(boardDir: string, stage: string) {
  const path = join(boardDir, "stylescape.html");
  if (!existsSync(path)) return;
  const html = readFileSync(path, "utf8");
  // Older stylescapes pointed at the current board with absolute URLs.
  const local = html.replace(/src="file:[^"]*\/board\/((?:samples\/|device-)[^"]+\.png)"/g, 'src="$1"');
  if (local === html) return;
  const updated = join(stage, "previous-stylescape.html");
  writeFileSync(updated, local);
  renameSync(updated, path);
}

export function readBoard(boardDir: string): Board {
  const board = JSON.parse(readFileSync(join(boardDir, "board.json"), "utf8")) as Board;
  const samples = board.samples.map((sample) => sample.source === undefined
    ? { ...sample, source: sample.html, html: `samples/${sample.format}.html` }
    : sample);
  return { ...board, version: board.version || 1, note: board.note ?? "", samples };
}

export function readBoardVersion(boardDir: string, current: Board, version: number): Board {
  if (version === current.version) return current;
  if (version > current.version) throw new Error(`Board version ${versionLabel(version)} does not exist. Current board is ${versionLabel(current.version)}.`);
  return readBoard(archive(boardDir, version));
}

export function readFrozenDesign(boardDir: string, current: Board, board: Board): string | undefined {
  if (!board.designHash) return;
  const dir = board.version === current.version ? boardDir : archive(boardDir, board.version);
  try {
    const design = unsignedDesign(readFileSync(join(dir, "DESIGN.md"), "utf8"));
    if (designHash(design) === board.designHash) return design;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sourceInputs({ name, direction, designHash, extractedDesignHash, brief, essentials, briefAssets, constraints, samples }: Board) {
  return { name, direction, designHash, extractedDesignHash, brief, essentials, briefAssets, constraints,
    samples: samples.map(({ format, canvas, html, source, stylesHash }) => ({ format, canvas, html, source, stylesHash })),
  };
}

function sameBoardSource(boardDir: string, previous: Board, stage: string, candidate: Board): boolean {
  if (!isDeepStrictEqual(sourceInputs(previous), sourceInputs(candidate))) return false;
  return candidate.samples.every(({ html, source, stylesHash }) => {
    const prior = join(boardDir, html);
    const next = join(stage, html);
    if (!existsSync(prior) || !existsSync(next)) return false;
    // Live pages can change request metadata without changing what they draw.
    return (stylesHash !== undefined && /^https?:\/\//i.test(source)) || readFileSync(prior).equals(readFileSync(next));
  });
}

/** Serialize changes to the current board directory, including exports. */
export function lockCurrentBoard(boardDir: string): { path: string; release: () => void } {
  const lock = `${boardDir}.lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Board is locked at ${lock}.`);
  }
  return { path: lock, release: () => rmdirSync(lock) };
}

/** Build beside the project board before moving the previous files into history. */
export async function publishBoard(
  boardDir: string,
  build: (stage: string, version: number, previous: Board | undefined) => Promise<Board>,
  hooks: { finishStage?: (stage: string, board: Board) => Promise<void>; prepareCurrent?: (board: Board, snapshot: string) => () => void } = {},
): Promise<{ board: Board; changed: boolean }> {
  const lock = lockCurrentBoard(boardDir);
  try {
    const previous = existsSync(join(boardDir, "board.json")) ? readBoard(boardDir) : undefined;
    const stage = mkdtempSync(join(dirname(boardDir), ".board-stage-"));
    try {
      await build(stage, previous ? previous.version + 1 : 1, previous);
      const board = readBoard(stage);
      if (previous && sameBoardSource(boardDir, previous, stage, board)) {
        const { changed, updateBaseline } = compareSourceAssets(boardDir, stage);
        if (!changed) {
          if (previous.designHash) {
            const guide = join(boardDir, "DESIGN.md");
            const authored = unsignedDesign(readFileSync(join(stage, "DESIGN.md"), "utf8"));
            if (!existsSync(guide) || readFileSync(guide, "utf8") !== stampDesign(authored, { ...previous, designHash: previous.designHash })) {
              throw new Error("The frozen DESIGN.md does not match its recorded source and stamp.");
            }
          }
          hooks.prepareCurrent?.(previous, boardDir)();
          // Backfill old snapshots and remember newly observed dependencies without creating a version.
          if (updateBaseline) {
            renameSync(join(stage, SOURCE_ASSETS_FILE), join(boardDir, SOURCE_ASSETS_FILE));
          }
          return { board: previous, changed: false };
        }
      }
      await hooks.finishStage?.(stage, board);
      const applyGuides = hooks.prepareCurrent?.(board, stage);
      // Keep snapshots at the same depth as board/ so relative sample asset paths still resolve.
      const backup = previous && archive(boardDir, previous.version);
      const emptyBoard = !previous && existsSync(boardDir);
      if (backup) {
        if (existsSync(backup)) throw new Error(`Board archive already exists at ${backup}.`);
        localizeLegacyStylescape(boardDir, stage);
        renameSync(boardDir, backup);
      } else if (emptyBoard) {
        // A project may already contain an empty board/ directory.
        rmdirSync(boardDir);
      }
      try {
        renameSync(stage, boardDir);
        try {
          applyGuides?.();
        } catch (error) {
          renameSync(boardDir, stage);
          throw error;
        }
      } catch (error) {
        if (backup) renameSync(backup, boardDir);
        else if (emptyBoard) mkdirSync(boardDir);
        throw error;
      }
      return { board, changed: true };
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  } finally {
    lock.release();
  }
}
