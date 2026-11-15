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

test("👍만 구글 시트로 보낸다 (비밀 문구와 함께, 실패해도 답은 그대로)", async () => {
  const posts = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { posts.push(JSON.parse(init.body)); return new Response("ok"); };
  try {
    const jobs = [], sheetEnv = { ...env, SHEET_URL: "https://sheet", SHEET_TOKEN: "t" };
    await handleUpdate(press("u:k1"), sheetEnv, NOON, { later: (p) => jobs.push(p) });
    await handleUpdate(press("d:k1", 11), sheetEnv, NOON, { later: (p) => jobs.push(p) });
    await Promise.all(jobs);
    assert.deepEqual(posts, [{ token: "t", key: "k1", at: NOON.toISOString(), source: "OpenAI 공식 블로그", title: "글", url: "https://x/1", kind: "즉시 알림" }]);
    globalThis.fetch = async () => { throw new TypeError("x"); };
    const r = await handleUpdate(press("u:k1", 12), sheetEnv, NOON, { later: (p) => jobs.push(p) });
    await Promise.all(jobs);
    assert.equal(r.text, "👍 기록했어요");
  } finally {
    globalThis.fetch = realFetch;
  }
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

test("보낸 링크: 답은 바로, 응답 뒤에 페이지 제목과 한 줄을 pinned에 붙인다", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "새 SDK 사용법 글이에요." }] } }] });
    }
    return new Response('<head><meta property="og:title" content="SDK &amp; 가이드"><meta name="description" content="설명"></head>');
  };
  const jobs = [];
  const r = await handleUpdate(say("https://a.com/x https://b.com/y"), { ...env, GEMINI_API_KEY: "k" }, NOON, { later: (p) => jobs.push(p) });
  assert.match(r.text, /받았어요/);
  assert.equal(jobs.length, 1); // 첫 링크만
  await Promise.all(jobs);
  assert.deepEqual(rows("SELECT url, title, line FROM pinned ORDER BY url"), [
    { url: "https://a.com/x", title: "SDK & 가이드", line: "새 SDK 사용법 글이에요." },
    { url: "https://b.com/y", title: "https://b.com/y", line: null },
  ]);

  globalThis.fetch = async () => new Response("", { status: 500 }); // 페이지를 못 읽어도 링크 기록은 그대로
  const later = [];
  await handleUpdate(say("https://c.com", 30), env, NOON, { later: (p) => later.push(p) });
  await Promise.all(later);
  assert.equal(rows("SELECT title FROM pinned WHERE url = 'https://c.com'")[0].title, "https://c.com");
});

test("링크 주소 검사: 내부로 향하는 주소는 열지 않는다", async () => {
  const { allowed } = await import("../src/links.js");
  for (const ok of ["https://openai.com/x", "http://a.b.co:80/", "https://sub.example.org:443/p?q=1"]) assert.ok(allowed(ok), ok);
  for (const bad of ["ftp://a.com", "javascript:alert(1)", "http://127.0.0.1/", "http://0x7f.1/", "http://2130706433/", "http://[::1]/",
    "http://localhost/", "http://localhost./", "http://a.localhost/", "http://printer.local/", "http://db.internal/", "http://router/",
    "http://u:p@a.com/", "https://a.com:8443/", "not a url"]) assert.equal(allowed(bad), null, bad);
});

test("리디렉션을 직접 따라가며 매번 검사한다", async (t) => {
  const { fetchSafe } = await import("../src/links.js");
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const seen = [];
  const hop = (to) => new Response(null, { status: 302, headers: { location: to } });
  const routes = {
    "https://a.com/1": () => hop("/2"), // 상대 주소
    "https://a.com/2": () => hop("https://b.com/end"),
    "https://b.com/end": () => new Response("<title>끝</title>"),
    "https://a.com/evil": () => hop("http://169.254.169.254/latest"),
    "https://a.com/loop": () => hop("https://a.com/loop"),
  };
  globalThis.fetch = async (url, init) => { seen.push(url); assert.equal(init.redirect, "manual"); return routes[url](); };
  assert.equal((await fetchSafe("https://a.com/1")).text, "<title>끝</title>");
  await assert.rejects(fetchSafe("https://a.com/evil"), /막힌 주소/);
  assert.ok(!seen.includes("http://169.254.169.254/latest")); // 내부 주소에는 요청 자체가 가지 않는다
  await assert.rejects(fetchSafe("https://a.com/loop"), /너무 많음/);
});

test("pageMeta: 속성 순서·작은따옴표·속성 붙은 <title>도 찾는다", async () => {
  const { pageMeta } = await import("../src/watch.js");
  assert.deepEqual(pageMeta('<meta content="A &amp; B" property="og:title"><meta name="description" content="설명">'), { title: "A & B", description: "설명" });
  assert.deepEqual(pageMeta("<title data-rh='true'>제목</title><meta property='og:description' content='og 설명'>"), { title: "제목", description: "og 설명" });
  assert.deepEqual(pageMeta("<script>...</script>"), { title: "", description: "" });
});
