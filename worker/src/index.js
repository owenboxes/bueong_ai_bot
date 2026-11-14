// 부엉 Cloudflare Worker (DESIGN.md).
// - scheduled: 매분 출처 1개를 순환 감시 (watch.js)
// - fetch POST /telegram: 텔레그램 webhook. 버튼·링크를 받는 즉시 기록하고 답한다 (inbox.js)
// 비밀 값(wrangler secret): TG_TOKEN, TG_CHAT_ID, TG_SECRET(webhook 확인용 임의 문자열), GEMINI_API_KEY
import { watch } from "./watch.js";
import { handleTelegram } from "./inbox.js";
import persona from "../../config/persona.md"; // 부엉 말투 (Gemini 담당 파일). wrangler.toml의 Text 규칙으로 묶는다

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "* * * * *") await watch(env, new Date(event.scheduledTime), persona);
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram") return handleTelegram(request, env);
    return new Response("bueong");
  },
};
