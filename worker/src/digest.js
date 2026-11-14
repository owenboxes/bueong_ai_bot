// 3단계 아침 요약. 규칙 원본: src/digest.py.
// - prepare (cron 0 23 * * *, 08:00 KST): 대기열을 Gemini로 정렬해 보낼 메시지(outbox)와 전체 목록 페이지(digests)를 확정하고 대기열·고정 구역을 비운다
// - sendOutbox (매분 cron): outbox를 이어 보낸다. 성공한 조각까지 진행도를 저장해 실패해도 다음 분에 이어 보낸다
// 전체 목록은 공개 저장소 대신 D1에 두고 Worker 주소 /digest/<무작위 32자>로 보여준다 (비밀 링크)
import { rank } from "./gemini.js";
import { renderList, safeHttpUrl } from "./page.js";
import { tg } from "./telegram.js";

const TG_LIMIT = 4000; // 텔레그램 한도 4,096자보다 조금 여유
const TITLE_MAX = 100, URL_MAX = 500; // 블록 하나가 TG_LIMIT를 넘지 않게 하는 상한 (요약 줄은 gemini.js가 200자로 자른다)
const MAX_TRIES = 5; // 같은 조각이 5분 연속 실패하면 건너뛴다 (형식 오류 하나가 나머지를 영영 막지 않게)
const KEEP_DAYS = 35; // 전체 목록 페이지 보관 기간
const PINNED = [["link", "📌 보내준 링크"], ["later", "🌙 자세히 보기로 한 글"]]; // 정렬 없이 항상 보여주는 구역

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");

function link(it, line = "") {
  const title = esc(it.title.slice(0, TITLE_MAX));
  const href = safeHttpUrl(it.url);
  const url = href ? escAttr(href) : "";
  const a = url && url.length <= URL_MAX ? `<a href="${url}">${title}</a>` : title; // 이스케이프 후에도 긴 주소는 링크 없이
  return `[${esc(it.source.slice(0, 40))}] ${a}` + (line ? ` – ${esc(line)}` : "");
}

function pinnedBlocks(pinned) {
  const blocks = [];
  for (const [kind, name] of PINNED) {
    const picked = pinned.filter((it) => it.kind === kind);
    if (picked.length) blocks.push(`\n━ ${name} (${picked.length})`, ...picked.map((it, n) => `${n + 1}. ${link(it, it.line?.slice(0, 200))}`));
  }
  return blocks;
}

const listLink = (url) => (url ? `<a href="${url}">→ 전체 목록 보기</a>` : "(전체 목록 주소가 설정되지 않았어요)");

/** 텔레그램으로 보낼 메시지 블록 목록 (각 블록은 한 덩어리로 유지). items는 정렬 대상, pinned는 고정 구역 */
export function build(items, ranks, listUrl, pinned = []) {
  if (!items.length && !pinned.length) return ["🦉 좋은 아침이에요.\n밤사이 새로 들어온 글은 없었어요. 오늘도 잘 다녀와요."];
  if (!items.length) return ["🦉 좋은 아침이에요.\n밤사이 새 글은 없었어요.", ...pinnedBlocks(pinned), "\n오늘도 잘 다녀와요."];
  const blocks = [`🦉 좋은 아침이에요.\n밤사이 ${items.length}건이 들어왔어요. 중요한 것부터 볼게요.`];
  if (!ranks) { // 정렬 없이: 출처별 건수 + 전체 목록
    const counts = new Map();
    for (const it of items) counts.set(it.source, (counts.get(it.source) || 0) + 1);
    blocks.push("오늘은 중요도 정렬을 못 했어요. 출처별로 모아뒀어요.", ...[...counts].map(([s, n]) => `• ${esc(s.slice(0, 40))} ${n}건`), listLink(listUrl));
    return [...blocks, ...pinnedBlocks(pinned)];
  }
  for (const [tier, name] of [[1, "꼭 볼 것"], [2, "알아두면 좋은 것"]]) {
    const picked = items.map((it, i) => [it, ranks[i]]).filter(([, r]) => r[0] === tier);
    if (picked.length) blocks.push(`\n━ ${name} (${picked.length})`, ...picked.map(([it, r], n) => `${n + 1}. ${link(it, r[1])}`));
  }
  blocks.push(`\n━ 나머지 (${ranks.filter((r) => r[0] === 3).length}) ${listLink(listUrl)}`);
  return [...blocks, ...pinnedBlocks(pinned), "\n위에 있는 것만 봐도 충분해요. 오늘도 잘 다녀와요."];
}

/** 블록을 자르지 않고 limit 이하 메시지들로 묶는다 (HTML 태그가 잘리지 않게) */
export function split(blocks, limit = TG_LIMIT) {
  const msgs = [];
  let cur = "";
  for (const b of blocks) {
    if (b.length > limit) throw new Error("블록 길이 상한(TITLE/LINE/URL_MAX)이 지켜지지 않음");
    if (cur && cur.length + 1 + b.length > limit) {
      msgs.push(cur);
      cur = b;
    } else cur = cur ? `${cur}\n${b}` : b;
  }
  return cur ? [...msgs, cur] : msgs;
}

