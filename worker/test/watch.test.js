import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { watch, alertKey, formatInstant, isQuiet } from "../src/watch.js";
import { pick, parse, INSTANT, DIGEST, SLOTS } from "../src/sources.js";
import { fakeD1 } from "./d1.js";

const rss = (...ids) => `<rss>${ids.map((i) => `<item><title>글 ${i}</title><link>https://x/${i}</link><guid>${i}</guid><description><![CDATA[<p>본문 ${i}. 둘째]]></description></item>`).join("")}</rss>`;
const CYCLE = SLOTS.length * 60_000, FIRST_INSTANT = SLOTS.findIndex((s) => s[0].mode === "instant");
const cycleStart = Math.floor(Date.UTC(2026, 10, 14, 1) / CYCLE) * CYCLE;
const at = (minute) => new Date(cycleStart + minute * 60_000); // 10시 전후 KST (무음 아님)
const OPENAI = FIRST_INSTANT + 1; // 즉시 알림 1번(OpenAI)

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

test("출처를 시간 경계와 관계없이 균등하게 순환하고, 유튜브 채널은 한 칸을 나눠 쓴다", () => {
  assert.equal(SLOTS.length, 14);
  const yt = SLOTS.find((s) => s[0].group === "youtube");
  assert.equal(yt.length, 4);
  const n = SLOTS.length * yt.length, counts = {};
  for (let m = 0; m < n; m++) { const name = pick(new Date(Date.UTC(2026, 10, 14, 2) + (m - 7) * 60_000)).name; counts[name] = (counts[name] || 0) + 1; }
  for (const src of [...DIGEST, ...INSTANT]) assert.equal(counts[src.name], src.group ? 1 : yt.length, src.name);
  const solo = INSTANT.filter((src) => !src.group);
  assert.deepEqual(solo.map((src, i) => pick(at(FIRST_INSTANT + i)).name), solo.map((src) => src.name));
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
  await watch(env, at(OPENAI + 14)); // 14분 뒤 OpenAI 차례: 아직 대기 중 → 건너뜀
  assert.equal(sent.length, before);
  await watch(env, at(OPENAI + 70)); // 70분 뒤 같은 차례: 다시 시도
  assert.equal(sent.length, before + 1);
  assert.equal(rows("SELECT * FROM retry").length, 0);
  assert.equal(rows("SELECT * FROM seen WHERE id = 'b'").length, 1);
});

test("한 번에 3건까지만 알리고 넘친 글은 잃지 않게 아침 요약 대기열로", async () => {
  await watch(env, at(OPENAI));
  feed = rss("1", "2", "3", "4", "5", "a");
  await watch(env, at(OPENAI));
  assert.equal(sent.length, 3);
  assert.deepEqual(rows("SELECT id FROM queue ORDER BY id").map((r) => r.id), ["4", "5"]);
  assert.equal(rows("SELECT new_items FROM runs").at(-1).new_items, 5);
  await watch(env, at(OPENAI));
  assert.equal(sent.length, 3);
});

test("23~08시 KST는 모든 출처를 알림 없이 대기열에, 낮에는 아침 요약 출처도 즉시 알림", async () => {
  const night = (m) => new Date(Math.floor(Date.UTC(2026, 10, 14, 15) / CYCLE) * CYCLE + m * 60_000); // 00시 전후 KST
  await watch(env, night(1)); // GeekNews 첫 실행
  await watch(env, night(OPENAI));
  feed = rss("b", "a");
  await watch(env, night(1));
  await watch(env, night(OPENAI)); // 즉시 알림 출처도 밤에는 대기열
  assert.equal(sent.length, 0);
  assert.deepEqual(rows("SELECT source, id FROM queue ORDER BY source").map((r) => ({ ...r })),
    [{ source: "GeekNews", id: "b" }, { source: "OpenAI 공식 블로그", id: "b" }]);
  await watch(env, night(1));
  assert.equal(rows("SELECT * FROM queue").length, 2);
  feed = rss("c", "b", "a");
  await watch(env, at(1)); // 낮: GeekNews도 바로 보낸다
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\[GeekNews\]/);
  assert.doesNotMatch(sent[0].text, /본문 c/); // 뉴스 출처는 요약 없이 제목·링크만
});

test("주간 리포트로 아침 요약에 옮긴 출처는 낮에도 대기열", async () => {
  await watch(env, at(OPENAI));
  env.DB.raw.prepare("INSERT INTO settings VALUES ('OpenAI 공식 블로그', 'digest', '2026-11-14T00:00:00Z')").run();
  feed = rss("b", "a");
  await watch(env, at(OPENAI));
  assert.equal(sent.length, 0);
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
  await watch(env, at(FIRST_INSTANT)); // Anthropic
  feed = '<a href="/news/new-model"><a href="/news/old"><meta property="og:title" content="New &amp; Model">';
  await watch(env, at(FIRST_INSTANT)); // Anthropic
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /<b>New &amp; Model<\/b>/);
});

