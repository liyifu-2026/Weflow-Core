/**
 * 搜索结果高亮：把 excerpt 按查询词切分为命中/未命中片段。
 * CJK 查询整词匹配；多词查询按空白拆分逐词匹配。
 */
export type HighlightSegment = { text: string; hit: boolean };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function splitHighlight(
  text: string,
  query: string,
): HighlightSegment[] {
  const terms = Array.from(
    new Set(
      query
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length > 0),
    ),
  );
  if (!text || !terms.length) return [{ text, hit: false }];
  const pattern = new RegExp(
    `(${terms.map(escapeRegExp).join("|")})`,
    "gi",
  );
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index), hit: false });
    }
    segments.push({ text: match[0], hit: true });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), hit: false });
  }
  return segments.length ? segments : [{ text, hit: false }];
}
