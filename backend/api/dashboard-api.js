import express from 'express';
import { getStore } from '../database/sheets-service.js';
import { SHEETS, STATUS, TASK_TYPES, DEFAULT_SETTINGS } from '../database/schema.js';
import { config } from '../../config/settings.js';
import { requireAuth, loginWithGoogle, logout } from './auth.js';
import { addDays, isoNow, nowIn, weekdayZh, isDateStr, toMinutes } from '../utils/time.js';
import { getSettings, updateWithAudit, isActive, logSystem, toBool } from '../services/common.js';
import { listWeights, createWeight, validateWeight } from '../services/weight-service.js';
import { listBody, createBodyComposition, sanitizeBody, BODY_FIELDS } from '../services/body-service.js';
import { listMeals, createMeal, summarizeDay } from '../services/meal-service.js';
import { listExercise, createExercise, summarizeExercise } from '../services/exercise-service.js';
import { createInjection, listInjections } from '../services/injection-service.js';
import { goalsWithProgress, createGoal } from '../services/goal-service.js';
import { generateReport, formatReportText } from '../services/report-service.js';
import { taskOccursOn, isTaskCompleted } from '../scheduler/reminder-job.js';
import { downloadPhoto } from '../database/drive-service.js';

export const apiRouter = express.Router();
apiRouter.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// 公開
// ---------------------------------------------------------------------------

apiRouter.get('/config', (req, res) => {
  res.json({
    googleClientId: config.dashboard.googleClientId,
    devAuth: process.env.NODE_ENV !== 'production' && !!process.env.DEV_AUTH_USER_ID,
  });
});
apiRouter.post('/auth/google', loginWithGoogle);
apiRouter.post('/auth/logout', logout);

apiRouter.use(requireAuth);

const wrap = (fn) => (req, res) => fn(req, res).catch(async (e) => {
  await logSystem('error', 'api', `${req.method} ${req.path} 失敗`, e.stack || e.message);
  res.status(e.status || 500).json({ error: e.expose ? e.message : '系統錯誤，請稍後再試' });
});

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

function today(settings) {
  return nowIn(settings.timezone).date;
}

// ---------------------------------------------------------------------------
// 使用者 / 總覽
// ---------------------------------------------------------------------------

apiRouter.get('/me', wrap(async (req, res) => {
  const s = await getSettings(req.userId);
  res.json({ user_id: req.userId, email: req.userEmail, display_name: s.display_name, timezone: s.timezone, today: today(s), baseUrl: config.baseUrl });
}));

apiRouter.get('/overview', wrap(async (req, res) => {
  const uid = req.userId;
  const s = await getSettings(uid);
  const d = today(s);
  const weekStart = addDays(d, -6);
  const [weights, bodies, mealsToday, exWeek, goals, tasks, overdue] = await Promise.all([
    listWeights(uid, { from: addDays(d, -60) }),
    listBody(uid),
    listMeals(uid, { from: d, to: d }),
    listExercise(uid, { from: weekStart, to: d }),
    goalsWithProgress(uid, d),
    getStore().list('Task_Schedule', (t) => t.user_id === uid),
    getStore().list('Reminder_Log', (r) => r.user_id === uid && r.status === '逾期' && r.occurrence_date >= addDays(d, -7)),
  ]);
  const lw = weights[weights.length - 1] || null;
  const lb = bodies[bodies.length - 1] || null;
  const pb = bodies.length > 1 ? bodies[bodies.length - 2] : null;
  const todayTasks = [];
  for (const t of tasks.filter((x) => toBool(x.enabled) && taskOccursOn(x, d) && !String(x.task_type).endsWith('_report'))) {
    todayTasks.push({ task_id: t.task_id, task_name: t.task_name, remind_time: t.remind_time, done: await isTaskCompleted(uid, t.task_type, d) });
  }
  const taskName = Object.fromEntries(tasks.map((t) => [t.task_id, t.task_name]));
  res.json({
    today: d,
    latest_weight: lw,
    latest_body: lb,
    body_change: lb && pb ? {
      since: pb.measure_date,
      body_fat_pct_pp: lb.body_fat_pct !== null && pb.body_fat_pct !== null ? Math.round((lb.body_fat_pct - pb.body_fat_pct) * 10) / 10 : null,
      skeletal_muscle_kg: lb.skeletal_muscle_kg !== null && pb.skeletal_muscle_kg !== null ? Math.round((lb.skeletal_muscle_kg - pb.skeletal_muscle_kg) * 10) / 10 : null,
    } : null,
    goals,
    nutrition_today: { ...summarizeDay(mealsToday), calorie_target_kcal: s.calorie_target_kcal, protein_target_g: s.protein_target_g },
    exercise_week: { ...summarizeExercise(exWeek), target_min_week: s.exercise_target_min_week, from: weekStart },
    today_tasks: todayTasks.sort((a, b) => String(a.remind_time).localeCompare(String(b.remind_time))),
    overdue: overdue.map((o) => ({ ...o, task_name: taskName[o.task_id] || '' })),
  });
}));

