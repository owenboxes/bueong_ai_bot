// 2단계 webhook: 텔레그램 입력(버튼 누름, 내가 보낸 링크)을 받는 즉시 D1에 기록하고 답한다.
// 규칙 원본: src/inbox.py.
// - 👍/👎 → feedback (주간 리포트용)
// - 🌙 아침에 자세히 → pinned에 later로 (다음 아침 요약 고정 구역)
// - 링크를 보내면 → pinned에 link로, 받았다고 답한다 (보낸 주소는 열어보지 않는다)
// 답은 webhook 응답 본문에 Bot API 호출로 담아 돌려준다 (따로 fetch하지 않아 빠르고 외부 요청이 줄어든다).
import { isQuiet } from "./watch.js";

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const MAX_LINKS = 5; // 메시지 하나에서 받을 링크 수 상한
const ANSWERS = { u: "👍 기록했어요", d: "👎 기록했어요", l: "🌙 내일 아침 요약에 넣을게요" };
const GOT_LINK = "🦉 받았어요.\n내일 아침 요약에 정리해둘게요.";
const EXPIRED = "오래된 알림이라 기록하지 못했어요";
const HELP = "🦉 링크를 보내주시면 다음 아침 요약에 정리해둘게요.";

/** 메시지 속 링크. 텔레그램 offset/length는 UTF-16 단위라 JS 문자열 위치와 같다 */
export function urlsIn(msg) {
  const text = msg.text || msg.caption || "";
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  const found = [];
  if (!entities.some((e) => e.type === "url")) { // 엔티티가 없을 때만 직접 찾는다
    found.push(...(text.match(URL_RE) || []).map((u) => u.replace(/[).,\]]+$/, "")));
  }
  for (const e of entities) {
    if (e.type === "url") found.push(text.slice(e.offset, e.offset + e.length)); // 원문 그대로 (끝 괄호 보존)
    else if (e.type === "text_link" && e.url) found.push(e.url); // 글자에 숨겨진 링크
  }
  return [...new Set(found)].slice(0, MAX_LINKS);
}

/** 내 개인 채팅에서 나 자신이 보낸 것만 (그룹에선 chat id만으로 보낸 사람을 보장 못 한다) */
const mine = (chat, from, chatId) => chat?.type === "private" && String(chat.id) === chatId && String(from?.id) === chatId;

/** update 하나를 처리하고, 돌려줄 Bot API 호출({method, ...}) 또는 null.
 * 기록은 모두 INSERT OR IGNORE라 같은 update가 다시 와도(텔레그램 재전송) 두 번 쌓이지 않는다.
 * D1이 실패하면 예외 → 500 → 텔레그램이 다시 보낸다 (입력 누락 방지) */
export async function handleUpdate(update, env, now = new Date()) {
  const db = env.DB, at = now.toISOString(), chatId = env.TG_CHAT_ID;
  const feedback = (key, action, source) => db.prepare("INSERT OR IGNORE INTO feedback (update_id, key, action, source, at) VALUES (?, ?, ?, ?, ?)")
    .bind(update.update_id, key, action, source, at);
  const pin = (kind, source, title, url) => db.prepare("INSERT OR IGNORE INTO pinned (kind, url, title, source, at) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM feedback WHERE update_id = ?)")
    .bind(kind, url, title, source, at, update.update_id);

  const cq = update.callback_query;
  if (cq) {
    if (!mine(cq.message?.chat, cq.from, chatId)) return null; // 신뢰 경계: 다른 사람이 누른 버튼
    const [action, key] = (cq.data || "").split(":");
    if (!Object.hasOwn(ANSWERS, action) || !key) return null;
    const info = await db.prepare("SELECT source, title, url FROM alerts WHERE key = ?").bind(key).first();
    if (!info) return { method: "answerCallbackQuery", callback_query_id: cq.id, text: EXPIRED }; // 오래돼 지워졌거나 모르는 알림
    await db.batch([...(action === "l" ? [pin("later", info.source, info.title, info.url)] : []), feedback(key, action, info.source)]);
    return { method: "answerCallbackQuery", callback_query_id: cq.id, text: ANSWERS[action] };
  }
  const msg = update.message;
  if (!msg || !mine(msg.chat, msg.from, chatId)) return null; // 신뢰 경계: 다른 사람이 보낸 메시지
  const links = urlsIn(msg);
  // 핀을 먼저 쓰고 처리 표식을 같은 트랜잭션에서 마지막에 남긴다.
  const results = await db.batch([...links.map((u) => pin("link", "보낸 링크", u, u)), feedback(null, links.length ? "link" : "msg", null)]);
  if (!results.at(-1).meta.changes) return null;
  return { method: "sendMessage", chat_id: chatId, text: links.length ? GOT_LINK : HELP, disable_notification: isQuiet(now) };
}

export async function handleTelegram(request, env) {
  // 신뢰 경계: 텔레그램이 setWebhook 때 받은 secret_token을 헤더로 돌려준다. 없거나 다르면 가짜 요청
  if (!env.TG_SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== env.TG_SECRET) {
    return new Response("forbidden", { status: 403 }); // 비밀 값이 설정되지 않았으면 무엇도 통과시키지 않는다
  }
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!Number.isSafeInteger(update?.update_id)) return new Response("bad request", { status: 400 });
  const call = await handleUpdate(update, env); // D1 실패는 그대로 던져 500
  return call ? Response.json(call) : new Response("ok"); // 남의 입력에도 200: 같은 요청을 계속 다시 보내지 않게
}
