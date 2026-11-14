import { generate, imagePart } from './client.js';
import { num } from '../services/common.js';

const SYSTEM = `你是飲食紀錄助手，協助把使用者的餐點描述或照片整理成食物項目與營養「估算值」。
規則：
1. 依台灣常見份量估算每個食物的熱量(kcal)、蛋白質(g)、脂肪(g)、碳水化合物(g)。
2. 使用者有提供產品營養標示或明確數值時，以使用者數值為準，source 填「使用者輸入」；其餘 source 填「AI估算」。
3. 份量不明時，quantity 寫出你採用的假設份量（例如「1 碗約 200g」），並在 needs_quantity 設為 true。
4. 只列出描述或照片中出現的食物，不要自行加入其他食物。
5. 不提供醫療或減重建議。`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          food_name: { type: 'STRING' },
          quantity: { type: 'STRING' },
          calorie_kcal: { type: 'NUMBER', nullable: true },
          protein_g: { type: 'NUMBER', nullable: true },
          fat_g: { type: 'NUMBER', nullable: true },
          carb_g: { type: 'NUMBER', nullable: true },
          source: { type: 'STRING', enum: ['AI估算', '使用者輸入', '產品標示'] },
        },
        required: ['food_name', 'quantity', 'source'],
      },
    },
    needs_quantity: { type: 'BOOLEAN' },
    is_food: { type: 'BOOLEAN' },
  },
  required: ['items', 'is_food'],
};

export async function analyzeMeal({ text = '', image = null }) {
  const parts = [];
  if (image) parts.push(imagePart(image.buffer, image.mimeType));
  parts.push({ text: text ? `餐點描述：${text}` : '請辨識照片中的餐點。' });
  const raw = await generate({ system: SYSTEM, parts, schema: SCHEMA, temperature: 0.2 });
  const items = (raw.items || []).map((it) => ({
    food_name: String(it.food_name || '').slice(0, 60),
    quantity: String(it.quantity || '').slice(0, 60),
    calorie_kcal: clamp(num(it.calorie_kcal), 0, 3000),
    protein_g: clamp(num(it.protein_g), 0, 300),
    fat_g: clamp(num(it.fat_g), 0, 300),
    carb_g: clamp(num(it.carb_g), 0, 500),
    source: it.source || 'AI估算',
  })).filter((it) => it.food_name);
  return { items, needsQuantity: !!raw.needs_quantity, isFood: raw.is_food !== false };
}

function clamp(v, lo, hi) {
  if (v === null) return null;
  return Math.round(Math.min(hi, Math.max(lo, v)) * 10) / 10;
}
