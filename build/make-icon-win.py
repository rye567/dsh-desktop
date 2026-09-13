#!/usr/bin/env python3
# Windows 图标生成：新版鲸鱼设计稿（icon-win-source.png，自带透明通道，
# 黑色仅为预览底色）→ 满幅 icon.ico + 启动页用 icon-win.png。
#
# 设计稿是一张展示图：左侧为完整主鲸鱼，右侧为小尺寸阶梯预览（不进图标）。
# 处理流程：
#   1) 按 alpha>=128 统计前景列分布，取最宽的连续列段即主鲸鱼（与右侧
#      阶梯之间有纯净空隙，天然可分），再在段内求行包围盒；
#   2) 以 Windows 满幅惯例重建画布：1024 画布、主体最大边 968（占比
#      ~94.5%，四周留 ~28px 防贴边），等比缩放居中；
#   3) 输出 icon.ico（16~256 全尺寸）与 icon-win.png（loading.html 的
#      Windows 启动页图标；macOS 启动页仍用 icon.png，保持不变）。
from PIL import Image
import numpy as np

SRC = 'icon-win-source.png'
CANVAS = 1024
SUBJECT = 968       # 主体最大边，占画布 ~94.5%，沿用 make-icon.py 的 Windows 惯例
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48),
             (64, 64), (128, 128), (256, 256)]

src = Image.open(SRC).convert('RGBA')
a = np.asarray(src)
fg = a[..., 3] >= 128

# ---- 1. 列分段定位主鲸鱼 ----
colfrac = fg.mean(axis=0)
segs, s = [], None
for x in range(len(colfrac)):
    if colfrac[x] >= 0.01 and s is None:
        s = x
    if colfrac[x] < 0.01 and s is not None:
        segs.append((s, x - 1))
        s = None
if s is not None:
    segs.append((s, len(colfrac) - 1))
assert segs, '未检测到前景'
l, r = max(segs, key=lambda t: t[1] - t[0])   # 最宽段 = 主鲸鱼
rows = np.where(fg[:, l:r + 1].any(axis=1))[0]
t, b = int(rows.min()), int(rows.max())

pad = 8                                       # 少量余量防裁掉边缘抗锯齿
box = (max(0, l - pad), max(0, t - pad),
       min(src.width, r + 1 + pad), min(src.height, b + 1 + pad))
print(f'主鲸鱼包围盒: 列 {l}-{r} 行 {t}-{b}，裁剪 {box}')

# ---- 2. 满幅画布居中 ----
crop = src.crop(box)
scale = SUBJECT / max(crop.size)
crop = crop.resize((round(crop.width * scale), round(crop.height * scale)),
                   Image.LANCZOS)
canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
canvas.paste(crop, ((CANVAS - crop.width) // 2, (CANVAS - crop.height) // 2),
             crop)

# ---- 3. 输出 ico 与启动页 png ----
canvas.save('icon.ico', sizes=ICO_SIZES)
print('icon.ico 完成:', [f'{w}x{h}' for w, h in ICO_SIZES])
canvas.save('icon-win.png')
print('icon-win.png 完成')
