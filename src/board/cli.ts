#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { adopt, adoptionPath, loadAdoption, selectAdoption } from "./adoption.js";
import { exportAstryx } from "./astryx.js";
import { check } from "./check.js";
import { diffBoards } from "./diff.js";
import { findProjectFormats, FORMATS, formatFiles, formatOfFile, isFormatFile, loadProjectFormats } from "./formats.js";
import { freeze, previewFreeze, renderBoard, type Board } from "./freeze.js";
import { boardValueKey, hasOutsideValues, isPieceFile, outputFiles, pieceStatusText, pieceVersion, pieceVersionText, readPiece, recordValueObservation } from "./pieces.js";
import { captureReferences, writeReferenceSheet } from "./refs.js";
import { MissingChromiumError, Renderer } from "./render.js";
import { writeSheet, writeStylescape, type SheetItem } from "./sheet.js";
import { prepareStandingInstructions } from "./standing.js";
import { parseVersion, readBoard, readBoardVersion, readFrozenDesign, versionLabel } from "./versions.js";

// Shells on Windows do not expand globs for native commands; expand a "*" in a file argument here.
const expand = (a: string) => {
  if (!a.includes("*")) return [a];
  const dir = dirname(a);
  const re = new RegExp("^" + basename(a).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f)) : [];
};
const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined) throw new Error(`Missing value for --${k}.`);
  args.splice(i, 2);
  return v;
};
const cmd = args.shift();

