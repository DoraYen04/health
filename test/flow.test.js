// 端對端流程：MemoryStore + 攔截 fetch（LINE API），不需要任何雲端帳號
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.STORAGE = 'memory';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test';

const { MemoryStore, setStore, getStore } = await import('../backend/database/sheets-service.js');
const { handleEvent } = await import('../backend/line/message-handler.js');
const { runTick } = await import('../backend/scheduler/reminder-job.js');

const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : {};
  sent.push({ url: String(url), body });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

const U = 'U_test';
const text = (t) => handleEvent({ type: 'message', replyToken: 'r', source: { userId: U }, message: { type: 'text', text: t } });
const postback = (data) => handleEvent({ type: 'postback', replyToken: 'r', source: { userId: U }, postback: { data } });
const lastText = () => sent[sent.length - 1].body.messages[0].text;
const lastQuick = () => sent[sent.length - 1].body.messages[0].quickReply?.items.map((i) => i.action) || [];

beforeEach(() => { setStore(new MemoryStore()); sent.length = 0; });

test('體重：記錄、重複輸入詢問覆蓋/新增、覆蓋保留修改紀錄', async () => {
  await text('上午 59.8');
  assert.match(lastText(), /記錄成功/);
  assert.equal((await getStore().list('Weight_Log')).length, 1);

  await text('上午 59.6');
  assert.match(lastText(), /覆蓋原紀錄/);
  const overwrite = lastQuick().find((a) => a.label === '覆蓋原紀錄');
  await postback(overwrite.data);
  const rows = await getStore().list('Weight_Log');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weight_kg, 59.6);
  assert.equal(rows[0].status, '已修正');
  const audit = await getStore().list('Audit_Log', { field: 'weight_kg' });
  assert.equal(audit[0].before_value, 59.8);
});

test('體重：差距過大需再確認、超出範圍拒絕', async () => {
  await text('上午 59.8');
  await text('下午 66');
  assert.match(lastText(), /請確認數值/);
  assert.equal((await getStore().list('Weight_Log')).length, 1);
  await text('確認');
  assert.match(lastText(), /記錄成功/);
  await text('下午 500');
  assert.match(lastText(), /合理範圍/);
});

test('施打與運動需確認後才寫入', async () => {
  await text('施打 2.5mg');
  assert.equal((await getStore().list('Injection_Log')).length, 0);
  await text('修改 劑量 5');
  await text('確認');
  const inj = await getStore().list('Injection_Log');
  assert.equal(inj[0].dosage_mg, 5);

  await text('上午 60');
  await text('騎車 60 分鐘 15 公里');
  assert.match(lastText(), /估算/);
  await text('確認');
  const ex = await getStore().list('Exercise_Log');
  assert.equal(ex[0].duration_min, 60);
  assert.equal(ex[0].calories_source, '估算');
});

test('飲食：AI 無法使用時仍可記錄食物名稱', async () => {
  await text('午餐：雞胸肉、雞蛋');
  assert.match(lastText(), /午餐/);
  await text('確認');
  const meals = await getStore().list('Meal_Log');
  assert.equal(meals.length, 1);
  assert.equal(meals[0].calorie_kcal, null);
});

const enableTask = async (taskType, patch = {}) => {
  const [t] = await getStore().list('Task_Schedule', (r) => r.task_type === taskType);
  await getStore().update('Task_Schedule', t.task_id, { enabled: true, ...patch });
};

test('預設排程：只啟用上午／下午體重與施打，且不補提醒', async () => {
  await handleEvent({ type: 'follow', replyToken: 'r', source: { userId: U } });
  const tasks = await getStore().list('Task_Schedule');
  const enabled = tasks.filter((t) => t.enabled === true).map((t) => t.task_type).sort();
  assert.deepEqual(enabled, ['injection', 'weight_am', 'weight_pm']);
  assert.ok(tasks.every((t) => t.repeat_enabled === false));

  // 2026-11-09 是週一：08:00、14:00 體重、20:00 施打各提醒一次，之後不再補提醒
  for (const iso of ['00:01', '00:45', '06:01', '06:45', '12:01', '13:30', '13:59']) {
    await runTick(new Date(`2026-11-09T${iso}:00Z`));
  }
  const logs = await getStore().list('Reminder_Log');
  assert.equal(logs.length, 3);
  assert.ok(logs.every((l) => l.reminder_type === '首次'));
  // 21:00 後不推播每日報告
  assert.equal((await getStore().list('Report_Log')).length, 0);
  assert.equal(sent.filter((s) => s.url.endsWith('/push') && /每日報告/.test(s.body.messages[0].text)).length, 0);
});

test('排程（啟用補提醒時）：首次提醒 → 補提醒一次 → 完成後不再提醒', async () => {
  await handleEvent({ type: 'follow', replyToken: 'r', source: { userId: U } });
  await enableTask('weight_am', { repeat_enabled: true, repeat_minutes: 30 });
  // 08:00 台北 = 00:00 UTC
  await runTick(new Date('2026-11-09T00:01:00Z'));
  let logs = await getStore().list('Reminder_Log');
  assert.equal(logs.filter((l) => l.reminder_type === '首次').length, 1);

  await runTick(new Date('2026-11-09T00:10:00Z'));
  assert.equal((await getStore().list('Reminder_Log')).length, 1); // 不重複發送

  await runTick(new Date('2026-11-09T00:31:00Z'));
  logs = await getStore().list('Reminder_Log');
  assert.equal(logs.filter((l) => l.reminder_type === '再次').length, 1);

  await runTick(new Date('2026-11-09T00:45:00Z'));
  assert.equal((await getStore().list('Reminder_Log')).length, 2); // 只補一次

  // 完成後狀態改為已完成
  await getStore().append('Weight_Log', { user_id: U, measure_date: '2026-11-09', period: 'AM', weight_kg: 59.8, status: '正常' });
  await runTick(new Date('2026-11-09T00:50:00Z'));
  logs = await getStore().list('Reminder_Log');
  assert.ok(logs.every((l) => l.status === '已完成'));
});

test('排程（啟用每日報告時）：21:00 只送一次', async () => {
  await handleEvent({ type: 'follow', replyToken: 'r', source: { userId: U } });
  await enableTask('daily_report');
  await runTick(new Date('2026-11-09T13:01:00Z'));
  await runTick(new Date('2026-11-09T13:06:00Z'));
  const reports = await getStore().list('Report_Log', { report_type: 'Daily' });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].delivery_status, '已傳送');
  const pushes = sent.filter((s) => s.url.endsWith('/push') && /每日報告/.test(s.body.messages[0].text));
  assert.equal(pushes.length, 1);
});
