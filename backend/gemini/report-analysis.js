import { generate, imagePart } from './client.js';

const SYSTEM = `你是個人健康紀錄的報告撰寫助手，使用繁體中文。
嚴格規則：
1. 只能使用提供的 JSON 資料；資料缺漏時明確說「無資料」或「未測量」，不可推測或補數字。
2. 所有差異、平均、總和都已由程式計算好，請直接引用，不可自行重新計算或修改數值。
3. 區分「測量值」、「使用者輸入值」與「AI估算值」（熱量、運動消耗多為估算）。
4. 單日體重變化多受水分、飲食與排便影響，不可解讀為脂肪增減；趨勢需看多日資料。
5. 體脂率變化單位是「百分點」。
6. 不可建議調整處方藥物、劑量或施打頻率；不做診斷。如有異常只建議與醫師討論。
7. 語氣中性、鼓勵，條列 3–5 點，每點不超過 40 字，總長 250 字內，不要使用 Markdown 標題。`;

const TITLES = { Daily: '每日', Weekly: '每週', Monthly: '每月' };

export async function summarizeReport(reportType, comparison) {
  const text = await generate({
    system: SYSTEM,
    parts: [{ text: `請根據以下${TITLES[reportType] || ''}比較資料撰寫觀察摘要：\n${JSON.stringify(comparison)}` }],
    temperature: 0.3,
    maxOutputTokens: 800,
  });
  return text.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim();
}

const BODY_SYSTEM = `你是個人身體組成報告的解讀助手，使用繁體中文。
資料來源：
A. JSON：程式已計算好的測量值與差異（本次 vs 上一次、vs 區間第一次、趨勢、去脂體重、目標）。
B. 圖片（可能沒有）：本次與上一次測量的原始報告截圖；長截圖會被切成多段，由上到下連續。每組圖片前會先標示是「本次」或「上一次」。
嚴格規則：
1. 體重、體脂率、體脂肪、骨骼肌、內臟脂肪、基礎代謝、BMI 及其差異，一律引用 JSON，不可自行計算或改數字。
2. JSON 沒有、但圖片上有的指標（如水分、蛋白質、肌肉率、皮下脂肪、身體年齡、各部位肌肉或脂肪、體型評估），可以比較本次與上一次，但必須標示「（報告上顯示）」；看不清楚或只有一次有的就不要比較。
3. 資料缺漏時說「無資料」或「未測量」，不可推測。沒有上一次測量時，說明無法比較，只描述本次。
4. 體脂率變化單位是「百分點」。兩次間隔 7 天內的變化可能受水分與量測條件影響，要提醒。
5. 不做診斷，不建議藥物、劑量或施打頻率；如有明顯異常，建議與醫師或專業人員討論。
6. 格式（不要用 Markdown 標題或粗體）：
   【整體】1–2 句總結。
   【與上一次比較】2–4 點，重點放在體脂與肌肉的變化方向。
   【報告其他指標】1–3 點（有圖片才寫，沒有就省略整段）。
   【建議】2–3 點一般性生活習慣建議（飲食、蛋白質、阻力訓練、睡眠等）。
   總長 450 字內。`;

/**
 * 身體組成分析：JSON（程式計算）＋ 本次與上一次的原始照片（選用）
 * photos：{ latest: [{buffer,mimeType}], previous: [...] }
 */
export async function summarizeBodyReport(comparison, photos = {}) {
  const parts = [];
  if (photos.latest?.length) {
    parts.push({ text: `【本次】${comparison.latest?.date || ''} 的原始報告（${photos.latest.length} 段）：` });
    photos.latest.forEach((im) => parts.push(imagePart(im.buffer, im.mimeType)));
  }
  if (photos.previous?.length) {
    parts.push({ text: `【上一次】${comparison.previous?.date || ''} 的原始報告（${photos.previous.length} 段）：` });
    photos.previous.forEach((im) => parts.push(imagePart(im.buffer, im.mimeType)));
  }
  parts.push({ text: `${parts.length ? '' : '（沒有原始照片）\n'}程式計算的身體組成資料：\n${JSON.stringify(comparison)}` });
  const text = await generate({ system: BODY_SYSTEM, parts, temperature: 0.3, maxOutputTokens: 2048 });
  return text.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim();
}

const QA_SYSTEM = `你是健康紀錄小助理，使用繁體中文簡短回答（150 字內）。
只提供一般性健康資訊，不做診斷、不建議調整任何處方藥物或劑量。
使用者的紀錄資料（若有）只能引用，不可推測未提供的數值。
遇到可能的緊急或嚴重症狀，請建議儘速就醫。`;

export async function answerQuestion(question, context) {
  return generate({
    system: QA_SYSTEM,
    parts: [{ text: `使用者近期已確認紀錄：${JSON.stringify(context)}\n\n問題：${question}` }],
    temperature: 0.4,
    maxOutputTokens: 600,
  });
}
