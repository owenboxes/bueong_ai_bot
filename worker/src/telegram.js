const TG_TIMEOUT_MS = 10_000;

/** 텔레그램 Bot API 호출. 결과(result)를 돌려주고, 실패하면 예외 (메시지에 토큰을 넣지 않는다) */
export async function tg(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await r.json();
  if (!body.ok) throw new Error(`telegram ${method} ok=false`);
  return body.result;
}
