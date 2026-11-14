// 文字指令解析（純函式，方便測試）。無法辨識的文字回傳 { type: 'unknown' }，
// 由 message-handler 決定是否交給 Gemini 理解。

import { parseDateToken } from '../utils/time.js';
import { matchExerciseType } from '../services/exercise-service.js';

const DATE_RE = '(今天|今日|昨天|昨日|前天|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}/\\d{1,2})';
const TIME_RE = '(\\d{1,2}:\\d{2})';
const NUM_RE = '(\\d{1,3}(?:\\.\\d{1,2})?)';

function periodOf(word) {
  if (!word) return null;
  if (/^(上午|早上|早|晨)$/.test(word)) return 'AM';
  if (/^(下午|午後|晚上|晚)$/.test(word)) return 'PM';
  return null;
}

function clean(text) {
  return String(text || '')
    .replace(/[０-９．：／]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全形轉半形
    .replace(/　/g, ' ')
    .trim();
}

export function parseCommand(rawText, today) {
  const text = clean(rawText);
  const compact = text.replace(/\s+/g, '');
  if (!text) return { type: 'unknown' };

  // --- 確認／取消 -----------------------------------------------------------
  if (/^(確認|確認儲存|確定|是|好|ok|OK|Ok|儲存)$/.test(compact)) return { type: 'confirm' };
  if (/^(取消|不要|否|算了)$/.test(compact)) return { type: 'cancel' };
  if (/^(覆蓋|覆蓋原紀錄)$/.test(compact)) return { type: 'choose', choice: 'overwrite' };
  if (/^(新增|新增一筆)$/.test(compact)) return { type: 'choose', choice: 'append' };

  // --- 修改待確認欄位：「修改 體脂率 28.4」「改 熱量 400」 -----------------------
  let m = /^(?:修改|改)\s*([^\d\s:：=]+?)\s*[:：=]?\s*(\d+(?:\.\d+)?)\s*(?:kg|%|kcal|g|公斤)?$/i.exec(text);
  if (m) return { type: 'modify', field: m[1], value: Number(m[2]) };

  // --- 說明／查詢 -----------------------------------------------------------
  if (/^(說明|幫助|help|指令|\?|？)$/i.test(compact)) return { type: 'help' };
  if (/^(今日報告|今天報告|每日報告|日報)$/.test(compact)) return { type: 'report', reportType: 'Daily' };
  if (/^(本週報告|每週報告|週報|周報|本周報告)$/.test(compact)) return { type: 'report', reportType: 'Weekly' };
  if (/^(本月報告|每月報告|月報)$/.test(compact)) return { type: 'report', reportType: 'Monthly' };
  if (/^(我的目標|目標進度|目標)$/.test(compact)) return { type: 'goal_query' };
  if (/^(今日待辦|待辦|今天待辦|待辦事項)$/.test(compact)) return { type: 'todo' };
  if (/^(今日營養|今天吃了多少|營養)$/.test(compact)) return { type: 'nutrition_today' };
  m = /^最近(\d{1,3})天$/.exec(compact);
  if (m) return { type: 'history', days: Math.min(365, Number(m[1])) };
  if (/^(暫停提醒)$/.test(compact)) return { type: 'pause', days: 1 };
  m = /^暫停提醒(\d{1,2})天$/.exec(compact);
  if (m) return { type: 'pause', days: Number(m[1]) };
  if (/^(恢復提醒|開啟提醒)$/.test(compact)) return { type: 'resume' };

  // --- 設定目標：「目標 體重 55 2027/3/31」「目標體脂 25」 ------------------------
  m = new RegExp(`^(?:設定)?目標\\s*(體重|體脂|體脂率|肌肉|骨骼肌)\\s*${NUM_RE}\\s*(?:kg|%|公斤)?\\s*${DATE_RE}?$`, 'i').exec(text);
  if (m) {
    const goalType = m[1].startsWith('體脂') ? '體脂' : m[1] === '體重' ? '體重' : '肌肉';
    return { type: 'goal_set', goalType, target: Number(m[2]), targetDate: m[3] ? parseDateToken(m[3], today) : null };
  }

  // --- 施打紀錄 -------------------------------------------------------------
  if (/(未施打|沒有施打|沒打)/.test(compact)) {
    return { type: 'injection', status: '未施打', dosage: null, medication: null, date: today };
  }
  if (/延後施打/.test(compact)) {
    return { type: 'injection', status: '延後', dosage: null, medication: null, date: today };
  }
  m = new RegExp(`^(?:${DATE_RE}\\s*)?(?:已)?(?:施打|注射|打針)\\s*([^\\d\\s]*?)\\s*${NUM_RE}\\s*(mg|毫克)\\s*${TIME_RE}?$`, 'i').exec(text);
  if (m) {
    return {
      type: 'injection',
      status: '已施打',
      date: m[1] ? parseDateToken(m[1], today) : today,
      medication: m[2] || null,
      dosage: Number(m[3]),
      time: m[5] || null,
    };
  }

  // --- 體重（含補登）：「59.8」「上午 59.8」「補登 11/08 下午 59.5 15:10」 ----------
  m = new RegExp(`^(補登)?\\s*${DATE_RE}?\\s*(上午|早上|早|下午|晚上|晚)?\\s*(?:體重)?\\s*${NUM_RE}\\s*(?:kg|公斤|KG)?\\s*${TIME_RE}?$`, 'i').exec(text);
  if (m) {
    const value = Number(m[4]);
    if (value >= 20) {
      const date = m[2] ? parseDateToken(m[2], today) : today;
      return {
        type: 'weight',
        value,
        period: periodOf(m[3]),
        date,
        time: m[5] || null,
        backfill: !!m[1] || (date && date !== today),
      };
    }
  }

  // --- 飲食：「午餐：雞胸肉、雞蛋」「早餐 水煮蛋2顆」 ------------------------------
  m = /^(早餐|午餐|晚餐|點心|宵夜|下午茶)\s*[:：]?\s*(.+)$/.exec(text);
  if (m) {
    const mealType = m[1] === '宵夜' || m[1] === '下午茶' ? '點心' : m[1];
    return { type: 'meal', mealType, description: m[2].trim() };
  }
  m = /^(?:我)?(?:今天)?(?:吃了|喝了)\s*(.+)$/.exec(text);
  if (m) return { type: 'meal', mealType: null, description: m[1].trim() };

  // --- 運動：「今天騎車 60 分鐘，約 15 公里」 ------------------------------------
  const durMatch = /(\d+(?:\.\d+)?)\s*(分鐘|分|min|mins|小時|hr|hrs|h)(?![a-z])/i.exec(text);
  const exType = matchExerciseType(text);
  if (durMatch && (exType || /運動/.test(text))) {
    const unit = durMatch[2].toLowerCase();
    const minutes = /小時|hr|hrs|h/.test(unit) ? Math.round(Number(durMatch[1]) * 60) : Math.round(Number(durMatch[1]));
    const dist = /(\d+(?:\.\d+)?)\s*(公里|km|KM|k)\b/i.exec(text) || /(\d+(?:\.\d+)?)\s*公里/.exec(text);
    const cal = /(?:消耗|燃燒)\s*(\d+)\s*(?:大卡|kcal|卡)/i.exec(text);
    const intensity = /高強度|很喘|激烈/.test(text) ? '高' : /低強度|輕鬆|慢慢/.test(text) ? '低' : '中';
    const dateTok = new RegExp(DATE_RE).exec(text);
    return {
      type: 'exercise',
      exerciseType: exType || '其他',
      minutes,
      distanceKm: dist ? Number(dist[1]) : null,
      calories: cal ? Number(cal[1]) : null,
      intensity,
      date: dateTok ? parseDateToken(dateTok[1], today) : today,
    };
  }

  return { type: 'unknown', text };
}
