// 부엉 Cloudflare Worker (DESIGN.md).
// - scheduled: 매분 출처 1개를 순환 감시 (watch.js)
// - scheduled 0 23 * * * (08:00 KST): 아침 요약 준비 (digest.js). 보내기는 매분 cron이 이어서 한다
// - scheduled 0 11 * * SUN (일 20:00 KST): 주간 리포트 준비 (weekly.js). 보내기는 아침 요약과 같은 outbox
// - fetch GET /digest/<batch>: 아침 요약 전체 목록 (비밀 링크), POST /digest/<batch>/like/<i>: 그 글 👍 (시트에도)
// - fetch POST /telegram: 텔레그램 webhook. 버튼·링크를 받는 즉시 기록하고 답한다 (inbox.js)
// 비밀 값(wrangler secret): TG_TOKEN, TG_CHAT_ID, TG_SECRET(webhook 확인용 임의 문자열), GEMINI_API_KEY,
//   PAUSED(있으면 cron이 아무것도 안 함, 되돌리기용), BASE_URL(이 Worker 주소, 전체 목록 링크용. 공개 저장소에 주소를 남기지 않으려고 비밀 값으로 둔다)
import { watch } from "./watch.js";
import { handleTelegram } from "./inbox.js";
import { prepare, sendOutbox, digestPage, likeDigest } from "./digest.js";
import { weekly } from "./weekly.js";
import persona from "../../config/persona.md"; // 부엉 말투 (Gemini 담당 파일). wrangler.toml의 Text 규칙으로 묶는다
import priorities from "../../config/priorities.md"; // 아침 요약 중요도 기준 (Gemini 담당 파일)

export default {
  async scheduled(event, env, ctx) {
    if (env.PAUSED) return; // 멈춤 스위치: secret PAUSED=1을 넣으면 바로 모든 cron이 아무것도 안 한다 (cron 설정 변경은 전파가 늦다)
    const now = new Date(event.scheduledTime);
    if (event.cron === "0 23 * * *") return prepare(env, now, persona, priorities);
    if (event.cron === "0 11 * * SUN") return weekly(env, now);
    try {
      await sendOutbox(env); // 남은 아침 요약 조각이 있으면 먼저 (대부분의 분에는 조회 한 번으로 끝)
    } catch (e) { // 보내기 문제가 감시를 막지 않게
      console.log(JSON.stringify({ event: "outbox_failed", error: e.message }));
    }
    await watch(env, now, persona);
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram") return handleTelegram(request, env, ctx, persona);
    const m = request.method === "GET" && url.pathname.match(/^\/digest\/([^/]+)$/);
    if (m) return digestPage(env, m[1]);
    const like = request.method === "POST" && url.pathname.match(/^\/digest\/([^/]+)\/like\/([^/]+)$/);
    if (like) return likeDigest(env, like[1], like[2], new Date(), (p) => ctx.waitUntil(p));
    return new Response("bueong");
  },
};
