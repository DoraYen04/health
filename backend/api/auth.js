import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { config } from '../../config/settings.js';
import { getStore } from '../database/sheets-service.js';
import { logSystem } from '../services/common.js';

// Dashboard 登入：前端以 Firebase Authentication（Google 帳號）登入，
// 每次呼叫 API 帶 Authorization: Bearer <Firebase ID token>，後端逐次驗證。
// 不使用 cookie（Firebase Hosting 轉送到 Cloud Run 時只保留 __session cookie）。

let verifyFirebaseToken = async (idToken) => {
  if (!getApps().length) initializeApp(config.projectId ? { projectId: config.projectId } : {});
  return getAuth().verifyIdToken(idToken);
};

/** 測試用：替換 ID token 驗證函式 */
export function setFirebaseVerifier(fn) {
  verifyFirebaseToken = fn;
  userCache.clear();
}

// email → LINE user_id 的對應快取，避免每個 API 請求都讀取 Settings 工作表
const userCache = new Map();
const CACHE_MS = 5 * 60_000;

/**
 * 依 email 找到對應的 LINE 使用者（Settings.dashboard_email）。
 * 單人使用時，若只有一位尚未綁定的使用者，第一次登入會自動綁定。
 */
async function resolveUser(email) {
  const hit = userCache.get(email);
  if (hit && hit.exp > Date.now()) return hit.user;
  const store = getStore();
  const users = await store.list('Settings');
  let user = users.find((u) => String(u.dashboard_email || '').toLowerCase() === email);
  if (!user) {
    const unbound = users.filter((u) => !u.dashboard_email);
    if (unbound.length !== 1) {
      const e = new Error(users.length
        ? '找不到對應的 LINE 使用者，請在 Settings 工作表的 dashboard_email 填入此帳號'
        : '請先在 LINE 加入官方帳號好友，再登入 Dashboard');
      e.status = 403;
      throw e;
    }
    await store.update('Settings', unbound[0].user_id, { dashboard_email: email });
    user = unbound[0];
  }
  userCache.set(email, { user, exp: Date.now() + CACHE_MS });
  return user;
}

/** 本機開發：DEV_AUTH_USER_ID 有值且非 production 時略過登入 */
export function devAuthEnabled() {
  return process.env.NODE_ENV !== 'production' && !!process.env.DEV_AUTH_USER_ID;
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  return m ? m[1].trim() : '';
}

export async function requireAuth(req, res, next) {
  const token = bearer(req);
  if (!token) {
    if (devAuthEnabled()) {
      req.userId = process.env.DEV_AUTH_USER_ID;
      req.userEmail = 'dev@local';
      return next();
    }
    return res.status(401).json({ error: '請先登入' });
  }

  let decoded;
  try {
    decoded = await verifyFirebaseToken(token);
  } catch {
    return res.status(401).json({ error: '登入已過期，請重新登入' });
  }

  const email = String(decoded.email || '').toLowerCase();
  const provider = decoded.firebase?.sign_in_provider;
  const allowed = config.dashboard.allowedEmails.map((e) => e.toLowerCase());
  if (!decoded.email_verified || provider !== 'google.com' || !email || !allowed.includes(email)) {
    await logSystem('warn', 'auth', `未授權登入：${email || '(無 email)'}（${provider || '-'}）`);
    return res.status(403).json({ error: '此 Google 帳號未被授權使用 Dashboard' });
  }

  try {
    const user = await resolveUser(email);
    req.userId = user.user_id;
    req.userEmail = email;
    return next();
  } catch (e) {
    if (e.status === 403) return res.status(403).json({ error: e.message });
    await logSystem('error', 'auth', '登入使用者對應失敗', e.stack || e.message);
    return res.status(500).json({ error: '系統錯誤，請稍後再試' });
  }
}
