// 報告的所有數值計算（純函式）。Gemini 只負責解讀，不可修改這裡算出的數字。

import { addDays, diffDays, previousMonthRange, firstDayOfMonth, lastDayOfMonth, weekdayZh } from '../utils/time.js';
import { round } from './common.js';
import { summarizeDay } from './meal-service.js';
import { summarizeExercise } from './exercise-service.js';
import { bodyOnDate } from './body-service.js';

/** 指定日期、時段的體重（同時段多筆取最後輸入）；查無回傳 null，不以其他時段代替 */
export function weightAt(weights, date, period) {
  const same = weights.filter((w) => w.measure_date === date && w.period === period);
  if (!same.length) return null;
  same.sort((a, b) => String(a.created_at || a.measure_time).localeCompare(String(b.created_at || b.measure_time)));
  return same[same.length - 1];
}

function diff(a, b, digits = 2) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return round(a - b, digits);
}

function cmp(cur, prev, digits = 2) {
  return { current: cur ?? null, previous: prev ?? null, diff: diff(cur, prev, digits) };
}

function dailyNutrition(meals, from, to) {
  const days = {};
  meals.filter((m) => m.meal_date >= from && m.meal_date <= to).forEach((m) => {
    (days[m.meal_date] = days[m.meal_date] || []).push(m);
  });
  const perDay = Object.entries(days).map(([d, ms]) => ({ date: d, ...summarizeDay(ms) }));
  const avg = (k) => {
    const vals = perDay.map((d) => d[k]).filter((v) => v !== null);
    return vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 0) : null;
  };
  return {
    recorded_days: perDay.length,
    avg_calorie_kcal: avg('calorie_kcal'),
    avg_protein_g: avg('protein_g'),
    includes_ai_estimate: perDay.some((d) => d.includes_ai_estimate),
  };
}

function weightStats(weights, from, to, period = 'AM') {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const w = weightAt(weights, d, period);
    if (w) days.push({ date: d, weight_kg: w.weight_kg });
  }
  if (!days.length) return { recorded_days: 0, first: null, last: null, avg: null, min: null, max: null };
  const vals = days.map((d) => d.weight_kg);
  return {
    recorded_days: days.length,
    first: days[0],
    last: days[days.length - 1],
    avg: round(vals.reduce((a, b) => a + b, 0) / vals.length, 2),
    min: Math.min(...vals),
    max: Math.max(...vals),
  };
}

function bodySnapshot(b) {
  if (!b) return null;
  return {
    date: b.measure_date,
    weight_kg: b.weight_kg,
    body_fat_pct: b.body_fat_pct,
    body_fat_kg: b.body_fat_kg,
    skeletal_muscle_kg: b.skeletal_muscle_kg,
    visceral_fat: b.visceral_fat,
  };
}

function bodyCompare(cur, prev) {
  return {
    weight_kg: cmp(cur?.weight_kg, prev?.weight_kg),
    body_fat_pct_pp: cmp(cur?.body_fat_pct, prev?.body_fat_pct),
    body_fat_kg: cmp(cur?.body_fat_kg, prev?.body_fat_kg),
    skeletal_muscle_kg: cmp(cur?.skeletal_muscle_kg, prev?.skeletal_muscle_kg),
  };
}

function taskStats(reminders, from, to) {
  const firsts = reminders.filter((r) => r.reminder_type === '首次'
    && r.occurrence_date >= from && r.occurrence_date <= to);
  return {
    due: firsts.length,
    completed: firsts.filter((r) => r.status === '已完成').length,
    overdue: firsts.filter((r) => r.status === '逾期').length,
  };
}

// ---------------------------------------------------------------------------

export function computeDaily({ date, weights, meals, exercises, settings }) {
  const prev = addDays(date, -1);
  const amT = weightAt(weights, date, 'AM');
  const amP = weightAt(weights, prev, 'AM');
  const pmT = weightAt(weights, date, 'PM');
  const pmP = weightAt(weights, prev, 'PM');
  const todayMeals = meals.filter((m) => m.meal_date === date);
  const todayEx = exercises.filter((e) => e.exercise_date === date);
  const n = summarizeDay(todayMeals);
  const ex = summarizeExercise(todayEx);
  return {
    report_type: 'Daily',
    period: { start: date, end: date, weekday: weekdayZh(date), compared_with: prev },
    weight: {
      am: { ...cmp(amT?.weight_kg, amP?.weight_kg), today_time: amT?.measure_time || null, previous_missing: !amP, today_missing: !amT },
      pm: { ...cmp(pmT?.weight_kg, pmP?.weight_kg), today_time: pmT?.measure_time || null, previous_missing: !pmP, today_missing: !pmT },
      am_pm_gap_today: diff(pmT?.weight_kg, amT?.weight_kg),
    },
    nutrition: {
      ...n,
      calorie_target_kcal: settings?.calorie_target_kcal ?? null,
      protein_target_g: settings?.protein_target_g ?? null,
      calorie_pct: n.calorie_kcal !== null && settings?.calorie_target_kcal ? round((n.calorie_kcal / settings.calorie_target_kcal) * 100, 0) : null,
      protein_pct: n.protein_g !== null && settings?.protein_target_g ? round((n.protein_g / settings.protein_target_g) * 100, 0) : null,
    },
    exercise: {
      recorded: ex.recorded,
      total_min: ex.recorded ? ex.total_min : null,
      by_type: ex.by_type,
      calories_estimated: ex.calories_estimated,
    },
  };
}