/** 趨勢資料 */
apiRouter.get('/series', wrap(async (req, res) => {
  const uid = req.userId;
  const s = await getSettings(uid);
  const to = isDateStr(req.query.to) ? req.query.to : today(s);
  const from = isDateStr(req.query.from) ? req.query.from : addDays(to, -29);
  const [weights, bodies, meals, exercises] = await Promise.all([
    listWeights(uid, { from, to }), listBody(uid, { from, to }), listMeals(uid, { from, to }), listExercise(uid, { from, to }),
  ]);
  const byDay = {};
  meals.forEach((m) => { (byDay[m.meal_date] = byDay[m.meal_date] || []).push(m); });
  const nutrition = Object.entries(byDay).sort().map(([date, ms]) => ({ date, ...summarizeDay(ms) }));
  const exByDay = {};
  exercises.forEach((e) => { exByDay[e.exercise_date] = (exByDay[e.exercise_date] || 0) + (e.duration_min || 0); });
  res.json({
    from, to,
    weights: weights.map((w) => ({ date: w.measure_date, period: w.period, weight_kg: w.weight_kg, time: w.measure_time })),
    bodies,
    nutrition,
    exercise: Object.entries(exByDay).sort().map(([date, minutes]) => ({ date, minutes })),
    exercise_by_type: summarizeExercise(exercises).by_type,
    targets: { calorie_target_kcal: s.calorie_target_kcal, protein_target_g: s.protein_target_g },
  });
}));

// ---------------------------------------------------------------------------
// 紀錄 CRUD（只允許下列工作表與欄位；刪除一律軟刪除）
// ---------------------------------------------------------------------------

const RECORDS = {
  Weight_Log: {
    date: 'measure_date', time: 'measure_time',
    editable: ['measure_date', 'measure_time', 'period', 'weight_kg', 'note'],
    numeric: ['weight_kg'],
  },
  Body_Composition: {
    date: 'measure_date', time: 'measure_time',
    editable: ['measure_date', 'measure_time', ...Object.keys(BODY_FIELDS)],
    numeric: Object.keys(BODY_FIELDS),
  },
  Meal_Log: {
    date: 'meal_date', time: 'meal_time',
    editable: ['meal_date', 'meal_time', 'meal_type', 'food_name', 'quantity', 'calorie_kcal', 'protein_g', 'fat_g', 'carb_g', 'nutrition_source'],
    numeric: ['calorie_kcal', 'protein_g', 'fat_g', 'carb_g'],
  },
  Exercise_Log: {
    date: 'exercise_date', time: 'exercise_time',
    editable: ['exercise_date', 'exercise_time', 'exercise_type', 'duration_min', 'distance_km', 'intensity', 'calories_burned', 'calories_source', 'note'],
    numeric: ['duration_min', 'distance_km', 'calories_burned'],
  },
  Injection_Log: {
    date: 'injection_date', time: 'injection_time',
    editable: ['injection_date', 'injection_time', 'medication', 'dosage_mg', 'status', 'note'],
    numeric: ['dosage_mg'],
  },
  Goal_Log: {
    date: 'start_date',
    editable: ['goal_type', 'start_value', 'target_value', 'start_date', 'target_date', 'status', 'note'],
    numeric: ['start_value', 'target_value'],
  },
  Body_Photo: { date: 'photo_date', editable: [], numeric: [] },
  Reminder_Log: { date: 'occurrence_date', editable: [], numeric: [] },
  Report_Log: { date: 'end_date', editable: [], numeric: [] },
};

function sheetDef(sheet) {
  const def = RECORDS[sheet];
  if (!def) throw httpError(404, '不支援的資料表');
  return def;
}

function cleanPatch(sheet, body) {
  const def = sheetDef(sheet);
  const patch = {};
  for (const k of def.editable) {
    if (!(k in body)) continue;
    let v = body[k];
    if (def.numeric.includes(k)) {
      v = v === '' || v === null ? null : Number(v);
      if (v !== null && !Number.isFinite(v)) throw httpError(400, `${k} 必須是數字`);
    } else {
      v = v === null || v === undefined ? '' : String(v).slice(0, 300);
    }
    if (k.endsWith('_date') && v && !isDateStr(v)) throw httpError(400, `${k} 日期格式需為 YYYY-MM-DD`);
    if (k.endsWith('_time') && v && Number.isNaN(toMinutes(v))) throw httpError(400, `${k} 時間格式需為 HH:mm`);
    patch[k] = v;
  }
  return patch;
}

