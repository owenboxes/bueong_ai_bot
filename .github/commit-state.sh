#!/usr/bin/env bash
# 봇이 바꾼 state/(와 digests/)를 커밋·push한다. 사용법: bash .github/commit-state.sh <커밋 이름>
set -u
git config user.name "bueong-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add state || exit 1   # 준비·커밋이 실패하면 push가 돼도 실패로 끝내야 미게시 링크를 보내지 않는다
if [ -d digests ]; then git add digests || exit 1; fi   # 새 글 0건인 날엔 폴더가 없을 수 있다
git diff --cached --quiet && exit 0
git commit -m "state: $1 $(date -u +%FT%TZ)" || exit 1
# 그사이 브랜치가 앞서 나갔으면 그 위에 다시 얹어서 push (실패하면 다음 실행에서 같은 알림이 반복되므로)
for i in 1 2 3; do
  if git pull --rebase && git push; then exit 0; fi
  if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
    git rebase --abort; echo "rebase 충돌: state/를 손으로 고친 커밋이 있는지 확인"; exit 1
  fi
  sleep 5
done
exit 1
