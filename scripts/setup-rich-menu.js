// 建立 LINE Rich Menu、上傳圖片並設為預設選單
// node --env-file=.env scripts/setup-rich-menu.js
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRichMenu } from '../backend/line/rich-menu.js';
import { config } from '../config/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const token = config.line.channelAccessToken;
const H = { Authorization: `Bearer ${token}` };

async function call(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  if (!token) throw new Error('未設定 LINE_CHANNEL_ACCESS_TOKEN');
  if (!config.baseUrl) console.warn('⚠️ 未設定 BASE_URL，「設定管理」按鈕將無法開啟 Dashboard');

  // 刪除舊的同名選單
  const list = await call('https://api.line.me/v2/bot/richmenu/list');
  for (const m of list.richmenus || []) {
    if (m.name === 'health-main-menu') {
      await call(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { method: 'DELETE' });
      console.log(`🗑 已刪除舊選單 ${m.richMenuId}`);
    }
  }

  const { richMenuId } = await call('https://api.line.me/v2/bot/richmenu', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildRichMenu(config.baseUrl)),
  });
  const img = await readFile(path.join(__dirname, '..', 'assets', 'rich-menu.png'));
  await call(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: img,
  });
  await call(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST' });
  console.log(`✅ Rich Menu 已建立並設為預設：${richMenuId}`);
}

main().catch((e) => {
  console.error('❌ 失敗：', e.message);
  process.exit(1);
});