test("제외된 글뿐인 첫 피드도 기준점을 남겨 다음 정식 릴리스를 보낸다", async () => {
  const codex = at(FIRST_INSTANT + 6);
  feed = rss("a-alpha");
  await watch(env, codex);
  assert.equal(sent.length, 0);
  feed = rss("b", "a-alpha");
  await watch(env, codex);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /글 b/);
});

test("유튜브: 키는 헤더로만, 리디렉션 금지, 실패 기록에 예외 원문(키)이 남지 않는다", async () => {
  const yt = SLOTS.findIndex((s) => s[0].group === "youtube");
  env.YT_KEY = "SECRET";
  let init;
  globalThis.fetch = async (url, i) => { init = i; assert.doesNotMatch(String(url), /SECRET/); throw new TypeError("bad header SECRET"); };
  await watch(env, at(yt));
  assert.equal(init.headers["x-goog-api-key"], "SECRET");
  assert.equal(init.redirect, "manual");
  assert.deepEqual(rows("SELECT last_error FROM health").map((r) => r.last_error), ["요청 실패 (TypeError)"]);
  globalThis.fetch = async () => new Response("", { status: 403 });
  await watch(env, at(yt + SLOTS.length)); // 다음 채널
  assert.ok(rows("SELECT last_error FROM health").some((r) => r.last_error === "HTTP 403"));
});

test("유튜브 새 영상은 Gemini 없이 제목만으로 즉시 알림", async () => {
  const yt = SLOTS.findIndex((s) => s[0].group === "youtube"), same = SLOTS.length * 4; // 같은 채널이 다시 오는 간격
  env.YT_KEY = "k"; env.GEMINI_API_KEY = "g";
  const vids = (...ids) => JSON.stringify({ items: ids.map((v) => ({ snippet: { title: `영상 ${v}`, resourceId: { videoId: v } } })) });
  const tgFetch = globalThis.fetch, gemini = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("generativelanguage")) gemini.push(url); // summarize가 예외를 삼키므로 끝난 뒤 건수로 본다
    return String(url).includes("googleapis.com/youtube") ? new Response(feed) : tgFetch(url, init);
  };
  feed = vids("a");
  await watch(env, at(yt)); // 첫 실행: 기록만
  feed = vids("b", "a");
  await watch(env, at(yt + same));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /<b>영상 b<\/b>\n\n<a href="https:\/\/www\.youtube\.com\/watch\?v=b">/);
  assert.equal(gemini.length, 0);
});

test("HN·GitHub JSON 파싱과 include/exclude", () => {
  const hn = parse(DIGEST[0], JSON.stringify({ hits: [{ objectID: "1", title: "New AI agent" }, { objectID: "2", title: "Rust 2.0", url: "https://r" }] }));
  assert.deepEqual(hn, [{ id: "1", title: "New AI agent", summary: "", url: "https://news.ycombinator.com/item?id=1" }]);
  const gh = parse(DIGEST[2], JSON.stringify({ items: [{ full_name: "a/b", description: "agent kit", html_url: "https://github.com/a/b" }] }));
  assert.equal(gh[0].title, "a/b — agent kit");
  assert.match(DIGEST[2].url(at(0)), /created:%3E2026-11-07&/);
  const ytSrc = INSTANT.find((s) => s.type === "youtube");
  assert.throws(() => ytSrc.headers({}), /YT_KEY 없음/);
  assert.deepEqual(ytSrc.headers({ YT_KEY: "k" }), { "x-goog-api-key": "k" });
  assert.match(ytSrc.url, /playlistId=UUqjmg0AJYxGcLBgGKTsU2sQ&/);
  assert.doesNotMatch(ytSrc.url, /key=/);
  assert.deepEqual(parse(ytSrc, JSON.stringify({ items: [{ snippet: { title: "에이전트 써보기", resourceId: { videoId: "abc" } } }] })),
    [{ id: "abc", title: "에이전트 써보기", url: "https://www.youtube.com/watch?v=abc", summary: "" }]);
  const kr = DIGEST.find((s) => s.type === "discourse");
  // 실제 응답처럼 fancy_title이 먼저, 글 안에 posters 배열·중괄호 든 제목
  const topic = (id, title) => ({ fancy_title: title, id, title, slug: `t-${id}`, posters: [{ user_id: 9, extras: "latest" }] });
  const json = JSON.stringify({ users: [{ id: 9, username: "u" }], topic_list: { can_create_topic: false, topics: [topic(1, '모델 "A" {공개}]'), topic(2, "에이전트")] } });
  assert.deepEqual(parse(kr, json.slice(0, json.lastIndexOf('"slug":"t-2"') + 5)), [ // 잘린 응답: 끝까지 온 글만
    { id: "1", title: '모델 "A" {공개}]', url: "https://discuss.pytorch.kr/t/t-1/1", summary: "" },
  ]);
  assert.deepEqual(parse(kr, json).map((i) => i.id), ["1", "2"]);
  const spaced = JSON.stringify({ suggested: { topics: [topic(7, "x")] }, topic_list: { topics: [topic(1, "y")] } }, null, 1);
  assert.deepEqual(parse(kr, spaced).map((i) => i.id), ["1"]); // topic_list 밖 topics·콜론 뒤 공백
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
