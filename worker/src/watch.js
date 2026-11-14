// 감시: 이번 분 차례의 출처 1개를 읽어 새 글을 즉시 알림(텔레그램) 또는 아침 요약 대기열(queue)로 보낸다.
// 규칙 원본: src/watch.py. 첫 실행은 기록만, 보내기 실패한 글은 미기록 후 재시도, 상태는 보내기 직후 기록.
import { readHead, stripHtml, MAX_BYTES } from "./feed.js";
import { pick, parse, filterTitles } from "./sources.js";
import { summarize } from "./gemini.js";
import { tg } from "./telegram.js";

const UA = "Mozilla/5.0 (compatible; bueong-bot/0.1)";
const MAX_SEND = 3; // 한 번에 보내기를 시도할 즉시 알림 수 (Gemini 호출도 그만큼)
const FEED_TIMEOUT_MS = 10_000;
const RETRY_AFTER_MS = 60 * 60 * 1000; // 실패한 글은 1시간 뒤에 다시 시도
const ALERT_DAYS = 35; // 버튼 응답·주간 리포트에 충분
const D1_MAX_PARAMS = 100; // D1은 쿼리 하나에 바인딩 값 100개까지

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function get(url, max) {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  return readHead(res, max);
}

export const isQuiet = (now) => {
  const h = (now.getUTCHours() + 9) % 24; // KST
  return h >= 23 || h < 8; // 23:00~08:00 KST는 무음 전송
};

/** 출처+글 id로 짧은 키 (버튼 데이터 64바이트 한도). GitHub 버전 alert_key와 같은 값 */
export async function alertKey(source, id) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${source}\n${id}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

export function formatInstant(srcName, item, lines = []) {
  const title = item.title.length <= 300 ? item.title : item.title.slice(0, 300) + "…"; // 텔레그램 4,096자 보호
  const summary = lines.map((l) => esc(l) + "\n").join("");
  return `🦉 방금 포착했어요\n[${esc(srcName)}]\n<b>${esc(title)}</b>\n\n` + (summary ? summary + "\n" : "")
    + `<a href="${esc(item.url)}">🔗 원문 보기</a>`;
}

const buttons = (key) => ({ inline_keyboard: [[
  { text: "👍 유용해요", callback_data: `u:${key}` },
  { text: "👎 별로예요", callback_data: `d:${key}` },
  { text: "🌙 아침에 자세히", callback_data: `l:${key}` },
]] });

/** 제목 없는 글(Anthropic): 글 페이지 앞부분의 og:title, 없으면 주소 끝 단어 */
async function fillTitle(item) {
  try {
    const { text } = await get(item.url, MAX_BYTES);
    const t = text.match(/<meta property="og:title" content="([^"]*)"/) || text.match(/<title>([^<]*)/);
    item.title = t ? stripHtml(t[1]) : "";
    const d = text.match(/<meta (?:name="description"|property="og:description") content="([^"]*)"/);
    item.summary = d ? d[1] : "";
  } catch (e) {
    console.log(JSON.stringify({ event: "title_failed", error: e.message }));
  }
  if (!item.title) item.title = decodeURIComponent(item.url.replace(/\/$/, "").split("/").pop()).replace(/-/g, " ");
}

async function knownIds(db, source, ids) {
  const known = new Set();
  const step = D1_MAX_PARAMS - 1; // source 자리 하나
  for (let i = 0; i < ids.length; i += step) {
    const part = ids.slice(i, i + step);
    const { results } = await db.prepare(`SELECT id FROM seen WHERE source = ? AND id IN (${part.map(() => "?").join(",")})`)
      .bind(source, ...part).all();
    for (const r of results) known.add(r.id);
  }
  return known;
}

