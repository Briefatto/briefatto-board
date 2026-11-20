/** Escape text before inserting it into the generated sheet. */
export const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text: string): string {
  // Tokenize code before applying emphasis so exact font declarations remain readable.
  const tokens = /(`+)(.+?)\1|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(\*\*|__)(.+?)\5|(\*|_)(\S(?:.*?\S)?)\7/g;
  let html = "";
  let cursor = 0;
  for (const token of text.matchAll(tokens)) {
    const [match, code, literal, label, url, strong, bold, , emphasis] = token;
    html += escapeHtml(text.slice(cursor, token.index));
    if (code) html += `<code>${escapeHtml(literal)}</code>`;
    else if (label) html += `<a href="${escapeHtml(url)}">${inline(label)}</a>`;
    else if (strong) html += `<strong>${inline(bold)}</strong>`;
    else html += `<em>${inline(emphasis)}</em>`;
    cursor = token.index + match.length;
  }
  return html + escapeHtml(text.slice(cursor));
}

const heading = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const listItem = /^\s*([-+*]|\d+[.)])\s+(.+)$/;
const fence = /^\s*(`{3,}|~{3,})/;
const rule = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;

/** The headings, prose, lists, quotations and code used in direction notes. Raw HTML stays inert. */
export function directionNotesHtml(markdown: string): string {
  const lines = markdown.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (lines[0].match(heading)?.[1] === "#") lines.shift();
  const html: string[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i++];
    if (!line.trim()) continue;
    const title = line.match(heading);
    const marker = line.match(fence)?.[1];
    const item = line.match(listItem);
    if (title) {
      const level = Math.max(2, title[1].length);
      html.push(`<h${level}>${inline(title[2])}</h${level}>`);
    } else if (marker) {
      const literal: string[] = [];
      while (i < lines.length) {
        const next = lines[i++];
        if (next.trim().startsWith(marker) && next.trim().split("").every((c) => c === marker[0])) break;
        literal.push(next);
      }
      html.push(`<pre><code>${escapeHtml(literal.join("\n"))}</code></pre>`);
    } else if (rule.test(line)) {
      html.push("<hr>");
    } else if (item) {
      const ordered = /^\d/.test(item[1]);
      const tag = ordered ? "ol" : "ul";
      const items = [item[2]];
      while (i < lines.length) {
        const next = lines[i].match(listItem);
        if (!next || rule.test(lines[i]) || /^\d/.test(next[1]) !== ordered) break;
        items.push(next[2]);
        i++;
      }
      const start = ordered ? ` start="${Number.parseInt(item[1], 10)}"` : "";
      html.push(`<${tag}${start}>${items.map((text) => `<li>${inline(text)}</li>`).join("")}</${tag}>`);
    } else if (/^>\s?/.test(line)) {
      const quote = [line.replace(/^>\s?/, "")];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      html.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
    } else {
      const paragraph = [line];
      while (i < lines.length && lines[i].trim() && !heading.test(lines[i]) && !fence.test(lines[i]) && !rule.test(lines[i]) && !listItem.test(lines[i]) && !/^>/.test(lines[i])) {
        paragraph.push(lines[i++]);
      }
      html.push(`<p>${inline(paragraph.join(" "))}</p>`);
    }
  }
  return html.join("\n");
}
