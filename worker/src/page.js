/**
 * 아침 요약 전체 목록을 모바일 친화적 HTML 페이지로 렌더링한다.
 */
import { CATEGORIES } from "./gemini.js";

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

function renderItem(it, i, tier, opts) {
  const tierBadge = tier
    ? `<span class="tier t${tier}">${tier}등급</span>`
    : "";
  const source = `<span class="src">${escHtml(it.source ?? "")}</span>`;
  const titleHtml = `<div class="title">${escHtml(it.title ?? "")}</div>`;

  const href = safeHttpUrl(it.url);
  const viewBtn = href
    ? `<a class="btn-link" href="${escHtml(href)}" target="_blank" rel="noreferrer">원문 보기</a>`
    : "";

  let likeHtml = "";
  if (opts && typeof opts.likeAction === "function") {
    if (opts.liked && opts.liked.has(i)) {
      likeHtml = `<span class="like-done" aria-disabled="true">👍 기록됨</span>`;
    } else {
      const action = escHtml(opts.likeAction(i));
      likeHtml = `<form class="like-form" method="post" action="${action}"><button class="btn-like" type="submit">👍</button></form>`;
    }
  }

  const actionsHtml =
    viewBtn || likeHtml ? `<div class="actions">${viewBtn}${likeHtml}</div>` : "";

  return `<li class="item" id="i${i}">${tierBadge}${source}${titleHtml}${actionsHtml}</li>`;
}

/**
 * 아침 요약 전체 목록 HTML 문자열을 반환한다.
 * @param {Array<{ source?: string, title?: string, url?: string }>} items
 * @param {Array<[number, string, string?]> | null} ranks
 * @param {string} batch
 * @param {{ likeAction?: (i: number) => string, liked?: Set<number> }} [opts]
 * @returns {string}
 */
export function renderList(items, ranks, batch, opts) {
  const list = Array.isArray(items) ? items : [];
  const batchShort = String(batch ?? "").slice(0, 8);
  const heading = `부엉 아침 요약 ${batchShort} — 전체 ${list.length}건`;

  const byTierAndSource = (a, b) => {
    const ta = ranks ? ranks[a][0] : 3;
    const tb = ranks ? ranks[b][0] : 3;
    if (ta !== tb) return ta - tb;
    return String(list[a]?.source ?? "").localeCompare(String(list[b]?.source ?? ""));
  };

  let bodyHtml = "";
  if (list.length === 0) {
    bodyHtml = '<p class="empty">표시할 항목이 없습니다.</p><ul></ul>';
  } else if (ranks) {
    const groups = new Map(CATEGORIES.map((c) => [c, []]));
    for (let i = 0; i < list.length; i++) {
      const rawCat = ranks[i]?.[2];
      const cat = CATEGORIES.includes(rawCat) ? rawCat : "기타";
      groups.get(cat).push(i);
    }
    bodyHtml = CATEGORIES.filter((cat) => groups.get(cat).length > 0)
      .map((cat) => {
        const indices = groups.get(cat).sort(byTierAndSource);
        const rows = indices
          .map((i) => renderItem(list[i] || {}, i, ranks[i][0], opts))
          .join("");
        return `<section class="cat-group"><h2 class="cat-title">${escHtml(cat)} <span class="cat-count">(${indices.length})</span></h2><ul>${rows}</ul></section>`;
      })
      .join("");
  } else {
    const order = list.map((_, i) => i).sort(byTierAndSource);
    const rows = order
      .map((i) => renderItem(list[i] || {}, i, null, opts))
      .join("");
    bodyHtml = `<ul>${rows}</ul>`;
  }

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escHtml(heading)}</title>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #71717a; --card: #ffffff; --border: #e4e4e7; --link: #1d4ed8; --btn-bg: #f4f4f5; --btn-hover: #e4e4e7; --t1: #dc2626; --t2: #d97706; --t3: #52525b; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #09090b; --fg: #f4f4f5; --muted: #a1a1aa; --card: #18181b; --border: #27272a; --link: #60a5fa; --btn-bg: #27272a; --btn-hover: #3f3f46; --t1: #f87171; --t2: #fbbf24; --t3: #a1a1aa; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; }
main { max-width: 640px; margin: 0 auto; }
h1 { font-size: 18px; margin: 0 0 16px; }
.cat-group { margin-bottom: 20px; }
.cat-title { font-size: 15px; font-weight: 700; margin: 0 0 10px; }
.cat-count { font-weight: 500; color: var(--muted); }
ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.item { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.tier { display: inline-block; font-size: 12px; font-weight: 600; margin-right: 6px; }
.t1 { color: var(--t1); }
.t2 { color: var(--t2); }
.t3 { color: var(--t3); }
.src { font-size: 12px; color: var(--muted); }
.title { margin-top: 4px; word-break: break-word; font-weight: 500; }
.actions { margin-top: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.btn-link, .btn-like, .like-done { display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 6px 12px; border-radius: 8px; font-size: 13.5px; line-height: 1.2; border: 1px solid var(--border); }
.btn-link { background: var(--btn-bg); color: var(--link); text-decoration: none; font-weight: 500; }
.btn-link:hover { background: var(--btn-hover); }
.like-form { margin: 0; display: inline-flex; }
.btn-like { background: var(--btn-bg); color: var(--fg); cursor: pointer; font: inherit; }
.btn-like:hover { background: var(--btn-hover); }
.like-done { color: var(--muted); background: transparent; opacity: 0.85; }
.empty { color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${escHtml(heading)}</h1>
${bodyHtml}
</main>
</body>
</html>`;
}
