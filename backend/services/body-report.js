import { BODY_FIELDS } from './body-service.js';
import { round } from './common.js';

/** 報告比較的欄位（體脂率差異以「百分點」表示） */
const KEYS = Object.keys(BODY_FIELDS);

function snapshot(b) {
  if (!b) return null;
  const o = { date: b.measure_date, time: b.measure_time || '', photo_id: b.photo_id || '' };
  for (const k of KEYS) o[k] = b[k] ?? null;
  return o;
}

function diffs(cur, prev) {
  if (!cur || !prev) return null;
  const o = {};
  for (const k of KEYS) {
    o[k] = cur[k] === null || prev[k] === null ? null : round(cur[k] - prev[k], k === 'bmr_kcal' ? 0 : 2);
  }
  return o;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/**
 * 身體組成分析（全部由程式計算，Gemini 只負責解讀）：
 * - 最新一次 vs 前一次、vs 區間內第一次
 * - 區間內每次測量的趨勢
 * - 由體脂肪與體重推得的「去脂體重」變化（體重 − 體脂肪），只在兩者都有測量時計算
 * bodies：已確認、依日期排序的 Body_Composition（只含 range.end 以前）
 */
export function computeBodyReport({ bodies, range, goals = [] }) {
  const inRange = bodies.filter((b) => b.measure_date >= range.start && b.measure_date <= range.end);
  const upto = bodies.filter((b) => b.measure_date <= range.end);
  const latest = snapshot(upto[upto.length - 1]);
  const previous = snapshot(upto[upto.length - 2]);
  const first = snapshot(inRange[0]);
  const lean = (s) => (s && s.weight_kg !== null && s.body_fat_kg !== null ? round(s.weight_kg - s.body_fat_kg, 2) : null);
  return {
    range,
    measurements_in_range: inRange.length,
    latest,
    previous,
    days_since_previous: latest && previous ? daysBetween(previous.date, latest.date) : null,
    vs_previous: diffs(latest, previous),
    first_in_range: first && latest && first.date !== latest.date ? first : null,
    vs_first_in_range: first && latest && first.date !== latest.date ? diffs(latest, first) : null,
    lean_mass_kg: { latest: lean(latest), previous: lean(previous), diff: lean(latest) !== null && lean(previous) !== null ? round(lean(latest) - lean(previous), 2) : null },
    trend: inRange.map((b) => ({ date: b.measure_date, weight_kg: b.weight_kg, body_fat_pct: b.body_fat_pct, skeletal_muscle_kg: b.skeletal_muscle_kg, visceral_fat: b.visceral_fat })),
    goals,
    note: '體脂率差異單位為百分點；去脂體重＝體重−體脂肪（兩者皆有測量才計算）。',
  };
}
