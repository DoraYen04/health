import { generate, imagePart } from './client.js';
import { sanitizeBody } from '../services/body-service.js';

const SYSTEM = `你是體脂計／身體組成分析儀畫面的讀值助手。
規則：
1. 只讀取照片中「清楚可見」的數字，逐字抄錄，不可推算、換算或依常理補齊。
2. 看不清楚、被遮擋、或畫面沒有的欄位一律回傳 null。
3. 體脂率是百分比數字（例如 28.6），不是 kg。
4. 若照片不是體脂計或身體組成報告，is_body_composition 回傳 false，所有數值為 null。
5. readability：clear（清楚）、partial（部分可讀）、unreadable（無法辨識）。`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_body_composition: { type: 'BOOLEAN' },
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

/**
 * 回傳 { values, warnings, readability, isBody, raw }
 * values 已經過範圍驗證；JSON 格式正確不代表數值正確，仍需使用者確認。
 */
export async function analyzeBodyPhoto(buffer, mimeType) {
  const raw = await generate({
    system: SYSTEM,
    parts: [imagePart(buffer, mimeType), { text: '請讀取這張照片中的身體組成數值。' }],
    schema: SCHEMA,
    temperature: 0,
  });
  const { values, warnings } = sanitizeBody(raw);
  return { values, warnings, readability: raw.readability || 'unreadable', isBody: raw.is_body_composition !== false, raw };
}
