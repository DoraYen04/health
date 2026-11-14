import { getStore } from '../database/sheets-service.js';
import { REMINDER_STATUS as RS } from '../database/schema.js';
import { nowIn, toMinutes, dayOfWeek, lastDayOfMonth, isoNow, addDays as addDaysSafe } from '../utils/time.js';
import { getSettings, listUsers, logSystem, toBool, isActive } from '../services/common.js';
import { lineClient, textWithQuickReply } from '../line/line-client.js';
import { createPending, latestPending } from '../services/pending-service.js';
import { runReportTask } from './report-jobs.js';

const REPORT_TYPES = { daily_report: 'Daily', weekly_report: 'Weekly', monthly_report: 'Monthly' };
const MAX_RETRY = 3;

export function taskOccursOn(task, date) {
  const f = task.frequency;
  if (f === '每日' || f === 'daily') return true;
  if (f === '每週' || f === 'weekly') return Number(task.weekday) === dayOfWeek(date);
  if (f === '每月' || f === 'monthly') {
    const dom = String(task.day_of_month ?? '').trim();
    if (dom === 'last' || dom === '最後一天') return date === lastDayOfMonth(date);
    const n = Number(dom);
    // 指定日大於當月天數時，於月底執行
    const last = Number(lastDayOfMonth(date).slice(8));
    return Number(date.slice(8)) === Math.min(n, last);
  }
  return false;
}

/** 依作業類型檢查當日是否已完成（資料已存在） */
export async function isTaskCompleted(userId, taskType, date) {
  const store = getStore();
  const has = async (sheet, dateField, extra = () => true) => (await store.list(sheet, (r) => r.user_id === userId
    && r[dateField] === date && isActive(r) && extra(r))).length > 0;
  switch (taskType) {
    case 'weight_am': return has('Weight_Log', 'measure_date', (r) => r.period === 'AM');
    case 'weight_pm': return has('Weight_Log', 'measure_date', (r) => r.period === 'PM');
    case 'body_composition': return has('Body_Composition', 'measure_date');
    case 'injection': return has('Injection_Log', 'injection_date');
    case 'meal': return has('Meal_Log', 'meal_date');
    case 'exercise': return has('Exercise_Log', 'exercise_date');
    default: return false;
  }
}

/** 使用者完成作業後立即呼叫：將當日提醒標記完成，未發送的補提醒自然不會再發 */
export async function markTaskCompleted(userId, taskType, date, tz) {
  const store = getStore();
  const tasks = await store.list('Task_Schedule', (t) => t.user_id === userId && t.task_type === taskType);
  if (!tasks.length) return;
  const ids = new Set(tasks.map((t) => t.task_id));
  const logs = await store.list('Reminder_Log', (r) => r.user_id === userId && ids.has(r.task_id)
    && r.occurrence_date === date && [RS.SENT, RS.OVERDUE, RS.PENDING, RS.FAILED].includes(r.status));
  if (!logs.length) return;
  const now = isoNow(tz);
  await store.updateMany('Reminder_Log', logs.map((l) => ({ id: l.reminder_id, patch: { status: RS.DONE, completed_at: now } })));
}

function quickRepliesFor(taskType) {
  if (taskType === 'body_composition') return [{ label: '開啟相機', camera: true }, { label: '從相簿選擇', cameraRoll: true }];
  if (taskType === 'meal') return [{ label: '拍餐點', camera: true }, { label: '從相簿選擇', cameraRoll: true }];
  if (taskType === 'injection') return [{ label: '未施打', text: '未施打' }, { label: '延後施打', text: '延後施打' }];
  return null;
}

async function sendReminder(userId, task, text) {
  const qr = quickRepliesFor(task.task_type);
  await lineClient.push(userId, qr ? textWithQuickReply(text, qr) : text);
  // 體脂提醒：讓下一張照片自動視為體脂照片（若使用者沒有其他待確認動作）
  if (task.task_type === 'body_composition' && !(await latestPending(userId))) {
    await createPending(userId, 'context_body', {}, { minutes: 180 });
  }
}

let running = false;

/** Cloud Scheduler 每 5 分鐘呼叫一次 */
export async function runTick(at = new Date()) {
  if (running) return { skipped: 'already running' };
  running = true;
  const summary = { users: 0, sent: 0, repeats: 0, overdue: 0, reports: 0, errors: 0 };
  try {
    const users = await listUsers();
    for (const u of users) {
      summary.users += 1;
      try {
        await tickUser(u.user_id, at, summary);
      } catch (e) {
        summary.errors += 1;
        await logSystem('error', 'scheduler', `使用者 ${u.user_id} 排程失敗`, e.stack || e.message);
      }
    }
  } finally {
    running = false;
  }
  return summary;
}