apiRouter.get('/records/:sheet', wrap(async (req, res) => {
  const { sheet } = req.params;
  const def = sheetDef(sheet);
  const { from, to, includeDeleted } = req.query;
  const rows = await getStore().list(sheet, (r) => r.user_id === req.userId
    && (includeDeleted === '1' || r.status !== STATUS.DELETED)
    && (!from || String(r[def.date] || '') >= from) && (!to || String(r[def.date] || '') <= to));
  rows.sort((a, b) => `${b[def.date] || ''}${b[def.time] || ''}`.localeCompare(`${a[def.date] || ''}${a[def.time] || ''}`));
  res.json({ rows: rows.slice(0, Number(req.query.limit) || 500), columns: SHEETS[sheet], editable: def.editable });
}));

apiRouter.post('/records/:sheet', wrap(async (req, res) => {
  const { sheet } = req.params;
  const uid = req.userId;
  const s = await getSettings(uid);
  const tz = s.timezone;
  const now = nowIn(tz);
  const b = cleanPatch(sheet, req.body || {});
  let row;
  switch (sheet) {
    case 'Weight_Log': {
      const check = validateWeight(b.weight_kg, s, null);
      if (!check.ok) throw httpError(400, check.error);
      if (!['AM', 'PM'].includes(b.period)) throw httpError(400, 'period 需為 AM 或 PM');
      const date = b.measure_date || now.date;
      row = await createWeight({ userId: uid, date, time: b.measure_time || '', period: b.period, weight: b.weight_kg, source: 'Dashboard', isBackfill: date !== now.date, note: b.note || '', tz });
      break;
    }
    case 'Body_Composition': {
      const { values, warnings } = sanitizeBody(b);
      if (warnings.length) throw httpError(400, warnings.join('；'));
      row = await createBodyComposition({ userId: uid, date: b.measure_date || now.date, time: b.measure_time || now.time, values, source: 'Dashboard手動', tz });
      break;
    }
    case 'Meal_Log': {
      if (!b.food_name) throw httpError(400, '請輸入食物名稱');
      [row] = await createMeal({
        userId: uid, date: b.meal_date || now.date, time: b.meal_time || now.time, mealType: b.meal_type || '點心',
        items: [{ ...b, source: b.nutrition_source || '使用者輸入' }], tz,
      });
      break;
    }
    case 'Exercise_Log':
      if (!b.exercise_type || !b.duration_min) throw httpError(400, '請輸入運動類型及分鐘數');
      row = await createExercise({
        userId: uid, date: b.exercise_date || now.date, time: b.exercise_time || '', type: b.exercise_type, minutes: b.duration_min,
        distanceKm: b.distance_km, intensity: b.intensity, calories: b.calories_burned, caloriesSource: b.calories_source || '使用者輸入', note: b.note, tz,
      });
      break;
    case 'Injection_Log':
      row = await createInjection({ userId: uid, date: b.injection_date || now.date, time: b.injection_time || '', medication: b.medication, dosageMg: b.dosage_mg, status: b.status || '已施打', note: b.note, tz });
      break;
    case 'Goal_Log':
      if (!['體重', '體脂', '肌肉'].includes(b.goal_type)) throw httpError(400, 'goal_type 需為 體重／體脂／肌肉');
      if (b.target_value === null || b.target_value === undefined) throw httpError(400, '請輸入目標值');
      row = await createGoal({ userId: uid, goalType: b.goal_type, targetValue: b.target_value, targetDate: b.target_date, startValue: b.start_value, startDate: b.start_date, note: b.note, tz });
      break;
    default:
      throw httpError(400, '此資料表不可新增');
  }
  res.json({ row });
}));

async function ownedRow(sheet, id, userId) {
  const row = await getStore().get(sheet, id);
  if (!row || row.user_id !== userId) throw httpError(404, '找不到資料');
  return row;
}

