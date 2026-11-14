// 부엉 Cloudflare Worker (DESIGN.md).
// - scheduled: 매분 출처 1개를 순환 감시 (watch.js)
// - fetch POST /telegram: 텔레그램 webhook. 2단계에서 버튼·링크 처리로 바꾼다
// 비밀 값(wrangler secret): TG_TOKEN, TG_CHAT_ID, TG_SECRET(webhook 확인용 임의 문자열), GEMINI_API_KEY
import { watch } from "./watch.js";
import { tg } from "./telegram.js";
import persona from "../../config/persona.md"; // 부엉 말투 (Gemini 담당 파일). wrangler.toml의 Text 규칙으로 묶는다

export async function handleTelegram(request, env) {
  // 신뢰 경계: 텔레그램이 setWebhook 때 받은 secret_token을 헤더로 돌려준다. 없거나 다르면 가짜 요청
  if (!env.TG_SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== env.TG_SECRET) {
    return new Response("forbidden", { status: 403 }); // 비밀 값이 설정되지 않았으면 무엇도 통과시키지 않는다
  }
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const msg = update?.message;
  const mine = msg && msg.chat?.type === "private" && String(msg.chat.id) === env.TG_CHAT_ID && String(msg.from?.id) === env.TG_CHAT_ID;
  if (mine) {
    try {
      await tg(env, "sendMessage", { chat_id: env.TG_CHAT_ID, text: "🦉 [시험판] 받았어요. (Cloudflare에서 바로 답하는 중)" });
    } catch (e) { // 답장이 실패해도 200: 500을 주면 텔레그램이 같은 메시지를 계속 다시 보낸다
      console.log(JSON.stringify({ event: "reply_failed", error: e.message }));
    }
  }
  return new Response("ok"); // 남의 메시지에도 200: 텔레그램이 같은 요청을 계속 다시 보내지 않게
}

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
