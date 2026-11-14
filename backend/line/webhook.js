import express from 'express';
import { verifySignature } from './line-client.js';
import { handleEvent } from './message-handler.js';
import { logSystem } from '../services/common.js';

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
function enqueue(userId, task) {
  const prev = queues.get(userId) || Promise.resolve();
  const next = prev.then(task, task).finally(() => {
    if (queues.get(userId) === next) queues.delete(userId);
  });
  queues.set(userId, next);
  return next;
}

export const webhookRouter = express.Router();

webhookRouter.post('/', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const signature = req.get('x-line-signature');
  if (!verifySignature(req.body, signature)) {
    logSystem('warn', 'webhook', '簽章驗證失敗', req.ip);
    return res.status(401).send('invalid signature');
  }
  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('bad json');
  }
  // 立即回 200，事件於背景處理（Cloud Run 需設定 --no-cpu-throttling）
  res.status(200).send('ok');
  for (const ev of body.events || []) {
    if (alreadySeen(ev.webhookEventId)) continue;
    const uid = ev.source?.userId || 'anon';
    enqueue(uid, () => handleEvent(ev));
  }
});
