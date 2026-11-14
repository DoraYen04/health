import { getStore } from '../database/sheets-service.js';
import { DEFAULT_SETTINGS, DEFAULT_TASKS, STATUS, SHEETS } from '../database/schema.js';
import { isoNow } from '../utils/time.js';
import { config } from '../../config/settings.js';

const NUMERIC_SETTINGS = [
  'weight_min_kg', 'weight_max_kg', 'weight_jump_alert_kg', 'height_cm',
  'calorie_target_kcal', 'protein_target_g', 'fat_target_g', 'carb_target_g',
  'exercise_target_min_week',
];

/** 讀取使用者設定（缺欄位以預設值補上） */
export async function getSettings(userId) {
  const [row] = await getStore().list('Settings', { user_id: userId });
  const merged = { ...DEFAULT_SETTINGS, ...(row ? stripNulls(row) : {}), user_id: userId };
  for (const k of NUMERIC_SETTINGS) {
    merged[k] = merged[k] === '' || merged[k] === null || merged[k] === undefined ? null : Number(merged[k]);
  }
  merged.reminder_enabled = toBool(merged.reminder_enabled);
  merged.report_ai_enabled = toBool(merged.report_ai_enabled);
  merged._exists = !!row;
  return merged;
}

export async function listUsers() {
  return getStore().list('Settings');
}

export function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined || v === '') return false;
  return ['true', '1', 'yes', 'y', '是', 'on'].includes(String(v).trim().toLowerCase());
}

function stripNulls(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
}

/** 首次加入好友：建立 Settings 與預設作業排程 */
export async function ensureUser(userId, displayName = '') {
  const store = getStore();
  const [row] = await store.list('Settings', { user_id: userId });
  if (row) return { created: false };
  const now = isoNow(config.timezone);
  await store.append('Settings', {
    ...DEFAULT_SETTINGS, user_id: userId, display_name: displayName, created_at: now, updated_at: now,
  });
  await store.append('Task_Schedule', DEFAULT_TASKS.map((t) => ({
    enabled: true, weekday: '', day_of_month: '', ...t, user_id: userId, created_at: now, updated_at: now,
  })));
  return { created: true };
}

/**
 * 修改紀錄：寫入新值並保留每個變動欄位的前後值到 Audit_Log。
 * 原始紀錄不刪除；刪除一律改 status = 已刪除。
 */
export async function updateWithAudit(sheet, id, patch, { userId, changedBy }) {
  const store = getStore();
  const now = isoNow(config.timezone);
  const fullPatch = { ...patch };
  if (SHEETS[sheet].includes('updated_at')) fullPatch.updated_at = now;
  if ('status' in fullPatch === false && hasStatusCorrected(sheet)) fullPatch.status = STATUS.CORRECTED;
  const { before, after } = await store.update(sheet, id, fullPatch);
  const audits = [];
  for (const [field, value] of Object.entries(patch)) {
    if (String(before[field] ?? '') !== String(value ?? '')) {
      audits.push({
        user_id: userId, sheet, record_id: id, field,
        before_value: before[field] ?? '', after_value: value ?? '',
        changed_by: changedBy, changed_at: now,
      });
    }
  }
  if (audits.length) await store.append('Audit_Log', audits);
  return { before, after, changes: audits.length };
}

function hasStatusCorrected(sheet) {
  return ['Weight_Log', 'Body_Composition', 'Meal_Log', 'Exercise_Log'].includes(sheet);
}

/** 系統異常紀錄（寫入 System_Log；失敗不拋出） */
export async function logSystem(level, source, message, detail = '') {
  const line = `[${level}] ${source}: ${message}`;
  if (level === 'error') console.error(line, detail); else console.log(line);
  try {
    await getStore().append('System_Log', {
      level, source, message: String(message).slice(0, 500),
      detail: typeof detail === 'string' ? detail.slice(0, 2000) : JSON.stringify(detail).slice(0, 2000),
      created_at: isoNow(config.timezone),
    });
  } catch (e) {
    console.error('System_Log 寫入失敗', e.message);
  }
}

export function round(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
  const f = 10 ** digits;
  return Math.round(Number(n) * f) / f;
}

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function isActive(row) {
  return row.status !== STATUS.DELETED;
}
