// 출처 목록과 순환 순서. CPU 10ms 한도 때문에 실행 한 번에 출처 1개만 읽는다 (DESIGN.md).
// 원본: config/sources.yaml. 읽는 방법이 다른 4곳(Anthropic·HN·GitHub·arXiv)은 Gemini 조사(2026-11-14) 결과대로 바꿨다.
// include / exclude: 제목에 거는 정규식, 대소문자 무시.
// 즉시 알림 출처의 id: 주간 리포트 버튼이 가리키는 고정 이름 (순서를 바꿔도 지난 버튼이 다른 출처를 가리키지 않게). 바꾸지 말 것
import { parseFeed } from "./feed.js";

const DAY = 24 * 60 * 60 * 1000;

export const INSTANT = [
  // /news 페이지 앞 64KB에 최신 3~4건이 있다. 제목은 새 글일 때만 글 페이지에서 가져온다
  { id: "anthropic", name: "Anthropic 공식 뉴스", type: "anthropic", url: "https://www.anthropic.com/news", max: 64 * 1024 },
  { id: "openai", name: "OpenAI 공식 블로그", type: "feed", url: "https://openai.com/news/rss.xml" },
  { id: "gemini", name: "Google Gemini 블로그", type: "feed", url: "https://blog.google/products/gemini/rss/" },
  { id: "claude-code", name: "Claude Code 릴리스", type: "feed", max: 32 * 1024, url: "https://github.com/anthropics/claude-code/releases.atom" },
  { id: "sdk-py", name: "Claude Agent SDK (Python) 릴리스", type: "feed", url: "https://github.com/anthropics/claude-agent-sdk-python/releases.atom" },
  { id: "sdk-ts", name: "Claude Agent SDK (TypeScript) 릴리스", type: "feed", url: "https://github.com/anthropics/claude-agent-sdk-typescript/releases.atom" },
  { id: "codex", name: "Codex 릴리스", type: "feed", url: "https://github.com/openai/codex/releases.atom", exclude: "-(alpha|beta|rc)" },
].map((s) => ({ ...s, mode: "instant" }));

export const DIGEST = [
  {
    name: "Hacker News", type: "hn", max: 32 * 1024,
    url: "https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points%3E20&hitsPerPage=50&attributesToRetrieve=title,url",
    include: "\\b(ai|llms?|gpt|claude|gemini|agents?|agentic|mcp|codex|anthropic|openai)\\b",
  },
  { name: "GeekNews", type: "feed", url: "https://news.hada.io/rss/news" },
  {
    // 트렌딩 페이지는 너무 커서, 최근 7일에 생긴 agent 저장소를 별 순으로 5개 (Search API, User-Agent 필수)
    name: "GitHub 트렌딩", type: "github", max: 64 * 1024,
    url: (now) => `https://api.github.com/search/repositories?q=agent+in:name,description,topics+created:%3E${new Date(now - 7 * DAY).toISOString().slice(0, 10)}&sort=stars&order=desc&per_page=5`,
  },
  {
    // 429가 나면 다시 시도하지 않고 다음 순번(1시간 뒤)에 읽는다
    name: "arXiv 에이전트 논문", type: "feed", max: 32 * 1024,
    url: "https://export.arxiv.org/api/query?search_query=ti:agent&sortBy=submittedDate&sortOrder=descending&max_results=10",
  },
].map((s) => ({ ...s, mode: "digest" }));

const SOURCES = [...DIGEST, ...INSTANT];

// 매분 한 출처씩 11분 주기로 균등 순환한다 (운영판도 같음). 정각에도 순번을 이어간다.
export const pick = (now) => SOURCES[Math.floor(now.getTime() / 60_000) % SOURCES.length];

/** 응답 본문을 [{id, title, url, summary}]로. 늘 글이 있는 출처라 0건이면 구조가 바뀐 것으로 본다 */
export function parse(src, text, { unfiltered = false } = {}) {
  let items;
  if (src.type === "feed") items = parseFeed(text);
  else if (src.type === "anthropic") {
    const paths = new Set([...text.matchAll(/href="(\/news\/[a-z0-9-]+)"/g)].map((m) => m[1]).filter((path) => !/\/news\/(announcements|features)$/.test(path)));
    items = [...paths].map((p) => ({ id: `https://www.anthropic.com${p}`, title: "", url: `https://www.anthropic.com${p}`, summary: "" }));
  } else if (src.type === "hn") {
    items = JSON.parse(text).hits.map((h) => ({
      id: h.objectID, title: h.title || "", summary: "",
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    }));
  } else if (src.type === "github") {
    items = JSON.parse(text).items.map((r) => ({
      id: r.full_name, title: r.description ? `${r.full_name} — ${r.description}` : r.full_name,
      url: r.html_url, summary: r.description || "",
    }));
  } else throw new Error(`모르는 type: ${src.type}`);
  if (!items.length) throw new Error("파싱 결과 0건 (구조 변경 의심)");
  if (unfiltered) return items;
  return filterTitles(src, items);
}

export function filterTitles(src, items) {
  const inc = src.include && new RegExp(src.include, "i");
  const exc = src.exclude && new RegExp(src.exclude, "i");
  return items.filter((i) => (!inc || inc.test(i.title)) && !(exc && exc.test(i.title)));
}
