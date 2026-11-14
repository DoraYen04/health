// 建立／補齊 Google Spreadsheet 的 15 張工作表與標題列，並建立照片資料夾。
// 用法：
//   1. 未設定 SPREADSHEET_ID → 新建試算表
//   2. 已設定 → 只補上缺少的工作表與標題（不動既有資料）
//   node --env-file=.env scripts/setup-sheets.js

import { google } from 'googleapis';
import { SHEETS } from '../backend/database/schema.js';
import { getGoogleAuth } from '../backend/database/google-auth.js';
import { config } from '../config/settings.js';

const auth = getGoogleAuth();
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

async function main() {
  let id = config.google.spreadsheetId;
  if (!id) {
    const res = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: 'LINE Gemini 健康管理資料庫', timeZone: 'Asia/Taipei', locale: 'zh_TW' },
        sheets: Object.keys(SHEETS).map((title) => ({ properties: { title, gridProperties: { frozenRowCount: 1 } } })),
      },
    });
    id = res.data.spreadsheetId;
    console.log(`✅ 已建立試算表：https://docs.google.com/spreadsheets/d/${id}`);
  }

  const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
  const existing = new Map(meta.data.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
  const missing = Object.keys(SHEETS).filter((s) => !existing.has(s));
  if (missing.length) {
    const r = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })) },
    });
    r.data.replies.forEach((rep) => existing.set(rep.addSheet.properties.title, rep.addSheet.properties.sheetId));
    console.log(`＋ 新增工作表：${missing.join(', ')}`);
  }

  // 標題列：只寫入空白的第一列，或與定義不一致時提示
  const heads = await sheets.spreadsheets.values.batchGet({ spreadsheetId: id, ranges: Object.keys(SHEETS).map((s) => `${s}!1:1`) });
  const data = [];
  heads.data.valueRanges.forEach((vr, i) => {
    const name = Object.keys(SHEETS)[i];
    const cur = vr.values?.[0] || [];
    const want = SHEETS[name];
    if (!cur.length) data.push({ range: `${name}!A1`, values: [want] });
    else if (cur.join('|') !== want.join('|')) {
      // 只允許在尾端新增欄位，避免打亂既有資料
      if (want.slice(0, cur.length).join('|') === cur.join('|')) data.push({ range: `${name}!A1`, values: [want] });
      else console.warn(`⚠️ ${name} 標題列與程式定義不同，請人工確認：\n  目前：${cur.join(', ')}\n  應為：${want.join(', ')}`);
    }
  });
  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: id, requestBody: { valueInputOption: 'RAW', data } });
    console.log(`✏️ 已寫入標題列：${data.map((d) => d.range.split('!')[0]).join(', ')}`);
  }

  // 標題列格式
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: {
      requests: [...existing.values()].map((sheetId) => ({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.95, blue: 0.98 } } },
          fields: 'userEnteredFormat(textFormat,backgroundColor)',
        },
      })),
    },
  });

  let folder = config.google.driveFolderId;
  if (!folder) {
    const f = await drive.files.create({
      requestBody: { name: '健康管理照片', mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    });
    folder = f.data.id;
    console.log(`📁 已建立照片資料夾：https://drive.google.com/drive/folders/${folder}`);
  }

  console.log('\n請將以下值填入 .env／Cloud Run 環境變數：');
  console.log(`SPREADSHEET_ID=${id}`);
  console.log(`DRIVE_FOLDER_ID=${folder}`);
}

main().catch((e) => {
  console.error('❌ 失敗：', e.message);
  process.exit(1);
});
