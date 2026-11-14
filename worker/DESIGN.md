# 부엉 Cloudflare 이전 설계

2026-11-14 결정. 지금 GitHub Actions 버전(`src/*.py`)을 Cloudflare Workers 하나로 옮긴다. 전환 전까지 GitHub 버전은 그대로 운영한다.

## 왜 옮기나
- GitHub Actions 약관: 개발과 무관한 상시 봇·서버리스 용도는 금지 대상. Cloudflare Workers는 원래 이 용도.
- 반응 속도: 텔레그램 버튼·링크는 webhook으로 즉시, 출처마다 11분 간격(지금 15분 + GitHub 지연).
- 개인 기록: D1은 기본 비공개라 암호화(`private.py`)가 필요 없다.

## 지켜야 할 한도 (Workers Free, 측정·조사 2026-11-14)
| 항목 | 한도 | 설계에 미치는 영향 |
|---|---|---|
| CPU | 실행당 10ms | **실행 한 번에 출처 1개만**. 실측: 고정 약 4ms + 피드 1KB당 약 0.08ms. 16KB 읽기 = 평균 5.7ms, 최대 7ms |
| 외부 요청 | 실행당 50개 | 출처 1개 + Gemini 1~3 + 텔레그램 몇 개라 여유 |
| Cron | 계정당 5개, 최소 1분 | `* * * * *`(감시), `0 23 * * *`(아침 요약 08:00 KST), `0 11 * * 0`(주간 리포트 일 20:00 KST) |
| D1 | 쓰기 10만 행/일, 바인딩 100개/쿼리 | 충분. IN 조회는 99개씩 나눈다 |
| 로그 | 3일 보관 | 통계는 D1에 남긴다 |

## 구조
Worker 하나 (`worker/src/index.js`):
- `scheduled`: `event.cron`으로 감시 / 아침 요약 / 주간 리포트를 나눈다.
- `fetch POST /telegram`: webhook. `x-telegram-bot-api-secret-token` 확인, 내 개인 채팅(chat.type == private, chat.id == from.id == TG_CHAT_ID)만 처리.

### 감시 순환 (2026-11-14 사용자 결정: 균등 순환)
- 매분 출처 11개(아침 요약 4 + 즉시 알림 7)를 차례로 하나씩: (1970년부터 센 분) % 11번. 출처마다 11분 간격

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

## 정한 것 (3단계, 2026-11-14)
- 아침 요약 전체 목록: Worker 주소 `/digest/<무작위 32자>` 비밀 링크. 공개 뉴스 제목·링크만 담고 개인 기록(보낸 링크·🌙)은 넣지 않는다. noindex·no-referrer·no-store·CSP. 35일 보관
- 아침 요약 발송: 08:00 cron은 준비만, 매분 cron이 outbox를 이어 보낸다 (실패해도 1분 뒤 재시도, 같은 조각 5회 실패 시 건너뜀)

## 아직 정하지 않은 것
- 설정(출처 목록)을 어디에 둘지: 코드에 묶기 vs D1 (주간 리포트 버튼으로 바꾸려면 D1)
