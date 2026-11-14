"""5단계 전환용 한 번짜리: GitHub 버전 state/를 운영 D1에 넣을 SQL로 바꿔 표준 출력에 쓴다.

실행: python worker/scripts/export_state.py <state 폴더> > /tmp/…/import.sql
  - <state 폴더>: GitHub 워크플로를 끈 뒤 origin/main의 state/를 꺼내 둔 곳 (seen.json, sent.json, queue.json, private.enc)
  - BUEONG_STATE_KEY 환경 변수가 있으면 private.enc(보낸 링크·🌙·버튼 기록)도 넣는다
옮기는 것: seen(새 글 판단), alerts(보낸 알림 → 옛 알림의 버튼이 계속 동작), queue, pinned, feedback.
arXiv는 GitHub 버전과 글 id 형식이 달라(RSS GUID ↔ API 주소) 옮기지 않는다. Worker가 첫 실행으로 기록만 한다.
  허용한 예외: 전환 사이에 올라온 arXiv 논문은 아침 요약에 안 들어갈 수 있다 (아침 요약 전용, 즉시 알림 아님. GitHub seen에도 arXiv는 0건).
옮기면 안 되는 상태(키 없음, 안 보낸 아침 요약)면 SQL을 만들지 않고 0이 아닌 코드로 끝난다.
SQL은 개인 기록을 담으므로 저장소 밖 임시 폴더에 쓰고, 넣은 뒤 지운다.
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

SKIP_SEEN = {"arXiv 에이전트 논문"}


def q(v):
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"


def utc(at):
    """GitHub 버전의 KST 분 단위 시각(2026-11-14T15:16+09:00)을 Worker 형식(UTC ISO, ms·Z)으로. D1은 이 문자열을 사전순으로 비교한다"""
    return datetime.fromisoformat(at).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def rows(table, cols, values):
    return [f"INSERT OR IGNORE INTO {table} ({', '.join(cols)}) VALUES ({', '.join(map(q, v))});" for v in values]


class Stop(Exception):
    """옮기면 안 되는 상태: SQL을 만들지 않고 멈춘다"""


def export(state, key=None, now=None):
    load = lambda name, default: json.loads((state / name).read_text("utf-8")) if (state / name).exists() else default
    now = utc((now or datetime.now(timezone.utc)).isoformat())
    out = []
    for source, ids in load("seen.json", {}).items():
        if source not in SKIP_SEEN:
            out += rows("seen", ("source", "id", "at"), [(source, i, now) for i in ids])
    out += rows("alerts", ("key", "source", "title", "url", "at"),
                [(k, a["source"], a["title"], a["url"], utc(a["at"])) for k, a in load("sent.json", {}).items()])
    out += rows("queue", ("source", "id", "title", "url", "at"),  # GitHub 대기열엔 id가 없어 주소를 id로
                [(it["source"], it["url"], it["title"], it["url"], utc(it["at"])) for it in load("queue.json", [])])
    if key and (state / "private.enc").exists():
        from cryptography.fernet import Fernet
        priv = json.loads(Fernet(key).decrypt((state / "private.enc").read_bytes()))
        out += rows("pinned", ("kind", "url", "title", "source", "at"),
                    [(p["kind"], p["url"], p["title"], p["source"], utc(p["at"])) for p in priv.get("pinned", [])])
        out += rows("feedback", ("update_id", "key", "action", "source", "at"),
                    [(f["update_id"], f.get("key"), f["action"], f.get("source"), utc(f["at"])) for f in priv.get("feedback", [])])
        box = priv.get("outbox") or {}
        if box.get("sent", 0) < len(box.get("messages", [])):  # 다 못 보낸 아침 요약이 있으면 전환하지 않는다 (08:00을 피하면 생기지 않음)
            raise Stop(f"GitHub outbox에 안 보낸 조각 {len(box['messages']) - box['sent']}개: 다 보낸 뒤 다시")
    elif (state / "private.enc").exists():
        raise Stop("BUEONG_STATE_KEY가 없어 보낸 링크·🌙·버튼 기록을 옮길 수 없음")
    return out


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("사용법: export_state.py <state 폴더>")
    try:
        lines = export(Path(sys.argv[1]), os.environ.get("BUEONG_STATE_KEY"))
    except Stop as e:
        sys.exit(f"중단: {e}")
    print("\n".join(lines))
    print(f"{len(lines)}행", file=sys.stderr)
