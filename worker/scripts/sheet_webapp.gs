// 부엉 👍 기록 시트용 Apps Script (시트에 붙인 스크립트 = 컨테이너 바인딩). 웹 앱으로 배포한다.
// 배포: 실행 계정 = 나, 액세스 = 모든 사용자(익명). 비밀 문구가 맞는 요청만 쓴다.
// 스크립트 속성 TOKEN = worker/.sheet_token 파일 내용 (Worker 비밀값 SHEET_TOKEN과 같은 값)
// Worker가 보내는 본문: {"token","key","at","source","title","url","kind"}
// 열: A 시각 · B 출처 · C 제목 · D 링크 · E 종류 · F key (부엉이 씀) | G 블로그상태(체크박스) · H 중복확인 (사용자가 추가, 2026-11-25)
const SHEET = "likes";
const HEAD = ["시각(KST)", "출처", "제목", "링크", "종류", "key"];
const KEY_COL = 6; // F: 부엉만 쓰는 열이라 "마지막 데이터 행"을 이 열로 찾는다 (G 체크박스는 미리 채워져 있어 기준이 못 된다)

function doPost(e) {
  let b;
  try { b = JSON.parse(e.postData.contents); } catch (err) { return out("bad"); }
  const token = PropertiesService.getScriptProperties().getProperty("TOKEN");
  if (!token || b.token !== token) return out("no");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // 동시에 두 번 눌러도 한 줄만
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET);
    if (sh.getLastRow() === 0) sh.appendRow(HEAD);
    const last = lastKeyRow(sh);
    if (last > 1 && sh.getRange(2, KEY_COL, last - 1, 1).getValues().some((r) => r[0] === b.key)) return out("dup");
    const row = last + 1;
    if (row > sh.getMaxRows()) sh.insertRowAfter(sh.getMaxRows());
    const at = Utilities.formatDate(new Date(b.at || Date.now()), "Asia/Seoul", "yyyy-MM-dd HH:mm");
    sh.getRange(row, 1, 1, HEAD.length).setValues([[at, b.source, b.title, b.url, b.kind, b.key].map(safe)]);
    copyExtra(sh, row);
    console.log(`v3 row=${row} maxRows=${sh.getMaxRows()} lastCol=${sh.getLastColumn()}`); // 실행 기록에서 새 코드가 도는지·어느 행에 썼는지 확인용
    return out("ok");
  } finally {
    lock.releaseLock();
  }
}

/** F열에서 값이 있는 마지막 행 (머리글만 있으면 1). 빈 문자열을 돌려주는 수식도 빈 칸으로 본다 */
function lastKeyRow(sh) {
  const vals = sh.getRange(1, KEY_COL, sh.getMaxRows(), 1).getValues();
  let last = vals.length;
  while (last > 1 && String(vals[last - 1][0]).trim() === "") last--;
  return last;
}

/** 편집기에서 ▶ 실행해 보는 시험: 배포 없이 지금 코드가 어느 행에 쓸지 보여 준다 (시트는 바꾸지 않음) */
function testWhere() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET);
  const last = lastKeyRow(sh);
  console.log(`마지막 기록 행=${last}, 새 줄이 들어갈 행=${last + 1}, 시트 전체 행=${sh.getMaxRows()}, 마지막 열=${sh.getLastColumn()}`);
}

/** G(체크박스)·H(중복확인)를 바로 윗줄에서 복사한다 (체크박스 모양·수식·값). 새 글은 아직 블로그 전이라 체크는 해제 */
function copyExtra(sh, row) {
  const extra = sh.getLastColumn() - HEAD.length; // G, H … 사용자가 붙인 열 수
  if (row <= 2 || extra <= 0) return;
  sh.getRange(row - 1, HEAD.length + 1, 1, extra).copyTo(sh.getRange(row, HEAD.length + 1, 1, extra));
  const box = sh.getRange(row, HEAD.length + 1);
  if (box.getDataValidation()?.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX) box.uncheck();
}

// 피드 제목이 =, +, -, @로 시작하면 수식으로 실행되지 않게 글자로 넣는다
const safe = (v) => { const s = String(v == null ? "" : v).slice(0, 1000); return /^[=+\-@]/.test(s) ? "'" + s : s; };
const out = (s) => ContentService.createTextOutput(s);
