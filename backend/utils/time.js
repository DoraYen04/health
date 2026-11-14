// 時區工具：所有日期以 'YYYY-MM-DD' 字串、時間以 'HH:mm' 字串處理，避免 Date 物件的時區陷阱。

export const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      timeZoneName: 'longOffset',
    }));
  }
  return fmtCache.get(tz);
}

/** 取得指定時區的當下日期／時間各部分 */
export function nowIn(tz = 'Asia/Taipei', date = new Date()) {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  const d = `${parts.year}-${parts.month}-${parts.day}`;
  const t = `${parts.hour}:${parts.minute}`;
  const offset = (parts.timeZoneName || 'GMT+08:00').replace('GMT', '') || '+00:00';
  return {
    date: d,
    time: t,
    seconds: parts.second,
    weekday: weekdayZh(d),
    dow: dayOfWeek(d),
    minutes: toMinutes(t),
    iso: `${d}T${t}:${parts.second}${offset === '' ? '+00:00' : offset}`,
  };
}

export function isoNow(tz = 'Asia/Taipei') {
  return nowIn(tz).iso;
}

/** 0=日 … 6=六 */
export function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayZh(dateStr) {
  return WEEKDAY_ZH[dayOfWeek(dateStr)];
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function diffDays(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

export function lastDayOfMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m, 0));
  return dt.toISOString().slice(0, 10);
}

export function firstDayOfMonth(dateStr) {
  return `${dateStr.slice(0, 7)}-01`;
}

export function previousMonthRange(dateStr) {
  const first = firstDayOfMonth(dateStr);
  const prevLast = addDays(first, -1);
  return { start: firstDayOfMonth(prevLast), end: prevLast };
}

/** 'HH:mm' → 分鐘數；非法回傳 NaN */
export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function fromMinutes(min) {
  const h = Math.floor(min / 60) % 24;
  const mm = min % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 時間是否在 [start, end]（含）之間，支援跨午夜 */
export function inWindow(hhmm, start, end) {
  const t = toMinutes(hhmm);
  const s = toMinutes(start);
  const e = toMinutes(end);
  if ([t, s, e].some(Number.isNaN)) return false;
  return s <= e ? t >= s && t <= e : t >= s || t <= e;
}

export function isDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

/** 'MM/DD'、'M/D'、'YYYY-MM-DD'、'YYYY/MM/DD'、'今天'、'昨天'、'前天' → 'YYYY-MM-DD' */
export function parseDateToken(token, today) {
  const t = String(token || '').trim();
  if (!t) return null;
  if (t === '今天' || t === '今日') return today;
  if (t === '昨天' || t === '昨日') return addDays(today, -1);
  if (t === '前天') return addDays(today, -2);
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})$/.exec(t);
  if (m) {
    let y = Number(today.slice(0, 4));
    const candidate = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    // 補登日期若落在未來，視為去年（例如 1/2 輸入 12/31）
    if (candidate > today) y -= 1;
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

/** 'YYYY-MM-DD' → 'MM/DD（日）' */
export function displayDate(dateStr) {
  if (!isDateStr(dateStr)) return dateStr || '';
  return `${dateStr.slice(5, 7)}/${dateStr.slice(8, 10)}（${weekdayZh(dateStr)}）`;
}
