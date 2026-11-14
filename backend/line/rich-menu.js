// Rich Menu 定義：2500 x 1686，4 欄 x 2 列，共 8 格。
// 圖片由 scripts/make-rich-menu-image.py 產生（assets/rich-menu.png），
// 執行 npm run setup:richmenu 上傳並設為預設選單。

import { dashboardUrl } from '../../config/settings.js';

const W = 2500;
const H = 1686;
const COLS = 4;
const ROWS = 2;

export const RICH_MENU_TILES = [
  { label: '體重記錄', sub: '上午／下午', data: 'menu=weight' },
  { label: '體脂測量', sub: '照片上傳', data: 'menu=body' },
  { label: '施打記錄', sub: '實際劑量', data: 'menu=injection' },
  { label: '飲食記錄', sub: '文字／照片', data: 'menu=meal' },
  { label: '運動記錄', sub: '時間／距離', data: 'menu=exercise' },
  { label: '健康報告', sub: '日／週／月', data: 'menu=report' },
  { label: '今日待辦', sub: '完成狀態', data: 'menu=todo' },
  { label: '設定管理', sub: 'Dashboard', uri: true },
];

export function buildRichMenu(baseUrl) {
  const cw = Math.floor(W / COLS);
  const ch = Math.floor(H / ROWS);
  return {
    size: { width: W, height: H },
    selected: true,
    name: 'health-main-menu',
    chatBarText: '健康管理選單',
    areas: RICH_MENU_TILES.map((t, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const bounds = {
        x: col * cw, y: row * ch,
        width: col === COLS - 1 ? W - col * cw : cw,
        height: row === ROWS - 1 ? H - row * ch : ch,
      };
      const action = t.uri
        ? { type: 'uri', label: t.label, uri: baseUrl ? dashboardUrl('#settings', baseUrl) : 'https://line.me' }
        : { type: 'postback', label: t.label, data: t.data, displayText: t.label };
      return { bounds, action };
    }),
  };
}
