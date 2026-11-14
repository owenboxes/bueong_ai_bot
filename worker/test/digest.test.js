import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { build, split, prepare, sendOutbox, digestPage } from "../src/digest.js";
import { fakeD1 } from "./d1.js";

const it = (n, source = "GeekNews") => ({ source, title: `글 ${n}`, url: `https://x/${n}` });
const AM8 = new Date(Date.UTC(2026, 10, 14, 23)); // 08:00 KST
let env, sent, tgFail, realFetch;
const rows = (sql) => env.DB.raw.prepare(sql).all().map((r) => ({ ...r }));
const put = (sql, ...a) => env.DB.raw.prepare(sql).run(...a);

beforeEach(() => {
  env = { DB: fakeD1(), TG_CHAT_ID: "1", BASE_URL: "https://w" }; // GEMINI_API_KEY 없음 → 정렬 없이 출처별
  sent = []; tgFail = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (tgFail > 0) { tgFail--; return Response.json({ ok: false }); }
    sent.push(body.text);
    return Response.json({ ok: true, result: {} });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

test("build: 빈 날·핀만 있는 날·정렬 실패·정렬 성공", () => {
  assert.match(build([], null, "u")[0], /새로 들어온 글은 없었어요/);
  const pin = [{ kind: "later", source: "OpenAI", title: "핀", url: "https://p" }, { kind: "link", source: "보낸 링크", title: "https://l", url: "https://l" }];
  const onlyPin = build([], null, "u", pin).join("\n");
  assert.ok(onlyPin.indexOf("📌 보내준 링크 (1)") < onlyPin.indexOf("🌙 자세히 보기로 한 글 (1)"));
  const noRank = build([it(1), it(2), it(3, "HN")], null, "https://w/digest/b").join("\n");
  assert.match(noRank, /• GeekNews 2건\n• HN 1건\n<a href="https:\/\/w\/digest\/b">/);
  const ranked = build([it(1), it(2), it(3)], [[2, "요약 <b>"], [1, ""], [3, ""]], "https://w/d").join("\n");
  assert.ok(ranked.indexOf("꼭 볼 것 (1)") < ranked.indexOf("알아두면 좋은 것 (1)"));
  assert.match(ranked, /글 1<\/a> – 요약 &lt;b&gt;/);
  assert.match(ranked, /나머지 \(1\)/);
  assert.match(build([it(1)], null, undefined).join("\n"), /주소가 설정되지 않았어요/);
});

test("유효한 HTTP(S) 주소만 요약에서 링크로 표시한다", () => {
  const invalid = ["", "javascript:alert(1)", "https://"];
  const text = build(invalid.map((url) => ({ ...it(1), url })), invalid.map(() => [1, ""]), "https://w/d").join("\n");
  assert.equal((text.match(/<a href=/g) || []).length, 1);
});

test("선택 뒤에 기록한 이전 시각의 행을 보존한다", async () => {
  const batch = env.DB.batch;
  env.DB.batch = (statements) => {
    put("INSERT INTO queue VALUES ('GeekNews', 'late', '글', 'https://x/late', '2026-11-14T22:59:00.000Z')");
    return batch(statements);
  };
  await prepare(env, AM8);
  assert.deepEqual(rows("SELECT id FROM queue"), [{ id: "late" }]);
});

test("split: 블록을 자르지 않고 한도 안으로 묶는다", () => {
  assert.deepEqual(split(["aa", "bb", "cc"], 5), ["aa\nbb", "cc"]);
  assert.throws(() => split(["x".repeat(6)], 5), /상한/);
  const long = build(Array.from({ length: 300 }, (_, n) => it(n)), Array.from({ length: 300 }, () => [1, "가".repeat(200)]), "u");
  assert.ok(split(long).every((m) => m.length <= 4000));
});

test("prepare: 발송분·전체 목록을 만들고, 이 시각 전의 대기열·핀만 비운다", async () => {
  put("INSERT INTO queue VALUES ('GeekNews', 'a', '글 a', 'https://x/a', '2026-11-14T10:00:00.000Z')");
  put("INSERT INTO queue VALUES ('GeekNews', 'b', '글 b', 'https://x/b', ?)", AM8.toISOString()); // 정렬 중에 들어온 글
  put("INSERT INTO pinned VALUES ('link', 'https://l', 'https://l', '보낸 링크', '2026-11-14T12:00:00.000Z')");
  await prepare(env, AM8);
  const [box] = rows("SELECT * FROM outbox");
  assert.equal(box.sent, 0);
  assert.match(box.batch, /^[0-9a-f]{32}$/);
  const text = JSON.parse(box.messages).join("\n");
  assert.match(text, /밤사이 1건/);
  assert.ok(text.includes(`https://w/digest/${box.batch}`));
  assert.match(text, /보내준 링크 \(1\)/);
  assert.deepEqual(rows("SELECT id FROM queue"), [{ id: "b" }]); // 내일로
  assert.equal(rows("SELECT * FROM pinned").length, 0);
  assert.equal(rows("SELECT batch FROM digests")[0].batch, box.batch);

  await prepare(env, new Date(AM8.getTime() + 86400_000)); // 어제 것을 다 못 보냈으면 건너뛴다
  assert.equal(rows("SELECT * FROM outbox").length, 1);
});

test("sendOutbox: 조각 순서대로, 실패하면 그 자리에서 멈췄다가 다음 분에 이어 보낸다", async () => {
  put("INSERT INTO outbox VALUES ('b1', ?, 0, 0, '2026-11-14T23:00:00Z')", JSON.stringify(["1", "2", "3"]));
  tgFail = 1;
  await sendOutbox(env);
  assert.deepEqual(sent, []);
  assert.deepEqual(rows("SELECT sent, tries FROM outbox"), [{ sent: 0, tries: 1 }]);
  await sendOutbox(env);
  assert.deepEqual(sent, ["1", "2", "3"]);
  assert.equal(rows("SELECT * FROM outbox").length, 0);
  await sendOutbox(env); // 보낼 것 없음
  assert.equal(sent.length, 3);
});

test("sendOutbox: 같은 조각이 5번 실패하면 건너뛰고 나머지를 보낸다", async () => {
  put("INSERT INTO outbox VALUES ('b1', ?, 0, 0, '2026-11-14T23:00:00Z')", JSON.stringify(["나쁜", "좋은"]));
  tgFail = 5;
  for (let n = 0; n < 5; n++) await sendOutbox(env);
  assert.deepEqual(rows("SELECT sent, tries FROM outbox"), [{ sent: 1, tries: 0 }]);
  await sendOutbox(env);
  assert.deepEqual(sent, ["좋은"]);
});

test("전체 목록 페이지: 있는 batch만, 비밀 링크가 새지 않게 헤더", async () => {
  put("INSERT INTO digests VALUES (?, '<p>목록</p>', '2026-11-14T23:00:00Z')", "a".repeat(32));
  const r = await digestPage(env, "a".repeat(32));
  assert.equal(await r.text(), "<p>목록</p>");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await digestPage(env, "b".repeat(32))).status, 404);
  assert.equal((await digestPage(env, "' OR 1=1 --")).status, 404);
});
