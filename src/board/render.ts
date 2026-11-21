// Capture an HTML page in Chromium and collect the computed styles of visible elements.

import { chromium, type Browser, type Page } from "playwright";
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatById, type BoardFormat } from "./formats.js";

export interface Box { x: number; y: number; w: number; h: number }

export interface TextRun {
  text: string;
  role?: string;
  family: string;
  /** The whole font-family list as written. */
  stack: string;
  loaded: boolean;
  size: number;
  weight: number;
  letterSpacingEm: number;
  lineHeight: number;
  transform: string;
  italic: boolean;
  fontStyle?: string;
  align: string;
  color: string;
  box: Box;
  clipped: boolean;
}

interface CopyGeometry {
  text: string;
  fragments: Box[];
  offCanvas: boolean;
  clipped: boolean;
}

interface ActionGeometry extends CopyGeometry {
  buttonTreatment: boolean;
}

export interface ColourUse { value: string; kind: "text" | "bg" | "border" | "fill" | "stroke" | "gradient" | "shadow"; area: number }

export interface ImageUse { box: Box; fit: string; filter: string; radius: number; src: string }

export interface Drawn {
  width: number;
  height: number;
  texts: TextRun[];
  copy?: CopyGeometry[];
  actions?: ActionGeometry[];
  visibleText?: string;
  generatedCopy?: number;
  colours: ColourUse[];
  radii: Array<{ px: number; full: boolean }>;
  images: ImageUse[];
  shadows: number;
  fontLinks: string[];
  fontFaces?: string[];
  /** Additional computed styles that the visual metrics do not consume. */
  designStyles?: { colours: string[]; stacks: string[]; sizes: number[] };
  siteStyles?: { title: string; variables: Record<string, string> };
  /** Elements marked data-device: the brand's one recurring graphic device. */
  devices: Array<{ box: Box; colours: string[]; radius: number; tag: string }>;
  /** The composition family the page says it follows (<meta name="board-family">), if any. */
  family: string | null;
}

export interface Rendered extends Drawn {
  png: string;
  /** WCAG 2.x contrast of each text run against the median of a ring of pixels around it (null when the ring is empty). */
  contrast: Array<number | null>;
}

export interface WebsiteRender {
  source: string;
  viewport: { width: number; height: number };
  captureHtml?: (html: string) => void;
}

