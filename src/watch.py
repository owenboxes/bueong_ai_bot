"""부엉 1단계: 출처를 읽고 새 글을 즉시 알림(텔레그램) 또는 아침 요약 대기열로 보낸다.

실행: python src/watch.py            (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID 필요)
      python src/watch.py --dry-run  (보내지 않고 화면에 출력)
"""
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

from summary import summarize

ROOT = Path(__file__).resolve().parent.parent
SEEN = ROOT / "state" / "seen.json"
QUEUE = ROOT / "state" / "queue.json"
KST = timezone(timedelta(hours=9))
UA = "Mozilla/5.0 (compatible; bueong-bot/0.1)"
SEEN_CAP = 2000  # 출처당 기억할 글 수. 지금 피드에 있는 글은 항상 남긴다.
ATOM = "{http://www.w3.org/2005/Atom}"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", "replace")


# ---------- 출처별 읽기: [{"id", "title", "url", "text"}] ----------

def strip_html(text):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", text or ""))).strip()


def parse_feed(xml_text):
    root = ET.fromstring(xml_text)
    items = []
    for it in root.iter("item"):  # RSS
        link = (it.findtext("link") or "").strip()
        title = (it.findtext("title") or "").strip()
        items.append({"id": (it.findtext("guid") or link).strip(), "title": title, "url": link, "text": title,
                      "summary": strip_html(it.findtext("description"))})
    for e in root.iter(ATOM + "entry"):  # Atom
        link_el = e.find(ATOM + "link[@rel='alternate']")
        if link_el is None:
            link_el = e.find(ATOM + "link")
        link = link_el.get("href", "") if link_el is not None else ""
        title = (e.findtext(ATOM + "title") or "").strip()
        body = e.findtext(ATOM + "summary") or e.findtext(ATOM + "content")
        items.append({"id": (e.findtext(ATOM + "id") or link).strip(), "title": title, "url": link, "text": title,
                      "summary": strip_html(body)})
    return items


def parse_sitemap(xml_text, path):
    urls = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", xml_text)
    # 제목은 새 글일 때만 페이지에서 가져온다 (fill_title)
    return [{"id": u, "title": "", "url": u, "text": u} for u in urls if path in u]


def parse_hn(json_text):
    items = []
    for h in json.loads(json_text)["hits"]:
        hn = f"https://news.ycombinator.com/item?id={h['objectID']}"
        title = h.get("title") or ""
        items.append({"id": h["objectID"], "title": title, "url": h.get("url") or hn, "text": title})
    return items


def parse_trending(page):
    items = []
    for block in page.split("<article")[1:]:
        m = re.search(r"<h2.*?href=\"/([^\"]+)\"", block, re.S)
        if not m:
            continue
        repo = m.group(1)
        d = re.search(r"<p class=\"col-9[^\"]*\">(.*?)</p>", block, re.S)
        desc = strip_html(d.group(1)) if d else ""  # 설명 안에 <a> 같은 태그가 섞여 온다
        items.append({"id": repo, "title": f"{repo} — {desc}" if desc else repo,
                      "url": f"https://github.com/{repo}", "text": f"{repo} {desc}"})
    return items


def fill_title(item):
    try:
        page = get(item["url"])
        m = re.search(r'<meta property="og:title" content="([^"]*)"', page) or re.search(r"<title>([^<]*)", page)
        item["title"] = html.unescape(m.group(1)).strip() if m else ""
        d = re.search(r'<meta (?:name="description"|property="og:description") content="([^"]*)"', page)
        item["summary"] = html.unescape(d.group(1)).strip() if d else ""
    except Exception as e:
        print(f"  제목 가져오기 실패 {item['url']}: {e}")
    if not item["title"]:
        item["title"] = urllib.parse.unquote(item["url"].rstrip("/").rsplit("/", 1)[-1]).replace("-", " ")


def fetch(src):
    body = get(src["url"])
    t = src["type"]
    if t == "feed":
        items = parse_feed(body)
    elif t == "sitemap":
        items = parse_sitemap(body, src["path"])
    elif t == "hn":
        items = parse_hn(body)
    elif t == "trending":
        items = parse_trending(body)
    else:
        raise ValueError(f"모르는 type: {t}")
    if not items and t in ("sitemap", "trending"):  # 이 둘은 늘 글이 있으니, 0건이면 페이지 구조가 바뀐 것
        raise ValueError("파싱 결과 0건 (페이지 구조 변경 의심)")
    inc, exc = src.get("include"), src.get("exclude")
    return [i for i in items
            if (not inc or re.search(inc, i["text"], re.I)) and not (exc and re.search(exc, i["text"], re.I))]


# ---------- 보내기 ----------

def is_quiet(now):
    return now.hour >= 23 or now.hour < 8  # 23:00~08:00 KST는 무음 전송


