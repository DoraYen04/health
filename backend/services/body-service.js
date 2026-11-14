import { getStore } from '../database/sheets-service.js';
import { STATUS } from '../database/schema.js';
import { isoNow } from '../utils/time.js';
import { isActive, num, round } from './common.js';

// 欄位中文名與合理範圍（超出範圍的辨識值會被清空並提示人工確認）
export const BODY_FIELDS = {
  weight_kg: { label: '體重', unit: 'kg', min: 30, max: 250 },
  body_fat_pct: { label: '體脂率', unit: '%', min: 3, max: 70 },
  body_fat_kg: { label: '體脂肪重', unit: 'kg', min: 1, max: 150 },
  skeletal_muscle_kg: { label: '骨骼肌重', unit: 'kg', min: 5, max: 80 },
  visceral_fat: { label: '內臟脂肪', unit: '', min: 1, max: 60 },
  bmr_kcal: { label: '基礎代謝', unit: 'kcal', min: 600, max: 4000 },
  bmi: { label: 'BMI', unit: '', min: 10, max: 70 },
};

export const BODY_ALIASES = {
  體重: 'weight_kg', 體脂: 'body_fat_pct', 體脂率: 'body_fat_pct', 體脂肪: 'body_fat_kg', 體脂肪重: 'body_fat_kg',
  骨骼肌: 'skeletal_muscle_kg', 骨骼肌重: 'skeletal_muscle_kg', 肌肉: 'skeletal_muscle_kg',
  內臟脂肪: 'visceral_fat', 基礎代謝: 'bmr_kcal', 代謝: 'bmr_kcal', bmi: 'bmi', BMI: 'bmi',
};

/** 驗證 AI 辨識結果：不合理值清空並列入 warnings；不推測缺值 */
export function sanitizeBody(values) {
  const out = {};
  const warnings = [];
  for (const [k, def] of Object.entries(BODY_FIELDS)) {
    const v = num(values?.[k]);
    if (v === null) { out[k] = null; continue; }
    if (v < def.min || v > def.max) {
      warnings.push(`${def.label} ${v}${def.unit} 超出合理範圍，已清空，請手動確認`);
      out[k] = null;
    } else {
      out[k] = v;
    }
  }
  return { values: out, warnings };
}

export function formatBody(values) {
  return Object.entries(BODY_FIELDS).map(([k, def]) => {
    const v = values?.[k];
    return `${def.label}：${v === null || v === undefined ? '未辨識' : `${v}${def.unit ? ` ${def.unit}` : ''}`}`;
  }).join('\n');
}

export async function createBodyComposition({ userId, date, time, values, photoId, aiConfidence, source = 'LINE照片', tz }) {
  const now = isoNow(tz);
  const [row] = await getStore().append('Body_Composition', {
    user_id: userId,
    measure_date: date,
    measure_time: time,
    ...values,
    photo_id: photoId || '',
    ai_confidence: aiConfidence || '',
    verified: true,
    source,
    status: STATUS.NORMAL,
    created_at: now,
    updated_at: now,
  });
  return row;
}

export async function listBody(userId, { from, to } = {}) {
  const rows = await getStore().list('Body_Composition', (r) => r.user_id === userId && isActive(r)
    && r.verified !== false && (!from || r.measure_date >= from) && (!to || r.measure_date <= to));
  return rows.map((r) => {
    const o = { ...r };
    for (const k of Object.keys(BODY_FIELDS)) o[k] = num(r[k]);
    return o;
  }).sort((a, b) => (a.measure_date + a.measure_time).localeCompare(b.measure_date + b.measure_time));
}

/** 指定日期的身體組成（同日多筆取最後一筆）；查無回傳 null，不以其他日期代替 */
export function bodyOnDate(rows, date) {
  const same = rows.filter((r) => r.measure_date === date);
  return same.length ? same[same.length - 1] : null;
}

export function bmiOf(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  return round(weightKg / ((heightCm / 100) ** 2), 1);
}