export async function prepare(env, now, persona = "", priorities = "") {
  const db = env.DB, at = now.toISOString();
  if (await db.prepare("SELECT 1 FROM outbox LIMIT 1").first()) { // 어제 다 못 보낸 요약부터 마저 보낸다 (새 대기열은 내일로)
    console.log(JSON.stringify({ event: "digest_skipped", reason: "outbox_pending" }));
    return;
  }
  // 이 시각 이전에 들어온 것만: 정렬하는 동안(최대 60초) 새로 쌓인 글·핀은 지우지 않고 내일로 넘긴다
  const items = (await db.prepare("SELECT rowid, source, title, url FROM queue WHERE at < ? ORDER BY at").bind(at).all()).results;
  const pinned = (await db.prepare("SELECT rowid, kind, source, title, url, line FROM pinned WHERE at < ? ORDER BY at").bind(at).all()).results;
  const ranks = await rank(env, items, persona, priorities);
  const batch = crypto.randomUUID().replace(/-/g, ""); // 추측할 수 없는 주소 (전체 목록 비밀 링크)
  const msgs = split(build(items, ranks, env.BASE_URL && `${env.BASE_URL}/digest/${batch}`, pinned));
  await db.batch([ // 한 트랜잭션: 발송분이 생기면 대기열이 비고, 실패하면 아무것도 바뀌지 않는다
    db.prepare("INSERT INTO outbox (batch, messages, sent, tries, at) VALUES (?, ?, 0, 0, ?)").bind(batch, JSON.stringify(msgs), at),
    ...(items.length ? [db.prepare("INSERT INTO digests (batch, html, at) VALUES (?, ?, ?)").bind(batch, renderList(items, ranks, batch), at)] : []),
    db.prepare("DELETE FROM queue WHERE at < ? AND rowid IN (SELECT value FROM json_each(?))").bind(at, JSON.stringify(items.map((it) => it.rowid))),
    db.prepare("DELETE FROM pinned WHERE at < ? AND rowid IN (SELECT value FROM json_each(?))").bind(at, JSON.stringify(pinned.map((it) => it.rowid))),
    db.prepare("DELETE FROM digests WHERE at < ?").bind(new Date(now.getTime() - KEEP_DAYS * 86400_000).toISOString()),
  ]);
  console.log(JSON.stringify({ event: "digest_prepared", items: items.length, pinned: pinned.length, ranked: !!ranks, messages: msgs.length }));
}

// shortcut: 텔레그램이 조각마다 10초씩 멈추면 다음 분 실행과 겹쳐 한 조각이 두 번 갈 수 있다, 생기면 잠금 행을 둔다
export async function sendOutbox(env) {
  const db = env.DB;
  const box = await db.prepare("SELECT batch, messages, sent, tries FROM outbox ORDER BY at LIMIT 1").first();
  if (!box) return;
  const msgs = JSON.parse(box.messages);
  let { sent, tries } = box;
  while (sent < msgs.length) {
    try {
      const m = typeof msgs[sent] === "string" ? { text: msgs[sent] } : msgs[sent]; // 주간 리포트 조각은 {text, reply_markup}
      await tg(env, "sendMessage", { chat_id: env.TG_CHAT_ID, ...m, parse_mode: "HTML", disable_web_page_preview: true });
      sent++;
      tries = 0;
    } catch (e) {
      tries++;
      console.log(JSON.stringify({ event: "digest_send_failed", part: sent, tries, error: e.message }));
      if (tries >= MAX_TRIES) { sent++; tries = 0; } // 이 조각은 포기하고 다음 분에 다음 조각부터
      break;
    } finally { // 조각마다 진행도 저장: 중간에 끊겨도 보낸 조각을 다시 보내지 않게
      await db.prepare("UPDATE outbox SET sent = ?, tries = ? WHERE batch = ?").bind(sent, tries, box.batch).run();
    }
  }
  if (sent >= msgs.length) await db.prepare("DELETE FROM outbox WHERE batch = ?").bind(box.batch).run();
}

/** GET /digest/<batch>: 전체 목록 페이지. 없는 주소는 404 */
export async function digestPage(env, batch) {
  const row = /^[0-9a-f]{32}$/.test(batch) && await env.DB.prepare("SELECT html FROM digests WHERE batch = ?").bind(batch).first();
  if (!row) return new Response("not found", { status: 404 });
  return new Response(row.html, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store",
    "x-robots-tag": "noindex", "referrer-policy": "no-referrer", // 비밀 링크가 검색·다른 사이트로 새지 않게
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  } });
}
