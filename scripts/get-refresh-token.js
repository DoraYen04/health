// 取得 Google OAuth refresh token（個人 Gmail 帳號必須，因 Service Account 無 Drive 儲存空間）
// 1. GCP Console → API 和服務 → 憑證 → 建立「OAuth 用戶端 ID」類型選「電腦版應用程式」
// 2. .env 填入 GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
// 3. node --env-file=.env scripts/get-refresh-token.js，以「專用 Google 帳號」登入授權
import http from 'node:http';
import { google } from 'googleapis';
import { SCOPES } from '../backend/database/google-auth.js';

const PORT = 53682;
const { GOOGLE_OAUTH_CLIENT_ID: id, GOOGLE_OAUTH_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) {
  console.error('請先設定 GOOGLE_OAUTH_CLIENT_ID 與 GOOGLE_OAUTH_CLIENT_SECRET');
  process.exit(1);
}
const client = new google.auth.OAuth2(id, secret, `http://localhost:${PORT}`);
const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('code');
  if (!code) { res.end('等待授權…'); return; }
  try {
    const { tokens } = await client.getToken(code);
    res.end('授權完成，可以關閉此頁面。');
    console.log('\n✅ 請將以下值填入 .env／Secret Manager：');
    console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
  } catch (e) {
    res.end(`失敗：${e.message}`);
    console.error(e.message);
  }
  server.close();
});
server.listen(PORT, () => console.log(`請用瀏覽器開啟並登入專用 Google 帳號：\n${url}`));
