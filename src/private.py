"""개인 기록(보낸 링크, 🌙 누른 글, 버튼 기록, 아침 요약 발송분)을 암호화해 state/private.enc에 둔다.

공개 저장소라 이 파일만 암호화한다. 키는 BUEONG_STATE_KEY (GitHub Secrets, 로컬은 .env).
암호문은 같은 내용이어도 매번 달라지므로, 내용이 바뀌었을 때만 다시 쓴다 (git 이력이 쌓이지 않게).
"""
import copy
import json
import os

from cryptography.fernet import Fernet

import watch

PATH = watch.ROOT / "state" / "private.enc"
EMPTY = {"pinned": [], "feedback": [], "outbox": {}}


def _fernet():
    key = os.environ.get("BUEONG_STATE_KEY")
    if not key:  # 키 없이 진행하면 개인 기록을 평문으로 남기거나 잃게 된다
        raise RuntimeError("BUEONG_STATE_KEY가 없습니다")
    return Fernet(key)


def _read():
    return json.loads(_fernet().decrypt(PATH.read_bytes())) if PATH.exists() else None


def load():
    _fernet()  # 파일이 아직 없어도 키부터 확인: 입력을 처리해 놓고 저장에서 실패하는 일이 없게
    data = _read() or {}
    return {k: data.get(k, copy.deepcopy(v)) for k, v in EMPTY.items()}


def save(data):
    """바뀌었으면 암호화해 저장하고 True, 그대로면 쓰지 않고 False."""
    if _read() == data or (not PATH.exists() and data == EMPTY):
        return False
    token = _fernet().encrypt(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode())
    watch.save_text(PATH, token.decode())  # Fernet 토큰은 ASCII라 텍스트로 써도 된다
    return True