/** sunday：本週日；與上週日比較；週區間為週一～週日 */
export function computeWeekly({ sunday, weights, bodies, meals, exercises, reminders, goals, settings }) {
  const lastSunday = addDays(sunday, -7);
  const start = addDays(sunday, -6);
  const prevStart = addDays(lastSunday, -6);
  const cur = bodySnapshot(bodyOnDate(bodies, sunday));
  const prev = bodySnapshot(bodyOnDate(bodies, lastSunday));
  const ex = summarizeExercise(exercises.filter((e) => e.exercise_date >= start && e.exercise_date <= sunday));
  const exPrev = summarizeExercise(exercises.filter((e) => e.exercise_date >= prevStart && e.exercise_date <= lastSunday));
  const wk = weightStats(weights, start, sunday, 'AM');
  const wkPrev = weightStats(weights, prevStart, lastSunday, 'AM');
  return {
    report_type: 'Weekly',
    period: { start, end: sunday, compared_with: { start: prevStart, end: lastSunday } },
    body_composition: {
      this_sunday: cur || '本週未測量',
      last_sunday: prev || '上週未測量',
      comparison: cur && prev ? bodyCompare(cur, prev) : null,
    },
    weight_am: {
      this_week: wk,
      last_week: wkPrev,
      avg_diff: diff(wk.avg, wkPrev.avg),
    },
    nutrition: { ...dailyNutrition(meals, start, sunday), calorie_target_kcal: settings?.calorie_target_kcal ?? null, protein_target_g: settings?.protein_target_g ?? null },
    exercise: {
      total_min: ex.recorded ? ex.total_min : 0,
      days: ex.days,
      by_type: ex.by_type,
      last_week_total_min: exPrev.recorded ? exPrev.total_min : 0,
      target_min_week: settings?.exercise_target_min_week ?? null,
    },
    tasks: taskStats(reminders, start, sunday),
    goals: goals || [],
  };
}

/** date：當月任一天（通常為月底）；與上個月相同口徑比較 */
export function computeMonthly({ date, today, weights, bodies, meals, exercises, reminders, goals }) {
  const start = firstDayOfMonth(date);
  const end = lastDayOfMonth(date);
  const effectiveEnd = today && today < end ? today : end;
  const prev = previousMonthRange(date);
  const w = weightStats(weights, start, effectiveEnd, 'AM');
  const wPrev = weightStats(weights, prev.start, prev.end, 'AM');
  const inMonth = bodies.filter((b) => b.measure_date >= start && b.measure_date <= end);
  const inPrev = bodies.filter((b) => b.measure_date >= prev.start && b.measure_date <= prev.end);
  const ex = summarizeExercise(exercises.filter((e) => e.exercise_date >= start && e.exercise_date <= end));
  const exPrev = summarizeExercise(exercises.filter((e) => e.exercise_date >= prev.start && e.exercise_date <= prev.end));
  const daysElapsed = diffDays(start, effectiveEnd) + 1;
  return {
    report_type: 'Monthly',
    period: { start, end, compared_with: prev },
    weight_am: {
      this_month: w,
      last_month: wPrev,
      avg_diff: diff(w.avg, wPrev.avg),
      month_change: w.first && w.last ? diff(w.last.weight_kg, w.first.weight_kg) : null,
      completeness_pct: round((w.recorded_days / daysElapsed) * 100, 0),
    },
    body_composition: {
      this_month: { measurements: inMonth.length, first: bodySnapshot(inMonth[0]), last: bodySnapshot(inMonth[inMonth.length - 1]) },
      last_month: { measurements: inPrev.length, last: bodySnapshot(inPrev[inPrev.length - 1]) },
      last_vs_last_month: inMonth.length && inPrev.length ? bodyCompare(bodySnapshot(inMonth[inMonth.length - 1]), bodySnapshot(inPrev[inPrev.length - 1])) : null,
    },
    nutrition: { this_month: dailyNutrition(meals, start, end), last_month: dailyNutrition(meals, prev.start, prev.end) },
    exercise: {
      this_month: { total_min: ex.recorded ? ex.total_min : 0, days: ex.days, by_type: ex.by_type },
      last_month: { total_min: exPrev.recorded ? exPrev.total_min : 0, days: exPrev.days },
    },
    tasks: taskStats(reminders, start, end),
    goals: goals || [],
  };
}
