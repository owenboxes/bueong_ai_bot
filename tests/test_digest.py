import json
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import digest  # noqa: E402
import watch  # noqa: E402

ITEMS = [{"source": "HN", "title": f"글 {n}", "url": f"https://x/{n}"} for n in range(4)]
KEY = {"GEMINI_API_KEY": "k"}
URL = "https://github.com/o/r/blob/main/digests/d.md"
NOW = datetime(2026, 11, 15, 8, 0, tzinfo=watch.KST)


class Rank(unittest.TestCase):
    def test_valid_and_missing_index_is_tier3(self):
        rows = [{"i": 0, "tier": 1, "line": "요약"}, {"i": 2, "tier": 2, "line": "가" * 500}]
        self.assertEqual(digest.check_ranks(rows, 4), [(1, "요약"), (3, ""), (2, ""), (3, "")])

    def test_invalid_shapes_fall_back(self):
        bad = [
            {"i": 0, "tier": 1},  # 배열이 아닌 객체
            [{"i": 0, "tier": 1}, {"i": 0, "tier": 2}],  # 번호 중복
            [{"i": True, "tier": 1}],  # bool 번호
            [{"i": 0, "tier": True}],  # bool 등급
            [{"i": 0, "tier": 1.0}],  # 실수 등급
            [{"i": 9, "tier": 1}],  # 범위 밖
            ["쓰레기"],
            [],  # 빈 답
        ]
        for rows in bad:
            with self.subTest(rows=rows):
                self.assertIsNone(digest.check_ranks(rows, 4))

    def test_rank_failure_or_no_key_is_none(self):
        with mock.patch.dict(os.environ, KEY), mock.patch.object(digest.summary, "ask_gemini", return_value="not json"):
            self.assertIsNone(digest.rank(ITEMS))
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(digest.rank(ITEMS))


class Build(unittest.TestCase):
    def test_sections(self):
        text = "\n".join(digest.build(ITEMS, [(1, "<중요>"), (2, ""), (3, ""), (3, "")], URL))
        for want in ("밤사이 4건", "━ 꼭 볼 것 (1)", "&lt;중요&gt;", "━ 알아두면 좋은 것 (1)", f"━ 나머지 (2) <a href=\"{URL}\">"):
            self.assertIn(want, text)

    def test_without_ranking_and_empty(self):
        text = "\n".join(digest.build(ITEMS, None, URL))
        self.assertIn("HN 4건", text)
        self.assertIn(URL, text)
        self.assertIn("없었어요", digest.build([], None, URL)[0])

    def test_worst_case_block_fits_and_long_url_unlinked(self):
        # 이스케이프로 가장 많이 늘어나는 & 와 " 로 채운 최악의 입력
        for url, linked in (("https://x/" + '"' * 490, False), ("https://x/" + "&" * 90, True)):
            it = {"source": "&" * 100, "title": "&" * 500, "url": url}
            block = f"99. {digest.link(it, '&' * digest.LINE_MAX)}"
            self.assertLess(len(block), digest.TG_LIMIT)
            self.assertEqual("<a href" in block, linked)

    def test_split_keeps_blocks_whole_and_under_limit(self):
        msgs = digest.split(["가" * 30] * 10, limit=100)
        self.assertTrue(all(len(m) <= 100 for m in msgs))
        self.assertEqual("\n".join(msgs).count("가" * 30), 10)


class Flow(unittest.TestCase):
    """prepare → (워크플로가 게시) → send 흐름을 임시 폴더에서 확인한다."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        patches = [
            mock.patch.object(watch, "QUEUE", self.tmp / "state" / "queue.json"),
            mock.patch.object(digest, "OUTBOX", self.tmp / "state" / "outbox.json"),
            mock.patch.object(digest, "DIGESTS", self.tmp / "digests"),
            mock.patch.object(digest, "rank", return_value=None),
            mock.patch.object(digest, "TG_LIMIT", 130),  # 메시지가 여러 조각이 되게
            mock.patch.dict(os.environ, {}, clear=True),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        watch.save(watch.QUEUE, ITEMS)

    def test_prepare_publishes_list_and_empties_queue(self):
        digest.prepare(NOW)
        box = watch.load(digest.OUTBOX, {})
        self.assertEqual((box["batch"], box["sent"]), ("2026-11-15-0800", 0))
        self.assertTrue((digest.DIGESTS / "2026-11-15-0800.md").exists())
        self.assertIn("digests/2026-11-15-0800.md", "".join(box["messages"]))
        self.assertEqual(watch.load(watch.QUEUE, None), [])

    def test_batch_has_run_id_and_branch(self):
        with mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "42", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_REF_NAME": "dev"}):
            digest.prepare(NOW)
        box = watch.load(digest.OUTBOX, {})
        self.assertEqual(box["batch"], "2026-11-15-0800-42-2")
        self.assertIn("/blob/dev/digests/2026-11-15-0800-42-2.md", "".join(box["messages"]))

    def test_partial_send_resumes_without_resending(self):
        digest.prepare(NOW)
        total = len(watch.load(digest.OUTBOX, {})["messages"])
        self.assertGreater(total, 1)
        sent = []

        def flaky(text, silent):
            if len(sent) == 1:
                raise RuntimeError("down")
            sent.append(text)
        with self.assertRaises(RuntimeError):
            digest.send_outbox(flaky)
        self.assertEqual(watch.load(digest.OUTBOX, {})["sent"], 1)

        watch.save(watch.QUEUE, ITEMS[:1])  # 그사이 새 글이 들어와도
        digest.prepare(NOW.replace(day=16))  # 다음 날 prepare는 남은 요약부터 (새 배치 안 만듦)
        self.assertEqual(watch.load(watch.QUEUE, None), ITEMS[:1])
        digest.send_outbox(lambda t, s: sent.append(t))
        self.assertEqual(len(sent), total)  # 첫 조각은 다시 보내지 않았다
        self.assertEqual(watch.load(digest.OUTBOX, None), {})


if __name__ == "__main__":
    unittest.main()
