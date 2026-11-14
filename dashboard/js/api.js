import { idToken } from './auth.js';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function authHeaders() {
  const token = await idToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(await authHeaders()), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}

/** 需要登入的檔案（例如照片）：帶 token 下載後以 blob 網址開啟 */
export async function openProtected(path) {
  const win = window.open('', '_blank'); // 先開視窗，避免被瀏覽器當成彈出視窗擋下
  try {
    const res = await fetch(`/api${path}`, { headers: await authHeaders() });
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    if (win) win.location.href = url; else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    if (win) win.close();
    toast(`無法開啟：${e.message}`, true);
  }
}

export function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isErr ? 'err' : '';
  el.style.display = 'block';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.style.display = 'none'; }, 3200);
}

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmt(v, unit = '', digits) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  const s = Number.isFinite(n) && digits !== undefined ? n.toFixed(digits) : String(v);
  return unit ? `${s} ${unit}` : s;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const WD = ['日', '一', '二', '三', '四', '五', '六'];
export function md(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}（${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}