export async function watch(env, now = new Date(), persona = "") {
  const src = pick(now);
  const db = env.DB, at = now.toISOString(), name = src.name;
  let read, items;
  try {
    const max = src.max || MAX_BYTES;
    const isJson = src.type === "hn" || src.type === "github";
    read = await get(typeof src.url === "function" ? src.url(now) : src.url, max + (isJson ? 1 : 0));
    if (isJson && read.bytes > max) throw new Error("JSON 응답이 상한보다 큼");
    items = parse(src, read.text, { unfiltered: true });
  } catch (e) { // 한 출처가 막혀도 다음 분에는 다른 출처를 읽는다. 연속 실패 수는 주간 리포트가 본다
    await db.prepare(`INSERT INTO health (source, fails, last_error, at) VALUES (?, 1, ?, ?)
      ON CONFLICT(source) DO UPDATE SET fails = fails + 1, last_error = excluded.last_error, at = excluded.at`)
      .bind(name, e.message.slice(0, 200), at).run();
    console.log(JSON.stringify({ event: "read_failed", source: name, error: e.message }));
    return;
  }

  items = [...new Map(items.map((i) => [i.id, i])).values()]; // 같은 피드에 같은 글이 두 번 나와도 한 번만
  // shortcut: seen은 지우지 않는다 (출처당 하루 수 건이라 D1 5GB에 수십 년), 커지면 오래된 행 정리를 넣는다
  const first = !(await db.prepare("SELECT 1 FROM seen WHERE source = ? LIMIT 1").bind(name).first());
  if (!first) items = filterTitles(src, items);
  const known = await knownIds(db, name, items.map((i) => i.id));
  const waiting = new Set((await db.prepare("SELECT id FROM retry WHERE source = ? AND next_at > ?")
    .bind(name, at).all()).results.map((r) => r.id));
  const fresh = items.filter((i) => !known.has(i.id) && !waiting.has(i.id)); // 재시도 대기 중인 글은 이번엔 건너뛴다

  const record = (it) => db.prepare("INSERT OR IGNORE INTO seen (source, id, at) VALUES (?, ?, ?)").bind(name, it.id, at);
  const unretry = (it) => db.prepare("DELETE FROM retry WHERE source = ? AND id = ?").bind(name, it.id);
  const done = [db.prepare("DELETE FROM health WHERE source = ?").bind(name)];
  let sent = 0, failed = 0;

  if (first) done.push(...fresh.map(record)); // 처음 본 출처: 보내지 않고 기록만 (첫 실행 폭탄 방지)
  else if (src.mode === "digest") { // 대기열과 seen을 한 batch로: 둘 중 하나만 남는 일이 없다
    for (const it of fresh) {
      done.push(record(it), unretry(it), db.prepare("INSERT OR IGNORE INTO queue (source, id, title, url, at) VALUES (?, ?, ?, ?, ?)")
        .bind(name, it.id, it.title, it.url, at));
    }
    sent = fresh.length;
  } else {
    // 시도 기준 상한: 실패도 한 번으로 센다. 한도를 넘은 새 글과 실패한 글은 기록하지 않아 다음 차례에 다시 시도한다
    for (const it of fresh.slice(0, MAX_SEND)) {
      try {
        if (!it.title) await fillTitle(it);
        const lines = await summarize(env, name, { ...it, summary: stripHtml(it.summary) }, persona);
        const key = await alertKey(name, it.id);
        await tg(env, "sendMessage", {
          chat_id: env.TG_CHAT_ID, parse_mode: "HTML", disable_web_page_preview: true,
          disable_notification: isQuiet(now), reply_markup: buttons(key), text: formatInstant(name, it, lines),
        });
        await db.batch([ // 보낸 직후 기록: 다음 차례에 다시 보내지 않게
          record(it), unretry(it),
          db.prepare("INSERT OR REPLACE INTO alerts (key, source, title, url, at) VALUES (?, ?, ?, ?, ?)").bind(key, name, it.title, it.url, at),
        ]);
        sent++;
      } catch (e) { // 한 건이 실패해도 다음 글과 측정 기록은 계속한다
        failed++;
        console.log(JSON.stringify({ event: "send_failed", source: name, error: e.message }));
        await db.prepare("INSERT OR REPLACE INTO retry (source, id, next_at) VALUES (?, ?, ?)")
          .bind(name, it.id, new Date(now.getTime() + RETRY_AFTER_MS).toISOString()).run();
      }
    }
    const cutoff = new Date(now.getTime() - ALERT_DAYS * 86400_000).toISOString();
    done.push(db.prepare("DELETE FROM alerts WHERE at < ?").bind(cutoff), db.prepare("DELETE FROM feedback WHERE at < ?").bind(cutoff));
  }
  done.push(db.prepare("INSERT INTO runs (at, source, received, bytes, items, new_items, failed) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(at, name, read.received, read.bytes, items.length, sent, failed));
  await db.batch(done);
  console.log(JSON.stringify({ event: "watch", source: name, received: read.received, bytes: read.bytes, items: items.length, sent, failed, first }));
}
