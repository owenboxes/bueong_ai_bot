import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFeed, readHead, stripHtml, MAX_BYTES } from "../src/feed.js";

test("RSS와 Atom 항목을 뽑는다 (CDATA·엔티티 해제)", () => {
  const rss = "<rss><item><title><![CDATA[A &amp; B]]></title><link>https://x/a</link><guid>g1</guid></item></rss>";
  assert.deepEqual(parseFeed(rss), [{ id: "g1", title: "A & B", url: "https://x/a", summary: "" }]);
  const atom = '<feed><entry><id>t1</id><title>0.169.0</title><link rel="alternate" href="https://g/1"/></entry></feed>';
  assert.deepEqual(parseFeed(atom), [{ id: "t1", title: "0.169.0", url: "https://g/1", summary: "" }]);
});

test("잘린 마지막 항목은 빠진다", () => {
  assert.equal(parseFeed("<rss><item><title>a</title><guid>1</guid></item><item><title>잘").length, 1);
});

test("readHead는 상한까지만 읽고 멈춘다", async () => {
  const big = new Response("가".repeat(MAX_BYTES)); // 한 글자 3바이트 → 상한의 3배
  const { bytes, received } = await readHead(big);
  assert.equal(bytes, MAX_BYTES);
  assert.ok(received >= MAX_BYTES);
  const small = await readHead(new Response("abc"));
  assert.deepEqual(small, { text: "abc", bytes: 3, received: 3 });
});

test("본문: CDATA·엔티티로 온 태그를 빼고 공백을 줄인다", () => {
  const atom = '<feed><entry><id>1</id><title>t</title><content type="html">&lt;p&gt;Hi&amp;nbsp;there&lt;/p&gt;\n &lt;b&gt;x&lt;/b&gt;</content></entry></feed>';
  assert.equal(stripHtml(parseFeed(atom)[0].summary), "Hi there x");
  assert.equal(stripHtml("<![CDATA[<p>a</p><p>b</p>]]>"), "a b");
});

test("Atom 링크: 작은따옴표 href도 읽는다 (GeekNews)", () => {
  const atom = "<feed><entry><id>https://news.hada.io/topic?id=1</id><title>Show GN</title><link rel='alternate' type='text/html' href='https://news.hada.io/topic?id=1&amp;x=2' /></entry></feed>";
  assert.equal(parseFeed(atom)[0].url, "https://news.hada.io/topic?id=1&x=2");
});
