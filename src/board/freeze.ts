// Freeze the agent's guide beside the chosen sample pages and their rendered values.

import { copyFileSync, existsSync, mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { loadAdoption, localAdoptionAssets, withAdoptedPages } from "./adoption.js";
import { readConstraintSources } from "./constraints.js";
import { designMd, describeChange } from "./design.js";
import { briefExpectations, computedSample, designHash, stampDesign, unsignedDesign, validateDesign, type SourceQuote } from "./design-validation.js";
import { FORMATS, formatById, formatFiles, formatOfFile, isFormatFile, loadProjectFormats, type BoardFormat } from "./formats.js";
import { briefFaults } from "./floor.js";
import { composition, deltaE, JND_DE76, palette, toHex, typeRoles, type Composition, type PaletteEntry, type TypeRole } from "./metrics.js";
import type { Rendered } from "./render.js";
import { loadEssentials, type Essentials } from "./essentials.js";
import { portableFontFaces, portableImages, type BriefAsset } from "./portable.js";
import { outputFiles, readPiece } from "./pieces.js";
import { Renderer } from "./render.js";
import { writeStylescape } from "./sheet.js";
import { publishBoard, readBoard, versionLabel } from "./versions.js";
import { hashLocalAssets, SOURCE_ASSETS_FILE } from "./source-assets.js";

export { designMd };

export interface Board {
  version: number;
  /** SHA-256 of the authored guide before the freeze stamp. */
  designHash?: string;
  note: string;
  name: string;
  direction: { id: string; title: string; text: string };
  frozenAt: string;
  palette: PaletteEntry[];
  fonts: Array<{ family: string; weights: number[]; stack: string }>;
  fontLinks: string[];
  fontFaces?: string[];
  type: { display?: TypeRole; body?: TypeRole };
  radii: { px: number[]; full: boolean };
  shadows: boolean;
  composition: {
    displayShare: [number, number];
    sizeRatio: [number, number];
    marginShare: [number, number];
    align: string[];
    textCoverage: [number, number];
    imageCoverage: [number, number];
    imageBleeds: boolean[];
  };
  images: { used: boolean; fits: string[]; filters: string[]; radii: number[]; srcs: string[] };
  /** Words set in the lead sample's display and body roles, for specimens. */
  specimen: { display: string; body: string };
  /** The one recurring graphic device (elements marked data-device in the samples). */
  device: { present: boolean; colours: string[]; radii: number[]; tags: string[]; sizeShare: [number, number] } ;
  /** What the brief requires of its campaign pieces (requested strings, body copy, its images); see essentials.ts. */
  essentials?: Essentials;
  /** The full source brief carries facts beyond the optional checker's essentials. */
  brief?: string;
  briefAssets?: BriefAsset[];
  changeSummary?: string;
  /** The client's verbatim musts and must-nots carried forward through freezes. */
  constraints?: string[];
  /** Composition families: each sample is one, named by its format; aspect = width / height. */
  samples: Array<{ format: string; canvas?: BoardFormat; aspect: number; html: string; png: string; source: string; stylesHash?: string; composition: Composition }>;
}

const range = (xs: number[]): [number, number] => [Math.min(...xs), Math.max(...xs)];
const uniq = <T>(xs: T[]) => [...new Set(xs)];

export function mergePalettes(ps: Array<{ p: PaletteEntry[]; area: number }>): PaletteEntry[] {
  const out: Array<PaletteEntry & { w: number }> = [];
  for (const { p, area } of ps) {
    for (const e of p) {
      const k = out.find((x) => deltaE(x.hex, e.hex) <= JND_DE76);
      if (k) { k.w += e.share * area; k.kinds = uniq([...k.kinds, ...e.kinds]); if (e.role !== "accent" && k.role === "accent") k.role = e.role; }
      else out.push({ ...e, w: e.share * area });
    }
  }
  const total = ps.reduce((s, x) => s + x.area, 0);
  return out.sort((a, b) => b.w - a.w).map(({ w, ...e }) => ({ ...e, share: Math.round((w / total) * 1000) / 1000 }));
}

export function boardFromRenders(name: string, direction: Board["direction"], renders: Array<{ file: string; fmt: string; canvas?: BoardFormat; r: Rendered; source?: string }>, boardDir: string): Board {
  const comps = renders.map((x) => composition(x.r));
  const roles = renders.map((x) => typeRoles(x.r));
  // The display and body roles come from the hero when present, otherwise the first sample.
  const lead = renders.findIndex((x) => x.fmt === "hero");
  const leadRoles = roles[lead >= 0 ? lead : 0];
  const fams = new Map<string, { family: string; weights: Set<number>; stack: string }>();
  for (const x of renders) for (const t of x.r.texts) {
    const f = fams.get(t.family) ?? { family: t.family, weights: new Set<number>(), stack: t.stack };
    f.weights.add(t.weight);
    fams.set(t.family, f);
  }
  const radii = renders.flatMap((x) => x.r.radii);
  const imgs = renders.flatMap((x) => x.r.images);
  const fontFaces = uniq(renders.flatMap((x) => x.r.fontFaces ?? []));
  return {
    version: 1,
    note: "",
    name,
    direction,
    frozenAt: new Date().toISOString(),
    palette: mergePalettes(renders.map((x) => ({ p: palette(x.r), area: x.r.width * x.r.height }))),
    fonts: [...fams.values()].map((f) => ({ family: f.family, weights: [...f.weights].sort((a, b) => a - b), stack: f.stack })),
    fontLinks: uniq(renders.flatMap((x) => x.r.fontLinks)),
    ...(fontFaces.length ? { fontFaces } : {}),
    type: { display: leadRoles.display, body: leadRoles.body },
    radii: { px: uniq(radii.filter((r) => !r.full).map((r) => r.px)).sort((a, b) => a - b), full: radii.some((r) => r.full) },
    shadows: renders.some((x) => x.r.shadows > 0),
    composition: {
      displayShare: range(comps.map((c) => c.displayShare)),
      sizeRatio: range(comps.map((c) => c.sizeRatio)),
      marginShare: range(comps.map((c) => c.marginShare)),
      align: uniq(comps.map((c) => c.align)),
      textCoverage: range(comps.map((c) => c.textCoverage)),
      imageCoverage: range(comps.map((c) => c.imageCoverage)),
      imageBleeds: uniq(comps.map((c) => c.imageBleeds)),
    },
    images: { used: imgs.length > 0, fits: uniq(imgs.map((i) => i.fit)), filters: uniq(imgs.map((i) => i.filter)), radii: uniq(imgs.map((i) => i.radius)), srcs: uniq(imgs.map((i) => i.src)) },
    specimen: (() => {
      const t = renders[lead >= 0 ? lead : 0].r.texts;
      const d = [...t].sort((a, b) => b.size - a.size)[0];
      const body = leadRoles.body ? t.filter((x) => x.family === leadRoles.body!.family && x !== d).sort((a, b) => b.text.length - a.text.length)[0] : undefined;
      return { display: d?.text ?? "", body: body?.text ?? "" };
    })(),
    device: (() => {
      const ds = renders.flatMap((x) => x.r.devices.map((d) => ({ d, short: Math.min(x.r.width, x.r.height) })));
      const hexes = uniq(ds.flatMap(({ d }) => d.colours.map((c) => toHex(c)).filter((h): h is string => !!h)));
      const shares = ds.map(({ d, short }) => Math.round((Math.max(d.box.w, d.box.h) / short) * 1000) / 1000);
      return { present: ds.length > 0, colours: hexes, radii: uniq(ds.map(({ d }) => d.radius)), tags: uniq(ds.map(({ d }) => d.tag)), sizeShare: ds.length ? range(shares) : [0, 0] as [number, number] };
    })(),
    samples: renders.map((x, i) => ({
      format: x.fmt, ...(x.canvas ? { canvas: x.canvas } : {}), aspect: Math.round((x.r.width / x.r.height) * 1000) / 1000,
      html: `samples/${x.fmt}.html`, png: `samples/${x.fmt}.png`,
      source: x.source ?? relative(boardDir, x.file).replace(/\\/g, "/"), composition: comps[i],
      ...(x.source ? { stylesHash: designHash(JSON.stringify({
        colours: x.r.colours.map(({ value, kind }) => [value, kind]),
        text: x.r.texts.map(({ text, stack, size, weight, color, transform, lineHeight, letterSpacingEm }) =>
          [text, stack, size, weight, color, transform, lineHeight, letterSpacingEm]),
        images: x.r.images.map(({ src, fit, radius, filter }) =>
          [src.startsWith("file:") ? basename(src) : src.split(/[?#]/, 1)[0], fit, radius, filter]),
        extra: x.r.designStyles, radii: x.r.radii, composition: comps[i],
      })) } : {}),
    })),
  };
}

const mid = (r: [number, number]) => Math.round(((r[0] + r[1]) / 2) * 1000) / 1000;
const q = (s: string) => JSON.stringify(s);

export function tokensCss(b: Board): string {
  const L: string[] = [];
  for (const l of b.fontLinks) L.push(`@import url(${q(l)});`);
  L.push(...(b.fontFaces ?? []));
  L.push("", `/* ${b.name}: frozen board v${b.version} (${b.direction.title}), ${b.frozenAt}. Values read from the chosen samples. */`, ":root {");
  L.push("  /* Each output's viewport is its canvas, so its short side is min(100vw, 100vh). */", "  --short: min(100vw, 100vh);");
  let a = 0;
  for (const p of b.palette) L.push(`  --color-${p.role === "accent" ? `accent-${++a}` : p.role}: ${p.hex}; /* ${(p.share * 100).toFixed(1)}% of the samples' area; ${p.kinds.join(", ")} */`);
  for (const [k, t] of Object.entries(b.type) as Array<[string, TypeRole | undefined]>) {
    if (!t) continue;
    const stack = b.fonts.find((f) => f.family === t.family)?.stack ?? q(t.family);
    L.push(`  --font-${k}: ${stack};`, `  --weight-${k}: ${t.weight};`, `  --tracking-${k}: ${t.letterSpacingEm}em;`, `  --leading-${k}: ${t.lineHeight};`, `  --case-${k}: ${t.transform};`, `  --style-${k}: ${t.italic ? "italic" : "normal"};`);
  }
  L.push(`  --display-size: calc(var(--short) * ${mid(b.composition.displayShare)}); /* samples: ${b.composition.displayShare.join(" to ")} of the short side */`);
  L.push(`  --body-size: calc(var(--display-size) / ${mid(b.composition.sizeRatio)}); /* display over body in the samples: ${b.composition.sizeRatio.join(" to ")} */`);
  L.push(`  --margin: calc(var(--short) * ${mid(b.composition.marginShare)}); /* samples: ${b.composition.marginShare.join(" to ")} */`);
  b.radii.px.forEach((r, i) => L.push(`  --radius-${i + 1}: ${r}px;`));
  if (b.radii.full) L.push("  --radius-full: 9999px;");
  L.push("}", "");
  return L.join("\n");
}

type BoardSources = { directionDir: string; project?: never } | { project: string; directionDir?: never };
type SampleRenders = Array<Parameters<typeof boardFromRenders>[2][number] & { boardFormat: BoardFormat }>;
const projectPath = (project: string, file: string) => relative(project, file).replace(/\\/g, "/");

async function renderAdoptedPages(project: string, samplesDir: string, renderer: Renderer,
  renders: SampleRenders, localAssets?: Set<string>): Promise<Board["direction"]> {
  return withAdoptedPages(project, loadAdoption(project), localAssets, async (pages) => {
    for (const { id, source, website, file, origin, root } of pages) {
      const html = join(samplesDir, id + ".html");
      const rendered = await renderer.render(html, undefined, join(samplesDir, id + ".png"), true, undefined, {
        ...website, captureHtml: file ? undefined : (content) => writeFileSync(html, content),
      });
      if (file) copyFileSync(file, html);
      const r = localAdoptionAssets(rendered, origin, root);
      const { width, height } = r;
      const canvas = { id, label: source, width, height, seenWidth: width, source };
      renders.push({ file: file ?? html, fmt: id, source, canvas, boardFormat: canvas, r });
    }
    return { id: "existing-site", title: "Existing site", text: "" };
  });
}

async function renderDirectionPages(directionDir: string, project: string, samplesDir: string, renderer: Renderer,
  renders: SampleRenders, collectStyles: boolean, localAssets?: Set<string>): Promise<Board["direction"]> {
  const formats = loadProjectFormats(project);
  const samples = formatFiles(directionDir, { formats }).map((file) => ({ file, fmt: formatOfFile(file, formats) }));
  if (!samples.length) throw new Error("No sample HTML in " + directionDir + ".");
  if (new Set(samples.map(({ fmt }) => fmt.id)).size !== samples.length) {
    throw new Error("Multiple sample files for the same format in " + directionDir + ".");
  }
  if (formats !== FORMATS) {
    const order = new Map(formats.map((fmt, i) => [fmt.id, i]));
    const missing = formats.filter((fmt) => !samples.some((sample) => sample.fmt.id === fmt.id));
    if (missing.length) throw new Error("Missing samples in " + directionDir + ": " + missing.map((fmt) => fmt.id + ".html").join(", ") + ".");
    samples.sort((a, b) => order.get(a.fmt.id)! - order.get(b.fmt.id)!);
  }
  const textPath = join(directionDir, "direction.md");
  const text = existsSync(textPath) ? readFileSync(textPath, "utf8") : "";
  const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? basename(directionDir)).trim();
  for (const { file, fmt } of samples) {
    const r = await renderer.render(file, fmt, join(samplesDir, fmt.id + ".png"), collectStyles, localAssets);
    copyFileSync(file, join(samplesDir, fmt.id + ".html"));
    renders.push({ file, fmt: fmt.id, canvas: formats === FORMATS ? undefined : fmt, boardFormat: fmt, r });
  }
  return { id: basename(directionDir), title, text };
}

function directionBrief(project: string): string {
  const path = join(project, "brief.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function constraintSources(project: string, directionDir: string | undefined, previous: Board | undefined): SourceQuote[] {
  const quotes = new Map((previous?.constraints ?? []).map((value, index) =>
    [value, { value, source: `board/board.json constraints[${index}]` }]));
  if (directionDir) {
    for (const { value, line } of readConstraintSources(join(project, "refs", "notes.md"))) {
      quotes.set(value, { value, source: `refs/notes.md:${line}` });
    }
  }
  return [...quotes.values()];
}

function guideInputs(project: string, board: Pick<Board, "brief" | "essentials">, renders: SampleRenders, constraints: SourceQuote[], brief: string | undefined) {
  return {
    brief: briefExpectations(board, constraints, brief),
    samples: renders.map(({ file, source, r }) => computedSample(source ?? projectPath(project, file), r)),
  };
}

async function campaignCopyFindings(project: string, directionDir: string | undefined, essentials: Essentials,
  renders: SampleRenders, renderer: Renderer) {
  const findings: Array<{ source: string; rule: string; detail: string }> = [];
  if (!essentials.required.length && !essentials.terms.length) return findings;
  const copyOnly = { ...essentials, body: [], assets: [] };
  const inspect = (source: string, r: Rendered, fmt: BoardFormat) => {
    for (const { rule, detail } of briefFaults(r, fmt, copyOnly)) {
      if (rule === "essential-missing" || rule === "term-missing") findings.push({ source, rule, detail: `${detail} from ${essentials.source}` });
    }
  };
  const campaigns = new Set<string>();
  for (const { file, source, boardFormat, r } of renders) {
    const { campaign } = readPiece(file);
    if (campaign) campaigns.add(campaign);
    if (directionDir || campaign) inspect(source ?? projectPath(project, file), r, boardFormat);
  }
  const outputs = outputFiles(join(project, "outputs")).filter((file) => {
    const { campaign } = readPiece(file);
    return campaign !== undefined && (!campaigns.size || campaigns.has(campaign));
  });
  if (outputs.length) {
    const formats = loadProjectFormats(project);
    using tmp = mkdtempDisposableSync(join(tmpdir(), "briefatto-campaign-"));
    for (const [index, file] of outputs.entries()) {
      const fmt = isFormatFile(file, formats) ? formatOfFile(file, formats) : undefined;
      const r = await renderer.render(file, fmt, join(tmp.path, `${index}.png`));
      inspect(projectPath(project, file), r, fmt ?? { ...formatById("hero"), id: "html", height: r.height });
    }
  }
  return findings;
}

/** Render a read-only preview of the values and wording the guide can claim. */
export async function previewFreeze(opts: BoardSources & { boardDir: string; renderer?: Renderer }) {
  const { boardDir, directionDir } = opts;
  const project = opts.project ?? dirname(boardDir);
  const previous = existsSync(join(boardDir, "board.json")) ? readBoard(boardDir) : undefined;
  const constraints = constraintSources(project, directionDir, previous);
  const brief = directionDir ? directionBrief(project) : undefined;
  const essentials = loadEssentials(project);
  using tmp = mkdtempDisposableSync(join(tmpdir(), "briefatto-freeze-"));
  const renderer = opts.renderer ?? new Renderer();
  const renders: SampleRenders = [];
  try {
    if (directionDir) await renderDirectionPages(directionDir, project, tmp.path, renderer, renders, true);
    else await renderAdoptedPages(project, tmp.path, renderer, renders);
    const board = { brief, essentials };
    const inputs = guideInputs(project, board, renders, constraints, brief);
    const campaignFindings = await campaignCopyFindings(project, directionDir, essentials, renders, renderer);
    const { source, required, terms, termsExempt } = essentials;
    return { ...inputs, campaignRequirements: { source, required, terms, termsExempt }, campaignFindings };
  } finally {
    if (!opts.renderer) await renderer.close();
  }
}

/** Render the selected direction or site into a staged board. */
export async function renderBoard(opts: BoardSources & {
  boardDir: string; name: string; renderer?: Renderer; version?: number; note?: string;
  constraints?: SourceQuote[]; previous?: Board; extract?: boolean; authoredDesign?: string; onValidated?: () => void; currentBoardDir?: string;
}): Promise<Board> {
  const { directionDir, boardDir, name } = opts;
  const project = opts.project ?? resolve(directionDir!, "..", "..");
  const samplesDir = join(boardDir, "samples");
  mkdirSync(samplesDir, { recursive: true });
  const renderer = opts.renderer ?? new Renderer();
  const renders: SampleRenders = [];
  const localAssets = opts.currentBoardDir ? new Set<string>() : undefined;
  try {
    const direction = directionDir
      ? await renderDirectionPages(directionDir, project, samplesDir, renderer, renders, opts.authoredDesign !== undefined, localAssets)
      : await renderAdoptedPages(project, samplesDir, renderer, renders, localAssets);
    const board = boardFromRenders(name, direction, renders, boardDir);
    board.version = opts.version ?? board.version;
    board.note = opts.note ?? board.note;
    const brief = directionDir ? directionBrief(project) : undefined;
    if (brief !== undefined) {
      board.essentials = loadEssentials(project);
      board.brief = brief.trim();
      if (board.essentials.assets.length) board.briefAssets = portableImages(project, board.essentials.assets);
    }
    if (board.fontFaces) board.fontFaces = portableFontFaces(project, board.fontFaces);
    if (opts.constraints?.length) board.constraints = opts.constraints.map(({ value }) => value);
    board.changeSummary = describeChange(opts.previous, board);
    if (opts.currentBoardDir) {
      const missing = await campaignCopyFindings(project, directionDir, board.essentials ?? loadEssentials(project), renders, renderer);
      if (missing.length) throw new Error(`FAIL campaign copy\n${missing.map(({ source, rule, detail }) => `  ${source}: ${rule}: ${detail}.`).join("\n")}`);
    }
    if (opts.authoredDesign !== undefined) {
      const inputs = guideInputs(project, board, renders, opts.constraints ?? [], brief);
      const findings = await validateDesign(opts.authoredDesign, project, inputs, renderer, localAssets);
      if (findings.length) throw new Error(`FAIL DESIGN.md\n${findings.map(({ rule, detail }) => `  ${rule}: ${detail}`).join("\n")}`);
      opts.onValidated?.();
      board.designHash = designHash(opts.authoredDesign);
      writeFileSync(join(boardDir, "DESIGN.md"), stampDesign(opts.authoredDesign, { ...board, designHash: board.designHash }));
    } else if (opts.extract) {
      writeFileSync(join(boardDir, "DESIGN.md"), designMd(board));
    }
    if (localAssets) {
      for (const asset of board.essentials?.assets ?? []) {
        if (!/^https?:\/\//i.test(asset)) localAssets.add(resolve(project, asset));
      }
      // Links to the current snapshot point at outputs that this freeze can replace.
      const output = resolve(opts.currentBoardDir!) + sep;
      const inputs = [...localAssets].filter((path) => !path.startsWith(output));
      writeFileSync(join(boardDir, SOURCE_ASSETS_FILE), JSON.stringify(hashLocalAssets(project, inputs)));
    }
    writeFileSync(join(boardDir, "board.json"), JSON.stringify(board, null, 2));
    writeFileSync(join(boardDir, "tokens.css"), tokensCss(board));
    return board;
  } finally {
    if (!opts.renderer) await renderer.close();
  }
}

/** Freeze a new current version while retaining the previous board and its sample files. */
export function freeze(opts: BoardSources & {
  boardDir: string; name: string; note?: string; renderer?: Renderer; extract?: boolean;
  onValidated?: () => void; prepareCurrent?: (guide: string, source?: Buffer) => () => void;
}) {
  const project = dirname(opts.boardDir);
  let source: Buffer | undefined;
  return publishBoard(opts.boardDir, (stage, version, previous) => {
    let authoredDesign: string | undefined;
    if (!opts.extract) {
      const designPath = join(project, "DESIGN.md");
      if (!existsSync(designPath)) throw new Error("FAIL DESIGN.md\n  missing-guide: Write the project-root DESIGN.md from the rendered pages before freezing.");
      source = readFileSync(designPath);
      try {
        authoredDesign = unsignedDesign(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source));
      } catch {
        throw new Error("FAIL DESIGN.md\n  truncated-line: Expected valid UTF-8.");
      }
      if (!authoredDesign.trim()) throw new Error("FAIL DESIGN.md\n  missing-guide: The project-root DESIGN.md is empty.");
    }
    const constraints = constraintSources(project, opts.directionDir, previous);
    return renderBoard({ ...opts, boardDir: stage, version, constraints, previous, authoredDesign, currentBoardDir: opts.boardDir });
  }, {
    finishStage: async (stage, b) => {
      await writeStylescape(b, stage, `${b.name}: frozen board ${versionLabel(b.version)} (${b.direction.title})`, join(stage, "stylescape.png"), opts.renderer);
    },
    prepareCurrent: opts.prepareCurrent && ((board, dir) => opts.prepareCurrent!(
      opts.extract ? designMd(board) : readFileSync(join(dir, "DESIGN.md"), "utf8"), source,
    )),
  });
}
