"""export_state.py 자체 점검: python worker/scripts/test_export_state.py (네트워크 없음, 만든 SQL을 진짜 schema.sql에 넣어 본다)"""
import json
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from export_state import export  # noqa: E402

from cryptography.fernet import Fernet  # noqa: E402

SCHEMA = (Path(__file__).parent.parent / "schema.sql").read_text("utf-8")

with tempfile.TemporaryDirectory() as d:
    st = Path(d)
    (st / "seen.json").write_text(json.dumps({"OpenAI 공식 블로그": ["a", "it's"], "arXiv 에이전트 논문": ["x"]}))
    (st / "sent.json").write_text(json.dumps({"k1": {"source": "OpenAI 공식 블로그", "title": "제목 '따옴표'", "url": "https://x/1", "at": "2026-11-14T15:16+09:00"}}))
    (st / "queue.json").write_text(json.dumps([{"source": "GeekNews", "title": "t", "url": "https://g/1", "at": "2026-11-14T15:16+09:00"}]))
    key = Fernet.generate_key()
    priv = {"pinned": [{"source": "보낸 링크", "title": "https://l", "url": "https://l", "kind": "link", "at": "2026-11-14T16:00+09:00"}],
            "feedback": [{"update_id": 7, "key": "k1", "action": "u", "source": "OpenAI 공식 블로그", "at": "2026-11-14T16:01+09:00"}],
            "outbox": {}}
    (st / "private.enc").write_bytes(Fernet(key).encrypt(json.dumps(priv).encode()))

    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)
    sql = export(st, key, datetime(2026, 11, 14, 11, tzinfo=timezone.utc))
    db.executescript("\n".join(sql + sql))  # 두 번 넣어도 같은 결과 (INSERT OR IGNORE)

    assert db.execute("SELECT source, id FROM seen ORDER BY id").fetchall() == [("OpenAI 공식 블로그", "a"), ("OpenAI 공식 블로그", "it's")]
    assert db.execute("SELECT title, at FROM alerts").fetchall() == [("제목 '따옴표'", "2026-11-14T06:16:00.000Z")]
    assert db.execute("SELECT id, at FROM queue").fetchall() == [("https://g/1", "2026-11-14T06:16:00.000Z")]
    assert db.execute("SELECT kind, url FROM pinned").fetchall() == [("link", "https://l")]
    assert db.execute("SELECT update_id, key, action FROM feedback").fetchall() == [(7, "k1", "u")]
    from export_state import Stop
    try:
        export(st)  # private.enc가 있는데 키가 없으면 멈춘다
        raise AssertionError("멈춰야 함")
    except Stop:
        pass
    priv["outbox"] = {"messages": ["a", "b"], "sent": 1}
    (st / "private.enc").write_bytes(Fernet(key).encrypt(json.dumps(priv).encode()))
    try:
        export(st, key)  # 안 보낸 아침 요약이 있으면 멈춘다
        raise AssertionError("멈춰야 함")
    except Stop:
        pass
print("ok")
