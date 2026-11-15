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
  // 유튜브: 채널 RSS가 404(2026-11-15)라 YouTube Data API(무료 1회 1단위, 키는 Worker 비밀값 YT_KEY). 제목·링크만, Gemini 요약 없이 즉시 알림 (사용자 결정 2026-11-15)
  // 채널 id는 Gemini가 채널 페이지 externalId로 확인. 4개가 순환 한 칸을 나눠 쓴다(group): 채널마다 약 56분 간격
  ...[
    ["yt-aiscene", "AI씬", "UCqjmg0AJYxGcLBgGKTsU2sQ"],
    ["yt-teddynote", "테디노트", "UCt2wAAXgm87ACiQnDHQEW6Q"],
    ["yt-jocoding", "조코딩", "UCQNE2JmbasNYbjGAcuBiRRg"],
    ["yt-gussi", "시민개발자 구씨", "UCDLlMjELbrJdETmSiAB68AA"],
  ].map(([key, who, id]) => ({
    // 키는 주소가 아니라 헤더로 (주소는 오류·로그에 남을 수 있다). 20건: 56분 사이 밀려도 놓치지 않게, fields로 작게
    id: key, name: `유튜브 · ${who}`, type: "youtube", group: "youtube", max: 32 * 1024,
    url: `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=20&playlistId=UU${id.slice(2)}`
      + "&fields=items(snippet(title,resourceId(videoId)))",
    headers: (env) => {
      if (!env?.YT_KEY) throw new Error("YT_KEY 없음");
      return { "x-goog-api-key": env.YT_KEY.trim() }; // 붙여 넣을 때 섞인 줄바꿈·공백은 헤더 오류(TypeError)가 된다
    },
  })),
].map((s) => ({ summarize: s.type !== "youtube", ...s, mode: "instant" })); // 요약은 공식 7곳만 (릴리스 제목은 버전뿐이라), 나머지는 제목·링크

export const DIGEST = [
  {
    id: "hn", name: "Hacker News", type: "hn", max: 32 * 1024,
    url: "https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points%3E20&hitsPerPage=50&attributesToRetrieve=title,url",
    include: "\\b(ai|llms?|gpt|claude|gemini|agents?|agentic|mcp|codex|anthropic|openai)\\b",
  },
  { id: "geeknews", name: "GeekNews", type: "feed", url: "https://news.hada.io/rss/news" },
  {
    // 트렌딩 페이지는 너무 커서, 최근 7일에 생긴 agent 저장소를 별 순으로 5개 (Search API, User-Agent 필수)
    id: "github", name: "GitHub 트렌딩", type: "github", max: 64 * 1024,
    url: (now) => `https://api.github.com/search/repositories?q=agent+in:name,description,topics+created:%3E${new Date(now - 7 * DAY).toISOString().slice(0, 10)}&sort=stars&order=desc&per_page=5`,
  },
  {
    // 429가 나면 다시 시도하지 않고 다음 순번(1시간 뒤)에 읽는다
    id: "arxiv", name: "arXiv 에이전트 논문", type: "feed", max: 32 * 1024,
    url: "https://export.arxiv.org/api/query?search_query=ti:agent&sortBy=submittedDate&sortOrder=descending&max_results=10",
  },
  // 국내 출처 (Gemini 조사 2026-11-15): 앞 16KB에 AI타임스 16건, PyTorch KR 9건
  { id: "aitimes", name: "AI타임스", type: "feed", url: "https://www.aitimes.com/rss/allArticle.xml" },
  // Discourse latest.json은 앞 16KB에서 잘리므로 topics 안의 완성된 글 객체만 하나씩 읽는다 (topics 함수)
  { id: "pytorchkr", name: "PyTorch KR", type: "discourse", url: "https://discuss.pytorch.kr/latest.json" },
].map((s) => ({ ...s, mode: "digest" }));

// 모든 출처 (낮에는 아침 요약 출처도 즉시 알림이라 주간 리포트 버튼은 전체에서 고른다. id는 바꾸지 말 것)
export const ALL = [...INSTANT, ...DIGEST];

// 순환 칸: 출처 하나가 한 칸, 같은 group은 한 칸을 차례로 나눠 쓴다
export const SLOTS = [];
for (const s of [...DIGEST, ...INSTANT]) {
  const slot = s.group && SLOTS.find((x) => x[0].group === s.group);
  if (slot) slot.push(s); else SLOTS.push([s]);
}

// 매분 한 칸씩 14분 주기로 균등 순환한다 (운영판도 같음). 정각에도 순번을 이어간다.
export const pick = (now) => {
  const m = Math.floor(now.getTime() / 60_000), slot = SLOTS[m % SLOTS.length];
  return slot[Math.floor(m / SLOTS.length) % slot.length];
};

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
  } else if (src.type === "discourse") {
    const base = new URL(src.url).origin;
    items = topics(text).map((t) => ({ id: String(t.id), title: t.title || "", url: `${base}/t/${t.slug}/${t.id}`, summary: "" }));
  } else if (src.type === "youtube") {
    items = JSON.parse(text).items.map(({ snippet: s }) => ({
      id: s.resourceId.videoId, title: s.title || "", url: `https://www.youtube.com/watch?v=${s.resourceId.videoId}`, summary: "",
    }));
  } else throw new Error(`모르는 type: ${src.type}`);
  if (!items.length) throw new Error("파싱 결과 0건 (구조 변경 의심)");
  if (unfiltered) return items;
  return filterTitles(src, items);
}

/** 잘린 Discourse JSON에서 "topics":[ 안의 끝까지 온 글 객체만 하나씩 JSON.parse (속성 순서와 무관) */
function topics(text) {
  const m = /"topic_list"\s*:\s*\{[^]*?"topics"\s*:\s*\[/.exec(text);
  if (!m) return [];
  const out = [];
  let depth = 0, from = -1, str = false;
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const c = text[i];
    if (str) { if (c === "\\") i++; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === "{" || c === "[") { if (depth++ === 0) from = i; }
    else if (c === "}" || c === "]") {
      if (depth === 0) break; // topics 배열 끝
      if (--depth === 0) out.push(JSON.parse(text.slice(from, i + 1)));
    }
  }
  return out.filter((t) => t.id && t.slug);
}

export function filterTitles(src, items) {
  const inc = src.include && new RegExp(src.include, "i");
  const exc = src.exclude && new RegExp(src.exclude, "i");
  return items.filter((i) => (!inc || inc.test(i.title)) && !(exc && exc.test(i.title)));
}