def format_instant(src_name, item, lines=()):
    summary = "".join(html.escape(l) + "\n" for l in lines)
    title = item["title"] if len(item["title"]) <= 300 else item["title"][:300] + "…"  # 텔레그램 4,096자 보호
    return (f"🦉 방금 포착했어요\n[{html.escape(src_name)}]\n<b>{html.escape(title)}</b>\n\n"
            + (summary + "\n" if summary else "")
            + f"<a href=\"{html.escape(item['url'], quote=True)}\">🔗 원문 보기</a>")


def send_telegram(text, silent):
    data = urllib.parse.urlencode({
        "chat_id": os.environ["TELEGRAM_CHAT_ID"], "text": text, "parse_mode": "HTML",
        "disable_notification": "true" if silent else "false", "disable_web_page_preview": "true",
    }).encode()
    url = f"https://api.telegram.org/bot{os.environ['TELEGRAM_BOT_TOKEN']}/sendMessage"
    with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=20) as r:
        if not json.loads(r.read()).get("ok"):
            raise RuntimeError("telegram ok=false")


# ---------- 상태 ----------

def load(path, default):
    return json.loads(path.read_text("utf-8")) if path.exists() else default


def save_text(path, text):
    path.parent.mkdir(exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, "utf-8")
    os.replace(tmp, path)  # 반쯤 쓰인 파일이 남지 않게 통째로 바꿔치기


def save(path, data):
    save_text(path, json.dumps(data, ensure_ascii=False, indent=1) + "\n")


def process(src, items, seen, queue, send, now):
    """새 글을 처리하고 (이 출처의 seen 목록, 보내기 실패 수)를 돌려준다. 실패한 글은 seen에 넣지 않아 다음에 다시 시도한다."""
    old = seen.get(src["name"])
    if old is None:  # 처음 보는 출처: 지금 있는 글은 본 것으로 기록만 한다 (첫 실행 폭탄 방지)
        return [i["id"] for i in items], 0
    old_set = set(old)
    done, send_failed = [], 0
    for item in items:
        if item["id"] in old_set:
            done.append(item["id"])
            continue
        if not item["title"]:
            fill_title(item)
        try:
            if src["mode"] == "instant":
                send(format_instant(src["name"], item, summarize(src["name"], item)), is_quiet(now))
            else:
                queue.append({"source": src["name"], "title": item["title"], "url": item["url"],
                              "at": now.isoformat(timespec="minutes")})
            done.append(item["id"])
            old_set.add(item["id"])  # 같은 피드에 같은 글이 두 번 나와도 한 번만
            print(f"  새 글 [{src['mode']}] {item['title']}")
        except Exception as e:
            print(f"  보내기 실패 {item['url']}: {e}")
            send_failed += 1
    # 지금 피드에 있는 글을 앞에 두고 자르므로, 잘려 나가는 건 피드에서 이미 사라진 글뿐이다
    return list(dict.fromkeys(done + old))[:SEEN_CAP], send_failed


def main():
    dry = "--dry-run" in sys.argv
    if dry:
        send = lambda text, silent: print(("[무음] " if silent else "") + text + "\n")
    else:
        if not os.environ.get("TELEGRAM_BOT_TOKEN") or not os.environ.get("TELEGRAM_CHAT_ID"):
            sys.exit("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID가 없습니다 (시험하려면 --dry-run)")
        send = send_telegram
    sources = yaml.safe_load((ROOT / "config" / "sources.yaml").read_text("utf-8"))["sources"]
    seen, queue = load(SEEN, {}), load(QUEUE, [])
    now = datetime.now(KST)
    failed, send_failed = [], 0
    for src in sources:
        print(src["name"])
        try:
            items = fetch(src)
        except Exception as e:  # 한 출처가 막혀도 나머지는 계속한다
            print(f"  읽기 실패: {e}")
            failed.append(src["name"])
            continue
        seen[src["name"]], n = process(src, items, seen, queue, send, now)
        send_failed += n
    if not dry:  # 드라이런에서 본 글을 기록하면 실제 실행 때 건너뛰게 된다
        save(QUEUE, queue)  # 대기열 먼저: 중간에 실패하면 누락 대신 중복이 된다
        save(SEEN, seen)
        if os.environ.get("GITHUB_OUTPUT"):  # 워크플로는 이 표시가 있을 때만 state/를 커밋한다
            with open(os.environ["GITHUB_OUTPUT"], "a") as f:
                f.write("saved=true\n")
    if failed:
        print(f"읽기 실패한 출처: {', '.join(failed)}")  # 출처 하나가 잠깐 막히는 건 흔해서 작업을 실패시키지 않는다
    if send_failed:  # 토큰 만료·chat ID 오류 등은 상태를 저장한 뒤 작업 실패로 드러낸다
        sys.exit(f"보내기 실패 {send_failed}건")


if __name__ == "__main__":
    main()
