// 本機示範資料（STORAGE=memory 時使用）：npm run dev 搭配 SEED_DEMO=1
import { getStore } from '../backend/database/sheets-service.js';
import { ensureUser } from '../backend/services/common.js';
import { nowIn, addDays, weekdayZh, dayOfWeek } from '../backend/utils/time.js';

export async function seedDemo(userId = 'U_demo') {
  const store = getStore();
  await ensureUser(userId, '示範使用者');
  await store.update('Settings', userId, { calorie_target_kcal: 1600, protein_target_g: 100, height_cm: 160 });
  const today = nowIn('Asia/Taipei').date;
  const weights = [];
  const bodies = [];
  const meals = [];
  const ex = [];
  let w = 62.4;
  for (let i = 40; i >= 0; i -= 1) {
    const d = addDays(today, -i);
    w -= 0.06 + (Math.sin(i) * 0.15);
    const am = Math.round(w * 10) / 10;
    if (i % 9 !== 4) weights.push({ user_id: userId, measure_date: d, weekday: weekdayZh(d), measure_time: '08:0' + (i % 9), period: 'AM', weight_kg: am, source: 'LINE', status: '正常', created_at: `${d}T08:00:00+08:00` });
    if (i > 0 && i % 7 !== 3) weights.push({ user_id: userId, measure_date: d, weekday: weekdayZh(d), measure_time: '14:1' + (i % 9), period: 'PM', weight_kg: Math.round((am + 0.4) * 10) / 10, source: 'LINE', status: '正常', created_at: `${d}T14:10:00+08:00` });
    if (dayOfWeek(d) === 0) {
      bodies.push({ user_id: userId, measure_date: d, measure_time: '09:05', weight_kg: am, body_fat_pct: Math.round((30 - (40 - i) * 0.04) * 10) / 10, skeletal_muscle_kg: Math.round((24.8 + (40 - i) * 0.01) * 10) / 10, verified: true, source: 'LINE照片', status: '正常' });
    }
    if (i < 20) {
      meals.push({ user_id: userId, meal_date: d, meal_time: '07:30', meal_type: '早餐', food_name: '水煮蛋', quantity: '2 顆', calorie_kcal: 140, protein_g: 12, fat_g: 10, carb_g: 1, nutrition_source: 'AI估算', verified: true, status: '正常' });
      if (i > 0) meals.push({ user_id: userId, meal_date: d, meal_time: '12:20', meal_type: '午餐', food_name: '雞胸便當', quantity: '1 個', calorie_kcal: 620 + (i % 4) * 40, protein_g: 42, fat_g: 18, carb_g: 70, nutrition_source: 'AI估算', verified: true, status: '正常' });
    }
    if (i % 2 === 0) ex.push({ user_id: userId, exercise_date: d, exercise_time: '19:00', exercise_type: i % 4 ? '騎車' : '快走', duration_min: i % 4 ? 60 : 30, distance_km: i % 4 ? 15 : 2.5, intensity: '中', calories_burned: i % 4 ? 410 : 105, calories_source: '估算', status: '正常' });
  }
  await store.append('Weight_Log', weights);
  await store.append('Body_Composition', bodies);
  await store.append('Meal_Log', meals);
  await store.append('Exercise_Log', ex);
  await store.append('Goal_Log', { user_id: userId, goal_type: '體重', start_value: 62.4, target_value: 55, start_date: addDays(today, -40), target_date: addDays(today, 140), current_value: null, status: '進行中' });
}
