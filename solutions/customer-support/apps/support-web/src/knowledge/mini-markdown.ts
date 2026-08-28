/**
 * Minimal, dependency-free markdown renderer for Wiki reading.
 *
 * Safety: the input is fully HTML-escaped BEFORE any markdown processing,
 * so raw HTML in the source can never execute. Links are rebuilt from
 * escaped content with `rel="noopener"`.
 *
 * Supports a deliberately small surface: headings, paragraphs, bullet
 * lists, bold, inline code, block code, links and horizontal rules.
 * Anything else renders as plain escaped text.
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
    );
}

export function renderMiniMarkdown(source: string): string {
  const lines = escapeHtml(source).split(/\r?\n/);
  const html: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      closeList();
      const level = line.match(/^#+/)?.[0].length ?? 1;
      const text = line.replace(/^#+\s*/, "");
      html.push(`<h${Math.min(level, 4)}>${inline(text)}</h${Math.min(level, 4)}>`);
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inline(line.replace(/^[-*]\s*/, ""))}</li>`);
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      closeList();
      html.push(`<p>${inline(line.replace(/^\d+\.\s*/, ""))}</p>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      closeList();
      html.push("<hr />");
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) {
    html.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
  }
  closeList();
  return html.join("\n");
}

