import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { SHEETS, ID_FIELD } from './schema.js';
import { getGoogleAuth } from './google-auth.js';
import { config } from '../../config/settings.js';

// ---------------------------------------------------------------------------
// 共用：物件 <-> 列 的轉換
// ---------------------------------------------------------------------------

function toCell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function fromCell(v) {
  if (v === '' || v === undefined) return null;
  if (v === 'TRUE') return true;
  if (v === 'FALSE') return false;
  return v;
}

export function rowToObject(sheet, row) {
  const cols = SHEETS[sheet];
  const obj = {};
  cols.forEach((c, i) => { obj[c] = fromCell(row[i]); });
  return obj;
}

export function objectToRow(sheet, obj) {
  return SHEETS[sheet].map((c) => toCell(obj[c]));
}

function assertSheet(sheet) {
  if (!SHEETS[sheet]) throw new Error(`未知的工作表：${sheet}`);
}

function matches(obj, where) {
  if (!where) return true;
  if (typeof where === 'function') return where(obj);
  return Object.entries(where).every(([k, v]) => obj[k] === v);
}

// ---------------------------------------------------------------------------
// 記憶體版（測試／本機開發）
// ---------------------------------------------------------------------------

export class MemoryStore {
  constructor() {
    this.tables = Object.fromEntries(Object.keys(SHEETS).map((s) => [s, []]));
  }

  async list(sheet, where) {
    assertSheet(sheet);
    return this.tables[sheet].filter((o) => matches(o, where)).map((o) => ({ ...o }));
  }

  async get(sheet, id) {
    assertSheet(sheet);
    const found = this.tables[sheet].find((o) => o[ID_FIELD[sheet]] === id);
    return found ? { ...found } : null;
  }

  async append(sheet, objs) {
    assertSheet(sheet);
    const arr = (Array.isArray(objs) ? objs : [objs]).map((o) => normalize(sheet, o));
    this.tables[sheet].push(...arr.map((o) => ({ ...o })));
    return arr;
  }

  async update(sheet, id, patch) {
    assertSheet(sheet);
    const idx = this.tables[sheet].findIndex((o) => o[ID_FIELD[sheet]] === id);
    if (idx < 0) throw new Error(`${sheet} 找不到 ${id}`);
    const before = { ...this.tables[sheet][idx] };
    const after = normalize(sheet, { ...before, ...patch, [ID_FIELD[sheet]]: id });
    this.tables[sheet][idx] = after;
    return { before, after: { ...after } };
  }

  async updateMany(sheet, updates) {
    const out = [];
    for (const u of updates) out.push(await this.update(sheet, u.id, u.patch));
    return out;
  }
}

function normalize(sheet, o) {
  const idField = ID_FIELD[sheet];
  const out = {};
  for (const c of SHEETS[sheet]) {
    const v = o[c];
    out[c] = v === undefined || v === '' ? null : v;
  }
  if (!out[idField]) out[idField] = randomUUID();
  return out;
}

// ---------------------------------------------------------------------------
// Google Sheets 版
// ---------------------------------------------------------------------------

const CACHE_MS = 4000;

export class SheetsStore {
  constructor(spreadsheetId) {
    if (!spreadsheetId) throw new Error('缺少 SPREADSHEET_ID');
    this.spreadsheetId = spreadsheetId;
    this.api = google.sheets({ version: 'v4', auth: getGoogleAuth() });
    this.cache = new Map(); // sheet -> { at, rows: [{obj,rowNumber}] }
    this.locks = new Map(); // sheet -> Promise（同一實例內序列化寫入）
  }

  async _withLock(sheet, fn) {
    const prev = this.locks.get(sheet) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    this.locks.set(sheet, prev.then(() => next));
    await prev;
    try { return await fn(); } finally { release(); }
  }

  async _load(sheet, force = false) {
    const c = this.cache.get(sheet);
    if (!force && c && Date.now() - c.at < CACHE_MS) return c.rows;
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${sheet}!A2:ZZ`,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const values = res.data.values || [];
    const rows = [];
    values.forEach((r, i) => {
      if (!r[0]) return; // 空列略過
      rows.push({ obj: rowToObject(sheet, r), rowNumber: i + 2 });
    });
    this.cache.set(sheet, { at: Date.now(), rows });
    return rows;
  }

  _invalidate(sheet) { this.cache.delete(sheet); }

  async list(sheet, where) {
    assertSheet(sheet);
    const rows = await this._load(sheet);
    return rows.map((r) => ({ ...r.obj })).filter((o) => matches(o, where));
  }

  async get(sheet, id) {
    assertSheet(sheet);
    const rows = await this._load(sheet);
    const f = rows.find((r) => r.obj[ID_FIELD[sheet]] === id);
    return f ? { ...f.obj } : null;
  }

  async append(sheet, objs) {
    assertSheet(sheet);
    const arr = (Array.isArray(objs) ? objs : [objs]).map((o) => normalize(sheet, o));
    if (!arr.length) return [];
    await this._withLock(sheet, async () => {
      await this.api.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheet}!A1`,
        valueInputOption: 'RAW',           // RAW：避免 Sheets 自動把 '08:00' 或日期轉型
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: arr.map((o) => objectToRow(sheet, o)) },
      });
      this._invalidate(sheet);
    });
    return arr;
  }

  async update(sheet, id, patch) {
    const [r] = await this.updateMany(sheet, [{ id, patch }]);
    return r;
  }

  /** 批次更新：一次 batchUpdate 寫回多列 */
  async updateMany(sheet, updates) {
    assertSheet(sheet);
    if (!updates.length) return [];
    return this._withLock(sheet, async () => {
      const rows = await this._load(sheet, true);
      const idField = ID_FIELD[sheet];
      const results = [];
      const data = [];
      for (const { id, patch } of updates) {
        const found = rows.find((r) => r.obj[idField] === id);
        if (!found) throw new Error(`${sheet} 找不到 ${id}`);
        const before = { ...found.obj };
        const after = normalize(sheet, { ...before, ...patch, [idField]: id });
        data.push({ range: `${sheet}!A${found.rowNumber}`, values: [objectToRow(sheet, after)] });
        found.obj = after;
        results.push({ before, after: { ...after } });
      }
      await this.api.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data },
      });
      this._invalidate(sheet);
      return results;
    });
  }
}

// ---------------------------------------------------------------------------

let store;
export function getStore() {
  if (!store) {
    store = config.storage === 'memory' ? new MemoryStore() : new SheetsStore(config.google.spreadsheetId);
  }
  return store;
}

export function setStore(s) { store = s; }
