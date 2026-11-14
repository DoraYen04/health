import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, assertProductionConfig } from '../config/settings.js';
import { webhookRouter } from './line/webhook.js';
import { handleEvent } from './line/message-handler.js';
import { apiRouter } from './api/dashboard-api.js';
import { requireInvoker } from './api/invoker-auth.js';
import { runTick } from './scheduler/reminder-job.js';
import { logSystem } from './services/common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, storage: config.storage }));

  // LINE Webhook（需原始 body 驗證簽章，必須放在 express.json 之前）
  app.use('/webhook', webhookRouter);

  // 排程：Cloud Scheduler 每 5 分鐘 POST /jobs/tick（OIDC 驗證）
  app.post('/jobs/tick', requireInvoker, async (req, res) => {
    try {
      const summary = await runTick();
      res.json(summary);
    } catch (e) {
      await logSystem('error', 'jobs', '排程執行失敗', e.stack || e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // LINE 事件：Cloud Tasks 派送（OIDC 驗證），在此請求內處理完畢。
  // 一律回 200（錯誤已記錄並回覆使用者），避免佇列重試造成重複寫入。
  app.post('/tasks/line-event', requireInvoker, express.json({ limit: '2mb' }), async (req, res) => {
    try {
      await handleEvent(req.body || {});
    } catch (e) {
      await logSystem('error', 'tasks', 'LINE 事件處理失敗', e.stack || e.message);
    }
    res.json({ ok: true });
  });

  app.use('/api', apiRouter);

  // Dashboard 靜態檔
  app.use(express.static(path.join(__dirname, '..', 'dashboard'), { index: 'index.html', maxAge: '10m' }));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const missing = assertProductionConfig();
  if (missing.length) console.warn(`⚠️ 尚未設定環境變數：${missing.join(', ')}`);
  if (config.storage === 'memory' && process.env.SEED_DEMO) {
    const { seedDemo } = await import('../scripts/seed-demo.js');
    await seedDemo(process.env.DEV_AUTH_USER_ID || 'U_demo');
    console.log('已載入示範資料（memory）');
  }
  createApp().listen(config.port, () => console.log(`Health server listening on :${config.port}（storage=${config.storage}）`));
}
