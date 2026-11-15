# 부엉 Cloudflare 이전 설계

2026-11-14 결정. 지금 GitHub Actions 버전(`src/*.py`)을 Cloudflare Workers 하나로 옮긴다. 전환 전까지 GitHub 버전은 그대로 운영한다.

## 왜 옮기나
- GitHub Actions 약관: 개발과 무관한 상시 봇·서버리스 용도는 금지 대상. Cloudflare Workers는 원래 이 용도.
- 반응 속도: 텔레그램 버튼·링크는 webhook으로 즉시, 출처마다 13분 간격(지금 15분 + GitHub 지연).
- 개인 기록: D1은 기본 비공개라 암호화(`private.py`)가 필요 없다.

## 지켜야 할 한도 (Workers Free, 측정·조사 2026-11-14)
| 항목 | 한도 | 설계에 미치는 영향 |
|---|---|---|
| CPU | 실행당 10ms | **실행 한 번에 출처 1개만**. 실측: 고정 약 4ms + 피드 1KB당 약 0.08ms. 16KB 읽기 = 평균 5.7ms, 최대 7ms |
| 외부 요청 | 실행당 50개 | 출처 1개 + Gemini 1~3 + 텔레그램 몇 개라 여유 |
| Cron | 계정당 5개, 최소 1분 | `* * * * *`(감시), `0 23 * * *`(아침 요약 08:00 KST), `0 11 * * SUN`(주간 리포트 일 20:00 KST) |
| D1 | 쓰기 10만 행/일, 바인딩 100개/쿼리 | 충분. IN 조회는 99개씩 나눈다 |
| 로그 | 3일 보관 | 통계는 D1에 남긴다 |

## 구조
Worker 하나 (`worker/src/index.js`):
- `scheduled`: `event.cron`으로 감시 / 아침 요약 / 주간 리포트를 나눈다.
- `fetch POST /telegram`: webhook. `x-telegram-bot-api-secret-token` 확인, 내 개인 채팅(chat.type == private, chat.id == from.id == TG_CHAT_ID)만 처리.

### 감시 순환 (2026-11-14 사용자 결정: 균등 순환)
- 매분 출처 13개(아침 요약 6 + 즉시 알림 7)를 차례로 하나씩: (1970년부터 센 분) % 13번. 출처마다 13분 간격 (2026-11-15 국내 출처 AI타임스·PyTorch KR 추가로 11→13)

### 출처별 읽는 방법
| 출처 | 방법 | 상태 |
|---|---|---|
| OpenAI, Gemini 블로그, Claude Code·Agent SDK(2)·Codex 릴리스, GeekNews | 피드 앞 16KB만 읽기 (최신 글이 앞에 있음) | 측정 완료 |
| Anthropic 뉴스 | `/news` HTML 앞 64KB에서 `/news/<slug>` 주소 추출, 새 글만 글 페이지 앞 16KB에서 og:title | 조사 완료(Gemini), CPU 측정 필요 |
| GitHub 트렌딩 | Search API: 최근 7일 생성 agent 저장소, 별 순 5개 (약 29KB JSON, User-Agent 필수, 공유 IP라 간헐 403/429) | 조사 완료(Gemini) |
| Hacker News | Algolia `search_by_date` points>20, 50개, `attributesToRetrieve=title,url` + 제목 키워드 필터 | 조사 완료(Gemini) |
| arXiv | `export.arxiv.org/api/query?search_query=ti:agent` 최신 10개 (약 25KB Atom, 429는 다음 순번으로) | 조사 완료(Gemini) |

출처 목록과 순환은 `src/sources.js`. JSON 출처는 상한(32·64KB)을 넘으면 잘린 JSON을 파싱하지 않고 읽기 실패로 둔다.

### D1 테이블
seen, retry(재시도 시각), alerts(보낸 즉시 알림 35일), queue(아침 요약 대기), pinned(보낸 링크·🌙), feedback(버튼 35일), outbox(아침 요약 발송분·진행도), health(출처별 읽기 실패), runs(측정). 상위 원칙은 GitHub 버전과 같다: 첫 실행은 기록만, 보내기 실패한 글은 미기록 후 재시도, 상태는 보내기 직후 기록.

### Gemini
즉시 알림 요약(두 줄, 실패 시 원문 첫 문장)과 아침 요약 정렬(JSON)은 GitHub 버전 규칙을 그대로 옮긴다. 지시문은 `config/persona.md`, `config/priorities.md`를 빌드 때 같이 묶는다.

## 단계
1. **감시 + 즉시 알림 + Gemini 요약** (11개 균등 순환, 즉시 알림 7개 + 아침 요약 출처 4개 대기열 쌓기) — 시험판 확인 완료
2. **webhook**: 👍👎🌙 버튼 즉시 응답, 링크 받기
3. **아침 요약**: 정렬, 고정 구역(보낸 링크·🌙), outbox 이어 보내기, 전체 목록은 D1에 두고 Worker 주소로 보여주기 (공개 저장소에 올리지 않음)
4. **주간 리포트** (기획서 5단계): 출처별 알림 수·반응률·반응 없는 출처·읽기 실패, 설정 변경 버튼
5. **전환**: 시험용 봇으로 1~4 확인 → 운영 봇 webhook을 Worker로 (setWebhook에 `allowed_updates=["message","callback_query"]`와 secret_token 필수. 빠뜨리면 버튼이 Worker에 안 온다: 시험판에서 실제로 겪음) → GitHub 워크플로 끄기 → GitHub `state/`는 보관만

