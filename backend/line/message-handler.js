import { lineClient, textWithQuickReply, confirmButtons } from './line-client.js';
import { parseCommand } from './parser.js';
import { getStore } from '../database/sheets-service.js';
import { config } from '../../config/settings.js';
import { nowIn, displayDate, addDays } from '../utils/time.js';
import { ensureUser, getSettings, logSystem, num, round, updateWithAudit, toBool } from '../services/common.js';
import {
  resolvePeriod, periodZh, validateWeight, latestWeight, findSamePeriod, createWeight, overwriteWeight, listWeights,
} from '../services/weight-service.js';
import { BODY_ALIASES, BODY_FIELDS, formatBody, createBodyComposition, listBody } from '../services/body-service.js';
import { createInjection } from '../services/injection-service.js';
import { createExercise, estimateCalories, listExercise, summarizeExercise } from '../services/exercise-service.js';
import { createMeal, guessMealType, formatItems, listMeals, summarizeDay } from '../services/meal-service.js';
import { createGoal, goalsWithProgress } from '../services/goal-service.js';
import {
  createPending, latestPending, getPending, resolvePending, cancelAllPending, updatePendingPayload, isUsable,
} from '../services/pending-service.js';
import { generateReport, findReport, reportRange, formatReportText } from '../services/report-service.js';
import { markTaskCompleted, taskOccursOn, isTaskCompleted } from '../scheduler/reminder-job.js';
import { uploadPhoto } from '../database/drive-service.js';
import { analyzeBodyPhoto } from '../gemini/image-analysis.js';
import { analyzeMeal } from '../gemini/meal-analysis.js';
import { answerQuestion } from '../gemini/report-analysis.js';

// ---------------------------------------------------------------------------
// 回覆工具：先用 replyToken（免費），失敗（例如 AI 處理過久 token 過期）再改用 push
// ---------------------------------------------------------------------------

function makeResponder(userId, replyToken) {
  let used = false;
  return async (messages) => {
    if (!used && replyToken) {
      used = true;
      try {
        await lineClient.reply(replyToken, messages);
        return;
      } catch (e) {
        console.warn('reply 失敗，改用 push：', e.message);
      }
    }
    await lineClient.push(userId, messages);
  };
}

const HELP = `📘 健康小助理指令
⚖️ 體重：59.8／上午 59.8／下午 59.5
　補登：補登 11/08 上午 59.8 08:10
📷 體脂：直接上傳體脂計照片
💉 施打：施打 2.5mg（或：施打 藥名 2.5mg）
🥗 飲食：午餐：水煮蛋2顆、蛋白飲一瓶（或上傳餐點照片）
🚴 運動：今天騎車 60 分鐘 15 公里
🎯 目標：目標 體重 55 2027/03/31
📈 查詢：今日報告／本週報告／本月報告／我的目標／最近30天／今日待辦
🔕 暫停提醒／暫停提醒3天／恢復提醒
✏️ 確認前修改：修改 體脂率 28.4`;

// ---------------------------------------------------------------------------
// 事件入口
// ---------------------------------------------------------------------------

