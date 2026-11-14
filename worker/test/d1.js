import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// D1 흉내: node:sqlite 위에 prepare().bind().all/first/run 과 batch만. 진짜 schema.sql을 그대로 쓴다
export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => db.prepare(sql).run(...args),
    exec: () => db.prepare(sql).run(...args),
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (list) => { db.exec("BEGIN"); try { const results = list.map((s) => ({ meta: s.exec() })); db.exec("COMMIT"); return results; } catch (e) { db.exec("ROLLBACK"); throw e; } },
  };
}
