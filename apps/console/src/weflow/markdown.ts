/**
 * Minimal, dependency-free markdown renderer for Wiki reading and help docs.
 *
 * Safety: the input is fully HTML-escaped BEFORE any markdown processing,
 * so raw HTML in the source can never execute. Links are rebuilt from
 * escaped content with `rel="noopener"`.
 *
 * Supports a deliberately small surface: headings, paragraphs, bullet and
 * ordered lists, task lists, blockquotes, tables, bold, inline code, block
 * code, links and horizontal rules. Anything else renders as plain escaped
 * text.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    .replace(
      /\[([^\]]+)\]\((#[\w-]+)\)/g,
      '<a href="$2">$1</a>',
    )
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string | undefined): boolean {
  if (!line) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderTable(lines: string[], start: number): { html: string; next: number } {
  const header = splitTableRow(lines[start]);
  const rows: string[][] = [];
  let cursor = start + 2;
  while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
    rows.push(splitTableRow(lines[cursor]));
    cursor++;
  }
  const renderCells = (cells: string[], tag: "th" | "td") =>
    cells
      .map((cell) => `<${tag}>${inline(cell)}</${tag}>`)
      .join("");
  const thead = `<thead><tr>${renderCells(header, "th")}</tr></thead>`;
  const tbody = rows.length
    ? `<tbody>${rows
        .map((row) => `<tr>${renderCells(row, "td")}</tr>`)
        .join("")}</tbody>`
    : "";
  return { html: `<table>${thead}${tbody}</table>`, next: cursor };
}

function renderBlockquote(lines: string[], start: number): { html: string; next: number } {
  const quoted: string[] = [];
  let cursor = start;
  while (cursor < lines.length && lines[cursor].trim().startsWith(">")) {
    const content = lines[cursor].trim().replace(/^>\s?/, "");
    quoted.push(content);
    cursor++;
  }
  const body = quoted
    .map((line) => (line.trim() ? inline(line) : "<br>"))
    .join("\n");
  return { html: `<blockquote>${body}</blockquote>`, next: cursor };
}

function renderList(lines: string[], start: number): { html: string; next: number } {
  const ordered = /^\d+\.\s/.test(lines[start]);
  const items: string[] = [];
  let cursor = start;
  while (cursor < lines.length) {
    const line = lines[cursor].trim();
    if (ordered) {
      if (!/^\d+\.\s/.test(line)) break;
      items.push(`<li>${inline(line.replace(/^\d+\.\s*/, ""))}</li>`);
    } else {
      if (!/^[-*]\s/.test(line)) break;
      const checkbox = line.match(/^[-*]\s+\[( |x|X)\]\s+/);
      if (checkbox) {
        const checked = checkbox[1] !== " ";
        const content = line.replace(/^[-*]\s+\[( |x|X)\]\s+/, "");
        items.push(
          `<li><input type="checkbox" disabled${checked ? " checked" : ""} /> ${inline(content)}</li>`,
        );
      } else {
        items.push(`<li>${inline(line.replace(/^[-*]\s*/, ""))}</li>`);
      }
    }
    cursor++;
  }
  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}>${items.join("")}</${tag}>`, next: cursor };
}

export function renderMiniMarkdown(source: string): string {
  const lines = escapeHtml(source).split(/\r?\n/);
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();

    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimEnd().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      html.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
      continue;
    }

    if (line.startsWith("|") && isTableSeparator(lines[i + 1]?.trimEnd())) {
      const table = renderTable(lines, i);
      html.push(table.html);
      i = table.next;
      continue;
    }

    if (line.startsWith(">")) {
      const quote = renderBlockquote(lines, i);
      html.push(quote.html);
      i = quote.next;
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)?.[0].length ?? 1;
      const text = line.replace(/^#+\s*/, "");
      html.push(`<h${Math.min(level, 6)}>${inline(text)}</h${Math.min(level, 6)}>`);
      i++;
      continue;
    }

    if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) {
      const list = renderList(lines, i);
      html.push(list.html);
      i = list.next;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      html.push("<hr />");
      i++;
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    html.push(`<p>${inline(line)}</p>`);
    i++;
  }

  return html.join("\n");
}
