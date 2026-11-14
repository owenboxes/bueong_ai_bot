import { test } from "node:test";
import assert from "node:assert/strict";
import { renderList } from "../src/page.js";

test("renderList는 등급 → 출처 순으로 정렬하고 1·2등급 요약 줄을 표시한다", () => {
  const items = [
    { source: "GeekNews", title: "3등급 글", url: "https://news.hada.io/1" },
    { source: "OpenAI", title: "1등급 글", url: "https://openai.com/1" },
    { source: "Anthropic", title: "2등급 글", url: "https://anthropic.com/1" },
    { source: "arXiv", title: "1등급 arXiv", url: "https://arxiv.org/1" },
  ];
  const ranks = [
    [3, "3등급 요약은 숨김"],
    [1, "핵심 요약 1"],
    [2, "참고 요약 2"],
    [1, "핵심 요약 arXiv"],
  ];

  const html = renderList(items, ranks, "2026-11-14-0800");
  assert.match(html, /부엉 아침 요약 2026-11- — 전체 4건/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /rel="noreferrer"/);

  // 1등급(arXiv -> OpenAI) -> 2등급(Anthropic) -> 3등급(GeekNews) 순서 확인
  const idxArxiv = html.indexOf("1등급 arXiv");
  const idxOpenAI = html.indexOf("1등급 글");
  const idxAnthropic = html.indexOf("2등급 글");
  const idxGeek = html.indexOf("3등급 글");
  assert.ok(idxArxiv < idxOpenAI && idxOpenAI < idxAnthropic && idxAnthropic < idxGeek);

  // 1·2등급 요약은 보이고 3등급 요약은 안 보임
  assert.ok(html.includes("핵심 요약 1"));
  assert.ok(html.includes("참고 요약 2"));
  assert.equal(html.includes("3등급 요약은 숨김"), false);
});

test("renderList는 ranks가 null이면 모두 같은 등급으로 보고 출처 순으로 정렬한다", () => {
  const items = [
    { source: "HN", title: "두번째", url: "https://example.com/2" },
    { source: "arXiv", title: "첫번째", url: "https://example.com/1" },
  ];
  const html = renderList(items, null, "2026-11-14");
  assert.ok(html.indexOf("첫번째") < html.indexOf("두번째"));
  assert.equal(html.includes("등급</span>"), false);
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
