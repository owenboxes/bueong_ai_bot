import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.fernet import Fernet

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import private  # noqa: E402


class T(unittest.TestCase):
    def setUp(self):
        self.path = Path(tempfile.mkdtemp()) / "state" / "private.enc"
        for p in (mock.patch.object(private, "PATH", self.path),
                  mock.patch.dict(os.environ, {"BUEONG_STATE_KEY": Fernet.generate_key().decode()})):
            p.start()
            self.addCleanup(p.stop)

    def test_roundtrip_encrypted_and_defaults(self):
        self.assertEqual(private.load(), private.EMPTY)
        self.assertFalse(private.save(private.load()))  # 빈 상태는 파일을 만들지 않는다
        data = private.load()
        data["pinned"].append({"url": "https://비밀"})
        self.assertTrue(private.save(data))
        self.assertNotIn("비밀".encode(), self.path.read_bytes())
        self.assertEqual(private.load()["pinned"], [{"url": "https://비밀"}])

    def test_unchanged_content_not_rewritten(self):  # 암호문이 매번 달라 이력이 쌓이는 걸 막는다
        data = private.load()
        data["feedback"].append({"a": 1})
        private.save(data)
        before = self.path.read_bytes()
        self.assertFalse(private.save(private.load()))
        self.assertEqual(self.path.read_bytes(), before)

    def test_missing_key_stops(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                private.load()  # 파일이 없어도 키부터 확인한다


if __name__ == "__main__":
    unittest.main()