/** Runs inside the page. Must stay self-contained (it is serialised by Playwright). */
function readPage(canvas: { width: number; height: number; collectDesignStyles: boolean; website: boolean; fixedCanvas: boolean }): Drawn {
  const W = canvas.width, H = canvas.height;
  const inter = (r: DOMRect) => {
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(W, r.right), y1 = Math.min(H, r.bottom);
    return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
  };
  const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "-apple-system", "blinkmacsystemfont", "emoji", "math"]);
  const ctx = document.createElement("canvas").getContext("2d")!;
  const probe = "mmmmmmmmmmlli1WQ@#&gy";
  const loadedCache = new Map<string, boolean>();
  const fontLoaded = (family: string, weight: string, style: string, text: string) => {
    if (generic.has(family.toLowerCase())) return true;
    const key = JSON.stringify([family, weight, style]);
    if (loadedCache.has(key)) return loadedCache.get(key)!;
    // Use the same face selection as the element, including faces loaded lazily by the browser.
    const font = `${style} ${weight} 72px`;
    const sample = probe + text;
    let ok = false;
    for (const fb of ["monospace", "serif", "sans-serif"]) {
      ctx.font = `${font} ${fb}`;
      const w0 = ctx.measureText(sample).width;
      ctx.font = `${font} ${family}, ${fb}`;
      if (Math.abs(ctx.measureText(sample).width - w0) > 0.01) { ok = true; break; }
    }
    loadedCache.set(key, ok);
    return ok;
  };
  const out: Drawn = { width: W, height: H, texts: [], colours: [], radii: [], images: [], shadows: 0, fontLinks: [], devices: [], family: document.querySelector('meta[name="board-family"]')?.getAttribute("content") ?? null };
  if (canvas.website) {
    const variables = new Map<string, string>();
    for (const element of [document.documentElement, document.body]) {
      const css = getComputedStyle(element);
      for (const name of Array.from(css).filter((name) => name.startsWith("--"))) {
        variables.set(name, css.getPropertyValue(name).trim());
      }
    }
    out.siteStyles = { title: document.title, variables: Object.fromEntries(variables) };
  }
  const styles = { colours: new Set<string>(), stacks: new Set<string>(), sizes: new Set<number>() };
  const cssColours = /(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([^()]*\)/g;
  const recordStyleColours = (...values: string[]) => {
    for (const value of values) for (const colour of value.match(cssColours) ?? []) styles.colours.add(colour);
  };
  const transparent = (c: string) => !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
  const rootBgs = [document.documentElement, document.body].map((e) => getComputedStyle(e).backgroundColor).filter((c) => !transparent(c));
  for (const c of rootBgs) out.colours.push({ value: c, kind: "bg", area: W * H });
  const els = [document.documentElement, document.body, ...document.body.querySelectorAll("*")];
  const copy: CopyGeometry[] = out.copy = [];
  const actions: ActionGeometry[] = out.actions = [];
  const visibleText: Array<{ node: Node; text: string; block: Element; first: DOMRect; last: DOMRect }> = [];
  const testedActions = new Set<Element>();
  const ink = document.createElement("canvas").getContext("2d")!;
  const range = document.createRange();
  type Edges = Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">;
  const canvasBounds = new DOMRect(0, 0, W, H);
  const computedStyles = new Map<Element, CSSStyleDeclaration>();
  const computed = (el: Element) => {
    let style = computedStyles.get(el);
    if (!style) computedStyles.set(el, style = getComputedStyle(el));
    return style;
  };
  const htmlStyle = computed(document.documentElement);
  const bodyStyle = computed(document.body);
  // The viewport crop already handles document overflow. See CSS Overflow level 3 §3.1.4.
  const overflowHost = htmlStyle.overflow === "visible" && htmlStyle.contain === "none" && bodyStyle.contain === "none"
    ? document.body : document.documentElement;
  // Keep the existing one-CSS-pixel tolerance for layout rounding at clip boundaries.
  const beyond = (r: Edges, clip: Edges) => r.left < clip.left - 1 || r.top < clip.top - 1
    || r.right > clip.right + 1 || r.bottom > clip.bottom + 1;
  const intersect = (a: Edges, b: Edges) => ({
    left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
  });
  const clipsOverflow = (value: string) => value === "hidden" || value === "clip"
    || (canvas.fixedCanvas && (value === "scroll" || value === "auto"));
  const clipCache = new Map<Element, Edges | null>();
  const clipBounds = (el: Element, cs: CSSStyleDeclaration): Edges | null => {
    if (clipCache.has(el)) return clipCache.get(el)!;
    const x = clipsOverflow(cs.overflowX), y = clipsOverflow(cs.overflowY);
    let bounds = null;
    if ((x || y) && cs.display !== "inline" && cs.display !== "contents") {
      const r = el.getBoundingClientRect();
      const sx = el instanceof HTMLElement && el.offsetWidth ? r.width / el.offsetWidth : 1;
      const sy = el instanceof HTMLElement && el.offsetHeight ? r.height / el.offsetHeight : 1;
      const left = r.left + el.clientLeft * sx, top = r.top + el.clientTop * sy;
      bounds = {
        left: x ? left : -Infinity, top: y ? top : -Infinity,
        right: x ? left + el.clientWidth * sx : Infinity, bottom: y ? top + el.clientHeight * sy : Infinity,
      };
    }
    clipCache.set(el, bounds);
    return bounds;
  };
  const insetCache = new Map<Element, Edges | null>();
  const insetBounds = (el: Element, cs: CSSStyleDeclaration): Edges | null => {
    if (insetCache.has(el)) return insetCache.get(el)!;
    const parts = /^inset\(([^()]*)\)$/.exec(cs.clipPath)?.[1].split(/\s+round\s+/, 1)[0].trim().split(/\s+/);
    let bounds = null;
    if (parts && parts.length <= 4 && parts.every((p) => /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|%)$/.test(p))) {
      const [top, right = top, bottom = top, left = right] = parts;
      const r = el.getBoundingClientRect();
      const offset = (value: string, extent: number, layoutExtent: number) => parseFloat(value) * (value.endsWith("%") ? extent / 100 : extent / (layoutExtent || extent || 1));
      const width = el instanceof HTMLElement ? el.offsetWidth : r.width;
      const height = el instanceof HTMLElement ? el.offsetHeight : r.height;
      bounds = {
        left: r.left + offset(left, r.width, width), right: r.right - offset(right, r.width, width),
        top: r.top + offset(top, r.height, height), bottom: r.bottom - offset(bottom, r.height, height),
      };
    }
    insetCache.set(el, bounds);
    return bounds;
  };
  const clipsFor = (el: Element, includeSelf: boolean): Edges[] | null => {
    const clips: Edges[] = [];
    let containingBlock: Element | null | undefined;
    for (let a: Element | null = el; a; a = a.parentElement) {
      const cs = computed(a);
      // Common accessibility-only text is deliberately unpainted.
      if (Number(cs.opacity) === 0 || cs.contentVisibility === "hidden"
        || cs.clip === "rect(0px, 0px, 0px, 0px)") return null;
      const inset = insetBounds(a, cs);
      if (inset) {
        if (inset.left >= inset.right || inset.top >= inset.bottom) return null;
        clips.push(inset);
      }
      if (a === containingBlock) containingBlock = undefined;
      const bounds = a !== document.documentElement && a !== overflowHost && clipBounds(a, cs);
      if ((a !== el || includeSelf) && bounds && containingBlock === undefined) clips.push(bounds);
      // An absolutely positioned descendant escapes overflow clips before its containing block.
      if (a instanceof HTMLElement && (cs.position === "absolute" || cs.position === "fixed")) containingBlock = a.offsetParent;
    }
    return clips;
  };
  const geometry = (text: string, boxes: DOMRect[], clips: Edges[]): CopyGeometry => {
    const fragments: Box[] = [];
    for (const r of boxes) {
      const shown = clips.reduce(intersect, intersect(r, canvasBounds));
      if (shown.right > shown.left && shown.bottom > shown.top) {
        fragments.push({ x: shown.left, y: shown.top, w: shown.right - shown.left, h: shown.bottom - shown.top });
      }
    }
    return { text, fragments, offCanvas: boxes.some((r) => beyond(r, canvasBounds)), clipped: boxes.some((r) => clips.some((b) => beyond(r, b))) };
  };
  const actionStyle = (el: Element, cs: CSSStyleDeclaration) => {
    const semantic = el.matches('button,[role="button"],input[type="button"],input[type="submit"]');
    const labelled = el.hasAttribute("data-cta") || Array.from(el.classList)
      .some((name) => /(?:^|[-_])(?:btn|button|cta)(?:$|[-_])/i.test(name));
    if (!semantic && !el.matches("a[href]") && !labelled && cs.cursor !== "pointer") return null;
    const padded = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].some((value) => parseFloat(value) > 0);
    const bordered = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].every((value) => parseFloat(value) > 0);
    const buttonTreatment = padded && (!transparent(cs.backgroundColor) || cs.backgroundImage !== "none" || bordered);
    return semantic || buttonTreatment ? { buttonTreatment } : null;
  };
  const textBlock = (el: Element) => {
    let block = el;
    while (block.parentElement && /^(inline|contents)/.test(computed(block).display)) block = block.parentElement;
    return block;
  };
  const readCopy = (el: Element, cs: CSSStyleDeclaration) => {
    const nodes = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent);
    const inputLabel = el instanceof HTMLInputElement && el.matches('input[type="button"],input[type="submit"]') ? el.value.trim() : "";
    if (!(nodes.length || inputLabel) || transparent(cs.color)) return;
    const clips = clipsFor(el, true);
    if (!clips) return;
    const size = parseFloat(cs.fontSize), stack = cs.fontFamily;
    const primaryFamily = (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]+)/.exec(stack)?.[0] ?? stack).trim();
    const family = primaryFamily.replace(/^["']|["']$/g, "").replace(/\\(["'\\])/g, "$1");
    const lineHeight = parseFloat(cs.lineHeight);
    const layout: Box[] = [];
    const textParts: string[] = [];
    let clipped = false;
    const remember = (node: Node, text: string, rects: DOMRect[]) => {
      visibleText.push({ node, text, block: textBlock(el), first: rects[0], last: rects[rects.length - 1] });
    };
    const measure = (node: Node, rawText: string, rects: DOMRect[]) => {
      if (!rects.length) return;
      const text = rawText.trim().replace(/\s+/g, " ");
      const sample = cs.textTransform === "uppercase" ? text.toUpperCase()
        : cs.textTransform === "lowercase" ? text.toLowerCase() : text;
      ink.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${stack}`;
      const metrics = ink.measureText(sample);
      const fontHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
      const painted = rects.map((r) => {
        // Ranges include unpainted ascent and descent. Scale the glyph metrics into viewport coordinates.
        if (!fontHeight || cs.writingMode !== "horizontal-tb" || !(el instanceof HTMLElement) || inputLabel) return r;
        const scale = r.height / fontHeight;
        const y = r.top + (metrics.fontBoundingBoxAscent - metrics.actualBoundingBoxAscent) * scale;
        return new DOMRect(r.x, y, r.width, (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) * scale);
      });
      const measured = geometry(text, painted, clips);
      if (canvas.fixedCanvas || measured.fragments.length) copy.push(measured);
      if (!measured.fragments.length) return;
      clipped ||= measured.offCanvas || measured.clipped;
      if (!measured.offCanvas && !measured.clipped && rects.length === measured.fragments.length) {
        remember(node, rawText, rects);
      }
      textParts.push(text);
      for (const r of rects) {
        const h = Number.isFinite(lineHeight) ? Math.min(r.height, Math.max(lineHeight, size)) : r.height;
        layout.push({ x: r.x, y: r.y + (r.height - h) / 2, w: r.width, h });
      }
    };
    for (const node of nodes) {
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      const text = node.textContent!;
      if (text.trim()) measure(node, text, rects);
      else if (rects.length) remember(node, text, rects);
    }
    if (inputLabel) measure(el, inputLabel, [el.getBoundingClientRect()]);
    if (canvas.fixedCanvas && (inputLabel || nodes.some((n) => n.textContent?.trim()))) {
      for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
        if (testedActions.has(a)) break;
        const style = actionStyle(a, computed(a));
        if (!style) continue;
        testedActions.add(a);
        const label = (inputLabel || (a as HTMLElement).innerText || a.textContent || "").trim().replace(/\s+/g, " ");
        const actionClips = clipsFor(a, false);
        if (actionClips) actions.push({ ...geometry(label, [a.getBoundingClientRect()], actionClips), ...style });
        break;
      }
    }
    if (!layout.length) return;
    const x = Math.min(...layout.map((r) => r.x)), y = Math.min(...layout.map((r) => r.y));
    const box = { x, y, w: Math.max(...layout.map((r) => r.x + r.w)) - x, h: Math.max(...layout.map((r) => r.y + r.h)) - y };
    const text = textParts.join(" ");
    const ls = cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing) / size;
    const lh = Number.isFinite(lineHeight) ? lineHeight / size : 1.2;
    const semantic = el.closest("h1,h2,h3,h4,h5,h6,button,[role=button],a,code,pre,p,label,figcaption");
    const tag = semantic?.tagName.toLowerCase();
    const role = el.closest("[data-board-role]")?.getAttribute("data-board-role")?.trim()
      || (tag === "p" ? "body" : tag === "h1" ? "headline" : tag === "a" ? "link" : tag === "pre" ? "code"
        : semantic?.getAttribute("role") === "button" ? "button" : tag) || "other text";
    out.texts.push({ text, role, family, stack, loaded: fontLoaded(primaryFamily, cs.fontWeight, cs.fontStyle, text), size, weight: parseInt(cs.fontWeight, 10), letterSpacingEm: Math.round(ls * 1000) / 1000, lineHeight: Math.round(lh * 100) / 100, transform: cs.textTransform, italic: cs.fontStyle !== "normal", fontStyle: cs.fontStyle, align: cs.textAlign, color: cs.color, box, clipped });
    out.colours.push({ value: cs.color, kind: "text", area: box.w * box.h });
  };
  for (const el of els) {
    const cs = computed(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || parseFloat(cs.opacity) === 0) continue;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "link", "meta", "head", "title", "noscript"].includes(tag)) continue;
    const r = el.getBoundingClientRect();
    const area = inter(r);
    if (area > 0) for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(el, pseudo);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0
        || transparent(style.color) || /^(?:none|normal|""|'')$|^url\(/.test(style.content)) continue;
      if (clipsFor(el, false)) out.generatedCopy = (out.generatedCopy ?? 0) + 1;
    }
    if (canvas.collectDesignStyles) {
      if (el instanceof SVGGeometryElement && cs.stroke !== "none" && parseFloat(cs.strokeWidth) > 0) {
        // Horizontal and vertical SVG rules paint even when their geometry has a zero-area box.
        const halfStroke = parseFloat(cs.strokeWidth) / 2;
        const painted = new DOMRect(r.x - halfStroke, r.y - halfStroke, r.width + halfStroke * 2, r.height + halfStroke * 2);
        if (inter(painted)) recordStyleColours(cs.stroke);
      }
      // SVG stops have no box of their own. Their computed colour supplies painted gradient stops.
      if (tag === "stop") recordStyleColours(cs.stopColor);
      if (area > 0) {
        if (el === document.body && Array.from(el.childNodes).some((node) => node.nodeType === 3 && node.textContent?.trim())) {
          styles.stacks.add(cs.fontFamily);
          styles.sizes.add(parseFloat(cs.fontSize));
          recordStyleColours(cs.color);
        }
        if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) recordStyleColours(cs.outlineColor);
        if (cs.textDecorationLine !== "none") recordStyleColours(cs.textDecorationColor);
        recordStyleColours(cs.textShadow, cs.boxShadow, cs.backgroundImage);
        for (const pseudo of ["::before", "::after"]) {
          const style = getComputedStyle(el, pseudo);
          if (style.content === "none" || style.content === "normal" || style.display === "none" || style.visibility === "hidden") continue;
          recordStyleColours(style.backgroundColor, style.backgroundImage);
          for (const side of ["top", "right", "bottom", "left"]) {
            if (parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0) recordStyleColours(style.getPropertyValue(`border-${side}-color`));
          }
          if (style.content !== '""' && !style.content.startsWith("url(")) {
            styles.stacks.add(style.fontFamily);
            styles.sizes.add(parseFloat(style.fontSize));
            recordStyleColours(style.color);
          }
        }
      }
    }
    if (el === document.documentElement || el === document.body || area === 0) {
      readCopy(el, cs);
      continue;
    }
    if (!transparent(cs.backgroundColor)) out.colours.push({ value: cs.backgroundColor, kind: "bg", area });
    const bgi = cs.backgroundImage;
    if (bgi && bgi !== "none") {
      for (const m of bgi.match(/(rgba?|oklch|oklab|lab|lch|hsla?|color)\([^()]*\)/g) ?? []) if (!transparent(m)) out.colours.push({ value: m, kind: "gradient", area });
      const u = bgi.match(/url\("?([^")]+)"?\)/);
      if (u) out.images.push({ box: { x: r.left, y: r.top, w: r.width, h: r.height }, fit: cs.backgroundSize, filter: cs.filter, radius: parseFloat(cs.borderTopLeftRadius) || 0, src: u[1] });
    }
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      const w = parseFloat((cs as any)[`border${side}Width`]);
      const st = (cs as any)[`border${side}Style`];
      const c = (cs as any)[`border${side}Color`];
      if (w > 0 && st !== "none" && !transparent(c)) out.colours.push({ value: c, kind: "border", area: Math.max(r.width, r.height) * w });
    }
    if (cs.boxShadow && cs.boxShadow !== "none") {
      out.shadows++;
      for (const m of cs.boxShadow.match(/(rgba?|oklch|lab|hsla?)\([^()]*\)/g) ?? []) if (!transparent(m)) out.colours.push({ value: m, kind: "shadow", area: 0 });
    }
    const rad = parseFloat(cs.borderTopLeftRadius) || 0;
    if (rad > 0) out.radii.push({ px: Math.round(rad * 10) / 10, full: rad >= Math.min(r.width, r.height) / 2 - 0.5 });
    if (el instanceof SVGElement && tag !== "svg") {
      if (cs.fill && cs.fill !== "none" && !cs.fill.startsWith("url") && !transparent(cs.fill)) out.colours.push({ value: cs.fill, kind: "fill", area });
      if (cs.stroke && cs.stroke !== "none" && !cs.stroke.startsWith("url") && !transparent(cs.stroke)) out.colours.push({ value: cs.stroke, kind: "stroke", area: 0 });
    }
    if (["img", "video", "canvas", "picture"].includes(tag)) {
      out.images.push({ box: { x: r.left, y: r.top, w: r.width, h: r.height }, fit: cs.objectFit, filter: cs.filter, radius: rad, src: (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || tag });
    }
    readCopy(el, cs);
  }
  visibleText.sort((a, b) =>
    a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
  out.visibleText = visibleText.map((run, i) => {
    const previous = visibleText[i - 1];
    const separate = previous && (previous.block !== run.block
      || previous.last.bottom <= run.first.top || run.first.bottom <= previous.last.top);
    return (separate ? " " : "") + run.text;
  }).join("");
  for (const d of Array.from(document.querySelectorAll("[data-device]"))) {
    const r = d.getBoundingClientRect();
    if (!inter(r)) continue;
    const cols = new Set<string>();
    for (const e of [d, ...Array.from(d.querySelectorAll("*"))]) {
      const cs = getComputedStyle(e);
      for (const c of [cs.backgroundColor, cs.color, cs.fill, cs.stroke, cs.borderTopColor]) if (c && !transparent(c) && !c.startsWith("url") && c !== "none") cols.add(c);
    }
    out.devices.push({ box: { x: r.left, y: r.top, w: r.width, h: r.height }, colours: [...cols], radius: parseFloat(getComputedStyle(d).borderTopLeftRadius) || 0, tag: d.tagName.toLowerCase() });
  }
  for (const l of Array.from(document.querySelectorAll('link[rel~="stylesheet"]'))) {
    const h = (l as HTMLLinkElement).href;
    if (/fonts\.(googleapis|bunny)|fontshare|typekit|fonts\.cdnfonts/.test(h)) out.fontLinks.push(h);
  }
  for (const s of Array.from(document.querySelectorAll("style"))) {
    for (const m of (s.textContent ?? "").matchAll(/@import\s+(?:url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])/g)) {
      const url = new URL(m[1] ?? m[2], document.baseURI);
      if (url.protocol === "https:" || url.protocol === "http:") out.fontLinks.push(url.href);
    }
  }
  const readFontFaces = (sheet: CSSStyleSheet) => {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // Preserve the exact link for cross-origin stylesheets whose CSSOM is unavailable.
      if (sheet.href && /^https?:\/\//i.test(sheet.href)) out.fontLinks.push(sheet.href);
      return;
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSImportRule && rule.styleSheet) readFontFaces(rule.styleSheet);
      if (rule instanceof CSSFontFaceRule) {
        const face = rule.cssText.replace(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/g, (_, quoted, single, plain) => {
          const url = new URL(quoted ?? single ?? plain.trim(), sheet.href ?? document.baseURI);
          return `url(${JSON.stringify(url.href)})`;
        });
        (out.fontFaces ??= []).push(face);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) readFontFaces(sheet);
  if (canvas.collectDesignStyles) out.designStyles = { colours: [...styles.colours], stacks: [...styles.stacks], sizes: [...styles.sizes] };
  return out;
}

const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function parseRgb(css: string): [number, number, number, number] | null {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

/** WCAG 2.x contrast of each text run against the median colour of a 1 px ring drawn 2 px outside its box
 * (2 px keeps the ring clear of the glyphs' anti-aliasing). */
function contrasts(png: PNG, texts: TextRun[]): Array<number | null> {
  return texts.map((t) => {
    const c = parseRgb(t.color);
    if (!c) return null;
    const x0 = Math.floor(t.box.x) - 2, y0 = Math.floor(t.box.y) - 2, x1 = Math.ceil(t.box.x + t.box.w) + 2, y1 = Math.ceil(t.box.y + t.box.h) + 2;
    const ls: number[] = [];
    const at = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
      const i = (y * png.width + x) * 4;
      ls.push(lum(png.data[i], png.data[i + 1], png.data[i + 2]));
    };
    for (let x = x0; x <= x1; x++) { at(x, y0); at(x, y1); }
    for (let y = y0; y <= y1; y++) { at(x0, y); at(x1, y); }
    if (!ls.length) return null;
    ls.sort((a, b) => a - b);
    const bg = ls[Math.floor(ls.length / 2)];
    const fg = lum(c[0], c[1], c[2]);
    const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  });
}

export class MissingChromiumError extends Error {
  constructor(cause: Error) {
    const { version } = createRequire(import.meta.url)("playwright/package.json");
    super(`Playwright Chromium is missing. Run: npx --yes playwright@${version} install chromium`, { cause });
  }
}

export async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Executable doesn't exist at ")) {
      throw new MissingChromiumError(error);
    }
    throw error;
  }
}

export class Renderer {
  private browser?: Browser;
  async open() { this.browser ??= await launchChromium(); return this; }
  async close() { await this.browser?.close(); this.browser = undefined; }

  /** Resolve CSS colour literals using the same serialization as the sample's computed styles. */
  async normalizeColours(values: string[]): Promise<string[]> {
    if (!values.length) return [];
    await this.open();
    const page = await this.browser!.newPage();
    try {
      return await page.evaluate((colours) => colours.map((colour) => {
        const element = document.body;
        element.style.color = "";
        element.style.color = colour;
        return element.style.color ? getComputedStyle(element).color : "";
      }), values);
    } finally {
      await page.close();
    }
  }

  /** Render at the format's size, or capture the full page at the website viewport when no format is specified. */
  async render(htmlPath: string, fmt: BoardFormat | undefined, pngPath = htmlPath.replace(/\.html?$/i, ".png"), collectDesignStyles = false, localAssets?: Set<string>, website?: WebsiteRender, inspect?: (page: Page) => Promise<void>): Promise<Rendered> {
    await this.open();
    const viewport = website?.viewport ?? fmt ?? formatById("hero");
    const { width } = viewport;
    const ctx = await this.browser!.newContext({ viewport: { width, height: viewport.height }, deviceScaleFactor: 1 });
    // tsx/esbuild wraps named functions in __name(); give the page a no-op so readPage can be serialised.
    await ctx.addInitScript("window.__name = (f) => f;");
    const page = await ctx.newPage();
    const source = website?.source ?? pathToFileURL(htmlPath).href;
    if (localAssets) page.on("request", (request) => {
      if (request.url() === source) return;
      const url = new URL(request.url());
      if (url.protocol !== "file:" || url.host) return;
      try {
        localAssets.add(fileURLToPath(url));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_INVALID_FILE_URL_PATH") throw error;
      }
    });
    try {
      const response = await page.goto(source, { waitUntil: website ? "load" : "networkidle", timeout: 60_000 });
      if (website && response && !response.ok()) throw new Error(`${source} returned HTTP ${response.status()}.`);
      if (website) {
        // Allow client-rendered content to settle without requiring polling apps to go idle.
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch((error) => {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
        });
      }
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      if (website?.captureHtml) website.captureHtml(await page.content());
      await inspect?.(page);
      const height = fmt?.height ?? await page.evaluate(() => Math.max(innerHeight, document.scrollingElement!.scrollHeight));
      const drawn = await page.evaluate(readPage, { width, height, collectDesignStyles, website: website !== undefined, fixedCanvas: fmt !== undefined });
      const buf = await page.screenshot({ fullPage: !fmt, clip: { x: 0, y: 0, width, height } });
      writeFileSync(pngPath, buf);
      const png = PNG.sync.read(buf);
      return { ...drawn, png: pngPath, contrast: contrasts(png, drawn.texts) };
    } finally {
      await ctx.close();
    }
  }
}

/** Screenshot a whole page (contact sheets) at a fixed width. */
export async function screenshotFullPage(renderer: Renderer, htmlPath: string, pngPath: string, width: number, options: { verifyImages?: boolean } = {}) {
  await renderer.open();
  const ctx = await (renderer as any).browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle", timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (options.verifyImages) {
      const unreadable = await page.evaluate(async () => {
        const images = Array.from(document.images);
        const decoded = await Promise.allSettled(images.map((image) => image.decode()));
        return images.filter((_, index) => decoded[index].status === "rejected").map((image) => image.src);
      });
      if (unreadable.length) throw new Error(`Could not decode image: ${unreadable.join(", ")}`);
    }
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await ctx.close();
  }
}

export function readHtml(path: string) { return readFileSync(path, "utf8"); }