apiRouter.patch('/records/:sheet/:id', wrap(async (req, res) => {
  const { sheet, id } = req.params;
  await ownedRow(sheet, id, req.userId);
  const patch = cleanPatch(sheet, req.body || {});
  if (!Object.keys(patch).length) throw httpError(400, '沒有可修改的欄位');
  if (patch.measure_date && sheet === 'Weight_Log') patch.weekday = weekdayZh(patch.measure_date);
  if (patch.period && !['AM', 'PM'].includes(patch.period)) throw httpError(400, 'period 需為 AM 或 PM');
  if (sheet === 'Meal_Log' && ['calorie_kcal', 'protein_g', 'fat_g', 'carb_g'].some((k) => k in patch) && !('nutrition_source' in patch)) {
    patch.nutrition_source = '使用者修正';
  }
  if (sheet === 'Exercise_Log' && 'calories_burned' in patch && !('calories_source' in patch)) patch.calories_source = '使用者輸入';
  const r = await updateWithAudit(sheet, id, patch, { userId: req.userId, changedBy: `Dashboard:${req.userEmail}` });
  res.json({ row: r.after, changes: r.changes });
}));

apiRouter.delete('/records/:sheet/:id', wrap(async (req, res) => {
  const { sheet, id } = req.params;
  sheetDef(sheet);
  if (!SHEETS[sheet].includes('status')) throw httpError(400, '此資料表不可刪除');
  await ownedRow(sheet, id, req.userId);
  await updateWithAudit(sheet, id, { status: STATUS.DELETED }, { userId: req.userId, changedBy: `Dashboard:${req.userEmail}` });
  res.json({ ok: true });
}));

apiRouter.get('/audit', wrap(async (req, res) => {
  const rows = await getStore().list('Audit_Log', (r) => r.user_id === req.userId
    && (!req.query.record_id || r.record_id === req.query.record_id));
  rows.sort((a, b) => String(b.changed_at).localeCompare(String(a.changed_at)));
  res.json({ rows: rows.slice(0, 300) });
}));

apiRouter.get('/injections', wrap(async (req, res) => {
  res.json({ rows: (await listInjections(req.userId)).filter(isActive).reverse() });
}));

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

const SETTINGS_EDITABLE = Object.keys(DEFAULT_SETTINGS).concat(['display_name']);

apiRouter.get('/settings', wrap(async (req, res) => {
  const s = await getSettings(req.userId);
  delete s._exists;
  res.json({ settings: s, editable: SETTINGS_EDITABLE });
}));

apiRouter.put('/settings', wrap(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  for (const k of SETTINGS_EDITABLE) {
    if (!(k in body)) continue;
    let v = body[k];
    if (typeof DEFAULT_SETTINGS[k] === 'boolean') v = !!v;
    else if (/_kg$|_kcal$|_g$|_cm$|_min_week$/.test(k)) {
      v = v === '' || v === null ? '' : Number(v);
      if (v !== '' && !Number.isFinite(v)) throw httpError(400, `${k} 必須是數字`);
    } else if (/_start$|_end$/.test(k)) {
      if (Number.isNaN(toMinutes(v))) throw httpError(400, `${k} 時間格式需為 HH:mm`);
    } else if (k === 'pause_until' && v && !isDateStr(v)) {
      throw httpError(400, 'pause_until 日期格式需為 YYYY-MM-DD');
    } else v = String(v ?? '').slice(0, 500);
    patch[k] = v;
  }
  const r = await updateWithAudit('Settings', req.userId, patch, { userId: req.userId, changedBy: `Dashboard:${req.userEmail}` });
  res.json({ settings: r.after });
}));

// ---------------------------------------------------------------------------
// 作業排程
// ---------------------------------------------------------------------------

const TASK_FIELDS = ['task_name', 'task_type', 'frequency', 'weekday', 'day_of_month', 'remind_time', 'repeat_enabled', 'repeat_minutes', 'overdue_minutes', 'required_input', 'message', 'enabled'];

function cleanTask(body) {
  const t = {};
  for (const k of TASK_FIELDS) {
    if (!(k in body)) continue;
    let v = body[k];
    if (k === 'repeat_enabled' || k === 'enabled') v = !!v;
    else if (k === 'repeat_minutes' || k === 'overdue_minutes') v = Number(v) || 0;
    else if (k === 'weekday') v = v === '' || v === null ? '' : Number(v);
    else v = String(v ?? '').slice(0, 500);
    t[k] = v;
  }
  if ('task_type' in t && !TASK_TYPES[t.task_type]) throw httpError(400, '未知的作業類型');
  if ('frequency' in t && !['每日', '每週', '每月'].includes(t.frequency)) throw httpError(400, '頻率需為 每日／每週／每月');
  if ('remind_time' in t && Number.isNaN(toMinutes(t.remind_time))) throw httpError(400, '提醒時間格式需為 HH:mm');
  if (t.frequency === '每週' && (t.weekday === '' || t.weekday < 0 || t.weekday > 6)) throw httpError(400, '每週作業需指定星期（0=日～6=六）');
  if (t.frequency === '每月' && !t.day_of_month) throw httpError(400, '每月作業需指定日期（1-31 或 last）');
  return t;
}

