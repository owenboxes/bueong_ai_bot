-- 새 D1 기준 스키마. CREATE TABLE IF NOT EXISTS라 이미 있는 DB에 다시 적용해도 된다 (열을 바꾸면 ALTER TABLE을 함께 둔다)
-- 이미 본 글 (출처별). 첫 실행 폭탄을 막기 위해 처음 본 출처는 기록만 한다
CREATE TABLE IF NOT EXISTS seen (source TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (source, id));
-- 실행 기록: 실행마다 읽은 바이트·건수 (Workers 로그는 3일만 남는다)
CREATE TABLE IF NOT EXISTS runs (at TEXT NOT NULL, source TEXT NOT NULL, received INTEGER, bytes INTEGER, items INTEGER, new_items INTEGER, failed INTEGER);
-- 보내기에 실패한 글: 다시 시도할 시각. 계속 실패하는 글이 앞자리를 막아 뒤 글이 못 나가는 일을 막는다
CREATE TABLE IF NOT EXISTS retry (source TEXT NOT NULL, id TEXT NOT NULL, next_at TEXT NOT NULL, PRIMARY KEY (source, id));
-- 보낸 즉시 알림 (35일). 버튼 응답과 주간 리포트가 읽는다
CREATE TABLE IF NOT EXISTS alerts (key TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, url TEXT, at TEXT NOT NULL);
-- 아침 요약 대기열
CREATE TABLE IF NOT EXISTS queue (source TEXT NOT NULL, id TEXT NOT NULL, title TEXT, url TEXT, at TEXT NOT NULL, PRIMARY KEY (source, id));
-- 출처별 연속 읽기 실패 (성공하면 행을 지운다)
CREATE TABLE IF NOT EXISTS health (source TEXT PRIMARY KEY, fails INTEGER NOT NULL, last_error TEXT, at TEXT NOT NULL);
-- 버튼 누름·보낸 메시지 (35일). update_id로 텔레그램 재전송을 한 번만 받는다. 주간 리포트가 읽는다
CREATE TABLE IF NOT EXISTS feedback (update_id INTEGER PRIMARY KEY, key TEXT, action TEXT NOT NULL, source TEXT, at TEXT NOT NULL);
-- 아침 요약 고정 구역: 보낸 링크(link)·🌙 자세히(later). 아침 요약이 보낸 뒤 지운다
CREATE TABLE IF NOT EXISTS pinned (kind TEXT NOT NULL, url TEXT NOT NULL, title TEXT, source TEXT, at TEXT NOT NULL, PRIMARY KEY (kind, url));
-- 아침 요약 발송분: 메시지 조각(JSON 배열)과 보낸 조각 수. 다 보내면 지운다
CREATE TABLE IF NOT EXISTS outbox (batch TEXT PRIMARY KEY, messages TEXT NOT NULL, sent INTEGER NOT NULL, tries INTEGER NOT NULL, at TEXT NOT NULL);
-- 아침 요약 전체 목록 페이지 (35일). 주소 /digest/<batch>는 추측할 수 없는 무작위 값이다
CREATE TABLE IF NOT EXISTS digests (batch TEXT PRIMARY KEY, html TEXT NOT NULL, at TEXT NOT NULL);
