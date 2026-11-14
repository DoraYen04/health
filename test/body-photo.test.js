// 身體組成報告上傳：長截圖切段 → Gemini（假回應）→ 回填表單 → 確認後新增並連結照片
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

Object.assign(process.env, {
  STORAGE: 'memory', NODE_ENV: 'test', DEV_AUTH_USER_ID: 'U_body',
  LINE_CHANNEL_ACCESS_TOKEN: 'test', GEMINI_API_KEY: 'test-key', // autopush:allow（測試用假值）
});

const { MemoryStore, setStore, getStore } = await import('../backend/database/sheets-service.js');
const { ensureUser } = await import('../backend/services/common.js');
const { createApp } = await import('../backend/server.js');
const { splitForVision } = await import('../backend/gemini/image-split.js');

// 攔截 Gemini：記錄收到幾張圖，回傳固定的辨識結果
const realFetch = globalThis.fetch;
let geminiImages = 0;
let geminiReply = {};
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('generativelanguage.googleapis.com')) {
    const body = JSON.parse(opts.body);
    geminiImages = body.contents[0].parts.filter((p) => p.inline_data).length;
    const text = JSON.stringify(geminiReply);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
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
beforeEach(async () => {
  setStore(new MemoryStore());
  await ensureUser('U_body', '測試');
});

const tallPng = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } }).png().toBuffer();

test('長截圖會切成多段；一般照片不切', async () => {
  assert.equal((await splitForVision(await tallPng(1080, 1400))).length, 1);
  const parts = await splitForVision(await tallPng(1080, 16000));
  assert.ok(parts.length >= 8 && parts.length <= 16, `片段數 ${parts.length}`);
  const huge = await splitForVision(await tallPng(1080, 60000));
  assert.ok(huge.length <= 16, '片段數有上限');
});

test('上傳報告：存照片、回傳 AI 讀值與報告日期，但尚未寫入身體組成', async () => {
  geminiReply = {
    is_body_composition: true, readability: 'clear', measure_date: '2026/10/14', measure_time: '6:35',
    weight_kg: 61, body_fat_pct: 31.3, body_fat_kg: 19.1, skeletal_muscle_kg: 23, visceral_fat: 8, bmr_kcal: 1275, bmi: 25.3,
  };
  const res = await realFetch(`${base}/api/body/photo`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await tallPng(1080, 16000) });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.ok, true);
  assert.ok(geminiImages > 1, '長截圖以多張片段送出');
  assert.deepEqual(r.values, { weight_kg: 61, body_fat_pct: 31.3, body_fat_kg: 19.1, skeletal_muscle_kg: 23, visceral_fat: 8, bmr_kcal: 1275, bmi: 25.3 });
  assert.equal(r.measure_date, '2026-10-14');
  assert.equal(r.measure_time, '06:35');
  const [photo] = await getStore().list('Body_Photo');
  assert.equal(photo.photo_id, r.photo_id);
  assert.equal(photo.ai_status, '待確認');
  assert.equal((await getStore().list('Body_Composition')).length, 0);

  // 使用者確認後新增 → 連結照片
  const save = await realFetch(`${base}/api/records/Body_Composition`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...r.values, measure_date: r.measure_date, measure_time: r.measure_time, photo_id: r.photo_id }),
  });
  assert.equal(save.status, 200);
  const [row] = await getStore().list('Body_Composition');
  assert.equal(row.photo_id, r.photo_id);
  assert.equal(row.source, 'Dashboard照片');
  assert.equal(row.measure_date, '2026-10-14');
  assert.equal((await getStore().get('Body_Photo', r.photo_id)).ai_status, '已確認');
});

test('上傳報告：未來日期不採用；非報告圖片回 ok=false；非圖片回 400', async () => {
  geminiReply = { is_body_composition: true, readability: 'clear', measure_date: '2099-01-01', weight_kg: 61 };
  let r = await (await realFetch(`${base}/api/body/photo`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await tallPng(800, 800) })).json();
  assert.equal(r.measure_date, '');
  assert.equal(r.date_from_report, false);

  geminiReply = { is_body_composition: false, readability: 'clear' };
  r = await (await realFetch(`${base}/api/body/photo`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await tallPng(800, 800) })).json();
  assert.equal(r.ok, false);
  assert.ok(r.photo_id, '照片仍會保存');

  const bad = await realFetch(`${base}/api/body/photo`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' });
  assert.equal(bad.status, 400);
});
