import { getStore } from '../database/sheets-service.js';
import { isoNow } from '../utils/time.js';

// 待確認動作：AI 辨識、重複輸入、異常數值等需要使用者按「確認」才寫入正式資料。
// 存在 Sheets（而非記憶體），Cloud Run 多實例或重啟後仍可延續對話。

const EXPIRE_MIN = Number(process.env.PENDING_EXPIRE_MINUTES || 60);

function expiresAt(minutes = EXPIRE_MIN) {
  return new Date(Date.now() + minutes * 60000).toISOString();
}

export async function createPending(userId, actionType, payload, { tz, minutes } = {}) {
  // 同一使用者同時只保留一個待確認動作，新的會取代舊的
  await cancelAllPending(userId, '取代');
  const [row] = await getStore().append('Pending_Action', {
    user_id: userId,
    action_type: actionType,
    payload_json: JSON.stringify(payload),
    status: '待確認',
    created_at: isoNow(tz),
    expires_at: expiresAt(minutes),
  });
  return { ...row, payload };
}

export async function getPending(pendingId) {
  const row = await getStore().get('Pending_Action', pendingId);
  return row ? hydrate(row) : null;
}

export async function latestPending(userId, actionTypes) {
  const rows = await getStore().list('Pending_Action', (r) => r.user_id === userId && r.status === '待確認'
    && (!actionTypes || actionTypes.includes(r.action_type)));
  const valid = rows.filter((r) => !r.expires_at || new Date(r.expires_at) > new Date());
  if (!valid.length) return null;
  valid.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return hydrate(valid[valid.length - 1]);
}

export function isUsable(p) {
  return p && p.status === '待確認' && (!p.expires_at || new Date(p.expires_at) > new Date());
}

export async function resolvePending(pendingId, status = '已處理', tz) {
  await getStore().update('Pending_Action', pendingId, { status, resolved_at: isoNow(tz) });
}

export async function updatePendingPayload(pendingId, payload) {
  await getStore().update('Pending_Action', pendingId, { payload_json: JSON.stringify(payload), expires_at: expiresAt() });
}

export async function cancelAllPending(userId, status = '已取消') {
  const store = getStore();
  const rows = await store.list('Pending_Action', (r) => r.user_id === userId && r.status === '待確認');
  if (rows.length) {
    await store.updateMany('Pending_Action', rows.map((r) => ({ id: r.pending_id, patch: { status, resolved_at: new Date().toISOString() } })));
  }
}

function hydrate(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
  return { ...row, payload };
}
