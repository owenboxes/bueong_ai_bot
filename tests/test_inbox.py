import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

from cryptography.fernet import Fernet

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import digest  # noqa: E402
import inbox  # noqa: E402
import watch  # noqa: E402

ME = "123"
NOW = datetime(2026, 11, 15, 9, 0, tzinfo=watch.KST)
ALERTS = {"k1": {"source": "OpenAI 공식 블로그", "title": "Wallet", "url": "https://o/w", "at": "2026-11-15T08:00+09:00"}}


def chat(cid=ME, kind="private"):
    return {"id": int(cid), "type": kind}


def press(uid, data, cid=ME, sender=ME, kind="private"):
    return {"update_id": uid, "callback_query": {"id": f"cq{uid}", "data": data, "from": {"id": int(sender)},
                                                 "message": {"chat": chat(cid, kind)}}}


def say(uid, text, cid=ME, sender=ME, kind="private", entities=()):
    return {"update_id": uid, "message": {"chat": chat(cid, kind), "from": {"id": int(sender)},
                                          "text": text, "entities": list(entities)}}


class Handle(unittest.TestCase):
    def run_handle(self, updates, queue=None, feedback=None):
        self.queue, self.feedback = queue if queue is not None else [], feedback if feedback is not None else []
        self.replies, self.answers = [], []
        return inbox.handle(updates, ME, ALERTS, self.queue, self.feedback,
                            self.replies.append, lambda i, t: self.answers.append(t), NOW)

    def test_buttons_recorded_and_later_queued_once(self):
        off = self.run_handle([press(1, "u:k1"), press(2, "l:k1"), press(3, "l:k1")])
        self.assertEqual(off, 4)
        self.assertEqual([f["action"] for f in self.feedback], ["u", "l", "l"])
        self.assertEqual(self.feedback[0]["source"], "OpenAI 공식 블로그")
        self.assertEqual([(q["kind"], q["url"]) for q in self.queue], [("later", "https://o/w")])
        self.assertEqual(len(self.answers), 3)

    def test_links_from_text_and_hidden_entity(self):
        self.run_handle([say(5, "이거 봐 https://threads.net/p/1. 좋아",
                             entities=[{"type": "text_link", "url": "https://en.wikipedia.org/wiki/Python_(language)"}])])
        self.assertEqual([q["url"] for q in self.queue],
                         ["https://threads.net/p/1", "https://en.wikipedia.org/wiki/Python_(language)"])
        self.assertEqual(self.queue[0]["title"], "https://threads.net/p/1")  # 열어보지 않고 주소만
        self.assertEqual(self.replies, [inbox.GOT_LINK])

    def test_pasted_url_uses_telegram_entity_offsets(self):  # 일반 붙여넣기 + 앞에 이모지(UTF-16 2칸)
        text = "🦉 https://en.wikipedia.org/wiki/Python_(language) 봐줘"
        url = "https://en.wikipedia.org/wiki/Python_(language)"
        off = len("🦉 ".encode("utf-16-le")) // 2
        self.run_handle([say(12, text, entities=[{"type": "url", "offset": off, "length": len(url.encode("utf-16-le")) // 2}])])
        self.assertEqual([q["url"] for q in self.queue], [url])

    def test_plain_message_gets_help(self):
        self.run_handle([say(6, "안녕")])
        self.assertEqual((self.queue, self.replies), ([], [inbox.HELP]))

    def test_other_chats_ignored(self):  # 신뢰 경계: 봇 주소를 아는 다른 사람
        off = self.run_handle([
            say(7, "https://evil", cid="999", sender="999"), press(8, "l:k1", cid="999", sender="999"),
            say(9, "https://group", cid=ME, sender="999", kind="group"),  # 그룹에서 다른 사람
            press(10, "u:k1", cid=ME, sender="999"),  # 내 채팅 id인데 보낸 사람이 다름
        ])
        self.assertEqual(off, 11)  # 무시해도 offset은 넘겨 다시 받지 않는다
        self.assertEqual((self.queue, self.feedback, self.replies, self.answers), ([], [], [], []))

    def test_already_processed_update_skipped(self):
        self.run_handle([say(9, "https://a")], feedback=[{"update_id": 9, "at": "x"}])
        self.assertEqual((self.queue, self.replies), ([], []))

    def test_unknown_button_and_expired_alert_not_recorded(self):
        self.run_handle([press(10, "zz:k1"), press(11, "l:gone")])
        self.assertEqual((self.feedback, self.queue), ([], []))
        self.assertEqual(self.answers, [inbox.EXPIRED])


class Alerts(unittest.TestCase):
    def test_instant_alert_has_buttons_and_is_logged(self):
        calls, alerts = [], {}
        item = {"id": "x", "title": "t", "url": "https://u", "text": "t"}
        watch.process({"name": "s", "mode": "instant"}, [item], {"s": ["old"]}, [],
                      lambda t, s, m=None: calls.append(m), NOW, alerts)
        key = watch.alert_key("s", "x")
        self.assertNotEqual(key, watch.alert_key("other", "x"))  # 다른 피드의 같은 GUID
        self.assertEqual(alerts[key]["url"], "https://u")
        data = [b["callback_data"] for b in calls[0]["inline_keyboard"][0]]
        self.assertEqual(data, [f"u:{key}", f"d:{key}", f"l:{key}"])
        self.assertTrue(all(len(d.encode()) <= 64 for d in data))  # 텔레그램 callback_data 한도


class Offset(unittest.TestCase):
    def test_empty_poll_clears_old_offset(self):
        tmp = Path(tempfile.mkdtemp())
        with mock.patch.object(inbox, "OFFSET", tmp / "off.json"), \
             mock.patch.object(watch, "telegram", return_value=[]) as tg, \
             mock.patch.object(inbox.private, "PATH", tmp / "private.enc"), \
             mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "t", "TELEGRAM_CHAT_ID": ME,
                                          "BUEONG_STATE_KEY": Fernet.generate_key().decode()}, clear=True):
            watch.save(inbox.OFFSET, {"offset": 500})
            inbox.main()
            self.assertEqual(tg.call_args.kwargs["offset"], 500)
            self.assertEqual(watch.load(inbox.OFFSET, None), {})


class Pinned(unittest.TestCase):
    def test_digest_shows_links_and_later_without_ranking(self):
        items = [{"source": "HN", "title": "일반", "url": "https://h"}]
        pinned = [{"source": "보낸 링크", "title": "스레드", "url": "https://t", "kind": "link"},
                  {"source": "OpenAI", "title": "Wallet", "url": "https://w", "kind": "later"}]
        text = "\n".join(digest.build(items, [(1, "")], "https://l", pinned))
        self.assertIn("밤사이 1건", text)
        self.assertIn("━ 📌 보내준 링크 (1)", text)
        self.assertIn("━ 🌙 자세히 보기로 한 글 (1)", text)
        only_pinned = "\n".join(digest.build([], None, "https://l", pinned))
        self.assertIn("새 글은 없었어요", only_pinned)
        self.assertIn("스레드", only_pinned)
        self.assertNotIn("스레드", digest.full_list(items, [(1, "")], "b"))


if __name__ == "__main__":
    unittest.main()