## 역할
| 누구 | 맡는 것 |
|---|---|
| Claude | 설계, `index.js`·감시·webhook·아침 요약·주간 리포트 코드, 문서 |
| Gemini | 출처 대체 방법 조사(위 「조사 필요」), `src/gemini.js`(요약·정렬 호출과 응답 검증) |
| Codex | D1 스키마 적용·배포·실행·측정·Actions 끄기, 모든 리뷰, 간단한 리뷰 수정 |

## 5단계 전환 절차 (운영 봇)
원칙: GitHub와 Worker가 동시에 보내는 시간(중복)도, 둘 다 안 보는 시간(누락)도 없게. 08:00 전후 30분(아침 요약)은 피한다.
1. 시험 Worker를 cron 없이 다시 배포 (`--env test`). cron은 계정당 5개라 운영 3개와 같이 못 둔다
2. 운영 D1 `bueong` 만들기 → wrangler.toml에 id → schema.sql 적용
3. 운영 비밀 값: TG_TOKEN·TG_CHAT_ID·GEMINI_API_KEY(로컬 .env), TG_SECRET(새 무작위), BASE_URL(운영 Worker 주소)
4. GitHub 워크플로 watch·digest 끄기 → 돌던 실행이 끝날 때까지 기다리기
5. origin/main의 최신 `state/`를 임시 폴더로 꺼내 `scripts/export_state.py`로 SQL 만들기 → 운영 D1에 넣기 → SQL 지우기 (개인 기록 포함)
   - 옮기는 것: seen(GitHub이 이미 본 글: 끈 뒤 새로 나온 글은 Worker가 보낸다), alerts(옛 알림 버튼), queue, pinned, feedback
6. 운영 Worker 배포 (cron 켜짐) → 운영 봇 setWebhook (allowed_updates=["message","callback_query"], secret_token)
7. 확인: 매분 감시 실행, 옛 알림 버튼·링크 답장, 다음 08:00 아침 요약
예외(허용): arXiv는 id 형식이 달라 옮기지 않아, 전환 사이에 올라온 논문은 아침 요약에 빠질 수 있다 (GitHub seen에도 arXiv는 0건).
되돌리기 (운영 Worker를 고칠 수 없을 때만):
  a. 운영 Worker 멈춤: `wrangler secret put PAUSED`(값 1) — 새 cron 실행은 바로 아무것도 안 한다 (cron 설정 변경은 전파가 늦어 쓰지 않는다)
  b. 운영 봇 deleteWebhook (GitHub inbox는 getUpdates라 webhook이 있으면 못 받는다)
  c. 진행 중이던 실행이 끝나기를 기다린다: 로그에서 PAUSED 뒤 감시·outbox·webhook 실행이 더 없는 것을 2분 이상 확인
  d. 넘길 것 정리: D1 queue·pinned를 SELECT해 사용자에게 한 번 보여 준다 (GitHub state/로 되옮기는 코드는 만들지 않음 — 드문 경로라)
  e. GitHub 워크플로 켜기
  감수할 것 (2026-11-14 사용자 결정):
  - 누락: Worker에 쌓인 아침 요약 대기열·보낸 링크·🌙는 GitHub 아침 요약에 안 들어간다 (d에서 한 번 보여 주는 것으로 대신). Worker 기간의 버튼 기록은 GitHub 주간 집계에 없다
  - 중복: GitHub seen은 전환 시점 그대로라, Worker가 보낸 알림 중 아직 피드 앞에 있는 글이 한 번 더 온다
GitHub `state/`·`src/*.py`는 지우지 않고 보관만 한다.

## 정한 것 (3·4단계, 2026-11-14)
- 아침 요약 전체 목록: Worker 주소 `/digest/<무작위 32자>` 비밀 링크. 공개 뉴스 제목·링크만 담고 개인 기록(보낸 링크·🌙)은 넣지 않는다. noindex·no-referrer·no-store·CSP. 35일 보관
- 아침 요약 발송: 08:00 cron은 준비만, 매분 cron이 outbox를 이어 보낸다 (실패해도 1분 뒤 재시도, 같은 조각 5회 실패 시 건너뜀)

- 출처 설정: 기본값은 코드(`src/sources.js`), 주간 리포트 버튼으로 바꾼 것만 D1 `settings`에 덮어쓴다 (4단계). 지금 바꿀 수 있는 것은 즉시 알림 → 아침 요약 하나
- 주간 리포트: 일 20:00 KST, 지난 7일 alerts·feedback·runs·health로 계산. 이번 주 성공 기록이 없는 출처도 표시한다 (CPU 한도로 끊겨 기록이 안 남는 출처를 잡기 위해)
