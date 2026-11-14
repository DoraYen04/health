import { getStore } from '../database/sheets-service.js';
import { STATUS } from '../database/schema.js';
import { isoNow } from '../utils/time.js';
import { isActive, num, round } from './common.js';

export const MEAL_TYPES = ['早餐', '午餐', '晚餐', '點心'];
const NUTRIENTS = [
  ['calorie_kcal', '熱量', 'kcal'],
  ['protein_g', '蛋白質', 'g'],
  ['fat_g', '脂肪', 'g'],
  ['carb_g', '碳水化合物', 'g'],
];

/** 依時間推測餐別（使用者未指定時） */
export function guessMealType(time) {
  const h = Number(String(time).slice(0, 2));
  if (h >= 4 && h < 10) return '早餐';
  if (h >= 10 && h < 15) return '午餐';
  if (h >= 17 && h < 21) return '晚餐';
  return '點心';
}

/**
 * 建立一餐（多個食物項目）。每個項目一列 Meal_Log，營養明細拆到 Nutrition_Log 並標示來源。
 * items: [{ food_name, quantity, calorie_kcal, protein_g, fat_g, carb_g, source }]
 */
export async function createMeal({ userId, date, time, mealType, items, photoId = '', photoUrl = '', tz }) {
  const store = getStore();
  const now = isoNow(tz);
  const mealRows = await store.append('Meal_Log', items.map((it) => ({
    user_id: userId,
    meal_date: date,
    meal_time: time,
    meal_type: mealType,
    food_name: it.food_name,
    quantity: it.quantity || '',
    photo_id: photoId,
    photo_url: photoUrl,
    calorie_kcal: num(it.calorie_kcal),
    protein_g: num(it.protein_g),
    fat_g: num(it.fat_g),
    carb_g: num(it.carb_g),
    nutrition_source: it.source || 'AI估算',
    verified: true,
    status: STATUS.NORMAL,
    created_at: now,
    updated_at: now,
  })));
  const nutrition = [];
  mealRows.forEach((m) => {
    for (const [field, label, unit] of NUTRIENTS) {
      if (m[field] === null) continue;
      nutrition.push({
        meal_id: m.meal_id, user_id: userId, nutrient_type: label, value: m[field], unit,
        source: m.nutrition_source, verified: true, created_at: now,
      });
    }
  });
  if (nutrition.length) await store.append('Nutrition_Log', nutrition);
  return mealRows;
}

export async function listMeals(userId, { from, to } = {}) {
  const rows = await getStore().list('Meal_Log', (r) => r.user_id === userId && isActive(r)
    && (!from || r.meal_date >= from) && (!to || r.meal_date <= to));
  return rows.map((r) => ({
    ...r,
    calorie_kcal: num(r.calorie_kcal), protein_g: num(r.protein_g), fat_g: num(r.fat_g), carb_g: num(r.carb_g),
  })).sort((a, b) => (a.meal_date + a.meal_time).localeCompare(b.meal_date + b.meal_time));
}

/** 當日營養加總；未記錄的餐次不視為 0，回傳已記錄餐別 */
export function summarizeDay(meals) {
  const types = [...new Set(meals.map((m) => m.meal_type))];
  const sum = (k) => {
    const vals = meals.map((m) => m[k]).filter((v) => v !== null && v !== undefined);
    return vals.length ? round(vals.reduce((a, b) => a + b, 0), 1) : null;
  };
  const estimated = meals.some((m) => m.nutrition_source === 'AI估算');
  return {
    recorded: meals.length > 0,
    meal_types: MEAL_TYPES.filter((t) => types.includes(t)),
    missing_meal_types: MEAL_TYPES.slice(0, 3).filter((t) => !types.includes(t)),
    items: meals.length,
    calorie_kcal: sum('calorie_kcal'),
    protein_g: sum('protein_g'),
    fat_g: sum('fat_g'),
    carb_g: sum('carb_g'),
    includes_ai_estimate: estimated,
  };
}

export function formatItems(items) {
  return items.map((it) => {
    const parts = [];
    if (it.calorie_kcal !== null && it.calorie_kcal !== undefined) parts.push(`${it.calorie_kcal} kcal`);
    if (it.protein_g !== null && it.protein_g !== undefined) parts.push(`蛋白質 ${it.protein_g} g`);
    return `・${it.food_name}${it.quantity ? `（${it.quantity}）` : ''}${parts.length ? `：${parts.join('、')}` : ''}`;
  }).join('\n');
}
