// 피드 읽기: CPU 10ms 한도 때문에 앞부분(최신 글)만 받아 정규식으로 항목을 뽑는다.

export const MAX_BYTES = 16 * 1024; // 최신 글은 피드 맨 앞에 있다.

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&").trim();

/** 태그를 빼고 공백을 하나로 (Atom content는 태그가 엔티티로 와서 decode 뒤에 뺀다) */
export const stripHtml = (s) => decode(s).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** RSS <item> / Atom <entry>를 [{id, title, url, summary}]로. 잘린 마지막 항목은 닫는 태그가 없어 자연히 빠진다. */
export function parseFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)) {
    const b = m[0];
    const title = decode((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || "");
    const url = decode((b.match(/<link[^>]*href="([^"]+)"/) || b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "");
    const id = decode((b.match(/<(guid|id)\b[^>]*>([\s\S]*?)<\/\1>/) || [])[2] || url);
    const body = (b.match(/<(description|summary|content)\b[^>]*>([\s\S]*?)<\/\1>/) || [])[2] || "";
    if (id) out.push({ id, title, url, summary: body });
  }
  return out;
}

/** 응답을 MAX_BYTES까지만 읽고 끊는다 (나머지는 내려받지도 않는다). */
export async function readHead(response, max = MAX_BYTES) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel();
  const buf = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    const part = c.subarray(0, buf.length - off);
    buf.set(part, off);
    off += part.length;
    if (off >= buf.length) break;
  }
  // received: 실제로 내려받은 양(마지막 청크가 경계를 넘을 수 있음), bytes: 파서에 넘긴 양
  return { text: new TextDecoder().decode(buf), bytes: buf.length, received: size };
}
