import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleUpdate, handleTelegram, urlsIn } from "../src/inbox.js";
import { fakeD1 } from "./d1.js";

const ME = { id: 1, type: "private" };
const NOON = new Date(Date.UTC(2026, 10, 14, 3)); // 12시 KST
let env;
const rows = (sql) => env.DB.raw.prepare(sql).all().map((r) => ({ ...r }));
const press = (data, id = 10, from = { id: 1 }, chat = ME) => ({ update_id: id, callback_query: { id: "cq", data, from, message: { chat } } });
const say = (text, id = 20, extra = {}) => ({ update_id: id, message: { chat: ME, from: { id: 1 }, text, ...extra } });

beforeEach(() => {
  env = { DB: fakeD1(), TG_CHAT_ID: "1", TG_SECRET: "s" };
  env.DB.raw.prepare("INSERT INTO alerts VALUES ('k1', 'OpenAI 공식 블로그', '글', 'https://x/1', '2026-11-14T00:00:00Z')").run();
});

test("👍·🌙 버튼: 기록하고 바로 답한다, 🌙은 고정 구역에", async () => {
  assert.deepEqual(await handleUpdate(press("u:k1"), env, NOON), { method: "answerCallbackQuery", callback_query_id: "cq", text: "👍 기록했어요" });
  await handleUpdate(press("l:k1", 11), env, NOON);
  assert.deepEqual(rows("SELECT update_id, key, action, source FROM feedback"), [
    { update_id: 10, key: "k1", action: "u", source: "OpenAI 공식 블로그" },
    { update_id: 11, key: "k1", action: "l", source: "OpenAI 공식 블로그" },
  ]);
  assert.deepEqual(rows("SELECT kind, url, title FROM pinned"), [{ kind: "later", url: "https://x/1", title: "글" }]);
});

test("같은 update가 다시 와도 한 번만 기록한다 (텔레그램 재전송)", async () => {
  await handleUpdate(press("l:k1"), env, NOON);
  await handleUpdate(press("l:k1"), env, NOON);
  assert.equal(rows("SELECT * FROM feedback").length, 1);
  assert.equal(rows("SELECT * FROM pinned").length, 1);
});

test("소비된 핀을 재전송으로 되살리거나 답장을 반복하지 않는다", async () => {
  const update = say("https://a.com");
  assert.equal((await handleUpdate(update, env, NOON)).method, "sendMessage");
  await env.DB.prepare("DELETE FROM pinned").run();
  assert.equal(await handleUpdate(update, env, NOON), null);
  assert.equal(rows("SELECT * FROM pinned").length, 0);
  assert.equal(rows("SELECT * FROM feedback").length, 1);
});

test("모르는 알림은 기록하지 않고 알려준다, 이상한 데이터는 무시", async () => {
  assert.equal((await handleUpdate(press("u:nope"), env, NOON)).text, "오래된 알림이라 기록하지 못했어요");
  assert.equal(await handleUpdate(press("x:k1"), env, NOON), null);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
});

test("신뢰 경계: 남이 누른 버튼·그룹 채팅·남의 메시지는 무시", async () => {
  assert.equal(await handleUpdate(press("u:k1", 10, { id: 2 }), env, NOON), null);
  assert.equal(await handleUpdate(press("u:k1", 11, { id: 1 }, { id: 1, type: "group" }), env, NOON), null);
  assert.equal(await handleUpdate({ update_id: 12, message: { chat: { id: 2, type: "private" }, from: { id: 2 }, text: "https://evil" } }, env, NOON), null);
  assert.equal(rows("SELECT * FROM feedback").length + rows("SELECT * FROM pinned").length, 0);
});

test("링크를 보내면 고정 구역에 넣고 받았다고 답한다, 링크 없으면 도움말", async () => {
  const r = await handleUpdate(say("이거 봐 https://a.com/x), 그리고 https://b.com/y."), env, NOON);
  assert.equal(r.method, "sendMessage");
  assert.match(r.text, /받았어요/);
  assert.equal(r.disable_notification, false);
  assert.deepEqual(rows("SELECT url FROM pinned ORDER BY url").map((p) => p.url), ["https://a.com/x", "https://b.com/y"]);
  assert.match((await handleUpdate(say("안녕", 21), env, NOON)).text, /링크를 보내주시면/);
  assert.deepEqual(rows("SELECT action FROM feedback ORDER BY update_id").map((f) => f.action), ["link", "msg"]);
});

test("urlsIn: 텔레그램 엔티티(UTF-16 위치)와 숨은 링크", () => {
  const text = "🦉 https://w.org/A_(b) 끝";
  assert.deepEqual(urlsIn({ text, entities: [{ type: "url", offset: 3, length: 19 }] }), ["https://w.org/A_(b)"]);
  assert.deepEqual(urlsIn({ text: "여기", entities: [{ type: "text_link", offset: 0, length: 2, url: "https://h" }] }), ["https://h"]);
  assert.equal(urlsIn({ text: Array.from({ length: 9 }, (_, i) => `https://x/${i}`).join(" ") }).length, 5);
});

test("webhook: 비밀 헤더가 없거나 다르면 403, 답은 응답 본문의 Bot API 호출로", async () => {
  const req = (secret, body) => new Request("https://w/telegram", { method: "POST", headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {}, body: JSON.stringify(body) });
  assert.equal((await handleTelegram(req(null, press("u:k1")), env)).status, 403);
  assert.equal((await handleTelegram(req("x", press("u:k1")), env)).status, 403);
  assert.equal((await handleTelegram(req("s", press("u:k1")), { ...env, TG_SECRET: "" })).status, 403);
  assert.equal((await handleTelegram(req("s", null), env)).status, 400);
  const ok = await handleTelegram(req("s", press("u:k1")), env);
  assert.equal(ok.headers.get("content-type"), "application/json");
  assert.equal((await ok.json()).method, "answerCallbackQuery");
  assert.equal(await (await handleTelegram(req("s", { update_id: 5, edited_message: {} }), env)).text(), "ok");
});

test("D1이 실패하면 500이 나가 텔레그램이 다시 보낸다 (입력 누락 방지)", async () => {
  env.DB.batch = async () => { throw new Error("D1 down"); };
  await assert.rejects(handleUpdate(say("https://a.com"), env, NOON), /D1 down/);
});
