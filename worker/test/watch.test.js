import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { watch, alertKey, formatInstant, isQuiet } from "../src/watch.js";
import { pick, parse, INSTANT, DIGEST } from "../src/sources.js";

// D1 흉내: node:sqlite 위에 prepare().bind().all/first/run 과 batch만
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => db.prepare(sql).run(...args),
    exec: () => db.prepare(sql).run(...args),
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (list) => { db.exec("BEGIN"); try { list.forEach((s) => s.exec()); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } },
  };
}

const rss = (...ids) => `<rss>${ids.map((i) => `<item><title>글 ${i}</title><link>https://x/${i}</link><guid>${i}</guid><description><![CDATA[<p>본문 ${i}. 둘째]]></description></item>`).join("")}</rss>`;
const cycleStart = Math.floor(Date.UTC(2026, 10, 14, 1) / 660_000) * 660_000;
const at = (minute) => new Date(cycleStart + minute * 60_000); // 10시 전후 KST (무음 아님)
const OPENAI = 5; // 분 5 → 즉시 알림 1번(OpenAI)

let env, sent, feed, tgOk, realFetch;
beforeEach(() => {
  env = { DB: fakeD1(), TG_TOKEN: "t", TG_CHAT_ID: "1" }; // GEMINI_API_KEY 없음 → 원문 첫 문장으로 대체
  sent = []; tgOk = true; feed = rss("a");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      sent.push(JSON.parse(init.body));
      return Response.json({ ok: tgOk, result: {} });
    }
    return typeof feed === "number" ? new Response("", { status: feed }) : new Response(feed);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const rows = (sql) => env.DB.raw.prepare(sql).all();

test("11개 출처를 시간 경계와 관계없이 균등하게 순환한다", () => {
  const names = [...DIGEST, ...INSTANT].map((src) => src.name);
  assert.deepEqual(Array.from({ length: 33 }, (_, m) => pick(at(m)).name), [...names, ...names, ...names]);
  const hour = Date.UTC(2026, 10, 14, 2);
  assert.equal(new Set(Array.from({ length: 11 }, (_, m) => pick(new Date(hour + (m - 5) * 60_000)).name)).size, 11);
});

test("첫 실행은 기록만, 다음 차례에 새 글만 버튼과 함께 보낸다", async () => {
  await watch(env, at(OPENAI));
  assert.equal(sent.length, 0);
  assert.equal(rows("SELECT * FROM seen").length, 1);

  feed = rss("b", "a", "b"); // 같은 글이 두 번 나와도 한 번만
  await watch(env, at(OPENAI));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /<b>글 b<\/b>\n\n본문 b\.\n/); // 요약 실패 → 원문 첫 문장
  assert.equal(sent[0].disable_notification, false);
  const key = await alertKey("OpenAI 공식 블로그", "b");
  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].callback_data, `u:${key}`);
  assert.deepEqual(rows("SELECT key, url FROM alerts").map((r) => ({ ...r })), [{ key, url: "https://x/b" }]);

  await watch(env, at(OPENAI)); // 이미 보낸 글은 다시 보내지 않는다
  assert.equal(sent.length, 1);
  assert.equal(rows("SELECT * FROM runs").length, 3);
});

test("보내기 실패한 글은 기록하지 않고 1시간 뒤 다시 시도한다", async () => {
  await watch(env, at(OPENAI));
  feed = rss("b", "a"); tgOk = false;
  await watch(env, at(OPENAI));
  assert.equal(rows("SELECT * FROM seen WHERE id = 'b'").length, 0);
  assert.equal(rows("SELECT * FROM retry").length, 1);
  tgOk = true;
  const before = sent.length; // 실패한 시도도 sent에 남는다
  await watch(env, at(OPENAI + 11)); // 11분 뒤 OpenAI 차례: 아직 대기 중 → 건너뜀
  assert.equal(sent.length, before);
  await watch(env, at(OPENAI + 66)); // 66분 뒤 같은 차례: 다시 시도
  assert.equal(sent.length, before + 1);
  assert.equal(rows("SELECT * FROM retry").length, 0);
  assert.equal(rows("SELECT * FROM seen WHERE id = 'b'").length, 1);
});

test("한 번에 3건까지만 시도하고 나머지는 다음 차례에", async () => {
  await watch(env, at(OPENAI));
  feed = rss("1", "2", "3", "4", "5", "a");
  await watch(env, at(OPENAI));
  assert.equal(sent.length, 3);
  await watch(env, at(OPENAI));
  assert.equal(sent.length, 5);
});

