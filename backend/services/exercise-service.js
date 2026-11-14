import { getStore } from '../database/sheets-service.js';
import { STATUS } from '../database/schema.js';
import { isoNow } from '../utils/time.js';
import { isActive, num, round } from './common.js';

// 常見運動與 MET 值（Compendium of Physical Activities 的一般強度概略值），僅用於「估算」
export const EXERCISE_TYPES = {
  騎車: { aliases: ['騎車', '騎腳踏車', '腳踏車', '自行車', '單車', '飛輪', '騎自行車'], met: 6.8 },
  步行: { aliases: ['步行', '走路', '散步', '健走', '快走'], met: 3.5 },
  跑步: { aliases: ['跑步', '慢跑', '路跑'], met: 8.3 },
  游泳: { aliases: ['游泳'], met: 6.0 },
  重訓: { aliases: ['重訓', '重量訓練', '健身', '肌力訓練'], met: 5.0 },
  瑜珈: { aliases: ['瑜珈', '瑜伽', '皮拉提斯'], met: 2.8 },
  登山: { aliases: ['登山', '爬山', '健行'], met: 6.0 },
  有氧: { aliases: ['有氧', '跳舞', '舞蹈', 'HIIT', 'hiit', '跳繩'], met: 7.0 },
  球類: { aliases: ['羽球', '桌球', '籃球', '網球', '排球', '打球'], met: 6.0 },
};

const INTENSITY_FACTOR = { 低: 0.8, 中: 1, 高: 1.25 };

export function matchExerciseType(text) {
  for (const [type, def] of Object.entries(EXERCISE_TYPES)) {
    if (def.aliases.some((a) => text.includes(a))) return type;
  }
  return null;
}

/** 估算消耗：MET × 體重 × 小時。無體重資料時不估算。 */
export function estimateCalories(type, minutes, weightKg, intensity = '中') {
  const def = EXERCISE_TYPES[type];
  if (!def || !minutes || !weightKg) return null;
  return Math.round(def.met * (INTENSITY_FACTOR[intensity] || 1) * weightKg * (minutes / 60));
}

export async function createExercise({ userId, date, time, type, minutes, distanceKm, intensity, calories, caloriesSource, note = '', tz }) {
  const now = isoNow(tz);
  const [row] = await getStore().append('Exercise_Log', {
    user_id: userId,
    exercise_date: date,
    exercise_time: time,
    exercise_type: type,
    duration_min: num(minutes),
    distance_km: num(distanceKm),
    intensity: intensity || '',
    calories_burned: num(calories),
    calories_source: calories === null || calories === undefined ? '' : caloriesSource,
    note,
    status: STATUS.NORMAL,
    created_at: now,
    updated_at: now,
  });
  return row;
}

export async function listExercise(userId, { from, to } = {}) {
  const rows = await getStore().list('Exercise_Log', (r) => r.user_id === userId && isActive(r)
    && (!from || r.exercise_date >= from) && (!to || r.exercise_date <= to));
  return rows.map((r) => ({
    ...r, duration_min: num(r.duration_min), distance_km: num(r.distance_km), calories_burned: num(r.calories_burned),
  })).sort((a, b) => (a.exercise_date + (a.exercise_time || '')).localeCompare(b.exercise_date + (b.exercise_time || '')));
}

export function summarizeExercise(rows) {
  if (!rows.length) return { recorded: false, total_min: null, days: 0, sessions: 0, by_type: {}, calories_estimated: null };
  const byType = {};
  let total = 0;
  let cal = 0;
  let calCount = 0;
  rows.forEach((r) => {
    total += r.duration_min || 0;
    byType[r.exercise_type] = (byType[r.exercise_type] || 0) + (r.duration_min || 0);
    if (r.calories_burned !== null) { cal += r.calories_burned; calCount += 1; }
  });
  return {
    recorded: true,
    total_min: round(total, 0),
    days: new Set(rows.map((r) => r.exercise_date)).size,
    sessions: rows.length,
    by_type: byType,
    calories_estimated: calCount ? Math.round(cal) : null,
  };
}
