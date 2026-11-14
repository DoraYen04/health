import { google } from 'googleapis';
import { config } from '../../config/settings.js';
import { handleEvent } from './message-handler.js';

// LINE 事件的處理方式：
// - 雲端（有設定 TASKS_QUEUE）：Webhook 驗證簽章後把事件放進 Cloud Tasks 佇列並立即回 200，
//   再由 Cloud Tasks 帶 OIDC token 呼叫 POST /tasks/line-event，在該請求內完成處理。
//   如此 Cloud Run 可使用「依請求計費」，沒有請求時會關機，不需要 --no-cpu-throttling。
//   佇列設定同時只派送 1 個（max-concurrent-dispatches=1），同一使用者的事件依序處理；
//   任務名稱使用 webhookEventId，LINE 重送時自動去除重複。
// - 本機／測試（未設定 TASKS_QUEUE）：直接在程式內背景處理（與原本相同）。

export function cloudTasksEnabled() {
  return !!config.tasks.queue;
}

// ---------------------------------------------------------------------------
// Cloud Tasks
// ---------------------------------------------------------------------------

let tasksApi;
function getTasksApi() {
  if (!tasksApi) {
    const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    tasksApi = google.cloudtasks({ version: 'v2', auth });
  }
  return tasksApi;
}

let createTask = async (parent, task) => {
  await getTasksApi().projects.locations.queues.tasks.create({ parent, requestBody: { task } });
};

/** 測試用：替換建立任務的函式 */
export function setTaskCreator(fn) {
  createTask = fn;
}

export function queuePath() {
  return `projects/${config.projectId}/locations/${config.tasks.location}/queues/${config.tasks.queue}`;
}

export function buildTask(ev, parent = queuePath()) {
  const { serviceUrl, serviceAccountEmail } = config.invoker;
  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url: `${serviceUrl}/tasks/line-event`,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(ev)).toString('base64'),
      oidcToken: { serviceAccountEmail, audience: serviceUrl },
    },
  };
  const id = String(ev.webhookEventId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (id) task.name = `${parent}/tasks/line-${id}`;
  return task;
}

async function enqueueCloud(ev) {
  const parent = queuePath();
  try {
    await createTask(parent, buildTask(ev, parent));
  } catch (e) {
    // 同名任務已存在＝LINE 重送的同一事件，視為成功
    if (e.code === 409 || e.status === 409 || /ALREADY_EXISTS/.test(e.message || '')) return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 本機：程式內背景處理
// ---------------------------------------------------------------------------

// 近期處理過的 webhookEventId（避免 LINE 重送時重複寫入；單一實例內有效）
const seen = new Map();
function alreadySeen(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 3600_000) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

// 同一使用者的事件依序處理，避免「確認」與下一則訊息互相競爭
const queues = new Map();
function enqueueLocal(userId, task) {
  const prev = queues.get(userId) || Promise.resolve();
  const next = prev.then(task, task).finally(() => {
    if (queues.get(userId) === next) queues.delete(userId);
  });
  queues.set(userId, next);
  return next;
}

// ---------------------------------------------------------------------------

/** 雲端模式：把所有事件放進佇列（失敗時丟出錯誤，讓 Webhook 回 5xx 由 LINE 重送） */
export async function enqueueEvents(events) {
  for (const ev of events) await enqueueCloud(ev);
}

/** 本機模式：背景依序處理（呼叫端不需等待） */
export function processEventsLocally(events) {
  for (const ev of events) {
    if (alreadySeen(ev.webhookEventId)) continue;
    const uid = ev.source?.userId || 'anon';
    enqueueLocal(uid, () => handleEvent(ev));
  }
}
