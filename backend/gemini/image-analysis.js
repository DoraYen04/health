import { generate, imagePart } from './client.js';
import { splitForVision } from './image-split.js';
import { sanitizeBody } from '../services/body-service.js';
import { isDateStr, toMinutes } from '../utils/time.js';

const SYSTEM = `你是體脂計／身體組成分析儀畫面、或手機 App 身體組成報告截圖的讀值助手。
規則：
1. 只讀取圖片中「清楚可見」的數字，逐字抄錄，不可推算、換算或依常理補齊。
2. 看不清楚、被遮擋、或畫面沒有的欄位一律回傳 null。
3. 若收到多張圖片，它們是「同一張長截圖由上到下切成的連續片段」，相鄰片段有少量重疊；請合併成一份結果，重疊處的同一個數字只算一次。
4. 欄位對應（注意不要混淆）：
   - weight_kg：體重（kg）。
   - body_fat_pct：體脂率（%），是百分比，不是 kg。
   - body_fat_kg：體脂肪量／脂肪量（kg）。不要用「皮下脂肪」或各部位脂肪。
   - skeletal_muscle_kg：骨骼肌量／骨骼肌重（kg）。不是「肌肉量」「肌肉率」「骨骼肌率（%）」。
   - visceral_fat：內臟脂肪等級（通常 1–30 的整數）。不是內臟脂肪面積。
   - bmr_kcal：基礎代謝率／基礎代謝量（kcal）。
   - bmi：BMI。
5. measure_date／measure_time：報告上顯示的「量測日期與時間」，格式 YYYY-MM-DD 與 HH:mm；畫面沒有就回傳 null，不可用今天代替。
6. 若圖片不是體脂計或身體組成報告，is_body_composition 回傳 false，所有數值為 null。
7. readability：clear（清楚）、partial（部分可讀）、unreadable（無法辨識）。`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_body_composition: { type: 'BOOLEAN' },
    measure_date: { type: 'STRING', nullable: true },
    measure_time: { type: 'STRING', nullable: true },
    weight_kg: { type: 'NUMBER', nullable: true },
    body_fat_pct: { type: 'NUMBER', nullable: true },
    body_fat_kg: { type: 'NUMBER', nullable: true },
    skeletal_muscle_kg: { type: 'NUMBER', nullable: true },
    visceral_fat: { type: 'NUMBER', nullable: true },
    bmr_kcal: { type: 'NUMBER', nullable: true },
    bmi: { type: 'NUMBER', nullable: true },
    readability: { type: 'STRING', enum: ['clear', 'partial', 'unreadable'] },
    note: { type: 'STRING', nullable: true },
  },
  required: ['is_body_composition', 'readability'],
};

/** 報告上的日期：格式正確且不晚於今天才採用 */
function pickDate(d, today) {
  const s = String(d || '').trim().replace(/\//g, '-');
  return isDateStr(s) && (!today || s <= today) ? s : null;
}
function pickTime(t) {
  const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const s = `${m[1].padStart(2, '0')}:${m[2]}`;
  return Number.isNaN(toMinutes(s)) ? null : s;
}

/**
 * 回傳 { values, warnings, readability, isBody, date, time, raw }
 * values 已經過範圍驗證；JSON 格式正確不代表數值正確，仍需使用者確認。
 * date/time 為報告上的量測時間（讀不到為 null，由呼叫端決定用上傳時間）。
 */
export async function analyzeBodyPhoto(buffer, mimeType, { today } = {}) {
  let images;
  try {
    images = await splitForVision(buffer);
  } catch {
    images = [{ buffer, mimeType }]; // 無法處理的格式就原圖送出
  }
  const raw = await generate({
    system: SYSTEM,
    parts: [
      ...images.map((im) => imagePart(im.buffer, im.mimeType)),
      { text: images.length > 1 ? `以上 ${images.length} 張是同一份報告由上到下的連續片段，請讀取身體組成數值。` : '請讀取這張照片中的身體組成數值。' },
    ],
    schema: SCHEMA,
    temperature: 0,
    maxOutputTokens: 4096,
  });
  const { values, warnings } = sanitizeBody(raw);
  return {
    values, warnings,
    readability: raw.readability || 'unreadable',
    isBody: raw.is_body_composition !== false,
    date: pickDate(raw.measure_date, today),
    time: pickTime(raw.measure_time),
    segments: images.length,
    raw,
  };
}
