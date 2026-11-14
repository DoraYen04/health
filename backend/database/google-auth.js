import { google } from 'googleapis';
import { config } from '../../config/settings.js';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

let cached;

/**
 * 取得 Google API 驗證：
 * 1. 有設定 OAuth refresh token → 以「專用 Google 帳號」身分存取（個人 Gmail 必須用這個，
 *    因為 Service Account 沒有 My Drive 儲存空間，無法上傳照片）。
 * 2. 否則使用 Application Default Credentials（Cloud Run 服務帳號）。
 *    此時試算表需分享給服務帳號，照片資料夾需位於共用雲端硬碟。
 */
export function getGoogleAuth() {
  if (cached) return cached;
  const g = config.google;
  if (g.oauthRefreshToken && g.oauthClientId && g.oauthClientSecret) {
    const client = new google.auth.OAuth2(g.oauthClientId, g.oauthClientSecret);
    client.setCredentials({ refresh_token: g.oauthRefreshToken });
    cached = client;
  } else {
    cached = new google.auth.GoogleAuth({ scopes: SCOPES });
  }
  return cached;
}

export { SCOPES };
