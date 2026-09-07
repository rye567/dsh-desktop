#!/usr/bin/env python3
# 图标生成：设计稿 → macOS 规范图标（icon.png / icon.icns / icon.ico）
#
# 不做内容分割（旧洪水填充+侵蚀方案会在深色 Dock 上留参差黑边）：
#   1) 自动测量设计稿中圆角卡片的边界与圆角半径（本稿面板 ~247 比背景
#      ~254 暗，以 ≤251 判定面板；底缘被图案投影压暗不可扫描，
#      靠"卡片是正方形"由顶/左/右三边推算）；
#   2) 以 Apple macOS 图标网格重建画布：1024 画布、卡片 824、圆角半径
#      185、四边留白 100；蒙版内缩保证边缘落在纯面板像素上；
#   3) 蒙版外用饱和度渐变保留可能溢出卡片的图案（此稿无溢出，逻辑待命）；
#   4) 烘焙轻微投影（macOS 图标资产惯例），输出全尺寸 iconset/icns/ico。
from PIL import Image, ImageDraw, ImageFilter
import numpy as np
import subprocess
import os
import shutil

SRC = 'icon-source.png'
CANVAS = 1024
CARD = 824          # Apple 网格：1024 画布中卡片 824，四边留白 100
APPLE_R = 185       # Apple 规范圆角半径（对应 824 卡片）
INSET = 3           # 蒙版相对卡片边缘内缩，确保切在纯面板上
THR = 251           # 面板(≤248) 与背景(≥253) 的分界

def run(m, n=4):
    return next((i for i in range(len(m) - n) if m[i:i + n].all()), None)

# ---- 1. 测量设计稿中的卡片 ----
# 本稿面板(~247，偏蓝)比背景(~254)暗且带蓝调：亮度≤251 或 蓝度(b-r)≥3 判面板。
# 直边用"面板行/列占比 >0.6 突变"定位——对图案溢出、右侧尺寸阶梯图标都稳健。
src = Image.open(SRC).convert('RGB')
a = np.asarray(src).astype(int)
h, w, _ = a.shape
face = (a.mean(axis=2) <= THR) | ((a[:, :, 2] - a[:, :, 0]) >= 3)

rowfrac = face[:, 300:700].mean(axis=1)
t = next(y for y in range(20, 600) if rowfrac[y] > 0.6 and rowfrac[y + 4] > 0.6)
colfrac = face[340:820, :].mean(axis=0)
l = next(x for x in range(10, 300) if colfrac[x] > 0.6 and colfrac[x + 4] > 0.6)
r = next(x for x in range(894, 500, -1) if colfrac[x] > 0.6 and colfrac[x - 4] > 0.6)
size = r - l
b = t + size                              # 卡片必为正方形
assert b < 990, f'推算底边 {b:.0f} 越界，先验失效'
print(f'卡片: ({l},{t})-({r},{b}) 尺寸 {size}')

# 圆角半径：左上角每行首个面板像素偏移，对圆方程最小二乘
dy = np.arange(15, size // 2)
offs = np.array([np.nan if (i := run(face[t + d, max(0, l - 20):l + 450])) is None
                 else i + max(0, l - 20) - l for d in dy])
ok = ~np.isnan(offs)
d, o = dy[ok], offs[ok]
cand = np.arange(60, 400)
err = [np.nansum((o - (rr - np.sqrt(np.clip(rr**2 - (rr - d)**2, 0, None))))**2)
       for rr in cand]
art_r = int(cand[int(np.argmin(err))])
print(f'设计稿圆角半径 ≈ {art_r}')

# ---- 2. 重建画布 ----
sat0 = a.max(axis=2) - a.min(axis=2)
ov = sat0 > 40                            # 溢出卡片的图案（背部轻溢等）；
ov[:max(0, t - 40), :] = False            # 只看主卡片邻域：排除上方、下方
ov[b + 20:, :] = False                    # 与右侧尺寸阶梯，以及卡片内部
ov[:, :max(0, l - 60)] = False
ov[:, r + 40:] = False
ov[:, l - 40:r + 40] = False
oys, oxs = np.where(ov)
box = [max(0, min(l - 45, (oxs.min() - 10) if len(oxs) else 10**9)),
       max(0, min(t - 45, (oys.min() - 10) if len(oys) else 10**9)),
       min(w, max(r + 45, (oxs.max() + 10) if len(oxs) else 0)),
       min(h, max(b + 45, (oys.max() + 10) if len(oys) else 0))]
print(f'裁剪窗口: {box}（{len(oxs)} 个溢出像素）')
crop = src.crop(tuple(box))
s = CARD / size
crop = crop.resize((round(crop.width * s), round(crop.height * s)), Image.LANCZOS)
px, py = round(100 - (l - box[0]) * s), round(100 - (t - box[1]) * s)

canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
canvas.paste(crop, (px, py))
rgb = np.asarray(canvas)[..., :3].astype(float)

# 圆角蒙版（4x 超采样抗锯齿）；内缩 + 半径不大于设计稿，保证蒙版 ⊆ 卡片
ss = 4
mss = Image.new('L', (CANVAS * ss, CANVAS * ss), 0)
ImageDraw.Draw(mss).rounded_rectangle(
    [(100 + INSET) * ss] * 2 + [(100 + CARD - INSET) * ss] * 2,
    radius=round(min(APPLE_R, art_r * s) - INSET) * ss, fill=255)
mask_a = np.asarray(mss.resize((CANVAS, CANVAS), Image.LANCZOS)).astype(float) / 255

# 蒙版外：饱和度渐变保留溢出图案
sat = rgb.max(axis=2) - rgb.min(axis=2)
whale = np.clip((sat - 30) / (80 - 30), 0, 1)
alpha = np.maximum(mask_a, np.where(mask_a > 0.99, 0, whale))

# 烘焙投影：卡片形状下移 12px + 高斯模糊，黑色 ~22%，标准 over 合成
shadow = Image.new('L', (CANVAS * ss, CANVAS * ss), 0)
ImageDraw.Draw(shadow).rounded_rectangle(
    [100 * ss, (100 + 12) * ss, (100 + CARD) * ss, (100 + CARD + 12) * ss],
    radius=APPLE_R * ss, fill=140)
shadow = shadow.resize((CANVAS, CANVAS), Image.LANCZOS).filter(
    ImageFilter.GaussianBlur(22))
sh = np.asarray(shadow).astype(float) / 255 * (1 - alpha)
a_out = alpha + sh * (1 - alpha)
rgb_out = (rgb * alpha[..., None]) / np.clip(a_out, 1e-6, 1)[..., None]
out = np.dstack([np.clip(rgb_out, 0, 255), a_out * 255]).astype(np.uint8)
Image.fromarray(out, 'RGBA').save('icon.png')
print('icon.png 完成')

# ---- 3. iconset → icns ----
os.makedirs('icon.iconset', exist_ok=True)
master = Image.open('icon.png')
for sz in [16, 32, 128, 256, 512]:
    master.resize((sz, sz), Image.LANCZOS).save(f'icon.iconset/icon_{sz}x{sz}.png')
    master.resize((sz * 2, sz * 2), Image.LANCZOS).save(f'icon.iconset/icon_{sz}x{sz}@2x.png')
subprocess.run(['iconutil', '-c', 'icns', '-o', 'icon.icns', 'icon.iconset'], check=True)
shutil.rmtree('icon.iconset')            # 中间产物用后即清
print('icon.icns 完成')

# ---- 4. Windows ico ----
master.save('icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                               (64, 64), (128, 128), (256, 256)])
print('icon.ico 完成')
