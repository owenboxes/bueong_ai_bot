import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, firstSentence, validLines, DEFAULT_PERSONA, FORMAT } from "../src/gemini.js";

const ITEM = {
  title: "v2.1.325",
  url: "https://example.com/v2.1.325",
  summary: "Adds a new flag. Fixes bugs.",
};

function makeOkResponse(parts, finishReason = "STOP") {
  return new Response(
    JSON.stringify({
      candidates: [{ finishReason, content: { parts } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("정상 두 줄 응답을 반환하고 thought 파트는 제외한다", async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit = null;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return makeOkResponse([
      { thought: true, text: "내부 생각은 제외돼야 해요.\n→ 무시" },
      { text: "새 플래그가 추가됐어요.\n→ 설정이 간편해져요." },
    ]);
  };

  const result = await summarize(
    { GEMINI_API_KEY: "secret-test-key" },
    "Claude Code 릴리스",
    ITEM,
    "",
  );

  assert.deepEqual(result, [
    "새 플래그가 추가됐어요.",
    "→ 설정이 간편해져요.",
  ]);
  assert.match(capturedUrl, /gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(capturedInit.headers["x-goog-api-key"], "secret-test-key");
  const sentBody = JSON.parse(capturedInit.body);
  assert.equal(sentBody.system_instruction.parts[0].text, `${DEFAULT_PERSONA}\n\n${FORMAT}`);
});

test("형식이 틀린 응답(1줄·화살표 누락·finishReason!=STOP)이면 원문 첫 문장으로 대체한다", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  });

  console.log = (msg) => logs.push(msg);

  // 1) 둘째 줄에 '→'가 없는 경우
  globalThis.fetch = async () => makeOkResponse([{ text: "한 줄 요약\n화살표 없음" }]);
  assert.deepEqual(
    await summarize({ GEMINI_API_KEY: "secret-test-key" }, "출처", ITEM, "페르소나"),
    ["Adds a new flag."],
  );

  // 2) finishReason !== STOP 인 경우
  globalThis.fetch = async () =>
    makeOkResponse([{ text: "중간에 잘린 문장\n→ 의미" }], "MAX_TOKENS");
  assert.deepEqual(
    await summarize({ GEMINI_API_KEY: "secret-test-key" }, "출처", ITEM, "페르소나"),
    ["Adds a new flag."],
  );

  assert.equal(logs.length, 2);
  assert.deepEqual(JSON.parse(logs[0]), { event: "summary_failed", error: "invalid_format" });
  assert.deepEqual(JSON.parse(logs[1]), { event: "summary_failed", error: "Error" });
});

test("HTTP 429 오류 시 키를 노출하지 않고 로그를 남긴 뒤 원문 첫 문장으로 대체한다", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  });

  console.log = (msg) => logs.push(msg);
  globalThis.fetch = async () =>
    new Response("Quota exceeded for key secret-test-key", { status: 429 });

  const result = await summarize(
    { GEMINI_API_KEY: "secret-test-key" },
    "출처",
    ITEM,
    "페르소나",
  );

  assert.deepEqual(result, ["Adds a new flag."]);
  assert.equal(logs.length, 1);
  const parsed = JSON.parse(logs[0]);
  assert.equal(parsed.event, "summary_failed");
  assert.equal(parsed.error, "Error HTTP 429");
  assert.equal(logs[0].includes("secret-test-key"), false);
});

test("GEMINI_API_KEY가 없으면 fetch 없이 바로 원문 첫 문장 또는 빈 배열을 반환한다", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("should not call fetch");
  };

  assert.deepEqual(await summarize({}, "출처", ITEM, "페르소나"), ["Adds a new flag."]);
  assert.deepEqual(await summarize({}, "출처", { title: "제목만" }, "페르소나"), []);
  assert.equal(fetchCalled, false);
});

test("firstSentence와 validLines 유틸 동작", () => {
  assert.equal(firstSentence("가".repeat(300)).endsWith("…"), true);
  assert.equal(validLines("요약 한 줄\n→ 의미\n여분"), null);
  assert.equal(validLines(`${"가".repeat(301)}\n→ 의미`), null);
});
