// 4단계 주간 리포트 (cron 0 11 * * SUN, 일요일 20:00 KST). 기획서 「3. 주간 리포트」.
// 지난 7일 D1 기록으로 출처별 알림 수·반응률·가장 유용했던 출처·반응 없던 출처·읽기 실패를 보내고,
// 반응 없던 즉시 알림 출처에는 「아침 요약으로 돌리기」 버튼을 붙인다 (누르면 settings에 기록, watch.js가 읽는다).
// 보내기는 아침 요약과 같은 outbox로: 실패해도 매분 cron이 이어 보낸다.
import { ALL } from "./sources.js";

const WEEK = 7 * 86400_000;
const KEEP_DAYS = 35; // runs(매분 1행) 보관 기간
const MIN_ALERTS = 3; // 이보다 적게 보낸 출처는 반응이 없어도 판단하지 않는다
const MAX_SUGGEST = 3; // 한 주에 제안할 설정 변경 수

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toMap = (results, key = "n") => new Map(results.map((r) => [r.source, r[key]]));

/** 지난 7일 숫자를 모은다 */
export async function stats(db, now) {
  const since = new Date(now.getTime() - WEEK).toISOString();
  const q = async (sql) => (await db.prepare(sql).bind(since, now.toISOString()).all()).results;
  const [alerts, reacted, ups, runs, health] = await Promise.all([
    q("SELECT source, COUNT(*) AS n FROM alerts WHERE at >= ? AND at < ? GROUP BY source"),
    q("SELECT a.source, COUNT(DISTINCT a.key) AS n FROM alerts a JOIN feedback f ON f.key = a.key WHERE a.at >= ? AND a.at < ? GROUP BY a.source"),
    q("SELECT a.source, COUNT(DISTINCT a.key) AS n FROM alerts a JOIN feedback f ON f.key = a.key WHERE f.action = 'u' AND a.at >= ? AND a.at < ? GROUP BY a.source"),
    q("SELECT source, COUNT(*) AS runs, SUM(new_items) AS n FROM runs WHERE at >= ? AND at < ? GROUP BY source"),
    db.prepare("SELECT source, fails, last_error FROM health").all().then((r) => r.results),
  ]);
  return { alerts: toMap(alerts), reacted: toMap(reacted), ups: toMap(ups), runs: toMap(runs, "runs"), items: toMap(runs), health };
}

/** 리포트 메시지들. 첫 번째는 요약, 그 뒤는 설정 변경 제안 (버튼 포함) */
export function report(s, modes = new Map()) {
  const sum = (m) => [...m.values()].reduce((a, b) => a + (b || 0), 0);
  const total = sum(s.alerts), reacted = sum(s.reacted);
  const lines = ["🦉 이번 주 부엉 리포트", `즉시 알림 ${total}건 · 반응 ${reacted}건 (${total ? Math.round((reacted / total) * 100) : 0}%)`];
  // runs.new_items = 보낸 알림 수 + 대기열에 넣은 수 → 전체에서 알림 수를 빼면 대기열 건수 (출처의 처리 방식과 무관)
  const digestItems = Math.max(0, sum(s.items) - total);
  lines.push(`아침 요약에 쌓인 글 ${digestItems}건`);
  const best = [...s.ups].sort((a, b) => b[1] - a[1])[0];
  if (best) lines.push(`가장 유용했던 출처: ${esc(best[0])} (👍 ${best[1]})`);
  const silent = ALL.filter((src) => modes.get(src.name) !== "digest"
    && (s.alerts.get(src.name) || 0) >= MIN_ALERTS && !s.reacted.get(src.name));
  if (silent.length) lines.push(`반응이 없던 출처: ${silent.map((src) => esc(src.name)).join(", ")}`);
  const failing = s.health.map((h) => `• ${esc(h.source)} 연속 ${h.fails}회 (${esc(h.last_error || "")})`);
  // 한 번도 성공 기록이 없는 출처: 읽기 실패뿐 아니라 CPU 한도로 끊겨 아무 기록도 못 남긴 경우도 여기서 드러난다
  const dead = ALL.filter((src) => !s.runs.get(src.name) && !s.health.some((h) => h.source === src.name));
  if (failing.length || dead.length) {
    lines.push("", "읽기 문제가 있는 출처:", ...failing, ...dead.map((src) => `• ${esc(src.name)}: 이번 주 성공 기록 없음`));
  }
  const msgs = [lines.join("\n")];
  for (const src of silent.slice(0, MAX_SUGGEST)) {
    const i = src.id;
    msgs.push({
      text: `${esc(src.name)}는 아침 요약으로만 보낼까요?`,
      reply_markup: { inline_keyboard: [[{ text: "그렇게 해줘", callback_data: `w:${i}` }, { text: "그대로 둬", callback_data: `k:${i}` }]] },
    });
  }
  return msgs;
}

export async function weekly(env, now) {
  const db = env.DB, at = now.toISOString();
  const modes = toMap((await db.prepare("SELECT source, mode FROM settings").all()).results, "mode");
  const msgs = report(await stats(db, now), modes);
  await db.batch([
    db.prepare("INSERT INTO outbox (batch, messages, sent, tries, at) VALUES (?, ?, 0, 0, ?)").bind(`weekly-${at}`, JSON.stringify(msgs), at),
    db.prepare("DELETE FROM runs WHERE at < ?").bind(new Date(now.getTime() - KEEP_DAYS * 86400_000).toISOString()),
  ]);
  console.log(JSON.stringify({ event: "weekly_prepared", messages: msgs.length }));
}
