import { readFileSync } from "node:fs";

/** Read explicitly marked client quotes without interpreting their wording. */
export function readConstraints(path: string): string[] {
  return readConstraintSources(path).map(({ value }) => value);
}

export function readConstraintSources(path: string): Array<{ value: string; line: number }> {
  let notes: string;
  try {
    const bytes = readFileSync(path);
    const utf16le = bytes[0] === 0xff && bytes[1] === 0xfe;
    const utf16be = bytes[0] === 0xfe && bytes[1] === 0xff;
    const encoding = utf16le ? "utf-16le" : utf16be ? "utf-16be" : "utf-8";
    notes = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const quotes: Array<{ value: string; line: number }> = [];
  let open: { marker: string; constraint: boolean; start: number } | undefined;
  for (const fence of notes.matchAll(/(?:^|(?<=\n))(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/g)) {
    const [, marker, info] = fence;
    if (!open) {
      open = { marker, constraint: info.trim() === "constraint", start: fence.index + fence[0].length };
      continue;
    }
    if (!marker.startsWith(open.marker) || info.trim()) continue;
    if (open.constraint) {
      const quote = notes.slice(open.start, fence.index).replace(/\r?\n$/, "");
      if (quote.trim()) quotes.push({ value: quote, line: notes.slice(0, open.start).split("\n").length });
    }
    open = undefined;
  }
  if (open?.constraint) throw new Error(`Unclosed constraint quote in ${path}.`);
  return quotes;
}

export function quotedConstraints(constraints: string[] | undefined): string[] {
  return (constraints ?? []).flatMap((quote) => ["", ...quote.split(/\r?\n/).map((line) => `> ${line}`)]);
}
