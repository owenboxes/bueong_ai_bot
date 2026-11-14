"""부엉 3단계: 매일 08:00(KST) 아침 요약.

두 단계로 나눠 실행한다 (워크플로가 사이에 커밋·push):
  python src/digest.py prepare  대기열을 정렬해 전체 목록(digests/배치.md)과 보낼 메시지(state/outbox.json)를 확정하고 대기열을 비운다
  python src/digest.py send     outbox의 메시지를 이어서 보낸다. 성공한 조각까지 진행도를 저장한다
  python src/digest.py --dry-run  정렬·메시지만 출력 (상태 변경 없음)
"""
import html
import json
import os
import sys
import urllib.error
from datetime import datetime

import summary
import watch

PRIORITIES = watch.ROOT / "config" / "priorities.md"  # 중요도 기준 (Gemini 담당 파일)
DIGESTS = watch.ROOT / "digests"  # 배치별 전체 목록 (텔레그램 「나머지」 링크가 가리킴)
OUTBOX = watch.ROOT / "state" / "outbox.json"  # 확정된 메시지와 보낸 개수
TG_LIMIT = 4000  # 텔레그램 한도 4,096자보다 조금 여유
RANK_TIMEOUT = 60  # 하루치를 한 번에 정렬하므로 즉시 알림보다 길게
TITLE_MAX, LINE_MAX, URL_MAX = 100, 200, 500  # 블록 하나가 TG_LIMIT를 넘지 않게 하는 상한
RANK_FORMAT = (
    "아래 글 목록을 중요도 기준에 따라 등급을 매기세요. JSON 배열로만 답하세요. "
    '각 원소: {"i": 글 번호, "tier": 1|2|3, "line": "1·2등급만, 한국어 한 문장 요약 (3등급은 빈 문자열)"}. '
    "모든 글 번호를 한 번씩 포함하세요."
)
DEFAULT_PRIORITIES = "1등급: 에이전트·SDK·도구 사용법, 신제품·요금·정책 변경. 2등급: 따라 해볼 수 있는 튜토리얼·예제. 나머지 3등급."


def is_int(v):
    return type(v) is int  # bool(True/False)은 int의 하위 타입이라 isinstance로는 걸러지지 않는다


def check_ranks(rows, n):
    """Gemini 답을 검증해 [(tier, line)]으로. 형식이 어긋나면 None (출처별 목록으로 대체)."""
    if not isinstance(rows, list) or not rows:  # 빈 답은 정렬 실패로 본다
        return None
    result, seen = [(3, "")] * n, set()
    for r in rows:
        if not isinstance(r, dict):
            return None
        i, tier, line = r.get("i"), r.get("tier"), r.get("line") or ""
        if not (is_int(i) and 0 <= i < n and i not in seen and is_int(tier) and tier in (1, 2, 3)):
            return None
        seen.add(i)
        result[i] = (tier, line.strip() if isinstance(line, str) and len(line) <= LINE_MAX else "")
    # 빠진 번호는 3등급으로 둔다: 하루 150건쯤에서 몇 건 빠졌다고 정렬 전체를 버리는 쪽이 더 손해
    return result