apiRouter.get('/tasks', wrap(async (req, res) => {
  const rows = await getStore().list('Task_Schedule', { user_id: req.userId });
  rows.sort((a, b) => String(a.remind_time).localeCompare(String(b.remind_time)));
  res.json({ rows, task_types: TASK_TYPES });
}));

apiRouter.post('/tasks', wrap(async (req, res) => {
  const t = cleanTask(req.body || {});
  if (!t.task_name || !t.task_type || !t.frequency || !t.remind_time) throw httpError(400, '請填寫名稱、類型、頻率及提醒時間');
  const now = isoNow((await getSettings(req.userId)).timezone);
  const [row] = await getStore().append('Task_Schedule', { enabled: true, ...t, user_id: req.userId, created_at: now, updated_at: now });
  res.json({ row });
}));

apiRouter.patch('/tasks/:id', wrap(async (req, res) => {
  const row = await ownedRow('Task_Schedule', req.params.id, req.userId);
  const t = cleanTask({ ...row, ...req.body });
  const patch = Object.fromEntries(Object.keys(req.body || {}).filter((k) => TASK_FIELDS.includes(k)).map((k) => [k, t[k]]));
  const r = await updateWithAudit('Task_Schedule', req.params.id, patch, { userId: req.userId, changedBy: `Dashboard:${req.userEmail}` });
  res.json({ row: r.after });
}));

apiRouter.get('/reminders', wrap(async (req, res) => {
  const s = await getSettings(req.userId);
  const to = isDateStr(req.query.to) ? req.query.to : today(s);
  const from = isDateStr(req.query.from) ? req.query.from : addDays(to, -13);
  const [logs, tasks] = await Promise.all([
    getStore().list('Reminder_Log', (r) => r.user_id === req.userId && r.occurrence_date >= from && r.occurrence_date <= to),
    getStore().list('Task_Schedule', { user_id: req.userId }),
  ]);
  const names = Object.fromEntries(tasks.map((t) => [t.task_id, t.task_name]));
  const firsts = logs.filter((l) => l.reminder_type === '首次');
  const stats = {};
  firsts.forEach((l) => {
    const n = names[l.task_id] || l.task_id;
    stats[n] = stats[n] || { due: 0, done: 0, overdue: 0 };
    stats[n].due += 1;
    if (l.status === '已完成') stats[n].done += 1;
    if (l.status === '逾期') stats[n].overdue += 1;
  });
  logs.sort((a, b) => String(b.scheduled_at).localeCompare(String(a.scheduled_at)));
  res.json({ from, to, rows: logs.map((l) => ({ ...l, task_name: names[l.task_id] || '' })), stats });
}));

// ---------------------------------------------------------------------------
// 報表
// ---------------------------------------------------------------------------

apiRouter.get('/reports', wrap(async (req, res) => {
  const rows = await getStore().list('Report_Log', (r) => r.user_id === req.userId && (!req.query.type || r.report_type === req.query.type));
  rows.sort((a, b) => String(b.end_date).localeCompare(String(a.end_date)));
  res.json({ rows: rows.slice(0, 120).map((r) => ({ ...r, text: formatReportText(r) })) });
}));

apiRouter.post('/reports/generate', wrap(async (req, res) => {
  const { type = 'Daily', date } = req.body || {};
  if (!['Daily', 'Weekly', 'Monthly'].includes(type)) throw httpError(400, '報告類型錯誤');
  const s = await getSettings(req.userId);
  const d = isDateStr(date) ? date : today(s);
  const row = await generateReport(req.userId, type, d, { force: true, tz: s.timezone });
  res.json({ row: { ...row, text: formatReportText(row) } });
}));

// ---------------------------------------------------------------------------
// 照片（後端代理，Drive 檔案不公開）
// ---------------------------------------------------------------------------

apiRouter.get('/photos/:id', wrap(async (req, res) => {
  const photo = await ownedRow('Body_Photo', req.params.id, req.userId);
  if (!photo.drive_file_id || String(photo.drive_file_id).startsWith('mem-')) throw httpError(404, '照片不存在');
  const { buffer, mimeType } = await downloadPhoto(photo.drive_file_id);
  res.set('Content-Type', mimeType);
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(buffer);
}));

