import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDaily, computeWeekly, weightAt } from '../backend/services/report-calc.js';
import { goalProgress } from '../backend/services/goal-service.js';

const w = (date, period, kg, t = '08:00') => ({ measure_date: date, period, weight_kg: kg, measure_time: t, created_at: `${date}T${t}` });

test('每日報告：同時段比較，缺值不以其他時段代替', () => {
  const weights = [w('2026-11-08', 'AM', 60.1), w('2026-11-09', 'AM', 59.8), w('2026-11-09', 'PM', 59.5, '14:02')];
  const c = computeDaily({ date: '2026-11-09', weights, meals: [], exercises: [], settings: {} });
  assert.equal(c.weight.am.diff, -0.3);
  assert.equal(c.weight.pm.previous_missing, true);
  assert.equal(c.weight.pm.diff, null);
  assert.equal(c.nutrition.recorded, false);
  assert.equal(c.nutrition.calorie_kcal, null); // 未記錄不視為 0
  assert.equal(c.exercise.total_min, null);
});

test('同時段多筆取最後輸入', () => {
  const weights = [w('2026-11-09', 'AM', 59.8, '08:00'), w('2026-11-09', 'AM', 59.6, '08:30')];
  assert.equal(weightAt(weights, '2026-11-09', 'AM').weight_kg, 59.6);
});

test('每週報告：週日未測量時標示，不以其他日期代替', () => {
  const bodies = [
    { measure_date: '2026-11-01', measure_time: '09:00', weight_kg: 60.3, body_fat_pct: 29.1, skeletal_muscle_kg: 25.0 },
    { measure_date: '2026-11-07', measure_time: '09:00', weight_kg: 59.9, body_fat_pct: 28.9, skeletal_muscle_kg: 25.1 },
  ];
  const base = { weights: [], meals: [], exercises: [], reminders: [], goals: [], settings: {} };
  const c1 = computeWeekly({ ...base, sunday: '2026-11-08', bodies });
  assert.equal(c1.body_composition.this_sunday, '本週未測量');
  assert.equal(c1.body_composition.comparison, null);

  const c2 = computeWeekly({ ...base, sunday: '2026-11-08', bodies: [...bodies, { measure_date: '2026-11-08', measure_time: '09:00', weight_kg: 59.5, body_fat_pct: 28.6, skeletal_muscle_kg: 25.2 }] });
  assert.equal(c2.body_composition.comparison.weight_kg.diff, -0.8);
  assert.equal(c2.body_composition.comparison.body_fat_pct_pp.diff, -0.5);
  assert.equal(c2.body_composition.comparison.skeletal_muscle_kg.diff, 0.2);
});

test('目標進度', () => {
  const p = goalProgress({ start_value: 62, target_value: 55, target_date: '2027-01-01' }, 59.9, '2026-11-09');
  assert.equal(p.pct, 30);
  assert.equal(p.remaining, 4.9);
  assert.equal(p.days_left, 53);
});
