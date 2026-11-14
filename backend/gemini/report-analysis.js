import { generate } from './client.js';

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
