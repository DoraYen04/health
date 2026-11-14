import { getStore } from '../database/sheets-service.js';
import { isoNow, diffDays } from '../utils/time.js';
import { num, round } from './common.js';
import { listWeights } from './weight-service.js';
import { listBody } from './body-service.js';

export const GOAL_TYPES = { 體重: 'weight_kg', 體脂: 'body_fat_pct', 肌肉: 'skeletal_muscle_kg' };
const UNITS = { 體重: 'kg', 體脂: '%', 肌肉: 'kg' };

export async function listGoals(userId, { activeOnly = false } = {}) {
  const rows = await getStore().list('Goal_Log', (r) => r.user_id === userId && (!activeOnly || r.status === '進行中'));
  return rows.map((g) => ({ ...g, start_value: num(g.start_value), target_value: num(g.target_value), current_value: num(g.current_value) }));
}

/** 取得目標類型的最新確認值 */
export async function latestValue(userId, goalType) {
  if (goalType === '體重') {
    const w = await listWeights(userId);
    return w.length ? { value: w[w.length - 1].weight_kg, date: w[w.length - 1].measure_date } : null;
  }
  const field = GOAL_TYPES[goalType];
  const b = (await listBody(userId)).filter((r) => r[field] !== null);
  return b.length ? { value: b[b.length - 1][field], date: b[b.length - 1].measure_date } : null;
}

/** 目標進度（程式計算，不交給 AI） */
export function goalProgress(goal, current, today) {
  const start = num(goal.start_value);
  const target = num(goal.target_value);
  if (start === null || target === null || current === null || current === undefined || start === target) {
    return { pct: null, remaining: null, days_left: goal.target_date ? diffDays(today, goal.target_date) : null };
  }
  const pct = ((start - current) / (start - target)) * 100;
  return {
    pct: round(Math.max(0, Math.min(100, pct)), 0),
    raw_pct: round(pct, 1),
    remaining: round(Math.abs(target - current), 1),
    direction: target < start ? '下降' : '上升',
    days_left: goal.target_date ? diffDays(today, goal.target_date) : null,
  };
}

export async function goalsWithProgress(userId, today) {
  const goals = await listGoals(userId, { activeOnly: true });
  const out = [];
  for (const g of goals) {
    const latest = await latestValue(userId, g.goal_type);
    const current = latest ? latest.value : g.current_value;
    out.push({ ...g, current_value: current, current_date: latest?.date || null, unit: UNITS[g.goal_type] || '', progress: goalProgress(g, current, today) });
  }
  return out;
}

/** 新目標：同類型舊的進行中目標改為「暫停」，起始值預設為目前最新值 */
export async function createGoal({ userId, goalType, targetValue, targetDate, startValue, startDate, note = '', tz }) {
  const store = getStore();
  const now = isoNow(tz);
  const today = now.slice(0, 10);
  const old = (await listGoals(userId, { activeOnly: true })).filter((g) => g.goal_type === goalType);
  if (old.length) {
    await store.updateMany('Goal_Log', old.map((g) => ({ id: g.goal_id, patch: { status: '暫停', updated_at: now } })));
  }
  let start = num(startValue);
  if (start === null) start = (await latestValue(userId, goalType))?.value ?? null;
  const [row] = await store.append('Goal_Log', {
    user_id: userId, goal_type: goalType, start_value: start, target_value: num(targetValue),
    start_date: startDate || today, target_date: targetDate || '', current_value: start,
    status: '進行中', note, created_at: now, updated_at: now,
  });
  return row;
}
