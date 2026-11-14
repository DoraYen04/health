import { getStore } from '../database/sheets-service.js';
import { STATUS } from '../database/schema.js';
import { inWindow, isoNow, weekdayZh } from '../utils/time.js';
import { isActive, num, updateWithAudit } from './common.js';

/** 依設定的上午／下午時段判斷；落在兩者之外回傳 null（需詢問使用者） */
export function resolvePeriod(time, settings) {
  if (inWindow(time, settings.am_window_start, settings.am_window_end)) return 'AM';
  if (inWindow(time, settings.pm_window_start, settings.pm_window_end)) return 'PM';
  return null;
}

export function periodZh(p) {
  return p === 'AM' ? '上午' : p === 'PM' ? '下午' : '';
}

/**
 * 數值檢查。回傳 { ok, error?, warning? }
 * - 超出 weight_min/max → 錯誤，要求重新輸入
 * - 與最近一筆差距超過 weight_jump_alert_kg → 警告，需使用者再確認
 */
export function validateWeight(value, settings, lastWeight) {
  const v = num(value);
  if (v === null) return { ok: false, error: '體重格式錯誤，請輸入數字，例如 59.8' };
  const min = settings.weight_min_kg ?? 30;
  const max = settings.weight_max_kg ?? 200;
  if (v < min || v > max) return { ok: false, error: `體重 ${v} kg 超出合理範圍（${min}–${max} kg），請重新輸入。` };
  const jump = settings.weight_jump_alert_kg;
  if (lastWeight && jump && Math.abs(v - lastWeight.weight_kg) > jump) {
    return {
      ok: true,
      warning: `與上一筆（${lastWeight.measure_date} ${periodZh(lastWeight.period)} ${lastWeight.weight_kg} kg）相差 ${Math.abs(v - lastWeight.weight_kg).toFixed(1)} kg，請確認數值是否正確。`,
    };
  }
  return { ok: true };
}

export async function listWeights(userId, { from, to } = {}) {
  const rows = await getStore().list('Weight_Log', (r) => r.user_id === userId && isActive(r)
    && (!from || r.measure_date >= from) && (!to || r.measure_date <= to));
  return rows.map((r) => ({ ...r, weight_kg: num(r.weight_kg) }))
    .sort((a, b) => (a.measure_date + a.period + a.measure_time).localeCompare(b.measure_date + b.period + b.measure_time));
}

export async function latestWeight(userId) {
  const rows = await listWeights(userId);
  return rows.length ? rows[rows.length - 1] : null;
}

export async function findSamePeriod(userId, date, period) {
  return getStore().list('Weight_Log', (r) => r.user_id === userId && isActive(r)
    && r.measure_date === date && r.period === period);
}

export async function createWeight({ userId, date, time, period, weight, source = 'LINE', isBackfill = false, note = '', tz }) {
  const now = isoNow(tz);
  const [row] = await getStore().append('Weight_Log', {
    user_id: userId,
    measure_date: date,
    weekday: weekdayZh(date),
    measure_time: time,
    period,
    weight_kg: Number(weight),
    source: isBackfill ? '補登' : source,
    is_backfill: !!isBackfill,
    status: STATUS.NORMAL,
    note,
    created_at: now,
    updated_at: now,
  });
  return row;
}

/** 覆蓋原紀錄（保留修改前後值） */
export async function overwriteWeight(id, { weight, time, userId, changedBy = 'LINE' }) {
  return updateWithAudit('Weight_Log', id, { weight_kg: Number(weight), measure_time: time }, { userId, changedBy });
}
