"""부엉 2단계: 즉시 알림에 붙일 한국어 두 줄 요약 (Gemini 무료 등급). 실패하면 원문 첫 문장으로 대체한다."""
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PERSONA = ROOT / "config" / "persona.md"  # 부엉 말투 (Gemini 담당 파일)
MODEL = "gemini-3.5-flash-lite"  # 2.5 계열은 신규 키에서 막힘 (ai.google.dev/gemini-api/docs/models, 2026-11-14 확인)
MAX_BODY = 6000  # Gemini에 보낼 본문 길이 상한 (글자)
MAX_LINE = 300  # 요약 한 줄 길이 상한. 넘으면 형식이 틀린 응답으로 본다 (텔레그램 4,096자 보호)
TIMEOUT = 15  # 요청 하나당 초
BUDGET = 120  # 한 번 실행에서 요약에 쓸 총 초. 넘으면 나머지는 대체 문구로 보낸다 (작업 제한 10분 보호)
FORMAT = ("정확히 두 줄로만 답하세요. 1줄: 무엇이 나왔는지 한국어 한 문장. "
          "2줄: '→ '로 시작하는, 이게 왜 중요한지 한 문장. 다른 말은 쓰지 마세요.")
DEFAULT_PERSONA = "당신은 AI 소식을 차분한 존댓말로 전하는 올빼미 '부엉'입니다."

_spent = 0.0  # 이번 실행에서 요약에 쓴 시간


def first_sentence(text, limit=200):
    # shortcut: "U.S." 같은 약어에서 문장이 잘린다, 대체 문구가 자주 쓰이면 그때 고친다
    s = re.split(r"(?<=[.!?。])\s", text.strip(), maxsplit=1)[0] if text.strip() else ""
    return s if len(s) <= limit else s[:limit].rstrip() + "…"


def ask_gemini(system, prompt, key, limit=TIMEOUT):
    """limit초 안에 응답을 다 받지 못하면 TimeoutError. 응답이 조금씩 계속 와도 전체 시간으로 끊는다."""
    deadline = time.monotonic() + limit
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    body = json.dumps({
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"parts": [{"text": prompt}]}],
    }).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "x-goog-api-key": key})
    chunks = []
    with urllib.request.urlopen(req, timeout=limit) as r:
        while chunk := r.read1(8192):  # read1: 소켓 읽기 한 번씩 돌려받아야 시한 검사가 밀리지 않는다
            chunks.append(chunk)
            if time.monotonic() > deadline:
                raise TimeoutError("응답 수신 시간 초과")
    cand = json.loads(b"".join(chunks))["candidates"][0]
    if cand.get("finishReason") != "STOP":  # 잘림(MAX_TOKENS)·안전 차단 등
        raise ValueError(f"finishReason={cand.get('finishReason')}")
    parts = cand["content"]["parts"]
    return "".join(p.get("text", "") for p in parts if not p.get("thought"))  # 생각(thought) 파트는 빼고 순서대로


def valid_lines(text):
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if len(lines) == 2 and lines[1].startswith("→") and all(len(l) <= MAX_LINE for l in lines):
        return lines
    return None


def summarize(src_name, item):
    """요약 줄 목록을 돌려준다 (Gemini 두 줄 → 원문 첫 문장 한 줄 → 빈 목록 순으로 대체)."""
    global _spent
    body = item.get("summary", "")
    key = os.environ.get("GEMINI_API_KEY")
    left = min(TIMEOUT, BUDGET - _spent)  # 남은 예산만큼만 기다린다
    if key and left >= 1:
        started = time.monotonic()
        try:
            persona = PERSONA.read_text("utf-8") if PERSONA.exists() else DEFAULT_PERSONA
            prompt = f"출처: {src_name}\n제목: {item['title']}\n본문:\n{body[:MAX_BODY] or '(본문 없음, 제목만 보고 판단)'}"
            lines = valid_lines(ask_gemini(f"{persona}\n\n{FORMAT}", prompt, key, left))
            if lines:
                return lines
            print("  요약 형식이 맞지 않아 원문 첫 문장으로 대체")
        except Exception as e:  # 무료 등급 한도·장애로 요약이 안 돼도 알림은 나간다
            # 예외 본문에 헤더(키) 값이 섞일 수 있어 종류와 HTTP 코드만 남긴다
            code = f" HTTP {e.code}" if isinstance(e, urllib.error.HTTPError) else ""
            print(f"  요약 실패({type(e).__name__}{code}), 원문 첫 문장으로 대체")
        finally:
            _spent += time.monotonic() - started
    s = first_sentence(body)
    return [s] if s else []
