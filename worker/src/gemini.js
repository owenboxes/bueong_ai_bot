/**
 * 부엉 즉시 알림용 Gemini 한국어 두 줄 요약 모듈 (Cloudflare Workers용).
 * 실패하거나 형식이 맞지 않으면 원문 첫 문장(없으면 빈 배열)으로 대체한다.
 */

export const MODEL = "gemini-3.5-flash-lite";
export const MAX_BODY = 6000;
export const MAX_LINE = 300;
export const TIMEOUT_MS = 15000;
export const FORMAT =
  "정확히 두 줄로만 답하세요. 1줄: 무엇이 나왔는지 한국어 한 문장. " +
  "2줄: '→ '로 시작하는, 이게 왜 중요한지 한 문장. 다른 말은 쓰지 마세요.";
export const DEFAULT_PERSONA =
  "당신은 AI 소식을 차분한 존댓말로 전하는 올빼미 '부엉'입니다.";

/** 원문에서 첫 문장을 추출해 limit 이내로 잘라 반환한다. */
export function firstSentence(text, limit = 200) {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  const s = trimmed.split(/(?<=[.!?。])\s/)[0];
  return s.length <= limit ? s : `${s.slice(0, limit).trimEnd()}…`;
}

/** Gemini 응답이 두 줄 형식(둘째 줄 '→' 시작, 각 줄 MAX_LINE 이하)인지 검증한다. */
export function validLines(text) {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (
    lines.length === 2 &&
    lines[1].startsWith("→") &&
    lines.every((l) => l.length <= MAX_LINE)
  ) {
    return lines;
  }
  return null;
}

/** Gemini generateContent API를 호출하고 thought 파트를 제외한 텍스트를 반환한다. */
export async function askGemini(
  system,
  prompt,
  key,
  { jsonMode = false, timeoutMs = TIMEOUT_MS } = {},
) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const payload = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ parts: [{ text: prompt }] }],
    ...(jsonMode
      ? { generationConfig: { responseMimeType: "application/json" } }
      : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const cand = data?.candidates?.[0];
  if (!cand) {
    throw new Error("empty_candidates");
  }
  if (cand.finishReason !== "STOP") {
    throw new Error(`finishReason=${cand.finishReason}`);
  }
  const parts = cand.content?.parts ?? [];
  return parts
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("");
}

/**
 * 항목을 두 줄로 요약한다.
 * @param {{ GEMINI_API_KEY?: string }} env
 * @param {string} srcName
 * @param {{ title?: string, url?: string, summary?: string }} item
 * @param {string} [persona]
 * @returns {Promise<string[]>}
 */
export async function summarize(env, srcName, item, persona) {
  const body = item?.summary || "";
  const key = env?.GEMINI_API_KEY;

  if (key) {
    const sysPersona =
      typeof persona === "string" && persona.trim()
        ? persona
        : DEFAULT_PERSONA;
    const prompt =
      `출처: ${srcName}\n` +
      `제목: ${item?.title || ""}\n` +
      `본문:\n${body.slice(0, MAX_BODY) || "(본문 없음, 제목만 보고 판단)"}`;

    try {
      const text = await askGemini(`${sysPersona}\n\n${FORMAT}`, prompt, key);
      const lines = validLines(text);
      if (lines) return lines;
      console.log(JSON.stringify({ event: "summary_failed", error: "invalid_format" }));
    } catch (e) {
      const error = e?.status
        ? `${e.name || "Error"} HTTP ${e.status}`
        : e?.name || "Error";
      console.log(JSON.stringify({ event: "summary_failed", error }));
    }
  }

  const s = firstSentence(body);
  return s ? [s] : [];
}
