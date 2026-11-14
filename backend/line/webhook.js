import express from 'express';
import { verifySignature } from './line-client.js';
import { cloudTasksEnabled, enqueueEvents, processEventsLocally } from './event-queue.js';
import { logSystem } from '../services/common.js';

export const webhookRouter = express.Router();

// 必須使用原始 body 驗證 x-line-signature，簽章不符一律 401（擋掉偽造訊息）
webhookRouter.post('/', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
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
  const events = body.events || [];

  if (cloudTasksEnabled()) {
    // 雲端：放進 Cloud Tasks 佇列後才回 200；佇列失敗回 500，LINE 可重送
    try {
      await enqueueEvents(events);
    } catch (e) {
      await logSystem('error', 'webhook', '事件放入佇列失敗', e.stack || e.message);
      return res.status(500).send('enqueue failed');
    }
    return res.status(200).send('ok');
  }

  // 本機：立即回 200，事件於背景處理
  res.status(200).send('ok');
  processEventsLocally(events);
});
