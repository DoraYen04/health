import { getStore } from '../database/sheets-service.js';
import { REMINDER_STATUS as RS } from '../database/schema.js';
import { generateReport, formatReportText } from '../services/report-service.js';
import { lineClient, textWithQuickReply } from '../line/line-client.js';
import { logSystem } from '../services/common.js';
import { config } from '../../config/settings.js';

const MAX_RETRY = 3;

/**
 * 報告排程：產生（每日／每週／每月）→ 推播 → 記錄。
 * Reminder_Log 以 event_id = task_id:日期:report 確保同一天只送一次；失敗最多重試 3 次。
 */
export async function runReportTask({ userId, task, reportType, today, now, logById }) {
  const store = getStore();
  const eventId = `${task.task_id}:${today}:report`;
  const log = logById.get(eventId);
  if (log && (log.status === RS.SENT || Number(log.retry_count || 0) >= MAX_RETRY)) return false;

  let report;
  try {
    report = await generateReport(userId, reportType, today, { force: true, tz: undefined });
    const dashboard = config.baseUrl ? [{ label: '開啟 Dashboard', uri: `${config.baseUrl}/` }] : [];
    const text = formatReportText(report);
    await lineClient.push(userId, dashboard.length ? textWithQuickReply(text, dashboard) : text);
    await store.update('Report_Log', report.report_id, { delivery_status: '已傳送', delivered_at: now.iso });
    const patch = { status: RS.SENT, sent_at: now.iso };
    if (log) await store.update('Reminder_Log', log.reminder_id, { ...patch, retry_count: Number(log.retry_count || 0) + 1 });
    else {
      await store.append('Reminder_Log', {
        event_id: eventId, user_id: userId, task_id: task.task_id, occurrence_date: today,
        scheduled_at: `${today}T${task.remind_time}`, reminder_type: '報告', ...patch, retry_count: 0,
      });
    }
    return true;
  } catch (e) {
    const retry = Number(log?.retry_count || 0) + 1;
    const patch = { status: RS.FAILED, last_error: String(e.message).slice(0, 300), last_error_at: now.iso, retry_count: retry };
    if (log) await store.update('Reminder_Log', log.reminder_id, patch);
    else {
      await store.append('Reminder_Log', {
        event_id: eventId, user_id: userId, task_id: task.task_id, occurrence_date: today,
        scheduled_at: `${today}T${task.remind_time}`, reminder_type: '報告', ...patch,
      });
    }
    if (report?.report_id) {
      await store.update('Report_Log', report.report_id, { delivery_status: '失敗', last_error: String(e.message).slice(0, 300), retry_count: retry });
    }
    await logSystem('error', 'report', `${reportType} 報告失敗（第 ${retry} 次）`, e.stack || e.message);
    if (retry >= MAX_RETRY) await notifyAdmin(`⚠️ ${reportType} 報告連續失敗 ${retry} 次：${e.message}`);
    return false;
  }
}

export async function notifyAdmin(text) {
  if (!config.line.adminUserId) return;
  try {
    await lineClient.push(config.line.adminUserId, text.slice(0, 1000));
  } catch (e) {
    console.error('管理者通知失敗', e.message);
  }
}