def rank(items):
    """[(tier, line)]을 items 순서대로 돌려준다. Gemini를 못 쓰면 None."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key or not items:
        return None
    try:
        system = "\n\n".join([
            summary.PERSONA.read_text("utf-8") if summary.PERSONA.exists() else summary.DEFAULT_PERSONA,
            PRIORITIES.read_text("utf-8") if PRIORITIES.exists() else DEFAULT_PRIORITIES,
            RANK_FORMAT,
        ])
        prompt = "\n".join(f"{n}. [{it['source']}] {it['title']}" for n, it in enumerate(items))
        rows = json.loads(summary.ask_gemini(system, prompt, key, RANK_TIMEOUT, json_mode=True))
    except Exception as e:  # 정렬이 안 돼도 아침 요약은 목록으로 나간다
        code = f" HTTP {e.code}" if isinstance(e, urllib.error.HTTPError) else ""
        print(f"정렬 실패({type(e).__name__}{code}), 출처별 목록으로 보냄")
        return None
    result = check_ranks(rows, len(items))
    if result is None:
        print("정렬 답 형식이 맞지 않아 출처별 목록으로 보냄")
    return result


def esc(text):
    return html.escape(text, quote=False)  # 본문 텍스트는 따옴표를 바꿀 필요가 없다 (길이 증가 줄이기)


def link(it, line=""):
    title = esc(it["title"][:TITLE_MAX])
    url = html.escape(it["url"], quote=True)
    a = f"<a href=\"{url}\">{title}</a>" if len(url) <= URL_MAX else title  # 이스케이프 후에도 긴 주소는 링크 없이
    return f"[{esc(it['source'][:40])}] {a}" + (f" – {esc(line)}" if line else "")


def build(items, ranks, list_url):
    """텔레그램으로 보낼 메시지 블록 목록 (각 블록은 한 덩어리로 유지)."""
    if not items:
        return ["🦉 좋은 아침이에요.\n밤사이 새로 들어온 글은 없었어요. 오늘도 잘 다녀와요."]
    blocks = [f"🦉 좋은 아침이에요.\n밤사이 {len(items)}건이 들어왔어요. 중요한 것부터 볼게요."]
    if ranks is None:  # 정렬 없이: 출처별 건수 + 전체 목록
        counts = {}
        for it in items:
            counts[it["source"]] = counts.get(it["source"], 0) + 1
        blocks.append("오늘은 중요도 정렬을 못 했어요. 출처별로 모아뒀어요.")
        blocks += [f"• {esc(s[:40])} {n}건" for s, n in counts.items()]
        blocks.append(f"<a href=\"{list_url}\">→ 전체 목록 보기</a>")
        return blocks
    for tier, name in ((1, "꼭 볼 것"), (2, "알아두면 좋은 것")):
        picked = [(it, line) for it, (t, line) in zip(items, ranks) if t == tier]
        if picked:
            blocks.append(f"\n━ {name} ({len(picked)})")
            blocks += [f"{n}. {link(it, line)}" for n, (it, line) in enumerate(picked, 1)]
    rest = sum(1 for t, _ in ranks if t == 3)
    blocks.append(f"\n━ 나머지 ({rest}) <a href=\"{list_url}\">→ 전체 목록 보기</a>")
    blocks.append("\n위에 있는 것만 봐도 충분해요. 오늘도 잘 다녀와요.")
    return blocks


def split(blocks, limit=None):
    """블록을 자르지 않고 limit 이하 메시지들로 묶는다 (HTML 태그가 잘리지 않게)."""
    limit = limit or TG_LIMIT
    msgs, cur = [], ""
    for b in blocks:
        assert len(b) <= limit, "블록 길이 상한(TITLE/LINE/URL_MAX)이 지켜지지 않음"
        if cur and len(cur) + 1 + len(b) > limit:
            msgs.append(cur)
            cur = b
        else:
            cur = f"{cur}\n{b}" if cur else b
    return msgs + ([cur] if cur else [])


def full_list(items, ranks, batch):
    lines = [f"# 부엉 아침 요약 {batch} — 전체 {len(items)}건", ""]
    order = sorted(range(len(items)), key=lambda i: (ranks[i][0] if ranks else 3, items[i]["source"]))
    for i in order:
        it = items[i]
        tier = f"{ranks[i][0]}등급 · " if ranks else ""
        lines.append(f"- {tier}[{it['source']}] [{it['title']}]({it['url']})")
    return "\n".join(lines) + "\n"


def mark_saved():
    if os.environ.get("GITHUB_OUTPUT"):  # 워크플로는 이 표시가 있을 때만 커밋한다
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write("saved=true\n")


def prepare(now):
    box = watch.load(OUTBOX, {})
    if box.get("sent", 0) < len(box.get("messages", [])):  # 어제 다 못 보낸 요약부터 마저 보낸다
        print("이전 아침 요약을 이어서 보냅니다 (새 대기열은 내일로)")
        mark_saved()
        return
    items = watch.load(watch.QUEUE, [])
    # 배치마다 고유 경로: 같은 날·같은 분에 다시 돌려도 이전 링크가 바뀌지 않게 실행 ID를 붙인다
    # Re-run은 RUN_ID를 재사용하므로 시도 번호(RUN_ATTEMPT)까지 붙인다
    run = "-".join(os.environ[k] for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT") if os.environ.get(k))
    batch = now.strftime("%Y-%m-%d-%H%M") + (f"-{run}" if run else "")
    repo = os.environ.get("GITHUB_REPOSITORY", "owenboxes/bueong_ai_bot")
    branch = os.environ.get("GITHUB_REF_NAME", "main")  # 실제로 게시되는 브랜치에 링크
    ranks = rank(items)
    msgs = split(build(items, ranks, f"https://github.com/{repo}/blob/{branch}/digests/{batch}.md"))
    if items:
        DIGESTS.mkdir(exist_ok=True)
        watch.save_text(DIGESTS / f"{batch}.md", full_list(items, ranks, batch))
    watch.save(OUTBOX, {"batch": batch, "messages": msgs, "sent": 0})  # outbox 먼저: 중간 실패 시 누락 대신 중복
    watch.save(watch.QUEUE, [])
    mark_saved()


def send_outbox(send):
    box = watch.load(OUTBOX, {})
    msgs, sent = box.get("messages", []), box.get("sent", 0)
    try:
        while sent < len(msgs):
            send(msgs[sent], False)
            sent += 1
    finally:  # 실패해도 성공한 조각까지는 기록해 다음 실행에서 이어 보낸다
        if msgs:
            watch.save(OUTBOX, {**box, "sent": sent} if sent < len(msgs) else {})
        mark_saved()


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "--dry-run":
        items = watch.load(watch.QUEUE, [])
        for m in split(build(items, rank(items), "https://example.invalid/digests/DRY.md")):
            print(m + "\n" + "-" * 20)
    elif cmd == "prepare":
        prepare(datetime.now(watch.KST))
    elif cmd == "send":
        if not os.environ.get("TELEGRAM_BOT_TOKEN") or not os.environ.get("TELEGRAM_CHAT_ID"):
            sys.exit("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID가 없습니다")
        send_outbox(watch.send_telegram)
    else:
        sys.exit("사용법: digest.py prepare | send | --dry-run")


if __name__ == "__main__":
    main()
