"""產生 LINE Rich Menu 圖片 assets/rich-menu.png（2500x1686，4x2 格）
需要 Pillow 與 Noto Sans CJK 字型：python scripts/make-rich-menu-image.py [字型路徑]"""
import sys
from PIL import Image, ImageDraw, ImageFont

W, H, COLS, ROWS = 2500, 1686, 4, 2
FONT = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
TILES = [
    ('體重記錄', '上午／下午', '#e4f6e9', '#16803c', 'kg'),
    ('體脂測量', '照片上傳', '#eee9ff', '#6d5bd0', '%'),
    ('施打記錄', '實際劑量', '#fff0e4', '#c15b1b', 'mg'),
    ('飲食記錄', '文字／照片', '#fff6dc', '#a16207', 'kcal'),
    ('運動記錄', '時間／距離', '#e8f1ff', '#2563eb', 'min'),
    ('健康報告', '日／週／月', '#e6f6f4', '#0f766e', '↗'),
    ('今日待辦', '完成狀態', '#fdecef', '#be185d', '✓'),
    ('設定管理', 'Dashboard', '#eef1f5', '#334155', '≡'),
]

img = Image.new('RGB', (W, H), '#ffffff')
d = ImageDraw.Draw(img)
big = ImageFont.truetype(FONT, 120, index=0)
mid = ImageFont.truetype(FONT, 66, index=0)
ico = ImageFont.truetype(FONT, 150, index=0)
cw, ch = W // COLS, H // ROWS
for i, (title, sub, bg, fg, mark) in enumerate(TILES):
    x, y = (i % COLS) * cw, (i // COLS) * ch
    d.rounded_rectangle([x + 18, y + 18, x + cw - 18, y + ch - 18], radius=48, fill=bg)
    cx = x + cw // 2
    d.ellipse([cx - 120, y + 110, cx + 120, y + 350], fill='#ffffff')
    d.text((cx, y + 230), mark, font=ico if len(mark) == 1 else mid, fill=fg, anchor='mm')
    d.text((cx, y + 500), title, font=big, fill=fg, anchor='mm')
    d.text((cx, y + 640), sub, font=mid, fill='#475569', anchor='mm')
img.save('assets/rich-menu.png', optimize=True)
print('saved assets/rich-menu.png')
