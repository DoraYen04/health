import { createHmac, timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';
import { config } from '../../config/settings.js';
import { getStore } from '../database/sheets-service.js';
import { logSystem } from '../services/common.js';

const COOKIE = 'hs_session';

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', config.dashboard.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !config.dashboard.sessionSecret) return null;
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', config.dashboard.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

/** 本機開發：DEV_AUTH_USER_ID 有值且非 production 時略過登入 */
function devUser() {
  if (process.env.NODE_ENV === 'production') return null;
  return process.env.DEV_AUTH_USER_ID ? { uid: process.env.DEV_AUTH_USER_ID, email: 'dev@local' } : null;
}

export function requireAuth(req, res, next) {
  const s = verify(req.cookies?.[COOKIE]) || devUser();
  if (!s) return res.status(401).json({ error: '請先登入' });
  req.userId = s.uid;
  req.userEmail = s.email;
  return next();
}

/**
 * Google 登入：驗證 ID Token → 檢查 ALLOWED_EMAILS → 對應 Settings.dashboard_email。
 * 單人使用時，若只有一位尚未綁定的使用者，第一次登入會自動綁定。
 */
export async function loginWithGoogle(req, res) {
  try {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: '缺少 credential' });
    const client = new google.auth.OAuth2(config.dashboard.googleClientId);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: config.dashboard.googleClientId });
    const p = ticket.getPayload();
    const email = String(p.email || '').toLowerCase();
    if (!p.email_verified || !config.dashboard.allowedEmails.map((e) => e.toLowerCase()).includes(email)) {
      await logSystem('warn', 'auth', `未授權登入：${email}`);
      return res.status(403).json({ error: '此 Google 帳號未被授權使用 Dashboard' });
    }
    const store = getStore();
    const users = await store.list('Settings');
    let user = users.find((u) => String(u.dashboard_email || '').toLowerCase() === email);
    if (!user) {
      const unbound = users.filter((u) => !u.dashboard_email);
      if (unbound.length === 1) {
        await store.update('Settings', unbound[0].user_id, { dashboard_email: email });
        user = unbound[0];
      } else {
        return res.status(403).json({
          error: users.length ? '找不到對應的 LINE 使用者，請在 Settings 工作表的 dashboard_email 填入此帳號' : '請先在 LINE 加入官方帳號好友，再登入 Dashboard',
        });
      }
    }
    const token = sign({ uid: user.user_id, email, exp: Date.now() + config.dashboard.sessionHours * 3600_000 });
    res.cookie(COOKIE, token, {
      httpOnly: true, secure: req.secure || req.get('x-forwarded-proto') === 'https', sameSite: 'lax',
      maxAge: config.dashboard.sessionHours * 3600_000, path: '/',
    });
    return res.json({ ok: true, user_id: user.user_id, display_name: user.display_name });
  } catch (e) {
    await logSystem('warn', 'auth', 'Google 登入驗證失敗', e.message);
    return res.status(401).json({ error: '登入驗證失敗' });
  }
}

export function logout(req, res) {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}
