import sharp from 'sharp';

/**
 * 長截圖（例如手機 App 的身體組成報告）若整張送給 Gemini 會被等比縮小，小字就讀不到。
 * 這裡把過長的圖切成多段（上下各重疊一點，避免數字剛好被切斷），每段寬度最多 1080px。
 * 一般比例的照片只做縮圖與轉正，不切割。
 */
export async function splitForVision(buffer, { maxWidth = 1080, segmentRatio = 1.6, overlap = 0.08, maxSegments = 16 } = {}) {
  const img = sharp(buffer, { failOn: 'none' }).rotate(); // 依 EXIF 轉正
  const meta = await img.metadata();
  let width = meta.autoOrient?.width || meta.width;
  let height = meta.autoOrient?.height || meta.height;
  if (!width || !height) throw new Error('無法讀取圖片尺寸');

  // 統一寬度（太寬才縮）
  let base = await img.resize({ width: Math.min(width, maxWidth), withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  ({ width, height } = await sharp(base).metadata());

  const segH = Math.round(width * segmentRatio);
  if (height <= segH * 1.25) return [{ buffer: base, mimeType: 'image/jpeg' }];

  // 段數太多時，把每段加高，避免超過上限
  const step0 = Math.round(segH * (1 - overlap));
  let h = segH;
  let step = step0;
  if (Math.ceil((height - h) / step) + 1 > maxSegments) {
    h = Math.ceil(height / (maxSegments * (1 - overlap) + overlap));
    step = Math.round(h * (1 - overlap));
  }
  const parts = [];
  for (let top = 0; top < height; top += step) {
    const ht = Math.min(h, height - top);
    parts.push({ buffer: await sharp(base).extract({ left: 0, top, width, height: ht }).jpeg({ quality: 88 }).toBuffer(), mimeType: 'image/jpeg' });
    if (top + ht >= height) break;
  }
  base = null;
  return parts;
}
