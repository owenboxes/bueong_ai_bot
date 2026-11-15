import { test } from "node:test";
import assert from "node:assert/strict";
import { renderList } from "../src/page.js";

test("renderList는 분야(CATEGORIES) 순서 → 등급 → 출처 순으로 정렬하고 원문 보기 버튼만 표시한다", () => {
  const items = [
    { source: "GeekNews", title: "3등급 기타 글", url: "https://news.hada.io/1" },
    { source: "OpenAI", title: "1등급 발표 글", url: "https://openai.com/1" },
    { source: "Anthropic", title: "2등급 발표 글", url: "https://anthropic.com/1" },
    { source: "arXiv", title: "1등급 연구 글", url: "https://arxiv.org/1" },
  ];
  const ranks = [
    [3, "3등급 요약은 숨김", "기타"],
    [1, "핵심 요약 1", "모델·제품 발표"],
    [2, "참고 요약 2", "모델·제품 발표"],
    [1, "핵심 요약 arXiv", "연구·논문"],
  ];

  const html = renderList(items, ranks, "2026-11-14-0800");
  assert.match(html, /부엉 아침 요약 2026-11- — 전체 4건/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /rel="noreferrer"/);
  assert.match(html, /원문 보기/);

  // 분야 순서(모델·제품 발표 -> 연구·논문 -> 기타) 및 분야 내 등급(1->2) 확인
  const idxCatModel = html.indexOf("모델·제품 발표");
  const idxOpenAI = html.indexOf("1등급 발표 글");
  const idxAnthropic = html.indexOf("2등급 발표 글");
  const idxCatResearch = html.indexOf("연구·논문");
  const idxArxiv = html.indexOf("1등급 연구 글");
  const idxCatEtc = html.indexOf("기타");
  const idxGeek = html.indexOf("3등급 기타 글");
  assert.ok(
    idxCatModel < idxOpenAI &&
      idxOpenAI < idxAnthropic &&
      idxAnthropic < idxCatResearch &&
      idxCatResearch < idxArxiv &&
      idxArxiv < idxCatEtc &&
      idxCatEtc < idxGeek,
  );

  // 요약 줄은 페이지에 표시하지 않으며, opts가 없으면 👍 버튼도 없음
  assert.equal(html.includes("핵심 요약 1"), false);
  assert.equal(html.includes("참고 요약 2"), false);
  assert.equal(html.includes("3등급 요약은 숨김"), false);
  assert.equal(html.includes("<form"), false);
});

test("renderList는 ranks가 null이면 분류 없이 출처 순으로 정렬한다", () => {
  const items = [
    { source: "HN", title: "두번째", url: "https://example.com/2" },
    { source: "arXiv", title: "첫번째", url: "https://example.com/1" },
  ];
  const html = renderList(items, null, "2026-11-14");
  assert.ok(html.indexOf("첫번째") < html.indexOf("두번째"));
  assert.equal(html.includes("등급</span>"), false);
  assert.equal(html.includes('<h2 class="cat-title">'), false);
});

test("renderList는 HTML 이스케이프와 javascript: 링크 차단을 수행한다", () => {
  const items = [
    {
      source: '<b>SRC</b>',
      title: '<script>alert(1)</script>',
      url: "javascript:alert(1)",
    },
    {
      source: "Data",
      title: "데이터 URL",
      url: "data:text/html,<script>alert(1)</script>",
    },
  ];

  const html = renderList(items, null, '<img src=x onerror=alert(1)>');
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<b>SRC</b>"), false);
  assert.equal(html.includes('href="javascript:'), false);
  assert.equal(html.includes('href="data:'), false);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("renderList는 opts가 있으면 원래 번호 기준 id와 👍 form을 넣고 liked 항목은 기록됨만 표시한다", () => {
  const items = [
    { source: "GeekNews", title: "원래 0번", url: "https://news.hada.io/0" },
    { source: "OpenAI", title: "원래 1번", url: "https://openai.com/1" },
  ];
  const ranks = [
    [3, "", "기타"],
    [1, "요약", "모델·제품 발표"],
  ];

  const html = renderList(items, ranks, "batch-1", {
    likeAction: (i) => `/digest/b"1/like/${i}`,
    liked: new Set([1]),
  });

  // 정렬 후 순서와 무관하게 원래 배열 번호 id="i0", id="i1" 사용
  assert.ok(html.includes('id="i0"'));
  assert.ok(html.includes('id="i1"'));

  // 0번은 form + 👍 버튼 (action 이스케이프 포함)
  assert.ok(
    html.includes(
      '<form class="like-form" method="post" action="/digest/b&quot;1/like/0"><button class="btn-like" type="submit">👍</button></form>',
    ),
  );

  // 1번(liked)은 버튼 대신 "👍 기록됨"만 표시
  assert.ok(html.includes("👍 기록됨"));
  assert.equal(html.includes('action="/digest/b&quot;1/like/1"'), false);
  assert.equal(html.includes("<script>"), false);
});
