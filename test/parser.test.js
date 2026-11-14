import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../backend/line/parser.js';
import { resolvePeriod, validateWeight } from '../backend/services/weight-service.js';
import { DEFAULT_SETTINGS } from '../backend/database/schema.js';
import { parseDateToken, addDays, dayOfWeek, lastDayOfMonth, inWindow, nowIn } from '../backend/utils/time.js';

const T = '2026-11-09';

test('體重指令', () => {
  assert.deepEqual(parseCommand('59.8', T), { type: 'weight', value: 59.8, period: null, date: T, time: null, backfill: false });
  assert.equal(parseCommand('上午 59.8', T).period, 'AM');
  assert.equal(parseCommand('下午59.5kg', T).period, 'PM');
  assert.equal(parseCommand('５９．８', T).value, 59.8);
  const b = parseCommand('補登 11/08 下午 59.5 15:10', T);
  assert.equal(b.date, '2026-11-08');
  assert.equal(b.period, 'PM');
  assert.equal(b.time, '15:10');
  assert.equal(b.backfill, true);
  assert.equal(parseCommand('昨天 上午 60.1', T).date, '2026-11-08');
});

test('施打、運動、飲食', () => {
  const inj = parseCommand('施打 2.5mg', T);
  assert.equal(inj.type, 'injection');
  assert.equal(inj.dosage, 2.5);
  assert.equal(parseCommand('已施打 Mounjaro 5 mg', T).medication, 'Mounjaro');
  assert.equal(parseCommand('未施打', T).status, '未施打');

  const ex = parseCommand('今天騎車 60 分鐘，約 15 公里。', T);
  assert.equal(ex.type, 'exercise');
  assert.equal(ex.exerciseType, '騎車');
  assert.equal(ex.minutes, 60);
  assert.equal(ex.distanceKm, 15);
  assert.equal(parseCommand('快走 1.5 小時', T).minutes, 90);

  const meal = parseCommand('午餐：水煮蛋2顆、蛋白飲一瓶', T);
  assert.equal(meal.type, 'meal');
  assert.equal(meal.mealType, '午餐');
  assert.equal(meal.description, '水煮蛋2顆、蛋白飲一瓶');
});

test('查詢與其他指令', () => {
  assert.equal(parseCommand('今日報告', T).reportType, 'Daily');
  assert.equal(parseCommand('本週報告', T).reportType, 'Weekly');
  assert.equal(parseCommand('最近30天', T).days, 30);
  assert.deepEqual(parseCommand('修改 體脂率 28.4', T), { type: 'modify', field: '體脂率', value: 28.4 });
  const g = parseCommand('目標 體重 55 2027/03/31', T);
  assert.equal(g.type, 'goal_set');
  assert.equal(g.targetDate, '2027-03-31');
  assert.equal(parseCommand('確認', T).type, 'confirm');
  assert.equal(parseCommand('今天天氣好嗎', T).type, 'unknown');
});

test('時段判斷與數值檢查', () => {
  assert.equal(resolvePeriod('08:02', DEFAULT_SETTINGS), 'AM');
  assert.equal(resolvePeriod('14:00', DEFAULT_SETTINGS), 'PM');
  assert.equal(resolvePeriod('23:30', DEFAULT_SETTINGS), null);
  assert.equal(validateWeight(5, DEFAULT_SETTINGS).ok, false);
  assert.ok(validateWeight(65, DEFAULT_SETTINGS, { weight_kg: 59.8, measure_date: T, period: 'AM' }).warning);
  assert.equal(validateWeight(60, DEFAULT_SETTINGS, { weight_kg: 59.8 }).warning, undefined);
});

test('日期工具', () => {
  assert.equal(parseDateToken('12/31', '2027-01-02'), '2026-12-31');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(dayOfWeek('2026-11-08'), 0);
  assert.equal(lastDayOfMonth('2028-02-10'), '2028-02-29');
  assert.ok(inWindow('23:30', '22:00', '02:00'));
  const n = nowIn('Asia/Taipei', new Date('2026-11-08T23:30:00Z'));
  assert.equal(n.date, '2026-11-09');
  assert.equal(n.time, '07:30');
  assert.ok(n.iso.endsWith('+08:00'));
});
