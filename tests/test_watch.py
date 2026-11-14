import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import watch  # noqa: E402

RSS = """<rss><channel>
<item><title>A</title><link>https://x/a</link><guid>ga</guid></item>
<item><title>B</title><link>https://x/b</link></item>
</channel></rss>"""

ATOM = """<feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>t1</id><title>0.169.0</title><link rel="alternate" href="https://g/1"/></entry>
<entry><id>t2</id><title>rust-v0.171.0-alpha.3</title><link rel="alternate" href="https://g/2"/></entry>
</feed>"""

SRC = {"name": "s", "mode": "instant"}
NOON = datetime(2026, 11, 14, 12, tzinfo=watch.KST)


def item(i):
    return {"id": i, "title": i, "url": f"https://x/{i}", "text": i}


class T(unittest.TestCase):
    def test_parse_rss_and_atom(self):
        self.assertEqual([(i["id"], i["url"]) for i in watch.parse_feed(RSS)],
                         [("ga", "https://x/a"), ("https://x/b", "https://x/b")])
        self.assertEqual([i["title"] for i in watch.parse_feed(ATOM)], ["0.169.0", "rust-v0.171.0-alpha.3"])

    def test_exclude_alpha(self):
        watch.get = lambda url: ATOM
        got = watch.fetch({"type": "feed", "url": "u", "exclude": "-(alpha|beta|rc)"})
        self.assertEqual([i["title"] for i in got], ["0.169.0"])

    def test_first_run_seeds_without_sending(self):
        sent, seen = [], {}
        out, _ = watch.process(SRC, [item("a"), item("b")], seen, [], lambda t, s: sent.append(t), NOON)
        self.assertEqual((out, sent), (["a", "b"], []))

    def test_new_item_sent_and_failed_send_retried(self):
        sent = []
        out, _ = watch.process(SRC, [item("new"), item("a")], {"s": ["a"]}, [], lambda t, s: sent.append(t), NOON)
        self.assertEqual(len(sent), 1)
        self.assertEqual(out, ["new", "a"])

        def boom(t, s):
            raise RuntimeError("down")
        out, failed = watch.process(SRC, [item("new"), item("a")], {"s": ["a"]}, [], boom, NOON)
        self.assertEqual((out, failed), (["a"], 1))  # 실패한 글은 seen에 안 넣어 다음 실행에 다시 보낸다

    def test_duplicate_id_in_one_feed_sent_once(self):
        sent = []
        watch.process(SRC, [item("n"), item("n")], {"s": ["a"]}, [], lambda t, s: sent.append(t), NOON)
        self.assertEqual(len(sent), 1)

    def test_digest_goes_to_queue(self):
        q = []
        watch.process({"name": "s", "mode": "digest"}, [item("n")], {"s": ["x"]}, q, None, NOON)
        self.assertEqual(q[0]["title"], "n")

    def test_empty_seed_still_delivers(self):  # 주말에 비어 있던 arXiv: 월요일 글은 진짜 새 글이다
        q = []
        out, _ = watch.process({"name": "s", "mode": "digest"}, [item("n")], {"s": []}, q, None, NOON)
        self.assertEqual((out, len(q)), (["n"], 1))

    def test_structure_change_is_failure(self):
        watch.get = lambda url: "<html>바뀐 페이지</html>"
        for t in ("trending", "sitemap"):
            with self.assertRaises(ValueError):
                watch.fetch({"type": t, "url": "u", "path": "/news/"})
        watch.get = lambda url: "<rss><channel></channel></rss>"
        self.assertEqual(watch.fetch({"type": "feed", "url": "u"}), [])  # 일반 피드는 빈 게 정상일 수 있다

    def test_cap_keeps_current_feed_items(self):
        old = [f"o{i}" for i in range(watch.SEEN_CAP)]
        out, _ = watch.process(SRC, [item("o1999")], {"s": old}, [], None, NOON)
        self.assertEqual(out[0], "o1999")
        self.assertEqual(len(out), watch.SEEN_CAP)

    def test_quiet_hours_and_escape(self):
        self.assertTrue(watch.is_quiet(NOON.replace(hour=23)))
        self.assertTrue(watch.is_quiet(NOON.replace(hour=7)))
        self.assertFalse(watch.is_quiet(NOON.replace(hour=8)))
        self.assertIn("&lt;b&gt;", watch.format_instant("s", {"title": "<b>", "url": "https://x"}))


if __name__ == "__main__":
    unittest.main()
