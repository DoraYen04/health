// 雲端部署相關的安全機制：Firebase ID token、白名單、OIDC（排程／佇列）、LINE 簽章與 Cloud Tasks
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

Object.assign(process.env, {
  STORAGE: 'memory',
  NODE_ENV: 'production',
  LINE_CHANNEL_SECRET: 'line-secret', // autopush:allow（測試用假值）
  LINE_CHANNEL_ACCESS_TOKEN: 'test',
  ALLOWED_EMAILS: 'me@gmail.com',
  GCP_PROJECT_ID: 'proj',
  SERVICE_URL: 'https://svc.example.run.app',
  INVOKER_SA_EMAIL: 'invoker@proj.iam.gserviceaccount.com',
  TASKS_QUEUE: 'line-events',
  TASKS_LOCATION: 'asia-east1',
});
delete process.env.DEV_AUTH_USER_ID;

const { MemoryStore, setStore, getStore } = await import('../backend/database/sheets-service.js');
const { ensureUser } = await import('../backend/services/common.js');
const { createApp } = await import('../backend/server.js');
const { setFirebaseVerifier } = await import('../backend/api/auth.js');
const { setOidcVerifier } = await import('../backend/api/invoker-auth.js');
const { setTaskCreator } = await import('../backend/line/event-queue.js');

// LINE API 改為假回應，其他（打本機伺服器）走真正的 fetch
const realFetch = globalThis.fetch;
const linePushes = [];
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.line.me') || String(url).startsWith('https://api-data.line.me')) {
    linePushes.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : {} });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};

let server;
let base;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const U = 'U_cloud';
beforeEach(async () => {
  setStore(new MemoryStore());
  linePushes.length = 0;
  await ensureUser(U, '測試');
  // 預設：token 字串即為 email，皆為已驗證的 Google 登入
  setFirebaseVerifier(async (t) => {
    if (t === 'bad') throw new Error('invalid');
    const [email, flag] = t.split('|');
    return { email, email_verified: flag !== 'unverified', firebase: { sign_in_provider: flag === 'password' ? 'password' : 'google.com' } }; // autopush:allow
  });
  setOidcVerifier(async (t, audience) => {
    if (audience !== 'https://svc.example.run.app') throw new Error('bad audience');
    if (t === 'bad') throw new Error('invalid');
    return { email: t, email_verified: true };
  });
});

const get = (path, token) => realFetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const post = (path, token, body) => realFetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body || {}),
});

// ---------------------------------------------------------------------------
// Dashboard API：Firebase ID token + 白名單
// ---------------------------------------------------------------------------

test('Dashboard API：未登入回 401，無效 token 回 401', async () => {
  assert.equal((await get('/api/me')).status, 401);
  assert.equal((await get('/api/me', 'bad')).status, 401);
  assert.equal((await get('/api/weights')).status, 401);
});

test('Dashboard API：白名單外、email 未驗證、非 Google 登入皆回 403', async () => {
  assert.equal((await get('/api/me', 'other@gmail.com')).status, 403);
  assert.equal((await get('/api/me', 'me@gmail.com|unverified')).status, 403);
  assert.equal((await get('/api/me', 'me@gmail.com|password')).status, 403);
});

test('Dashboard API：白名單帳號可登入，第一次自動綁定 LINE 使用者', async () => {
  const res = await get('/api/me', 'Me@Gmail.com');
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.equal(me.user_id, U);
  assert.equal(me.email, 'me@gmail.com');
  const [s] = await getStore().list('Settings', { user_id: U });
  assert.equal(s.dashboard_email, 'me@gmail.com');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('Dashboard API：production 時 DEV_AUTH_USER_ID 無效', async () => {
  process.env.DEV_AUTH_USER_ID = U;
  try {
    assert.equal((await get('/api/me')).status, 401);
  } finally {
    delete process.env.DEV_AUTH_USER_ID;
  }
});

// ---------------------------------------------------------------------------
// 排程與佇列端點：OIDC
// ---------------------------------------------------------------------------

test('排程端點：沒有 token、token 無效、服務帳號不符皆回 401', async () => {
  assert.equal((await post('/jobs/tick')).status, 401);
  assert.equal((await post('/jobs/tick', 'bad')).status, 401);
  assert.equal((await post('/jobs/tick', 'someone@gmail.com')).status, 401);
  assert.equal((await post('/tasks/line-event', 'someone@gmail.com', {})).status, 401);
});

test('排程端點：Cloud Scheduler 服務帳號可執行', async () => {
  const res = await post('/jobs/tick', 'invoker@proj.iam.gserviceaccount.com');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).users, 1);
});

test('佇列端點：Cloud Tasks 派送的 LINE 事件會被處理', async () => {
  const ev = { type: 'message', replyToken: 'r', source: { userId: U }, message: { type: 'text', text: '上午 59.8' } };
  const res = await post('/tasks/line-event', 'invoker@proj.iam.gserviceaccount.com', ev);
  assert.equal(res.status, 200);
  assert.equal((await getStore().list('Weight_Log')).length, 1);
  assert.ok(linePushes.some((p) => p.url.endsWith('/message/reply')));
});

// ---------------------------------------------------------------------------
// LINE Webhook：簽章 + Cloud Tasks
// ---------------------------------------------------------------------------

function webhook(body, secret = 'line-secret') { // autopush:allow
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', secret).update(raw).digest('base64');
  return realFetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body: raw });
}

test('Webhook：簽章錯誤回 401，且不放入佇列', async () => {
  const created = [];
  setTaskCreator(async (parent, task) => { created.push(task); });
  const res = await webhook({ events: [{ type: 'message', webhookEventId: 'E1' }] }, 'wrong-secret');
  assert.equal(res.status, 401);
  assert.equal(created.length, 0);
});

test('Webhook：簽章正確 → 建立帶 OIDC 的 Cloud Tasks 任務後回 200', async () => {
  const created = [];
  setTaskCreator(async (parent, task) => { created.push({ parent, task }); });
  const ev = { type: 'message', webhookEventId: '01HXYZ', source: { userId: U }, message: { type: 'text', text: '59.8' } };
  const res = await webhook({ events: [ev] });
  assert.equal(res.status, 200);
  assert.equal(created.length, 1);
  const { parent, task } = created[0];
  assert.equal(parent, 'projects/proj/locations/asia-east1/queues/line-events');
  assert.equal(task.name, `${parent}/tasks/line-01HXYZ`);
  assert.equal(task.httpRequest.url, 'https://svc.example.run.app/tasks/line-event');
  assert.deepEqual(task.httpRequest.oidcToken, { serviceAccountEmail: 'invoker@proj.iam.gserviceaccount.com', audience: 'https://svc.example.run.app' });
  assert.deepEqual(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString('utf8')), ev);
  assert.equal((await getStore().list('Weight_Log')).length, 0); // 由佇列處理，Webhook 本身不處理
});

test('Webhook：LINE 重送（任務已存在）視為成功；佇列故障回 500', async () => {
  setTaskCreator(async () => { const e = new Error('ALREADY_EXISTS'); e.code = 409; throw e; });
  assert.equal((await webhook({ events: [{ type: 'message', webhookEventId: 'E2' }] })).status, 200);
  setTaskCreator(async () => { throw new Error('unavailable'); });
  assert.equal((await webhook({ events: [{ type: 'message', webhookEventId: 'E3' }] })).status, 500);
});
