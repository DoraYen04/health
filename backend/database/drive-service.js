import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { getGoogleAuth } from './google-auth.js';
import { config } from '../../config/settings.js';

let drive;
function api() {
  if (!drive) drive = google.drive({ version: 'v3', auth: getGoogleAuth() });
  return drive;
}

/**
 * 上傳照片到 Drive 指定資料夾。檔案維持私人（不建立公開分享連結），
 * Dashboard 透過後端 /api/photos/:id 代理讀取。
 */
export async function uploadPhoto({ buffer, mimeType = 'image/jpeg', name }) {
  if (config.storage === 'memory') {
    return { fileId: `mem-${Date.now()}`, webViewLink: '' };
  }
  const res = await api().files.create({
    requestBody: {
      name,
      parents: config.google.driveFolderId ? [config.google.driveFolderId] : undefined,
      mimeType,
    },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  return { fileId: res.data.id, webViewLink: res.data.webViewLink || '' };
}

export async function downloadPhoto(fileId) {
  const meta = await api().files.get({ fileId, fields: 'mimeType', supportsAllDrives: true });
  const res = await api().files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return { buffer: Buffer.from(res.data), mimeType: meta.data.mimeType || 'image/jpeg' };
}
