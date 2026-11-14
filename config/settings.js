// 系統設定：只放「部署層級」的參數（金鑰、ID、網址）。
// 提醒時間、目標、營養目標等「使用者層級」設定一律存在 Google Sheets（Settings / Task_Schedule），
// 由 Dashboard 修改，不寫死在程式中。

const env = process.env;

function list(v) {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: Number(env.PORT || 8080),
  baseUrl: env.BASE_URL || '',                      // 例：https://health-xxxx.a.run.app
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

  dashboard: {
    googleClientId: env.DASHBOARD_GOOGLE_CLIENT_ID || '', // Google Identity Services 用的 Web Client ID
    allowedEmails: list(env.ALLOWED_EMAILS),              // 允許登入 Dashboard 的 Google 帳號
    sessionSecret: env.SESSION_SECRET || '',
    sessionHours: Number(env.SESSION_HOURS || 72),
  },

  jobs: {
    secret: env.JOB_SECRET || '',                          // Cloud Scheduler 呼叫 /jobs/* 時帶入 X-Job-Secret
  },

  storage: env.STORAGE || 'sheets',                        // sheets | memory（memory 僅供本機測試）
};

export function assertProductionConfig() {
  const missing = [];
  if (!config.line.channelSecret) missing.push('LINE_CHANNEL_SECRET');
  if (!config.line.channelAccessToken) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  if (config.storage === 'sheets' && !config.google.spreadsheetId) missing.push('SPREADSHEET_ID');
  if (!config.dashboard.sessionSecret) missing.push('SESSION_SECRET');
  if (!config.jobs.secret) missing.push('JOB_SECRET');
  return missing;
}
