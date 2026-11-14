"""부엉 4단계: 텔레그램 입력(버튼 누름, 내가 보낸 링크)을 15분마다 가져와 기록한다.

- 👍/👎 → 개인 기록 feedback (주간 리포트용)
- 🌙 아침에 자세히 → 그 글을 개인 기록 pinned에 「자세히」로 넣는다 (다음 아침 요약에 표시)
- 링크를 보내면 → 개인 기록 pinned에 「보낸 링크」로 넣고 받았다고 답한다
개인 기록은 state/private.enc에 암호화해 둔다 (private.py)
실행: python src/inbox.py   (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID 필요)
"""
import os
import re
import sys
from datetime import datetime, timedelta

import private
import watch

OFFSET = watch.ROOT / "state" / "tg_offset.json"  # 다음에 가져올 update_id
URL_RE = re.compile(r"https?://[^\s<>\"']+")
MAX_LINKS = 5  # 메시지 하나에서 받을 링크 수 상한
ANSWERS = {"u": "👍 기록했어요", "d": "👎 기록했어요", "l": "🌙 내일 아침 요약에 넣을게요"}
GOT_LINK = "🦉 받았어요.\n내일 아침 요약에 정리해둘게요."
EXPIRED = "오래된 알림이라 기록하지 못했어요"
HELP = "🦉 링크를 보내주시면 다음 아침 요약에 정리해둘게요."


def urls_in(msg):
    text = msg.get("text") or msg.get("caption") or ""
    entities = msg.get("entities", []) + msg.get("caption_entities", [])
    utf16 = text.encode("utf-16-le")  # 텔레그램 offset/length는 UTF-16 단위
    found = []
    if not any(e.get("type") == "url" for e in entities):  # 엔티티가 없을 때만 직접 찾는다
        found += [u.rstrip(").,]") for u in URL_RE.findall(text)]
    for e in entities:
        if e.get("type") == "url":  # 텔레그램이 찾은 주소: 위치대로 원문 그대로 (끝 괄호 보존)
            found.append(utf16[e["offset"] * 2:(e["offset"] + e["length"]) * 2].decode("utf-16-le"))
        elif e.get("type") == "text_link" and e.get("url"):  # 글자에 숨겨진 링크: 텔레그램이 준 주소 그대로
            found.append(e["url"])
    return list(dict.fromkeys(found))[:MAX_LINKS]


def mine(chat, sender, chat_id):
    """내 개인 채팅에서 나 자신이 보낸 것만 받는다 (그룹에선 chat_id만으로 보낸 사람을 보장 못 함)."""
    chat, sender = chat or {}, sender or {}
    return chat.get("type") == "private" and str(chat.get("id")) == chat_id and str(sender.get("id")) == chat_id


def handle(updates, chat_id, alerts, queue, feedback, reply, answer, now):  # queue: 개인 기록의 pinned
    """updates를 처리하고 다음 offset을 돌려준다. 내 채팅이 아닌 곳에서 온 입력은 무시한다."""
    at = now.isoformat(timespec="minutes")
    done_ids = {f.get("update_id") for f in feedback}
    queued = {(q.get("kind"), q["url"]) for q in queue}
    offset = None
    for u in updates:
        offset = u["update_id"] + 1
        if u["update_id"] in done_ids:  # 커밋 실패로 같은 입력을 다시 받은 경우
            continue
        cq = u.get("callback_query")
        msg = u.get("message")
        if cq:
            if not mine((cq.get("message") or {}).get("chat"), cq.get("from"), chat_id):
                continue  # 신뢰 경계: 다른 사람이 누른 버튼
            action, _, key = (cq.get("data") or "").partition(":")
            if action not in ANSWERS:
                continue
            info = alerts.get(key)
            if not info:  # 오래돼 지워졌거나 모르는 알림: 기록하지 않는다
                answer(cq["id"], EXPIRED)
                continue
            answer(cq["id"], ANSWERS[action])
            feedback.append({"update_id": u["update_id"], "key": key, "action": action,
                             "source": info["source"], "at": at})
            if action == "l" and ("later", info["url"]) not in queued:
                queue.append({"source": info["source"], "title": info["title"], "url": info["url"],
                              "kind": "later", "at": at})
                queued.add(("later", info["url"]))
        elif msg:
            if not mine(msg.get("chat"), msg.get("from"), chat_id):
                continue  # 신뢰 경계: 다른 사람이 보낸 메시지
            links = urls_in(msg)
            for url in links:
                if ("link", url) in queued:
                    continue
                # 보낸 링크는 열어보지 않고 주소만 저장한다 (러너에서 임의 주소에 접속하지 않기 위해)
                queue.append({"source": "보낸 링크", "title": url, "url": url, "kind": "link", "at": at})
                queued.add(("link", url))
            reply(GOT_LINK if links else HELP)
            feedback.append({"update_id": u["update_id"], "action": "link" if links else "msg", "at": at})
    return offset


def mark_saved():
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write("saved=true\n")


def main():
    if not os.environ.get("TELEGRAM_BOT_TOKEN") or not os.environ.get("TELEGRAM_CHAT_ID"):
        sys.exit("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID가 없습니다")
    chat_id = os.environ["TELEGRAM_CHAT_ID"]
    priv = private.load()  # 키가 없으면 여기서 멈춘다 (입력을 받아놓고 저장 못 하는 일이 없게)
    start = watch.load(OFFSET, {}).get("offset")
    params = {"timeout": 0, "allowed_updates": ["message", "callback_query"]}
    if start:
        params["offset"] = start
    updates = watch.telegram("getUpdates", **params)
    if not updates:
        if start:  # 이 호출로 이전 입력은 확정됐다. 텔레그램은 1주 조용하면 번호를 새로 고르므로 offset을 비운다
            watch.save(OFFSET, {})
            mark_saved()
        return

    def answer(cq_id, text):
        try:
            watch.telegram("answerCallbackQuery", callback_query_id=cq_id, text=text)
        except Exception:  # 15분 뒤라 버튼 응답 시한이 지났을 수 있다. 기록은 그대로 한다
            pass

    def reply(text):
        try:
            watch.send_telegram(text, watch.is_quiet(datetime.now(watch.KST)))
        except Exception as e:  # 답장을 못 해도 받은 링크 기록은 남긴다
            print(f"답장 실패({type(e).__name__})")

    offset = handle(updates, chat_id, watch.load(watch.ALERTS, {}), priv["pinned"], priv["feedback"], reply, answer,
                    datetime.now(watch.KST))
    cutoff = (datetime.now(watch.KST) - timedelta(days=watch.ALERT_DAYS)).isoformat(timespec="minutes")
    priv["feedback"] = [f for f in priv["feedback"] if f["at"] >= cutoff]
    private.save(priv)
    watch.save(OFFSET, {"offset": offset})  # 마지막에: 앞이 실패하면 다음 실행에서 같은 입력을 다시 받는다
    mark_saved()
    print(f"텔레그램 입력 {len(updates)}건 처리")


if __name__ == "__main__":
    main()
