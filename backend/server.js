import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config, assertProductionConfig } from '../config/settings.js';
import { webhookRouter } from './line/webhook.js';
import { apiRouter } from './api/dashboard-api.js';
import { runTick } from './scheduler/reminder-job.js';
import { logSystem } from './services/common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(cookieParser());

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, storage: config.storage }));

  // LINE Webhook（需原始 body 驗證簽章，必須放在 express.json 之前）
  app.use('/webhook', webhookRouter);

  // 排程：Cloud Scheduler 每 5 分鐘 POST /jobs/tick，Header 帶 X-Job-Secret
  app.post('/jobs/tick', async (req, res) => {
    if (!checkJobSecret(req.get('x-job-secret'))) return res.status(401).json({ error: 'unauthorized' });
    try {
      const summary = await runTick();
      res.json(summary);
    } catch (e) {
      await logSystem('error', 'jobs', '排程執行失敗', e.stack || e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.use('/api', apiRouter);

  // Dashboard 靜態檔
  app.use(express.static(path.join(__dirname, '..', 'dashboard'), { index: 'index.html', maxAge: '10m' }));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}

function checkJobSecret(given) {
  const expected = config.jobs.secret;
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
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
