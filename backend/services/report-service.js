import { getStore } from '../database/sheets-service.js';
import { addDays, displayDate, isoNow, firstDayOfMonth, lastDayOfMonth, previousMonthRange } from '../utils/time.js';
import { computeDaily, computeWeekly, computeMonthly } from './report-calc.js';
import { listWeights } from './weight-service.js';
import { listBody } from './body-service.js';
import { listMeals } from './meal-service.js';
import { listExercise } from './exercise-service.js';
import { goalsWithProgress } from './goal-service.js';
import { getSettings, logSystem } from './common.js';
import { summarizeReport, summarizeBodyReport } from '../gemini/report-analysis.js';
import { computeBodyReport } from './body-report.js';
import { downloadPhoto } from '../database/drive-service.js';
import { splitForVision } from '../gemini/image-split.js';

export const REPORT_ZH = { Daily: '每日', Weekly: '每週', Monthly: '每月', Body: '身體組成' };
export const REPORT_TYPES = Object.keys(REPORT_ZH);
/** 身體組成分析的回顧區間（天） */
export const BODY_REPORT_DAYS = 90;

/** 依報告類型與基準日算出報告區間 */
export function reportRange(type, date) {
  if (type === 'Daily') return { start: date, end: date };
  if (type === 'Body') return { start: addDays(date, -(BODY_REPORT_DAYS - 1)), end: date };
  if (type === 'Weekly') {
    // 基準日所在週的週日（週一～週日）
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const sunday = dow === 0 ? date : addDays(date, 7 - dow);
    return { start: addDays(sunday, -6), end: sunday };
  }
  return { start: firstDayOfMonth(date), end: lastDayOfMonth(date) };
}

async function buildBodyComparison(userId, range, today) {
  const [bodies, goals] = await Promise.all([
    listBody(userId, { to: range.end }),
    goalsWithProgress(userId, today),
  ]);
  const goalBrief = goals.filter((g) => ['體脂', '肌肉', '體重'].includes(g.goal_type)).map((g) => ({
    goal_type: g.goal_type, target_value: g.target_value, current_value: g.current_value, unit: g.unit, progress_pct: g.progress.pct,
  }));
  return computeBodyReport({ bodies, range, goals: goalBrief });
}

/** 讀取一筆測量的原始照片並切段；沒有照片或讀取失敗回傳空陣列 */
async function photoImages(photoId) {
  if (!photoId) return [];
  try {
    const photo = await getStore().get('Body_Photo', photoId);
    if (!photo?.drive_file_id || String(photo.drive_file_id).startsWith('mem-')) return [];
    const { buffer } = await downloadPhoto(photo.drive_file_id);
    return await splitForVision(buffer, { maxSegments: 12 });
  } catch (e) {
    await logSystem('warn', 'report-ai', '讀取身體組成原始照片失敗', e.message);
    return [];
  }
}

async function buildComparison(userId, type, range, today, settings) {
  if (type === 'Body') return buildBodyComparison(userId, range, today);
  // 讀取足夠的歷史區間（含上一期）
  const from = type === 'Monthly' ? previousMonthRange(range.start).start : addDays(range.start, -14);
  const [weights, bodies, meals, exercises, reminders, goals] = await Promise.all([
    listWeights(userId, { from, to: range.end }),
    listBody(userId, { from, to: range.end }),
    listMeals(userId, { from, to: range.end }),
    listExercise(userId, { from, to: range.end }),
    getStore().list('Reminder_Log', (r) => r.user_id === userId && r.occurrence_date >= from && r.occurrence_date <= range.end),
    type === 'Daily' ? [] : goalsWithProgress(userId, today),
  ]);
  const goalBrief = goals.map((g) => ({
    goal_type: g.goal_type, start_value: g.start_value, target_value: g.target_value, current_value: g.current_value,
    unit: g.unit, target_date: g.target_date, progress_pct: g.progress.pct, remaining: g.progress.remaining, days_left: g.progress.days_left,
  }));
  if (type === 'Daily') return computeDaily({ date: range.end, weights, meals, exercises, settings });
  if (type === 'Weekly') return computeWeekly({ sunday: range.end, weights, bodies, meals, exercises, reminders, goals: goalBrief, settings });
  return computeMonthly({ date: range.end, today, weights, bodies, meals, exercises, reminders, goals: goalBrief, settings });
}

export async function findReport(userId, type, range) {
  const rows = await getStore().list('Report_Log', (r) => r.user_id === userId && r.report_type === type
    && r.start_date === range.start && r.end_date === range.end);
  return rows[rows.length - 1] || null;
}

/**
 * 產生報告。以 (user_id, report_type, start_date, end_date) 為唯一鍵，
 * 已存在則直接回傳（force=true 時重新計算並更新同一筆）。
 */