const briefTitle = (project: string) => {
  const p = join(project, "brief.md");
  return existsSync(p) ? (readFileSync(p, "utf8").match(/^#\s+(.+)$/m)?.[1] ?? "Brief").trim() : "Brief";
};

function line(x: Awaited<ReturnType<typeof check>>[number], piece?: ReturnType<typeof pieceVersion>, current?: string): string {
  const c = "consistency" in x ? x.consistency : undefined;
  const family = "family" in x ? x.family : undefined;
  const br = "brief" in x ? x.brief : [];
  const values = "outsideValues" in x ? x.outsideValues.map(({ kind, value, previousVersion, previousRole }) =>
    `uses ${value}${previousRole ? `, which is ${previousVersion}'s ${previousRole}` : previousVersion ? `, a ${kind} in ${previousVersion}` : ""}, outside ${current}`) : [];
  const notes = x.designNotes.map((f) => `${f.rule}: ${f.detail}`);
  return `${x.pass ? "PASS" : "FAIL"} ${x.format}: floor ${x.floor.length}${x.floor.length ? ` (${x.floor.map((f) => `${f.rule}: ${f.detail}`).join("; ")})` : ""}` +
    (piece ? `; ${pieceVersionText(piece)}` : "") +
    `; brief ${br.length}${br.length ? ` (${br.map((f) => `${f.rule}: ${f.detail}`).join("; ")})` : ""}` +
    [...values, ...notes].map((note) => `; note: ${note}`).join("") +
    (c ? `; off-palette ${c.offPalette.length}${c.offPalette.length ? ` (${c.offPalette.map((o) => `${o.hex} ${o.kind} ΔE${o.deltaE} from ${o.nearest}`).join("; ")})` : ""}; off-fonts ${c.offFonts.length}${c.offFonts.length ? ` (${c.offFonts.join(", ")})` : ""}` : "") +
    (c?.deviceMissing ? "; device missing (no data-device element)" : "") +
    (c?.resizedFrom?.length ? `; note: same thirds arrangement as ${c.resizedFrom.join(", ")} on a different shape` : "") +
    (family ? `; family ${family.name}${family.declared ? "" : " (nearest shape)"}: ${family.beside.join("; ")}` : "") +
    `; checks ran: ${x.checks.ran.join(", ")}` +
    (x.checks.skipped.length ? `; checks skipped: ${x.checks.skipped.map(({ check, reason }) => `${check} (${reason})`).join(", ")}` : "");
}

/** The floor and the brief's requirements on a direction's own samples, before anyone picks or freezes it. */
async function checkSamples(dir: string, b: Board, r: Renderer) {
  const formats = loadProjectFormats(resolve(dir, "..", ".."));
  return check(b, formatFiles(dir, { formats }), { renderer: r, out: join(dir, "check.json"), consistency: true, formats, brief: true });
}

async function main() {
  if (cmd === "adopt") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      root: { type: "string" },
      page: { type: "string", multiple: true },
      viewport: { type: "string", multiple: true },
      check: { type: "boolean" },
    } });
    if (positionals.length > 1) throw new Error("Usage: board adopt [project] [--root <dir>] [--page <file-or-url>] [--viewport WIDTHxHEIGHT] [--check]");
    const project = resolve(positionals[0] ?? ".");
    const manifest = !values.root && !values.page && !values.viewport && existsSync(adoptionPath(project))
      ? loadAdoption(project)
      : selectAdoption(project, { root: values.root, pages: values.page ?? [], viewports: values.viewport ?? [] });
    const renderer = new Renderer();
    try {
      const { output, evidence } = await adopt(project, manifest, renderer, values.check ?? false);
      for (const item of evidence) {
        console.log(item.source + " " + item.viewport.width + "x" + item.viewport.height + " ? " + join(output, item.png));
        if (item.findings) {
          console.log("  floor " + item.findings.length);
          for (const finding of item.findings) console.log("  " + finding.rule + ": " + finding.detail);
          for (const note of item.designNotes ?? []) console.log("  note: " + note.rule + ": " + note.detail);
        }
      }
      console.log("Computed styles and project style sources: " + join(output, "evidence.json"));
      console.log("Write DESIGN.md from the existing pages, then run board freeze.");
    } finally { await renderer.close(); }
    return;
  }
  if (cmd === "render") {
    const r = new Renderer();
    try {
      for (const f of args.flatMap(expand)) {
        const out = await r.render(resolve(f), formatOfFile(f, findProjectFormats(f)));
        console.log(out.png);
      }
    } finally { await r.close(); }
    return;
  }
  if (cmd === "refs") {
    const capture = args.indexOf("--capture");
    if (capture >= 0) {
      const captures = args.slice(capture + 1);
      if (capture > 1 || captures.length === 0 || captures.length % 2 !== 0) {
        throw new Error("Usage: board refs [project] --capture <url> <image.png> [<url> <image.png> ...]");
      }
      const requests = [];
      for (let i = 0; i < captures.length; i += 2) requests.push({ url: captures[i], image: captures[i + 1] });
      for (const result of await captureReferences(resolve(capture ? args[0] : "."), requests)) {
        if ("error" in result) {
          console.error(`${result.url}: ${result.error}`);
          process.exitCode = 1;
        } else {
          console.log(result.output);
          for (const warning of result.warnings) console.warn(`${basename(result.output)}: ${warning}`);
        }
      }
      return;
    }
    if (args.length > 1) throw new Error("Usage: board refs [project]");
    console.log(await writeReferenceSheet(resolve(args[0] ?? ".")));
    return;
  }
  if (cmd === "directions") {
    const scope = args.filter((arg) => arg !== "--check");
    if (scope.length > 2) throw new Error("Usage: board directions <project> [<id>] [--check]");
    const project = resolve(scope[0] ?? ".");
    const root = join(project, "directions");
    const directions = readdirSync(root).filter((d) => !d.startsWith("_") && existsSync(join(root, d, "direction.md")));
    const selected = scope[1];
    if (selected && !directions.includes(selected)) throw new Error(`Direction ${selected} not found in ${root}.`);
    const r = new Renderer();
    try {
      for (const id of selected ? [selected] : directions) {
        const dir = join(root, id);
        const b = await renderBoard({ directionDir: dir, boardDir: join(dir, "_values"), name: briefTitle(project), renderer: r });
        await writeStylescape(b, join(dir, "_values"), `${briefTitle(project)}: direction ${id}, ${b.direction.title}`, join(dir, "sheet.png"), r);
        console.log(join(dir, "sheet.png"));
        if (args.includes("--check")) {
          for (const x of await checkSamples(dir, b, r)) console.log(`  sample ${line(x, undefined, versionLabel(b.version))}`);
        }
      }
    } finally { await r.close(); }
    return;
  }
  if (cmd === "freeze") {
    const note = flag("note");
    const boardName = flag("name");
    const scope = args.filter((arg) => !["--check", "--force", "--extract", "--dry-run"].includes(arg));
    if (scope.length > 2 || scope.some((arg) => arg.startsWith("--"))) throw new Error("Usage: board freeze [project] [<direction>] [--name <name>] [--note <note>] [--check] [--dry-run]");
    const project = resolve(scope[0] ?? ".");
    const dir = scope[1] ? join(project, "directions", scope[1]) : undefined;
    if (!dir && !existsSync(adoptionPath(project))) throw new Error("Run board adopt to select existing pages, or give board freeze a direction ID.");
    if (!dir && args.includes("--extract")) throw new Error("Write DESIGN.md from the existing pages before freezing an adoption.");
    const adoptedTitle = () => {
      const guide = join(project, "DESIGN.md");
      const header = existsSync(guide) ? readFileSync(guide, "utf8").match(/^\uFEFF?---\r?\n([\s\S]*?)^---\s*$/m)?.[1] : undefined;
      return header?.match(/^name:[ \t]*(.+)$/m)?.[1].trim().replace(/^(["'])(.*)\1$/, "$2") ?? basename(project);
    };
    const name = boardName ?? (dir ? briefTitle(project) : adoptedTitle());
    const boardDir = join(project, "board");
    const sources = dir ? { directionDir: dir } : { project };
    if (args.includes("--dry-run")) {
      console.log(JSON.stringify(await previewFreeze({ ...sources, boardDir }), null, 2));
      return;
    }
    if (args.includes("--check")) {
      const rr = new Renderer();
      try {
        if (dir) {
          const preview = await renderBoard({ directionDir: dir, boardDir: join(dir, "_values"), name, renderer: rr });
          const bad = (await checkSamples(dir, preview, rr)).filter((x) => x.floor.length || ("brief" in x && x.brief.some((f) => f.rule !== "essential-missing" && f.rule !== "term-missing")));
          if (bad.length && !args.includes("--force")) {
            for (const x of bad) console.log(`sample ${line(x, undefined, versionLabel(preview.version))}`);
            throw new Error(`Not frozen: fix these samples in ${dir}. Pass --force to waive the optional sample checks. Required campaign copy still applies.`);
          }
        } else {
          const { evidence } = await adopt(project, loadAdoption(project), rr, true);
          const bad = evidence.filter((page) => page.findings?.length);
          if (bad.length && !args.includes("--force")) {
            for (const { source, viewport, findings } of bad) {
              console.log(source + " at " + viewport.width + "px:");
              for (const finding of findings!) console.log("  " + finding.rule + ": " + finding.detail);
            }
            throw new Error("Not frozen: fix the page findings and rerun freeze.");
          }
        }
      } finally { await rr.close(); }
    }
    const { board: b, changed } = await freeze({
      ...sources, boardDir, name, note, extract: args.includes("--extract"),
      onValidated: () => console.log("PASS DESIGN.md: computed colours, font families and sizes, required quotations, font load sources, line integrity, project file references."),
      prepareCurrent: (guide, source) => prepareStandingInstructions(project, guide, source),
    });
    if (!changed) {
      console.log(`no change (board ${versionLabel(b.version)})`);
      return;
    }
    const snapshot = { board: boardDir, version: versionLabel(b.version), note: b.note };
    console.log(JSON.stringify(b.designHash
      ? { ...snapshot, frozenAt: b.frozenAt, designHash: b.designHash }
      : { ...snapshot, palette: b.palette.map((p) => `${p.hex} ${p.role}`), fonts: b.fonts.map((f) => f.family), composition: b.composition }, null, 2));
    return;
  }
  if (cmd === "log") {
    const boardDir = resolve(args[0] ?? ".", "board");
    const current = readBoard(boardDir);
    for (let version = 1; version <= current.version; version++) {
      const b = readBoardVersion(boardDir, current, version);
      console.log(`${versionLabel(version)}  ${b.frozenAt}  ${b.note ? JSON.stringify(b.note) : "(no note)"}${version === current.version ? "  (current)" : ""}`);
    }
    return;
  }
  if (cmd === "diff") {
    if (!args[0] || !args[1]) throw new Error("Usage: board diff <a> <b> [project]");
    const boardDir = resolve(args[2] ?? ".", "board");
    const current = readBoard(boardDir);
    const [a, b] = args.slice(0, 2).map((label) => readBoardVersion(boardDir, current, parseVersion(label)));
    const changes = diffBoards(a, b);
    console.log(`${versionLabel(a.version)} → ${versionLabel(b.version)}`);
    console.log(changes.length ? changes.join("\n") : "No extracted values changed.");
    return;
  }
  if (cmd === "status") {
    const project = resolve(args[0] ?? ".");
    const boardDir = join(project, "board");
    const b = existsSync(join(boardDir, "board.json")) ? readBoard(boardDir) : undefined;
    const files = outputFiles(join(project, "outputs"));
    console.log(b ? "Current board: " + versionLabel(b.version) : "No frozen board.");
    if (!b && existsSync(adoptionPath(project))) console.log("Adoption recorded. Write DESIGN.md and run board freeze.");
    if (!files.length) console.log("No pieces in outputs/.");
    const boardKey = b && boardValueKey(b);
    for (const file of files) {
      const { boardVersion, sourceHash } = readPiece(file);
      const outside = b && boardKey && hasOutsideValues(file, boardKey, sourceHash) ? ", uses values outside " + versionLabel(b.version) + " (last checked)" : "";
      console.log(relative(project, file).replace(/\\/g, "/") + ": " + pieceStatusText(boardVersion, b?.version) + outside);
    }
    return;
  }
  if (cmd === "export") {
    if (args[0] !== "astryx" || args.length > 2) throw new Error("Usage: board export astryx [project]");
    console.log(exportAstryx(resolve(args[1] ?? ".", "board")));
    return;
  }
  if (cmd === "check") {
    const consistency = args.includes("--consistency");
    const brief = args.includes("--brief");
    const [target, ...pieces] = args.filter((arg) => arg !== "--consistency" && arg !== "--brief");
    if (!target || ((consistency || brief) && target === "--floor-only")) {
      throw new Error("Usage: board check <project> <file.html...> [--brief] [--consistency], or board check --floor-only <file.html...>");
    }
    const boardDir = resolve(target, "board");
    const board = target === "--floor-only" ? null : readBoard(boardDir);
    const formats = board ? loadProjectFormats(resolve(target)) : undefined;
    const files = pieces.flatMap(expand).map((f) => resolve(f))
      .filter(consistency || !board ? (f) => isFormatFile(f, formats ?? findProjectFormats(f)) : isPieceFile);
    if (!files.length) throw new Error("No piece HTML files matched.");
    const out = join(dirname(files[0]), "check.json");
    const sources = board ? files.map(readPiece) : [];
    const previous: Board[] = [];
    const designs = new Map<number, string>();
    if (board) {
      for (let version = board.version - 1; version >= 1; version--) {
        if (existsSync(join(`${boardDir}.${versionLabel(version)}`, "board.json"))) previous.push(readBoardVersion(boardDir, board, version));
      }
      for (const snapshot of [board, ...previous]) {
        const design = readFrozenDesign(boardDir, board, snapshot);
        if (design !== undefined) designs.set(snapshot.version, design);
      }
    }
    const res = await check(board, files, { consistency, formats, previous, brief, designs });
    const current = board && versionLabel(board.version);
    const versions = board ? sources.map(({ boardVersion }) => pieceVersion(boardVersion, board.version)) : [];
    if (board) {
      const boardKey = boardValueKey(board);
      res.forEach((x, i) => {
        if ("outsideValues" in x) recordValueObservation(x.file, boardKey, {
          sourceHash: sources[i].sourceHash,
          usesOutsideValues: x.outsideValues.length > 0,
        });
      });
    }
    writeFileSync(out, JSON.stringify(res.map((x, i) => ({ ...x, ...versions[i], checkedAgainst: current ?? undefined })), null, 2));
    if (res.some((x) => !x.pass)) process.exitCode = 1;
    res.forEach((x, i) => console.log(line(x, versions[i], current ?? undefined)));
    console.log(out);
    return;
  }
  if (cmd === "kit") {
    const project = resolve(args[0]);
    const dir = join(project, flag("dir") ?? "outputs");
    const formats = loadProjectFormats(project);
    const have = formats.filter((f) => existsSync(join(dir, `${f.id}.png`)));
    const item = (f: typeof FORMATS[number]): SheetItem => ({ label: f.label, png: join(dir, `${f.id}.png`), width: f.width, height: f.height });
    const wide = ["hero", "og", "link"];
    const boardDir = join(project, "board");
    const b = existsSync(join(boardDir, "board.json")) ? readBoard(boardDir) : null;
    const out = join(dir, "kit-sheet.png");
    await writeSheet(join(dir, "kit-sheet.html"), out, {
      title: `${briefTitle(project)}: kit${b ? ` from the frozen board (${b.direction.title})` : ""}`,
      swatches: b?.palette.map((p) => p.hex), fonts: b?.fonts.map((f) => `${f.family} ${f.weights.join("/")}`),
      rowHeight: 400,
      rows: formats === FORMATS
        ? [{ items: have.filter((f) => wide.includes(f.id)).map(item) }, { items: have.filter((f) => !wide.includes(f.id)).map(item) }]
        : [{ items: have.map(item) }],
    });
    console.log(out);
    return;
  }
  const usage = "Usage: briefatto-board <install|adopt|render|refs|directions|freeze|log|diff|status|export|check|kit>";
  if (cmd === "--help" || cmd === "-h") {
    console.log(usage);
    return;
  }
  console.error(usage);
  process.exit(2);
}

// A reader that stops early (head, Select-Object -First) closes the pipe; that is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") process.exit(); throw e; });
main().catch((e) => { console.error(e instanceof MissingChromiumError ? e.message : e); process.exit(1); });
