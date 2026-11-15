import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { weekly, stats, report } from "../src/weekly.js";
import { sendOutbox } from "../src/digest.js";
import { handleUpdate } from "../src/inbox.js";
import { watch } from "../src/watch.js";
import { INSTANT, DIGEST, SLOTS } from "../src/sources.js";
import { fakeD1 } from "./d1.js";

const SUN = new Date(Date.UTC(2026, 10, 15, 11)); // 일 20:00 KST
const DAY_AGO = "2026-11-14T11:00:00.000Z", OLD = "2026-11-01T00:00:00.000Z";
const [CC, CODEX] = ["Claude Code 릴리스", "Codex 릴리스"];
let env, sent, realFetch;
const put = (sql, ...a) => env.DB.raw.prepare(sql).run(...a);
const rows = (sql) => env.DB.raw.prepare(sql).all().map((r) => ({ ...r }));

beforeEach(() => {
  env = { DB: fakeD1(), TG_CHAT_ID: "1" };
  sent = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.telegram.org/")) { sent.push(JSON.parse(init.body)); return Response.json({ ok: true, result: {} }); }
    return new Response("<rss><item><title>t</title><guid>a</guid></item><item><title>n</title><guid>new</guid></item></rss>");
  };
  // Claude Code: 알림 2건, 그중 1건에 👍 / Codex: 알림 3건, 반응 없음 / 오래된 알림은 세지 않는다
  for (const [k, s] of [["c1", CC], ["c2", CC], ["x1", CODEX], ["x2", CODEX], ["x3", CODEX]]) put("INSERT INTO alerts VALUES (?, ?, 't', 'u', ?)", k, s, DAY_AGO);
  put("INSERT INTO alerts VALUES ('old', ?, 't', 'u', ?)", CODEX, OLD);
  put("INSERT INTO feedback VALUES (1, 'c1', 'u', ?, ?)", CC, DAY_AGO);
  put("INSERT INTO feedback VALUES (2, 'c1', 'l', ?, ?)", CC, DAY_AGO); // 같은 알림에 두 번 반응해도 반응 1건
  for (const src of [...INSTANT, ...DIGEST]) if (src.name !== "arXiv 에이전트 논문") put("INSERT INTO runs VALUES (?, ?, 0, 0, 1, ?, 0)", DAY_AGO, src.name, { GeekNews: 7, [CC]: 2, [CODEX]: 3 }[src.name] || 0); // new_items = 알림 + 대기열
  put("INSERT INTO runs VALUES (?, 'GeekNews', 0, 0, 1, 99, 0)", OLD);
  put("INSERT INTO health VALUES ('GitHub 트렌딩', 4, 'HTTP 403', ?)", DAY_AGO);
});
afterEach(() => { globalThis.fetch = realFetch; });

test("리포트: 알림·반응률·유용한 출처·반응 없던 출처·읽기 문제", async () => {
  const [main, suggest, ...rest] = report(await stats(env.DB, SUN));
  assert.match(main, /즉시 알림 5건 · 반응 1건 \(20%\)/);
  assert.match(main, /아침 요약에 쌓인 글 7건/);
  assert.match(main, /가장 유용했던 출처: Claude Code 릴리스 \(👍 1\)/);
  assert.match(main, /반응이 없던 출처: Codex 릴리스$/m); // Claude Code는 반응 있음, 알림 3건 미만 출처는 판단하지 않음
  assert.match(main, /GitHub 트렌딩 연속 4회 \(HTTP 403\)/);
  assert.match(main, /arXiv 에이전트 논문: 이번 주 성공 기록 없음/);
  assert.equal(suggest.reply_markup.inline_keyboard[0][0].callback_data, "w:codex");
  assert.equal(rest.length, 0);
});

test("같은 알림의 반복 👍와 집계 종료 이후 기록을 제외한다", async () => {
  put("INSERT INTO feedback VALUES (3, 'c1', 'u', ?, ?)", CC, DAY_AGO);
  put("INSERT INTO alerts VALUES ('future', ?, 't', 'u', ?)", CC, SUN.toISOString());
  const s = await stats(env.DB, SUN);
  assert.equal(s.ups.get(CC), 1);
  assert.equal(s.alerts.get(CC), 2);
});

test("이미 아침 요약으로 돌린 출처는 다시 제안하지 않는다", async () => {
  const msgs = report(await stats(env.DB, SUN), new Map([[CODEX, "digest"]]));
  assert.equal(msgs.length, 1);
  assert.doesNotMatch(msgs[0], /반응이 없던 출처/);
});

test("weekly → outbox → 매분 cron이 버튼까지 보내고, 오래된 runs는 지운다", async () => {
  put("INSERT INTO runs VALUES ('2026-09-01T00:00:00.000Z', 'GeekNews', 0, 0, 1, 1, 0)"); // 35일보다 오래됨
  await weekly(env, SUN);
  assert.equal(rows("SELECT * FROM runs WHERE at < '2026-10-01'").length, 0);
  assert.equal(rows("SELECT * FROM runs WHERE at = '2026-11-01T00:00:00.000Z'").length, 1);
  await sendOutbox(env);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /이번 주 부엉 리포트/);
  assert.ok(sent[1].reply_markup.inline_keyboard[0][0].callback_data.startsWith("w:"));
  assert.equal(rows("SELECT * FROM outbox").length, 0);
});

test("「그렇게 해줘」를 누르면 그 출처의 새 글이 즉시 알림 대신 아침 요약 대기열로 간다", async () => {
  const i = "openai", turnIndex = INSTANT.findIndex((s) => s.id === i);
  const press = (data, id) => ({ update_id: id, callback_query: { id: "cq", data, from: { id: 1 }, message: { chat: { id: 1, type: "private" } } } });
  assert.equal((await handleUpdate(press(`k:${i}`, 50), env)).text, "그대로 둘게요");
  assert.equal(rows("SELECT * FROM settings").length, 0);
  assert.match((await handleUpdate(press(`w:${i}`, 51), env)).text, /아침 요약으로 보낼게요/);
  assert.match((await handleUpdate(press("w:999", 52), env)).text, /오래된 알림/);
  assert.match((await handleUpdate(press("w:__proto__", 53), env)).text, /오래된 알림/);

  const turn = new Date(Math.ceil(SUN.getTime() / (SLOTS.length * 60_000)) * SLOTS.length * 60_000 + (SLOTS.findIndex((s) => s[0].mode === "instant") + turnIndex) * 60_000); // OpenAI 차례인 분
  put("INSERT INTO seen VALUES ('OpenAI 공식 블로그', 'a', ?)", DAY_AGO);
  await watch(env, turn);
  assert.equal(sent.length, 0);
  assert.deepEqual(rows("SELECT source, id FROM queue"), [{ source: "OpenAI 공식 블로그", id: "new" }]);
});
