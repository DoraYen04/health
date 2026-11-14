import { config } from '../../config/settings.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * 呼叫 Gemini generateContent（REST）。
 * parts: [{ text }] 或 [{ inline_data: { mime_type, data(base64) } }]
 * schema: 有值時要求回傳 JSON 並套用 responseSchema
 */
export async function generate({ system, parts, schema, temperature = 0.2, maxOutputTokens = 2048 }) {
  if (!config.gemini.apiKey) throw new Error('未設定 GEMINI_API_KEY');
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, maxOutputTokens },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (schema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = schema;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.gemini.timeoutMs);
  try {
    const res = await fetch(`${BASE}/${config.gemini.model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) throw new Error(`Gemini 無回應內容（${data.candidates?.[0]?.finishReason || 'unknown'}）`);
    if (!schema) return text;
    return JSON.parse(stripFence(text));
  } finally {
    clearTimeout(timer);
  }
}

function stripFence(t) {
  return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
}

export function imagePart(buffer, mimeType = 'image/jpeg') {
  return { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } };
}