export async function generateReport(userId, type, date, { force = false, persist = true, tz } = {}) {
  const store = getStore();
  const settings = await getSettings(userId);
  tz = tz || settings.timezone;
  const today = isoNow(tz).slice(0, 10);
  const range = reportRange(type, date);
  const existing = persist ? await findReport(userId, type, range) : null;
  if (existing && !force) return existing;

  const comparison = await buildComparison(userId, type, range, today, settings);
  let aiSummary = '';
  if (settings.report_ai_enabled) {
    try {
      if (type === 'Body') {
        // 本次與上一次的原始照片一起給 Gemini，比較報告上的其他指標
        const [latest, previous] = await Promise.all([photoImages(comparison.latest?.photo_id), photoImages(comparison.previous?.photo_id)]);
        aiSummary = comparison.latest ? await summarizeBodyReport(comparison, { latest, previous }) : '';
      } else {
        aiSummary = await summarizeReport(type, comparison);
      }
    } catch (e) {
      await logSystem('warn', 'report-ai', `${type} 報告 AI 摘要失敗`, e.message);
      aiSummary = '';
    }
  }
  const now = isoNow(tz);
  const record = {
    user_id: userId, report_type: type, start_date: range.start, end_date: range.end,
    comparison_json: JSON.stringify(comparison), ai_summary: aiSummary, generated_at: now,
  };
  if (!persist) return { ...record, report_id: null, delivery_status: '即時查詢' };
  if (existing) {
    const { after } = await store.update('Report_Log', existing.report_id, record);
    return after;
  }
  const [row] = await store.append('Report_Log', { ...record, delivery_status: '已產生', retry_count: 0 });
  return row;
}

// ---------------------------------------------------------------------------
// LINE 文字格式
// ---------------------------------------------------------------------------

function fmtDiff(d, unit = 'kg') {
  if (d === null || d === undefined) return '';
  if (d === 0) return '持平';
  return `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(unit === '百分點' ? 1 : 1)} ${unit}`;
}

function v(x, unit) {
  return x === null || x === undefined ? '—' : `${x}${unit ? ` ${unit}` : ''}`;
}

function weightLine(label, w) {
  if (w.today_missing) return `${label}：今日未記錄`;
  if (w.previous_missing) return `${label}：${w.current} kg（前一日無資料）`;
  return `${label}：${w.current} kg（較前一日 ${fmtDiff(w.diff)}）`;
}

const BODY_ROWS = [
  ['weight_kg', '體重', 'kg'], ['body_fat_pct', '體脂率', '%', '百分點'], ['body_fat_kg', '體脂肪', 'kg'],
  ['skeletal_muscle_kg', '骨骼肌', 'kg'], ['visceral_fat', '內臟脂肪', ''], ['bmr_kcal', '基礎代謝', 'kcal'], ['bmi', 'BMI', ''],
];

function fmtSigned(d, unit) {
  if (d === null || d === undefined) return '—';
  if (d === 0) return '持平';
  return `${d > 0 ? '+' : '−'}${Math.abs(d)}${unit ? ` ${unit}` : ''}`;
}

function formatBodyLines(c, report) {
  const lines = [`🧍 身體組成分析｜${displayDate(report.end_date)}`];
  if (!c.latest) return [...lines, '這段期間沒有身體組成紀錄。請先上傳體脂計照片或報告截圖。'];
  lines.push(`本次：${displayDate(c.latest.date)}${c.latest.time ? ` ${c.latest.time}` : ''}`);
  lines.push(c.previous ? `上一次：${displayDate(c.previous.date)}（相隔 ${c.days_since_previous} 天）` : '上一次：無（這是第一次紀錄，下次上傳後即可比較）');
  lines.push('');
  for (const [k, label, unit, dUnit] of BODY_ROWS) {
    const cur = c.latest[k];
    lines.push(`${label}：${v(cur, unit)}${c.vs_previous ? `（${fmtSigned(c.vs_previous[k], dUnit ?? unit)}）` : ''}`);
  }
  if (c.lean_mass_kg?.latest !== null && c.lean_mass_kg?.latest !== undefined) {
    lines.push(`去脂體重：${c.lean_mass_kg.latest} kg${c.lean_mass_kg.diff !== null ? `（${fmtSigned(c.lean_mass_kg.diff, 'kg')}）` : ''}`);
  }
  if (c.vs_previous) lines.push('（括號內為與上一次相比）');
  if (c.measurements_in_range > 2) lines.push(`近 90 天共測量 ${c.measurements_in_range} 次`);
  c.goals?.forEach((g) => lines.push(`🎯 ${g.goal_type}目標 ${g.target_value}${g.unit}：進度 ${g.progress_pct ?? '—'}%`));
  return lines;
}