test("아침 요약 출처는 보내지 않고 대기열에 쌓는다", async () => {
  await watch(env, at(1)); // GeekNews
  feed = rss("b", "a");
  await watch(env, at(1));
  assert.equal(sent.length, 0);
  assert.deepEqual(rows("SELECT source, id FROM queue").map((r) => ({ ...r })), [{ source: "GeekNews", id: "b" }]);
  await watch(env, at(1));
  assert.equal(rows("SELECT * FROM queue").length, 1);
});

test("읽기 실패는 health에 쌓이고 성공하면 지워진다", async () => {
  feed = 429;
  await watch(env, at(OPENAI));
  await watch(env, at(OPENAI));
  assert.equal(rows("SELECT fails FROM health")[0].fails, 2);
  feed = rss("a");
  await watch(env, at(OPENAI));
  assert.equal(rows("SELECT * FROM health").length, 0);
});

test("Anthropic: 목록에서 주소를 뽑고, 새 글 제목은 글 페이지에서", async () => {
  const items = parse(INSTANT[0], '<a href="/news/claude-x">x</a><a href="/news/claude-x">x</a><a href="/news/b-2">');
  assert.deepEqual(items.map((i) => i.id), ["https://www.anthropic.com/news/claude-x", "https://www.anthropic.com/news/b-2"]);
  feed = '<a href="/news/old">';
  await watch(env, at(4));
  feed = '<a href="/news/new-model"><a href="/news/old"><meta property="og:title" content="New &amp; Model">';
  await watch(env, at(4));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /<b>New &amp; Model<\/b>/);
});

test("제외된 글뿐인 첫 피드도 기준점을 남겨 다음 정식 릴리스를 보낸다", async () => {
  const codex = at(10);
  feed = rss("a-alpha");
  await watch(env, codex);
  assert.equal(sent.length, 0);
  feed = rss("b", "a-alpha");
  await watch(env, codex);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /글 b/);
});

test("HN·GitHub JSON 파싱과 include/exclude", () => {
  const hn = parse(DIGEST[0], JSON.stringify({ hits: [{ objectID: "1", title: "New AI agent" }, { objectID: "2", title: "Rust 2.0", url: "https://r" }] }));
  assert.deepEqual(hn, [{ id: "1", title: "New AI agent", summary: "", url: "https://news.ycombinator.com/item?id=1" }]);
  const gh = parse(DIGEST[2], JSON.stringify({ items: [{ full_name: "a/b", description: "agent kit", html_url: "https://github.com/a/b" }] }));
  assert.equal(gh[0].title, "a/b — agent kit");
  assert.match(DIGEST[2].url(at(0)), /created:%3E2026-11-07&/);
  const codex = INSTANT.find((s) => s.name === "Codex 릴리스");
  const atom = '<feed><entry><id>1</id><title>0.9.0</title></entry><entry><id>2</id><title>0.9.0-alpha.1</title></entry></feed>';
  assert.deepEqual(parse(codex, atom).map((i) => i.id), ["1"]);
  assert.throws(() => parse(INSTANT[1], "<rss></rss>"), /0건/);
});

test("JSON 출처가 상한보다 크면 잘린 JSON을 파싱하지 않고 읽기 실패로 둔다", async () => {
  const prefix = JSON.stringify({ hits: [{ objectID: "1", title: "AI news" }] }).padEnd(32 * 1024);
  const encoder = new TextEncoder();
  feed = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(prefix));
      controller.enqueue(encoder.encode(" "));
      controller.close();
    },
  });
  await watch(env, at(0));
  assert.match(rows("SELECT last_error FROM health")[0].last_error, /상한/);
});

test("알림 형식·무음 시간·키", async () => {
  assert.equal(await alertKey("OpenAI 공식 블로그", "abc"), "b77f7f280020"); // GitHub 버전 alert_key와 같은 값
  assert.equal(isQuiet(new Date(Date.UTC(2026, 10, 14, 14, 0))), true); // 23시 KST
  assert.equal(isQuiet(new Date(Date.UTC(2026, 10, 14, 23, 0))), false); // 08시 KST
  const t = formatInstant("<src>", { title: "a".repeat(400), url: 'https://x/?a=1&b="2"' }, ["한 줄 <b>"]);
  assert.ok(t.includes("a".repeat(300) + "…</b>"));
  assert.ok(t.includes("한 줄 &lt;b&gt;\n\n"));
  assert.ok(t.includes('href="https://x/?a=1&amp;b=&quot;2&quot;"'));
});
