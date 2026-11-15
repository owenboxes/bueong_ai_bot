// 부엉 👍 기록 시트용 Apps Script (시트에 붙인 스크립트 = 컨테이너 바인딩). 웹 앱으로 배포한다.
// 배포: 실행 계정 = 나, 액세스 = 모든 사용자(익명). 비밀 문구가 맞는 요청만 쓴다.
// 스크립트 속성 TOKEN = worker/.sheet_token 파일 내용 (Worker 비밀값 SHEET_TOKEN과 같은 값)
// Worker가 보내는 본문: {"token","key","at","source","title","url","kind"}
const SHEET = "likes";
const HEAD = ["시각(KST)", "출처", "제목", "링크", "종류", "key"];

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
    const n = sh.getLastRow() - 1;
    if (n > 0 && sh.getRange(2, 6, n, 1).getValues().some((r) => r[0] === b.key)) return out("dup");
    const at = Utilities.formatDate(new Date(b.at || Date.now()), "Asia/Seoul", "yyyy-MM-dd HH:mm");
    sh.appendRow([at, b.source, b.title, b.url, b.kind, b.key].map(safe));
    return out("ok");
  } finally {
    lock.releaseLock();
  }
}

// 피드 제목이 =, +, -, @로 시작하면 수식으로 실행되지 않게 글자로 넣는다
const safe = (v) => { const s = String(v == null ? "" : v).slice(0, 1000); return /^[=+\-@]/.test(s) ? "'" + s : s; };
const out = (s) => ContentService.createTextOutput(s);
