// 系統設定：只放「部署層級」的參數（金鑰、ID、網址）。
// 提醒時間、目標、營養目標等「使用者層級」設定一律存在 Google Sheets（Settings / Task_Schedule），
// 由 Dashboard 修改，不寫死在程式中。

const env = process.env;

function list(v) {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: Number(env.PORT || 8080),
  baseUrl: (env.BASE_URL || '').replace(/\/+$/, ''), // Dashboard 網址（Firebase Hosting），例：https://health-dora.web.app
  timezone: env.TZ_DEFAULT || 'Asia/Taipei',

  line: {
    channelSecret: env.LINE_CHANNEL_SECRET || '',
    channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN || '',
    adminUserId: env.ADMIN_LINE_USER_ID || '',       // 系統異常通知對象
  },

  gemini: {
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-2.5-flash',
    timeoutMs: Number(env.GEMINI_TIMEOUT_MS || 45000),
  },

  google: {
    spreadsheetId: env.SPREADSHEET_ID || '',
    driveFolderId: env.DRIVE_FOLDER_ID || '',
    // 個人 Gmail 帳號時，Service Account 沒有 Drive 儲存空間，需改用 OAuth refresh token。
    oauthClientId: env.GOOGLE_OAUTH_CLIENT_ID || '',
    oauthClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    oauthRefreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
  },

  // Google Cloud / Firebase 專案（Firebase Auth 驗證 ID token、Cloud Tasks 都會用到）
  projectId: env.GCP_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || '',

  dashboard: {
    allowedEmails: list(env.ALLOWED_EMAILS),              // 允許登入 Dashboard 的 Google 帳號（Firebase Auth）
  },

  // Cloud Scheduler 與 Cloud Tasks 呼叫後端時，帶 OIDC token（由此服務帳號簽發、audience 為 SERVICE_URL）
  invoker: {
    serviceUrl: (env.SERVICE_URL || '').replace(/\/+$/, ''), // Cloud Run 服務網址，例：https://health-xxxx.asia-east1.run.app
    serviceAccountEmail: env.INVOKER_SA_EMAIL || '',          // 例：health-invoker@<project>.iam.gserviceaccount.com
  },

  // LINE 事件改由 Cloud Tasks 佇列處理；未設定 TASKS_QUEUE 時（本機／測試）直接在程式內處理
  tasks: {
    queue: env.TASKS_QUEUE || '',
    location: env.TASKS_LOCATION || 'asia-east1',
  },

  storage: env.STORAGE || 'sheets',                        // sheets | memory（memory 僅供本機測試）
};

export function assertProductionConfig() {
  const missing = [];
  if (!config.line.channelSecret) missing.push('LINE_CHANNEL_SECRET');
  if (!config.line.channelAccessToken) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  if (config.storage === 'sheets' && !config.google.spreadsheetId) missing.push('SPREADSHEET_ID');
  if (!config.projectId) missing.push('GCP_PROJECT_ID');
  if (!config.dashboard.allowedEmails.length) missing.push('ALLOWED_EMAILS');
  if (!config.invoker.serviceUrl) missing.push('SERVICE_URL');
  if (!config.invoker.serviceAccountEmail) missing.push('INVOKER_SA_EMAIL');
  return missing;
}

/**
 * Dashboard 連結（給 LINE 訊息／選單用）。
 * 加上 openExternalBrowser=1 讓 LINE 改用手機的預設瀏覽器開啟：
 * Google 不允許在 LINE 內建瀏覽器中登入（disallowed_useragent）。
 */
export function dashboardUrl(hash = '', baseUrl = config.baseUrl) {
  return baseUrl ? `${baseUrl}/?openExternalBrowser=1${hash}` : '';
}
