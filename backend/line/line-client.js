import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config/settings.js';

const API = 'https://api.line.me/v2/bot';
const DATA_API = 'https://api-data.line.me/v2/bot';

/** 驗證 X-Line-Signature（HMAC-SHA256，使用原始 request body） */
export function verifySignature(rawBody, signature, secret = config.line.channelSecret) {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function call(url, body, { retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.line.channelAccessToken}`,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.status === 200 ? res.json().catch(() => ({})) : {};
      const text = await res.text();
      const err = new Error(`LINE API ${res.status}: ${text}`);
      err.status = res.status;
      // 4xx（除 429）不重試
      if (res.status < 500 && res.status !== 429) throw err;
      lastErr = err;
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  throw lastErr;
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [messages])
    .map((m) => (typeof m === 'string' ? { type: 'text', text: m } : m))
    .slice(0, 5);
}

export const lineClient = {
  async reply(replyToken, messages) {
    return call(`${API}/message/reply`, { replyToken, messages: normalizeMessages(messages) }, { retries: 0 });
  },
  async push(to, messages) {
    return call(`${API}/message/push`, { to, messages: normalizeMessages(messages) });
  },
  async getContent(messageId) {
    const res = await fetch(`${DATA_API}/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${config.line.channelAccessToken}` },
    });
    if (!res.ok) throw new Error(`LINE content ${res.status}: ${await res.text()}`);
    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    return { buffer: Buffer.from(await res.arrayBuffer()), mimeType };
  },
  async getProfile(userId) {
    const res = await fetch(`${API}/profile/${userId}`, {
      headers: { Authorization: `Bearer ${config.line.channelAccessToken}` },
    });
    if (!res.ok) return null;
    return res.json();
  },
};

// ---------------------------------------------------------------------------
// 訊息組件
// ---------------------------------------------------------------------------

/** 文字＋快速回覆按鈕。items: [{label, data}|{label, text}] */
export function textWithQuickReply(text, items) {
  return {
    type: 'text',
    text,
    quickReply: {
      items: items.slice(0, 13).map((it) => ({
        type: 'action',
        action: it.data
          ? { type: 'postback', label: it.label.slice(0, 20), data: it.data, displayText: it.displayText || it.label }
          : it.uri
            ? { type: 'uri', label: it.label.slice(0, 20), uri: it.uri }
            : it.camera
              ? { type: 'camera', label: it.label.slice(0, 20) }
              : it.cameraRoll
                ? { type: 'cameraRoll', label: it.label.slice(0, 20) }
                : { type: 'message', label: it.label.slice(0, 20), text: it.text || it.label },
      })),
    },
  };
}

export function confirmButtons(pendingId, { confirmLabel = '確認儲存', extra = [] } = {}) {
  return [
    { label: confirmLabel, data: `action=confirm&pid=${pendingId}` },
    ...extra,
    { label: '取消', data: `action=cancel&pid=${pendingId}` },
  ];
}
