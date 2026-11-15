// 👍 누른 글을 구글 시트 "부엉 좋아요"에 한 줄씩 (Apps Script 웹 앱, scripts/sheet_webapp.gs).
// 주소·비밀 문구는 Worker 비밀값 SHEET_URL·SHEET_TOKEN. 같은 key는 시트 쪽에서 한 번만 쓴다.
// shortcut: 보내기 실패는 로그만 남기고 다시 보내지 않는다 (👍 기록은 D1 feedback에 남아 있다), 자주 빠지면 매분 cron으로 재시도한다
const TIMEOUT_MS = 10_000;

export async function toSheet(env, row) {
  if (!env.SHEET_URL || !env.SHEET_TOKEN) return;
  try {
    const res = await fetch(env.SHEET_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: env.SHEET_TOKEN, ...row }), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = (await res.text()).slice(0, 10);
    // 응답 원문은 남기지 않는다: 시트 스크립트의 고정 답(no·bad)만, 그 밖은 "unexpected"
    if (!["ok", "dup"].includes(text)) console.log(JSON.stringify({ event: "sheet_failed", status: res.status, reply: ["no", "bad"].includes(text) ? text : "unexpected" }));
  } catch (e) {
    console.log(JSON.stringify({ event: "sheet_failed", error: e.name })); // 원문엔 주소가 섞일 수 있어 종류만
  }
}
