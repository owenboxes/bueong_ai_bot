/**
 * 아침 요약 전체 목록을 모바일 친화적 HTML 페이지로 렌더링한다.
 */

function escHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeHttpUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch {
    return null;
  }
  return null;
}

/**
 * 아침 요약 전체 목록 HTML 문자열을 반환한다.
 * @param {Array<{ source?: string, title?: string, url?: string }>} items
 * @param {Array<[number, string]> | null} ranks
 * @param {string} batch
 * @returns {string}
 */
export function renderList(items, ranks, batch) {
  const list = Array.isArray(items) ? items : [];
  const batchShort = String(batch ?? "").slice(0, 8);
  const heading = `부엉 아침 요약 ${batchShort} — 전체 ${list.length}건`;

  const order = list.map((_, i) => i).sort((a, b) => {
    const ta = ranks ? ranks[a][0] : 3;
    const tb = ranks ? ranks[b][0] : 3;
    if (ta !== tb) return ta - tb;
    return String(list[a]?.source ?? "").localeCompare(String(list[b]?.source ?? ""));
  });

  const rowsHtml = order
    .map((i) => {
      const it = list[i] || {};
      const tier = ranks ? ranks[i][0] : null;
      const line = ranks ? ranks[i][1] : "";
      const tierBadge = tier
        ? `<span class="tier t${tier}">${tier}등급</span>`
        : "";
      const source = `<span class="src">${escHtml(it.source ?? "")}</span>`;
      const titleText = escHtml(it.title ?? "");
      const href = safeHttpUrl(it.url);
      const titleHtml = href
        ? `<a href="${escHtml(href)}" target="_blank" rel="noreferrer">${titleText}</a>`
        : `<span class="plain-title">${titleText}</span>`;
      const lineHtml =
        tier && tier <= 2 && line
          ? `<p class="line">${escHtml(line)}</p>`
          : "";
      return `<li class="item">${tierBadge}${source}<div class="title">${titleHtml}</div>${lineHtml}</li>`;
    })
    .join("");

  const emptyHtml =
    list.length === 0 ? '<p class="empty">표시할 항목이 없습니다.</p>' : "";

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escHtml(heading)}</title>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #71717a; --card: #ffffff; --border: #e4e4e7; --link: #1d4ed8; --t1: #dc2626; --t2: #d97706; --t3: #52525b; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #09090b; --fg: #f4f4f5; --muted: #a1a1aa; --card: #18181b; --border: #27272a; --link: #60a5fa; --t1: #f87171; --t2: #fbbf24; --t3: #a1a1aa; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; }
main { max-width: 640px; margin: 0 auto; }
h1 { font-size: 18px; margin: 0 0 14px; }
ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.item { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.tier { display: inline-block; font-size: 12px; font-weight: 600; margin-right: 6px; }
.t1 { color: var(--t1); }
.t2 { color: var(--t2); }
.t3 { color: var(--t3); }
.src { font-size: 12px; color: var(--muted); }
.title { margin-top: 4px; word-break: break-word; }
.title a { color: var(--link); text-decoration: none; }
.title a:hover { text-decoration: underline; }
.line { margin: 6px 0 0; font-size: 13.5px; color: var(--muted); }
.empty { color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${escHtml(heading)}</h1>
${emptyHtml}<ul>${rowsHtml}</ul>
</main>
</body>
</html>`;
}
