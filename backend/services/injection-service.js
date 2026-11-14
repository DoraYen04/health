import { getStore } from '../database/sheets-service.js';
import { isoNow } from '../utils/time.js';
import { num } from './common.js';

// 施打紀錄：系統只「記錄」使用者實際施打的日期與劑量，不提供任何劑量或頻率建議。

export async function createInjection({ userId, date, time, medication, dosageMg, status = '已施打', note = '', tz }) {
  const now = isoNow(tz);
  const [row] = await getStore().append('Injection_Log', {
    user_id: userId,
    injection_date: date,
    injection_time: time,
    medication: medication || '',
    dosage_mg: num(dosageMg),
    status,
    note,
    created_at: now,
    updated_at: now,
  });
  return row;
}

export async function listInjections(userId, { from, to } = {}) {
  const rows = await getStore().list('Injection_Log', (r) => r.user_id === userId
    && (!from || r.injection_date >= from) && (!to || r.injection_date <= to));
  return rows.map((r) => ({ ...r, dosage_mg: num(r.dosage_mg) }))
    .sort((a, b) => (a.injection_date + (a.injection_time || '')).localeCompare(b.injection_date + (b.injection_time || '')));
}