async function tickUser(userId, at, summary) {
  const store = getStore();
  const settings = await getSettings(userId);
  const now = nowIn(settings.timezone, at);
  const today = now.date;
  const paused = !settings.reminder_enabled
    || (settings.pause_until && String(settings.pause_until) >= today)
    || String(settings.skip_dates || '').split(',').map((s) => s.trim()).includes(today);

  const tasks = (await store.list('Task_Schedule', (t) => t.user_id === userId && toBool(t.enabled)))
    .filter((t) => taskOccursOn(t, today));
  const logs = await store.list('Reminder_Log', (r) => r.user_id === userId && r.occurrence_date >= addDaysSafe(today, -7));
  const logById = new Map(logs.map((l) => [l.event_id, l]));

  // 1. 過去日期仍為「已發送」的提醒 → 逾期（已完成者改已完成）
  const stale = logs.filter((l) => l.occurrence_date < today && l.status === RS.SENT);
  for (const l of stale) {
    const task = await store.get('Task_Schedule', l.task_id);
    const done = task ? await isTaskCompleted(userId, task.task_type, l.occurrence_date) : false;
    await store.update('Reminder_Log', l.reminder_id, done ? { status: RS.DONE, completed_at: now.iso } : { status: RS.OVERDUE });
    if (!done) summary.overdue += 1;
  }

  for (const task of tasks) {
    const remindMin = toMinutes(task.remind_time);
    if (Number.isNaN(remindMin) || now.minutes < remindMin) continue;

    // 報告類作業
    if (REPORT_TYPES[task.task_type]) {
      const sent = await runReportTask({ userId, task, reportType: REPORT_TYPES[task.task_type], today, now, logById, settings });
      if (sent) summary.reports += 1;
      continue;
    }

    const firstId = `${task.task_id}:${today}:first`;
    const repeatId = `${task.task_id}:${today}:repeat`;
    const first = logById.get(firstId);
    const repeat = logById.get(repeatId);
    const done = await isTaskCompleted(userId, task.task_type, today);

    if (done) {
      const open = [first, repeat].filter((l) => l && l.status !== RS.DONE);
      if (open.length) await store.updateMany('Reminder_Log', open.map((l) => ({ id: l.reminder_id, patch: { status: RS.DONE, completed_at: now.iso } })));
      if (!first) {
        // 提醒時間前就完成：仍留一筆首次紀錄，供完成率統計
        await store.append('Reminder_Log', {
          event_id: firstId, user_id: userId, task_id: task.task_id, occurrence_date: today,
          scheduled_at: `${today}T${task.remind_time}`, reminder_type: '首次', status: RS.DONE, completed_at: now.iso, retry_count: 0,
        });
      }
      continue;
    }

    const overdueMin = Number(task.overdue_minutes) > 0 ? Number(task.overdue_minutes) : 720;
    const repeatMin = Number(task.repeat_minutes) || 30;

    if (paused) continue;

    // 2. 首次提醒（含失敗重試）
    if (!first) {
      if (now.minutes - remindMin > overdueMin) continue; // 系統停機過久：不補發過時提醒
      await pushAndLog({ userId, task, eventId: firstId, type: '首次', text: task.message || `提醒：${task.task_name}`, today, now });
      summary.sent += 1;
      continue;
    }
    if (first.status === RS.FAILED && Number(first.retry_count || 0) < MAX_RETRY) {
      await pushAndLog({ userId, task, eventId: firstId, type: '首次', text: task.message || `提醒：${task.task_name}`, today, now, existing: first });
      continue;
    }

    // 3. 補提醒（只補一次）
    if (toBool(task.repeat_enabled) && !repeat && now.minutes >= remindMin + repeatMin && first.status === RS.SENT) {
      await pushAndLog({ userId, task, eventId: repeatId, type: '再次', text: `⏰ 再次提醒：${task.message || task.task_name}`, today, now });
      summary.repeats += 1;
      continue;
    }

    // 4. 逾期
    if (now.minutes >= remindMin + overdueMin) {
      const toMark = [first, repeat].filter((l) => l && l.status === RS.SENT);
      if (toMark.length) {
        await store.updateMany('Reminder_Log', toMark.map((l) => ({ id: l.reminder_id, patch: { status: RS.OVERDUE } })));
        summary.overdue += 1;
      }
    }
  }
}

async function pushAndLog({ userId, task, eventId, type, text, today, now, existing }) {
  const store = getStore();
  const base = {
    event_id: eventId, user_id: userId, task_id: task.task_id, occurrence_date: today,
    scheduled_at: `${today}T${task.remind_time}`, reminder_type: type,
  };
  try {
    await sendReminder(userId, task, text);
    if (existing) await store.update('Reminder_Log', existing.reminder_id, { status: RS.SENT, sent_at: now.iso, retry_count: Number(existing.retry_count || 0) + 1 });
    else await store.append('Reminder_Log', { ...base, status: RS.SENT, sent_at: now.iso, retry_count: 0 });
  } catch (e) {
    const patch = { status: RS.FAILED, last_error: String(e.message).slice(0, 300), last_error_at: now.iso };
    if (existing) await store.update('Reminder_Log', existing.reminder_id, { ...patch, retry_count: Number(existing.retry_count || 0) + 1 });
    else await store.append('Reminder_Log', { ...base, ...patch, retry_count: 1 });
    await logSystem('error', 'reminder', `提醒發送失敗 ${eventId}`, e.message);
  }
}
