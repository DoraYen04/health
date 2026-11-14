import { google } from 'googleapis';
import { config } from '../../config/settings.js';
import { logSystem } from '../services/common.js';

// Cloud Scheduler（/jobs/*）與 Cloud Tasks（/tasks/*）呼叫後端時，
// 帶 Google 簽發的 OIDC token：audience = SERVICE_URL、email = INVOKER_SA_EMAIL。
// Cloud Run 為了讓 LINE 與 Firebase Hosting 呼叫得到，必須允許未驗證呼叫，
// 所以這兩類端點在程式內自行驗證 OIDC token，其他人打不進來。

const oauth = new google.auth.OAuth2();

let verifyOidc = async (idToken, audience) => {
  const ticket = await oauth.verifyIdToken({ idToken, audience });
  return ticket.getPayload();
};

/** 測試用：替換 OIDC token 驗證函式 */
export function setOidcVerifier(fn) {
  verifyOidc = fn;
}

export async function requireInvoker(req, res, next) {
  const { serviceUrl, serviceAccountEmail } = config.invoker;
  if (!serviceUrl || !serviceAccountEmail) {
    return res.status(503).json({ error: 'invoker not configured' });
  }
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!m) return res.status(401).json({ error: 'unauthorized' });
  try {
    const p = await verifyOidc(m[1].trim(), serviceUrl);
    if (!p || !p.email_verified || String(p.email).toLowerCase() !== serviceAccountEmail.toLowerCase()) {
      throw new Error(`unexpected caller: ${p?.email || '-'}`);
    }
    return next();
  } catch (e) {
    await logSystem('warn', 'invoker', `排程／佇列端點驗證失敗：${req.path}`, e.message);
    return res.status(401).json({ error: 'unauthorized' });
  }
}