export function formatReportText(report) {
  let c = {};
  try { c = JSON.parse(report.comparison_json || '{}'); } catch { c = {}; }
  const lines = [];
  if (report.report_type === 'Daily') {
    lines.push(`📊 每日報告｜${displayDate(report.end_date)}`);
    lines.push(weightLine('⚖️ 上午', c.weight.am));
    lines.push(weightLine('⚖️ 下午', c.weight.pm));
    const n = c.nutrition;
    if (!n.recorded) lines.push('🥗 飲食：今日未記錄');
    else {
      lines.push(`🥗 熱量 ${v(n.calorie_kcal, 'kcal')}${n.calorie_target_kcal ? ` / ${n.calorie_target_kcal}` : ''}｜蛋白質 ${v(n.protein_g, 'g')}${n.protein_target_g ? ` / ${n.protein_target_g}` : ''}`);
      lines.push(`　已記錄：${n.meal_types.join('、') || '—'}${n.missing_meal_types.length ? `；未記錄：${n.missing_meal_types.join('、')}` : ''}${n.includes_ai_estimate ? '（含 AI 估算）' : ''}`);
    }
    lines.push(c.exercise.recorded ? `🚴 運動 ${c.exercise.total_min} 分鐘` : '🚴 運動：今日未記錄');
  } else if (report.report_type === 'Weekly') {
    lines.push(`📈 每週報告｜${displayDate(report.start_date)}～${displayDate(report.end_date)}`);
    const b = c.body_composition;
    if (b.comparison) {
      lines.push('🧍 身體組成（本週日 vs 上週日）');
      lines.push(`　體重 ${v(b.this_sunday.weight_kg, 'kg')}（${fmtDiff(b.comparison.weight_kg.diff) || '—'}）`);
      lines.push(`　體脂率 ${v(b.this_sunday.body_fat_pct, '%')}（${fmtDiff(b.comparison.body_fat_pct_pp.diff, '百分點') || '—'}）`);
      lines.push(`　骨骼肌 ${v(b.this_sunday.skeletal_muscle_kg, 'kg')}（${fmtDiff(b.comparison.skeletal_muscle_kg.diff) || '—'}）`);
    } else {
      lines.push(`🧍 身體組成：${typeof b.this_sunday === 'string' ? b.this_sunday : '本週已測量'}${typeof b.last_sunday === 'string' ? `／${b.last_sunday}` : ''}，無法比較`);
    }
    const w = c.weight_am;
    lines.push(`⚖️ 上午體重週平均 ${v(w.this_week.avg, 'kg')}（${w.this_week.recorded_days} 天）${w.avg_diff !== null ? `，較上週 ${fmtDiff(w.avg_diff)}` : ''}`);
    const n = c.nutrition;
    lines.push(n.recorded_days ? `🥗 平均熱量 ${v(n.avg_calorie_kcal, 'kcal')}、蛋白質 ${v(n.avg_protein_g, 'g')}（${n.recorded_days} 天有紀錄）` : '🥗 本週無飲食紀錄');
    lines.push(`🚴 運動 ${c.exercise.total_min} 分鐘／${c.exercise.days} 天${c.exercise.target_min_week ? `（目標 ${c.exercise.target_min_week}）` : ''}`);
    lines.push(`✅ 作業 ${c.tasks.completed}/${c.tasks.due} 完成${c.tasks.overdue ? `，逾期 ${c.tasks.overdue}` : ''}`);
    c.goals?.forEach((g) => lines.push(`🎯 ${g.goal_type}目標 ${g.target_value}${g.unit}：進度 ${g.progress_pct ?? '—'}%`));
  } else if (report.report_type === 'Body') {
    lines.push(...formatBodyLines(c, report));
  } else {
    lines.push(`🗓️ 每月報告｜${report.start_date.slice(0, 7)}`);
    const w = c.weight_am;
    lines.push(`⚖️ 上午體重月平均 ${v(w.this_month.avg, 'kg')}${w.avg_diff !== null ? `（較上月 ${fmtDiff(w.avg_diff)}）` : ''}`);
    if (w.month_change !== null) lines.push(`　月初 ${w.this_month.first.weight_kg} → 月末 ${w.this_month.last.weight_kg}（${fmtDiff(w.month_change)}）`);
    lines.push(`　紀錄完整度 ${w.completeness_pct}%（${w.this_month.recorded_days} 天）`);
    const b = c.body_composition;
    if (b.this_month.last) lines.push(`🧍 最新體脂率 ${v(b.this_month.last.body_fat_pct, '%')}、骨骼肌 ${v(b.this_month.last.skeletal_muscle_kg, 'kg')}（本月測量 ${b.this_month.measurements} 次）`);
    else lines.push('🧍 本月未測量身體組成');
    const n = c.nutrition.this_month;
    lines.push(n.recorded_days ? `🥗 平均熱量 ${v(n.avg_calorie_kcal, 'kcal')}、蛋白質 ${v(n.avg_protein_g, 'g')}（${n.recorded_days} 天）` : '🥗 本月無飲食紀錄');
    lines.push(`🚴 運動 ${c.exercise.this_month.total_min} 分鐘／${c.exercise.this_month.days} 天（上月 ${c.exercise.last_month.total_min} 分鐘）`);
    c.goals?.forEach((g) => lines.push(`🎯 ${g.goal_type}目標 ${g.target_value}${g.unit}：進度 ${g.progress_pct ?? '—'}%`));
  }
  if (report.ai_summary) {
    lines.push('', '🤖 Gemini 分析摘要', report.ai_summary, '', '※ 分析依已確認數據產生，不作藥物調整建議。');
  }
  return lines.join('\n').slice(0, 4900);
}