export async function handleEvent(event) {
  const userId = event.source?.userId;
  if (!userId) return;
  const respond = makeResponder(userId, event.replyToken);
  try {
    if (event.type === 'follow') {
      const profile = await lineClient.getProfile(userId).catch(() => null);
      await ensureUser(userId, profile?.displayName || '');
      await respond([`歡迎使用健康管理小助理${profile?.displayName ? `，${profile.displayName}` : ''}！已為您建立預設提醒（上午 08:00、下午 14:00 量體重，21:00 每日報告），可於 Dashboard 調整。`, HELP]);
      return;
    }
    await ensureUser(userId);
    const settings = await getSettings(userId);
    const ctx = { userId, settings, tz: settings.timezone, now: nowIn(settings.timezone), respond };

    if (event.type === 'message' && event.message.type === 'text') return await handleText(ctx, event.message.text);
    if (event.type === 'message' && event.message.type === 'image') return await handleImage(ctx, event.message.id);
    if (event.type === 'postback') return await handlePostback(ctx, event.postback.data);
    if (event.type === 'message') return await respond('目前支援文字與照片訊息喔！輸入「說明」查看指令。');
  } catch (e) {
    await logSystem('error', 'line-handler', `處理事件失敗：${e.message}`, e.stack);
    try { await respond('抱歉，系統處理時發生錯誤，請稍後再試一次。'); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 文字
// ---------------------------------------------------------------------------

async function handleText(ctx, text) {
  const { userId, now, respond } = ctx;
  const cmd = parseCommand(text, now.date);
  const trimmed = text.trim();

  // 待確認的體重時段：直接回「上午」「下午」
  if (cmd.type === 'unknown' && /^(上午|早上|下午|晚上)$/.test(trimmed)) {
    const p = await latestPending(userId, ['weight']);
    if (p?.payload.stage === 'period') {
      return continueWeight(ctx, { ...p.payload, period: /上午|早上/.test(trimmed) ? 'AM' : 'PM' }, p.pending_id);
    }
  }

  switch (cmd.type) {
    case 'confirm': {
      const p = await latestPending(userId);
      if (!p || p.action_type.startsWith('context')) return respond('目前沒有需要確認的資料。');
      return executePending(ctx, p);
    }
    case 'cancel':
      await cancelAllPending(userId);
      return respond('已取消，資料未儲存。');
    case 'choose': {
      const p = await latestPending(userId, ['weight']);
      if (p?.payload.stage !== 'duplicate') return respond('目前沒有需要選擇的重複紀錄。');
      return continueWeight(ctx, { ...p.payload, dupChoice: cmd.choice }, p.pending_id);
    }
    case 'modify': return modifyPending(ctx, cmd);
    case 'help': return respond(HELP);
    case 'weight': return startWeight(ctx, cmd);
    case 'injection': return startInjection(ctx, cmd);
    case 'exercise': return startExercise(ctx, cmd);
    case 'meal': return startMealText(ctx, cmd.mealType, cmd.description);
    case 'report': return replyReport(ctx, cmd.reportType);
    case 'goal_query': return replyGoals(ctx);
    case 'goal_set': return setGoal(ctx, cmd);
    case 'todo': return replyTodo(ctx);
    case 'history': return replyHistory(ctx, cmd.days);
    case 'nutrition_today': return replyNutritionToday(ctx);
    case 'pause': return pauseReminders(ctx, cmd.days);
    case 'resume': return resumeReminders(ctx);
    default: break;
  }

  // 在「飲食」情境中輸入的自由文字視為餐點描述
  const context = await latestPending(userId, ['context_meal']);
  if (context) return startMealText(ctx, null, trimmed);

  // 其他：Gemini 一般健康問答（只引用已確認資料）
  if (config.gemini.apiKey && trimmed.length >= 4) {
    try {
      const [w, b, goals] = await Promise.all([
        listWeights(userId, { from: addDays(now.date, -14) }),
        listBody(userId, { from: addDays(now.date, -60) }),
        goalsWithProgress(userId, now.date),
      ]);
      const answer = await answerQuestion(trimmed, {
        recent_weights: w.slice(-10).map((x) => ({ date: x.measure_date, period: x.period, kg: x.weight_kg })),
        latest_body: b.length ? b[b.length - 1] : null,
        goals: goals.map((g) => ({ type: g.goal_type, target: g.target_value, current: g.current_value, pct: g.progress.pct })),
      });
      return respond(`${answer}\n\n※ 一般健康資訊，不取代醫師診療或處方指示。`);
    } catch (e) {
      await logSystem('warn', 'qa', 'Gemini 問答失敗', e.message);
    }
  }
  return respond(textWithQuickReply('我看不太懂這句話 🙏 輸入「說明」查看可用指令。', [
    { label: '說明', text: '說明' }, { label: '今日報告', text: '今日報告' }, { label: '今日待辦', text: '今日待辦' },
  ]));
}

// ---------------------------------------------------------------------------
// 體重
// ---------------------------------------------------------------------------

async function startWeight(ctx, cmd) {
  const { now, settings } = ctx;
  const isBackfill = !!cmd.backfill;
  const data = {
    weight: cmd.value,
    date: cmd.date || now.date,
    time: cmd.time || (isBackfill ? '' : now.time),
    period: cmd.period || (isBackfill ? null : resolvePeriod(now.time, settings)),
    isBackfill,
  };
  if (data.date > now.date) return ctx.respond('日期不能是未來，請重新輸入。');
  return continueWeight(ctx, data, null);
}

/** 體重流程：時段 → 範圍檢查 → 異常跳動確認 → 重複處理 → 儲存 */
async function continueWeight(ctx, data, pendingId) {
  const { userId, settings, tz, respond } = ctx;
  const save = async (stage, extraText, buttons) => {
    const payload = { ...data, stage };
    let pid = pendingId;
    if (pid) await updatePendingPayload(pid, payload);
    else pid = (await createPending(userId, 'weight', payload, { tz })).pending_id;
    return respond(textWithQuickReply(extraText, buttons(pid)));
  };

  if (!data.period) {
    return save('period', `體重 ${data.weight} kg 要記錄為上午還是下午？`, (pid) => [
      { label: '上午', data: `action=weight&pid=${pid}&set=AM` },
      { label: '下午', data: `action=weight&pid=${pid}&set=PM` },
      { label: '取消', data: `action=cancel&pid=${pid}` },
    ]);
  }

  const last = await latestWeight(userId);
  const check = validateWeight(data.weight, settings, last);
  if (!check.ok) {
    if (pendingId) await resolvePending(pendingId, '已取消', tz);
    return respond(check.error);
  }
  if (check.warning && !data.jumpConfirmed) {
    data.jumpConfirmed = false;
    return save('jump', `⚠️ ${check.warning}\n確認以 ${data.weight} kg 記錄 ${displayDate(data.date)} ${periodZh(data.period)}體重？`, (pid) => [
      { label: '確認儲存', data: `action=weight&pid=${pid}&set=jump_ok` },
      { label: '取消', data: `action=cancel&pid=${pid}` },
    ]);
  }

  const dups = await findSamePeriod(userId, data.date, data.period);
  if (dups.length && !data.dupChoice) {
    const d = dups[dups.length - 1];
    data.dupId = d.weight_id;
    return save('duplicate', `${displayDate(data.date)} ${periodZh(data.period)}已有紀錄 ${d.weight_kg} kg（${d.measure_time || '—'}）。\n要覆蓋原紀錄，還是新增一筆？`, (pid) => [
      { label: '覆蓋原紀錄', data: `action=weight&pid=${pid}&set=overwrite` },
      { label: '新增一筆', data: `action=weight&pid=${pid}&set=append` },
      { label: '取消', data: `action=cancel&pid=${pid}` },
    ]);
  }

  // 儲存
  let row;
  if (data.dupChoice === 'overwrite' && data.dupId) {
    const r = await overwriteWeight(data.dupId, { weight: data.weight, time: data.time, userId, changedBy: 'LINE' });
    row = r.after;
  } else {
    row = await createWeight({
      userId, date: data.date, time: data.time, period: data.period, weight: data.weight,
      isBackfill: data.isBackfill, note: data.isBackfill && !data.time ? '補登未指定時間' : '', tz,
    });
  }
  if (pendingId) await resolvePending(pendingId, '已處理', tz);
  await markTaskCompleted(userId, data.period === 'AM' ? 'weight_am' : 'weight_pm', data.date, tz);

  // 與前一日同時段比較（不以其他時段代替）
  const prevDate = addDays(data.date, -1);
  const prev = (await findSamePeriod(userId, prevDate, data.period)).pop();
  const diffText = prev ? `\n較前一日${periodZh(data.period)}：${fmtSigned(round(data.weight - num(prev.weight_kg), 2))} kg` : '\n前一日同時段無資料';
  return respond(`✅ 記錄成功${data.dupChoice === 'overwrite' ? '（已覆蓋原紀錄）' : ''}${data.isBackfill ? '（補登）' : ''}
日期：${displayDate(row.measure_date)}
時間：${row.measure_time || '未指定'}
類別：${periodZh(row.period)}體重
體重：${row.weight_kg} kg${diffText}`);
}

function fmtSigned(n) {
  if (n === null) return '—';
  if (n === 0) return '±0';
  return `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// 施打
// ---------------------------------------------------------------------------

async function startInjection(ctx, cmd) {
  const { userId, now, settings, tz, respond } = ctx;
  const payload = {
    date: cmd.date || now.date,
    time: cmd.time || now.time,
    medication: cmd.medication || settings.default_medication || '',
    dosage: cmd.dosage,
    status: cmd.status,
  };
  const p = await createPending(userId, 'injection', payload, { tz });
  const lines = cmd.status === '已施打'
    ? [`💉 請確認施打紀錄`, `日期：${displayDate(payload.date)}`, `時間：${payload.time}`, `藥物：${payload.medication || '未指定'}`, `實際劑量：${payload.dosage} mg`]
    : [`💉 記錄本次狀態：${cmd.status}`, `日期：${displayDate(payload.date)}`];
  lines.push('', '如需修改：「修改 劑量 5」或「修改 時間 21:30」；確認後寫入施打紀錄。');
  return respond(textWithQuickReply(lines.join('\n'), confirmButtons(p.pending_id)));
}

// ---------------------------------------------------------------------------
// 運動
// ---------------------------------------------------------------------------

async function startExercise(ctx, cmd) {
  const { userId, now, tz, respond } = ctx;
  let calories = cmd.calories;
  let caloriesSource = calories !== null ? '使用者輸入' : '';
  if (calories === null) {
    const w = await latestWeight(userId);
    calories = estimateCalories(cmd.exerciseType, cmd.minutes, w?.weight_kg, cmd.intensity);
    caloriesSource = calories !== null ? '估算' : '';
  }
  const payload = {
    date: cmd.date || now.date, time: now.time, type: cmd.exerciseType, minutes: cmd.minutes,
    distanceKm: cmd.distanceKm, intensity: cmd.intensity, calories, caloriesSource,
  };
  const p = await createPending(userId, 'exercise', payload, { tz });
  return respond(textWithQuickReply(formatExercise(payload), confirmButtons(p.pending_id)));
}

function formatExercise(p) {
  return [
    '🚴 已整理運動紀錄，請確認：',
    `日期：${displayDate(p.date)}`,
    `類型：${p.type}`,
    `時間：${p.minutes} 分鐘`,
    `距離：${p.distanceKm !== null && p.distanceKm !== undefined ? `${p.distanceKm} 公里` : '未提供'}`,
    `強度：${p.intensity || '—'}`,
    `消耗：${p.calories !== null && p.calories !== undefined ? `約 ${p.calories} kcal（${p.caloriesSource}）` : '無可靠資料，不估算'}`,
    '',
    '修改範例：「修改 分鐘 45」「修改 距離 12」「修改 消耗 350」',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 飲食
// ---------------------------------------------------------------------------

async function startMealText(ctx, mealType, description) {
  const { userId, now, tz, respond } = ctx;
  let items;
  let note = '';
  try {
    const r = await analyzeMeal({ text: description });
    items = r.items;
    if (r.needsQuantity) note = '\n（部分份量為假設值，請依實際份量或產品標示修正）';
  } catch (e) {
    await logSystem('warn', 'meal-ai', '飲食估算失敗', e.message);
    items = [{ food_name: description.slice(0, 60), quantity: '', calorie_kcal: null, protein_g: null, fat_g: null, carb_g: null, source: '使用者輸入' }];
    note = '\n（AI 估算暫時無法使用，僅記錄食物名稱；可稍後於 Dashboard 補上營養數值）';
  }
  if (!items.length) return respond('沒有辨識到食物項目，請再描述一次，例如「午餐：雞胸肉 150g、白飯半碗」。');
  const payload = { date: now.date, time: now.time, mealType: mealType || guessMealType(now.time), items, photoId: '', photoUrl: '' };
  const p = await createPending(userId, 'meal', payload, { tz });
  return respond(textWithQuickReply(formatMeal(payload) + note, confirmButtons(p.pending_id)));
}

function formatMeal(p) {
  const total = summarizeDay(p.items.map((it) => ({ ...it, meal_type: p.mealType, nutrition_source: it.source })));
  return [
    `🥗 ${p.mealType}｜營養估算（待確認）`,
    formatItems(p.items),
    '',
    `合計：熱量 ${total.calorie_kcal ?? '—'} kcal、蛋白質 ${total.protein_g ?? '—'} g、脂肪 ${total.fat_g ?? '—'} g、碳水 ${total.carb_g ?? '—'} g`,
    total.includes_ai_estimate ? '※ AI 估算值，實際請依產品標示及份量修正' : '',
    p.items.length === 1 ? '修改範例：「修改 熱量 400」「修改 蛋白質 35」' : '多項食物可於儲存後在 Dashboard 逐項修正',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// 照片
// ---------------------------------------------------------------------------

async function handleImage(ctx, messageId) {
  const { userId, tz, respond } = ctx;
  const context = await latestPending(userId, ['context_body', 'context_meal']);
  if (context?.action_type === 'context_body') return processBodyPhoto(ctx, messageId);
  if (context?.action_type === 'context_meal') return processMealPhoto(ctx, messageId);
  const p = await createPending(userId, 'image_classify', { messageId }, { tz, minutes: 30 });
  return respond(textWithQuickReply('收到照片！請問這是？', [
    { label: '體脂計照片', data: `action=img&pid=${p.pending_id}&kind=body` },
    { label: '餐點照片', data: `action=img&pid=${p.pending_id}&kind=meal` },
    { label: '取消', data: `action=cancel&pid=${p.pending_id}` },
  ]));
}

async function savePhoto(ctx, messageId, photoType) {
  const { userId, now, tz } = ctx;
  const { buffer, mimeType } = await lineClient.getContent(messageId);
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  const name = `${photoType === '體脂' ? 'body' : 'meal'}_${now.date.replace(/-/g, '')}_${now.time.replace(':', '')}_${messageId}.${ext}`;
  const file = await uploadPhoto({ buffer, mimeType, name });
  const [photo] = await getStore().append('Body_Photo', {
    user_id: userId, photo_date: now.date, photo_time: now.time, photo_type: photoType,
    drive_file_id: file.fileId, drive_url: file.webViewLink, ai_status: '待辨識',
    created_at: now.iso, updated_at: now.iso,
  });
  return { photo, buffer, mimeType, tz };
}

async function processBodyPhoto(ctx, messageId) {
  const { userId, now, tz, respond } = ctx;
  const { photo, buffer, mimeType } = await savePhoto(ctx, messageId, '體脂');
  let result;
  try {
    result = await analyzeBodyPhoto(buffer, mimeType);
  } catch (e) {
    await getStore().update('Body_Photo', photo.photo_id, { ai_status: '失敗', updated_at: now.iso });
    await logSystem('error', 'body-ai', '體脂辨識失敗', e.message);
    return respond('照片已保存，但 AI 辨識暫時失敗。可稍後重新上傳，或於 Dashboard 手動輸入數值。');
  }
  await getStore().update('Body_Photo', photo.photo_id, { ai_status: result.isBody ? '待確認' : '失敗', ai_raw_json: JSON.stringify(result.raw), updated_at: now.iso });
  if (!result.isBody || result.readability === 'unreadable') {
    return respond('這張照片看起來無法辨識體脂計數值 🙏 請在光線充足處、正面拍攝螢幕或報告後重新上傳。');
  }
  const payload = { photoId: photo.photo_id, date: now.date, time: now.time, values: result.values, readability: result.readability };
  const p = await createPending(userId, 'body', payload, { tz });
  const text = [
    '📷 Gemini 辨識結果｜等待確認',
    formatBody(result.values),
    ...(result.warnings.length ? ['', ...result.warnings.map((w) => `⚠️ ${w}`)] : []),
    '',
    '未清楚辨識的欄位顯示「未辨識」，不會自動補值。',
    '如需修改：「修改 體脂率 28.4」「修改 骨骼肌 25.1」',
  ].join('\n');
  return respond(textWithQuickReply(text, confirmButtons(p.pending_id)));
}

async function processMealPhoto(ctx, messageId) {
  const { userId, now, tz, respond } = ctx;
  const { photo, buffer, mimeType } = await savePhoto(ctx, messageId, '飲食');
  let r;
  try {
    r = await analyzeMeal({ image: { buffer, mimeType } });
  } catch (e) {
    await getStore().update('Body_Photo', photo.photo_id, { ai_status: '失敗', updated_at: now.iso });
    await logSystem('error', 'meal-ai', '餐點照片辨識失敗', e.message);
    return respond('照片已保存，但 AI 辨識暫時失敗。可直接用文字描述，例如「午餐：雞胸肉、白飯半碗」。');
  }
  await getStore().update('Body_Photo', photo.photo_id, { ai_status: r.isFood ? '待確認' : '失敗', ai_raw_json: JSON.stringify(r), updated_at: now.iso });
  if (!r.isFood || !r.items.length) return respond('這張照片沒有辨識到食物，請重新拍攝或改用文字描述。');
  const payload = { date: now.date, time: now.time, mealType: guessMealType(now.time), items: r.items, photoId: photo.photo_id, photoUrl: photo.drive_url || '' };
  const p = await createPending(userId, 'meal', payload, { tz });
  return respond(textWithQuickReply(`${formatMeal(payload)}\n（照片估算份量誤差較大，建議補充份量）`, [
    ...confirmButtons(p.pending_id).slice(0, 1),
    ...['早餐', '午餐', '晚餐', '點心'].filter((t) => t !== payload.mealType).map((t) => ({ label: `改為${t}`, data: `action=mealtype&pid=${p.pending_id}&v=${t}` })),
    ...confirmButtons(p.pending_id).slice(1),
  ]));
}

// ---------------------------------------------------------------------------
// 待確認動作：修改／執行
// ---------------------------------------------------------------------------

const EXERCISE_ALIASES = { 分鐘: 'minutes', 時間: 'minutes', 時長: 'minutes', 距離: 'distanceKm', 公里: 'distanceKm', 消耗: 'calories', 熱量: 'calories' };
const MEAL_ALIASES = { 熱量: 'calorie_kcal', 卡路里: 'calorie_kcal', 蛋白質: 'protein_g', 脂肪: 'fat_g', 碳水: 'carb_g', 碳水化合物: 'carb_g' };

async function modifyPending(ctx, cmd) {
  const { userId, respond } = ctx;
  const p = await latestPending(userId, ['body', 'meal', 'exercise', 'injection', 'weight']);
  if (!p) return respond('目前沒有待確認的資料可以修改。');
  const payload = { ...p.payload };
  const f = cmd.field.trim();
  let applied = false;

  if (p.action_type === 'body') {
    const key = BODY_ALIASES[f] || BODY_ALIASES[f.toLowerCase()];
    if (key) {
      const def = BODY_FIELDS[key];
      if (cmd.value < def.min || cmd.value > def.max) return respond(`${def.label} ${cmd.value} 超出合理範圍（${def.min}–${def.max}），請確認。`);
      payload.values = { ...payload.values, [key]: cmd.value };
      payload.modified = true;
      applied = true;
    }
  } else if (p.action_type === 'exercise') {
    const key = EXERCISE_ALIASES[f];
    if (key) {
      payload[key] = cmd.value;
      if (key === 'calories') payload.caloriesSource = '使用者輸入';
      applied = true;
    }
  } else if (p.action_type === 'meal') {
    const key = MEAL_ALIASES[f];
    if (key && payload.items.length === 1) {
      payload.items = [{ ...payload.items[0], [key]: cmd.value, source: '使用者輸入' }];
      applied = true;
    } else if (key) {
      return respond('這餐有多項食物，請先確認儲存，再到 Dashboard 逐項修正營養數值。');
    }
  } else if (p.action_type === 'injection') {
    if (/劑量|mg/.test(f)) { payload.dosage = cmd.value; applied = true; }
  } else if (p.action_type === 'weight' && /體重/.test(f)) {
    payload.weight = cmd.value;
    applied = true;
  }

  if (!applied) return respond(`找不到可修改的欄位「${f}」。`);
  await updatePendingPayload(p.pending_id, payload);
  if (p.action_type === 'weight') {
    return continueWeight(ctx, { ...payload, jumpConfirmed: false }, p.pending_id);
  }
  const text = p.action_type === 'body' ? `已修改，請再次確認：\n${formatBody(payload.values)}`
    : p.action_type === 'exercise' ? formatExercise(payload)
      : p.action_type === 'meal' ? formatMeal(payload)
        : `已修改劑量為 ${payload.dosage} mg，請確認。`;
  return respond(textWithQuickReply(text, confirmButtons(p.pending_id)));
}

async function executePending(ctx, p) {
  const { userId, tz, respond } = ctx;
  const d = p.payload;
  switch (p.action_type) {
    case 'weight': {
      if (d.stage === 'jump') return continueWeight(ctx, { ...d, jumpConfirmed: true }, p.pending_id);
      if (d.stage === 'duplicate') return respond('請選擇「覆蓋原紀錄」或「新增一筆」。');
      if (d.stage === 'period') return respond('請先選擇上午或下午。');
      return continueWeight(ctx, d, p.pending_id);
    }
    case 'body': {
      const row = await createBodyComposition({
        userId, date: d.date, time: d.time, values: d.values, photoId: d.photoId,
        aiConfidence: `${d.readability}${d.modified ? '／使用者修正' : ''}`, tz,
      });
      await getStore().update('Body_Photo', d.photoId, { ai_status: '已確認', related_record_id: row.body_id });
      await resolvePending(p.pending_id, '已處理', tz);
      await markTaskCompleted(userId, 'body_composition', d.date, tz);
      return respond(`✅ 已儲存 ${displayDate(d.date)} 身體組成資料及原始照片連結。`);
    }
    case 'injection': {
      await createInjection({ userId, date: d.date, time: d.time, medication: d.medication, dosageMg: d.dosage, status: d.status, tz });
      await resolvePending(p.pending_id, '已處理', tz);
      await markTaskCompleted(userId, 'injection', d.date, tz);
      return respond(d.status === '已施打'
        ? `✅ 已寫入施打紀錄：${displayDate(d.date)} ${d.time}，${d.medication || '未指定藥物'} ${d.dosage} mg。`
        : `✅ 已記錄：${displayDate(d.date)} ${d.status}。`);
    }
    case 'exercise': {
      await createExercise({
        userId, date: d.date, time: d.time, type: d.type, minutes: d.minutes, distanceKm: d.distanceKm,
        intensity: d.intensity, calories: d.calories, caloriesSource: d.caloriesSource, tz,
      });
      await resolvePending(p.pending_id, '已處理', tz);
      await markTaskCompleted(userId, 'exercise', d.date, tz);
      const week = summarizeExercise(await listExercise(userId, { from: addDays(d.date, -6), to: d.date }));
      return respond(`✅ 已儲存運動紀錄：${d.type} ${d.minutes} 分鐘。\n近 7 天累計：${week.total_min ?? 0} 分鐘（${week.days} 天）`);
    }
    case 'meal': {
      await createMeal({ userId, date: d.date, time: d.time, mealType: d.mealType, items: d.items, photoId: d.photoId, photoUrl: d.photoUrl, tz });
      if (d.photoId) await getStore().update('Body_Photo', d.photoId, { ai_status: '已確認' });
      await resolvePending(p.pending_id, '已處理', tz);
      await markTaskCompleted(userId, 'meal', d.date, tz);
      return replyNutritionToday(ctx, `✅ 已儲存${d.mealType}。\n`);
    }
    default:
      return respond('這個動作已無法確認，請重新輸入。');
  }
}

// ---------------------------------------------------------------------------
// Postback（快速回覆按鈕、Rich Menu）
// ---------------------------------------------------------------------------

async function handlePostback(ctx, data) {
  const { userId, tz, respond } = ctx;
  const q = new URLSearchParams(data);
  const action = q.get('action');
  const menu = q.get('menu');
  if (menu) return handleMenu(ctx, menu);

  const pid = q.get('pid');
  const p = pid ? await getPending(pid) : null;
  if (pid && !isUsable(p)) return respond('這筆確認已過期或已處理，請重新輸入。');

  switch (action) {
    case 'confirm': return executePending(ctx, p);
    case 'cancel':
      await resolvePending(pid, '已取消', tz);
      return respond('已取消，資料未儲存。');
    case 'weight': {
      const set = q.get('set');
      const d = { ...p.payload };
      if (set === 'AM' || set === 'PM') d.period = set;
      if (set === 'jump_ok') d.jumpConfirmed = true;
      if (set === 'overwrite' || set === 'append') d.dupChoice = set;
      return continueWeight(ctx, d, pid);
    }
    case 'img': {
      await resolvePending(pid, '已處理', tz);
      return q.get('kind') === 'body' ? processBodyPhoto(ctx, p.payload.messageId) : processMealPhoto(ctx, p.payload.messageId);
    }
    case 'mealtype': {
      const d = { ...p.payload, mealType: q.get('v') };
      await updatePendingPayload(pid, d);
      return respond(textWithQuickReply(formatMeal(d), confirmButtons(pid)));
    }
    case 'report': return replyReport(ctx, q.get('type') || 'Daily');
    default: return respond('未知的操作。');
  }
}

async function handleMenu(ctx, menu) {
  const { userId, tz, respond } = ctx;
  switch (menu) {
    case 'weight':
      return respond(textWithQuickReply('⚖️ 請輸入體重（kg），例如 59.8。\n系統會依時間判斷上午／下午，也可輸入「上午 59.8」「下午 59.5」；補登：「補登 11/08 上午 59.8」。', [
        { label: '最近7天', text: '最近7天' }, { label: '今日報告', text: '今日報告' },
      ]));
    case 'body':
      await createPending(userId, 'context_body', {}, { tz, minutes: 30 });
      return respond(textWithQuickReply('📷 請上傳體脂計測量照片（螢幕或報告完整入鏡、避免反光）。', [
        { label: '開啟相機', camera: true }, { label: '從相簿選擇', cameraRoll: true },
      ]));
    case 'injection':
      return respond(textWithQuickReply('💉 請依醫囑記錄實際施打：\n「施打 2.5mg」或「施打 藥名 2.5mg」；補登：「11/10 施打 2.5mg 20:30」。\n系統只做紀錄，不提供劑量建議。', [
        { label: '未施打', text: '未施打' }, { label: '延後施打', text: '延後施打' },
      ]));
    case 'meal':
      await createPending(userId, 'context_meal', {}, { tz, minutes: 30 });
      return respond(textWithQuickReply('🥗 今天吃了什麼呢？可以輸入文字（例如「午餐：水煮蛋2顆、蛋白飲一瓶」）或上傳餐點照片。', [
        { label: '拍餐點', camera: true }, { label: '從相簿選擇', cameraRoll: true }, { label: '今日營養', text: '今日營養' },
      ]));
    case 'exercise':
      return respond(textWithQuickReply('🚴 請輸入運動，例如「騎車 60 分鐘 15 公里」「快走 30 分鐘」「重訓 45 分鐘 高強度」。', [
        { label: '騎車 30 分鐘', text: '騎車 30 分鐘' }, { label: '快走 30 分鐘', text: '快走 30 分鐘' },
      ]));
    case 'report':
      return respond(textWithQuickReply('📈 要查看哪一份報告？', [
        { label: '今日報告', text: '今日報告' }, { label: '本週報告', text: '本週報告' }, { label: '本月報告', text: '本月報告' },
        { label: '我的目標', text: '我的目標' }, { label: '最近30天', text: '最近30天' },
      ]));
    case 'todo': return replyTodo(ctx);
    case 'help': return respond(HELP);
    default: return respond(HELP);
  }
}

// ---------------------------------------------------------------------------
// 查詢
// ---------------------------------------------------------------------------

async function replyReport(ctx, type) {
  const { userId, now, settings, respond } = ctx;
  const range = reportRange(type, now.date);
  // 已產生（排程送出過）的報告直接回傳；尚未產生則即時計算，但不寫入 Report_Log，避免影響排程推播
  let report = await findReport(userId, type, range);
  if (!report) report = await generateTransient(userId, type, now.date, settings);
  const extra = config.baseUrl ? [{ label: '開啟 Dashboard', uri: `${config.baseUrl}/` }] : [];
  return respond(extra.length ? textWithQuickReply(formatReportText(report), extra) : formatReportText(report));
}

async function generateTransient(userId, type, date, settings) {
  return generateReport(userId, type, date, { force: true, persist: false, tz: settings.timezone });
}

async function replyGoals(ctx) {
  const { userId, now, respond } = ctx;
  const goals = await goalsWithProgress(userId, now.date);
  if (!goals.length) return respond('尚未設定目標。可輸入「目標 體重 55 2027/03/31」或在 Dashboard 設定。');
  const lines = ['🎯 目標進度'];
  goals.forEach((g) => {
    lines.push(`${g.goal_type}：${g.start_value ?? '—'} → 目標 ${g.target_value}${g.unit}`);
    lines.push(`　目前 ${g.current_value ?? '—'}${g.unit}${g.current_date ? `（${displayDate(g.current_date)}）` : ''}，完成 ${g.progress.pct ?? '—'}%${g.progress.remaining !== null ? `，尚差 ${g.progress.remaining}${g.unit}` : ''}${g.progress.days_left !== null ? `，剩 ${g.progress.days_left} 天` : ''}`);
  });
  return respond(lines.join('\n'));
}

async function setGoal(ctx, cmd) {
  const { userId, tz, respond } = ctx;
  const g = await createGoal({ userId, goalType: cmd.goalType, targetValue: cmd.target, targetDate: cmd.targetDate, tz });
  return respond(`🎯 已設定${cmd.goalType}目標：${g.start_value ?? '（尚無起始值）'} → ${g.target_value}${cmd.targetDate ? `，期限 ${displayDate(cmd.targetDate)}` : ''}。`);
}

async function replyTodo(ctx) {
  const { userId, now, respond } = ctx;
  const tasks = (await getStore().list('Task_Schedule', (t) => t.user_id === userId && toBool(t.enabled)))
    .filter((t) => taskOccursOn(t, now.date) && !String(t.task_type).endsWith('_report'))
    .sort((a, b) => String(a.remind_time).localeCompare(String(b.remind_time)));
  if (!tasks.length) return respond('今天沒有排定的作業 👍');
  const lines = [`📋 今日待辦｜${displayDate(now.date)}`];
  for (const t of tasks) {
    const done = await isTaskCompleted(userId, t.task_type, now.date);
    lines.push(`${done ? '✅' : '○'} ${t.remind_time} ${t.task_name}`);
  }
  return respond(lines.join('\n'));
}

async function replyHistory(ctx, days) {
  const { userId, now, respond } = ctx;
  const from = addDays(now.date, -(days - 1));
  const [w, b, ex] = await Promise.all([
    listWeights(userId, { from, to: now.date }), listBody(userId, { from, to: now.date }), listExercise(userId, { from, to: now.date }),
  ]);
  const am = w.filter((x) => x.period === 'AM');
  const lines = [`📅 最近 ${days} 天（${displayDate(from)}～${displayDate(now.date)}）`];
  if (am.length) {
    const vals = am.map((x) => x.weight_kg);
    lines.push(`⚖️ 上午體重 ${am.length} 天：${am[0].weight_kg} → ${am[am.length - 1].weight_kg} kg（${fmtSigned(round(am[am.length - 1].weight_kg - am[0].weight_kg, 2))}）`);
    lines.push(`　平均 ${round(vals.reduce((a, c) => a + c, 0) / vals.length, 1)}、最低 ${Math.min(...vals)}、最高 ${Math.max(...vals)} kg`);
  } else lines.push('⚖️ 無上午體重紀錄');
  if (b.length) {
    const f = b[0];
    const l = b[b.length - 1];
    lines.push(`🧍 體脂率 ${f.body_fat_pct ?? '—'}% → ${l.body_fat_pct ?? '—'}%（測量 ${b.length} 次）`);
  }
  const s = summarizeExercise(ex);
  lines.push(s.recorded ? `🚴 運動 ${s.total_min} 分鐘／${s.days} 天` : '🚴 無運動紀錄');
  if (config.baseUrl) lines.push('', `完整趨勢圖：${config.baseUrl}/`);
  return respond(lines.join('\n'));
}

async function replyNutritionToday(ctx, prefix = '') {
  const { userId, now, settings, respond } = ctx;
  const meals = await listMeals(userId, { from: now.date, to: now.date });
  const s = summarizeDay(meals);
  if (!s.recorded) return respond(`${prefix}今天還沒有飲食紀錄。`);
  const cal = settings.calorie_target_kcal ? ` / ${settings.calorie_target_kcal}` : '';
  const pro = settings.protein_target_g ? ` / ${settings.protein_target_g}` : '';
  return respond(`${prefix}🥗 今日營養（已記錄：${s.meal_types.join('、')}）
熱量：${s.calorie_kcal ?? '—'}${cal} kcal
蛋白質：${s.protein_g ?? '—'}${pro} g
脂肪：${s.fat_g ?? '—'} g｜碳水：${s.carb_g ?? '—'} g${s.includes_ai_estimate ? '\n※ 含 AI 估算值' : ''}${s.missing_meal_types.length ? `\n尚未記錄：${s.missing_meal_types.join('、')}` : ''}`);
}

async function pauseReminders(ctx, days) {
  const { userId, now, respond } = ctx;
  const until = addDays(now.date, days - 1);
  await updateWithAudit('Settings', userId, { pause_until: until }, { userId, changedBy: 'LINE' });
  return respond(`🔕 已暫停提醒至 ${displayDate(until)}（報告照常傳送）。輸入「恢復提醒」可提前恢復。`);
}

async function resumeReminders(ctx) {
  const { userId, respond } = ctx;
  await updateWithAudit('Settings', userId, { pause_until: '', reminder_enabled: true }, { userId, changedBy: 'LINE' });
  return respond('🔔 已恢復提醒。');
}
