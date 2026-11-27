# gen-boot-assets.py — 首页 SpaceX 星舰风格主视觉资产生成
# 1) 裁剪 starship.png 的透明包围盒 → public/images/boot/starship-hero.png（去掉多余透明边距，便于 CSS 精确排版）
# 2) 程序化生成深空星空背景 → public/images/boot/starfield.jpg（细密星点 + 极淡银河雾带）
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "images" / "boot"
OUT.mkdir(parents=True, exist_ok=True)

# ---------- 1) 星舰主视觉裁剪 ----------
src = Image.open(ROOT / "public" / "images" / "rockets" / "starship.png").convert("RGBA")
bbox = src.getchannel("A").getbbox()
pad = 4
box = (max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(src.width, bbox[2] + pad), min(src.height, bbox[3] + pad))
hero = src.crop(box)
hero.save(OUT / "starship-hero.png")
print(f"starship-hero.png {hero.size} ratio={hero.width / hero.height:.3f}")

# ---------- 2) 星空背景 ----------
random.seed(20261125)
W, H = 1920, 1920
img = Image.new("RGB", (W, H), (2, 4, 10))
draw = ImageDraw.Draw(img)

# 极淡的深空底色渐变（上暗下微亮，接近 SpaceX 夜景照片的天空）
for y in range(H):
    t = y / H
    draw.line([(0, y), (W, y)], fill=(int(2 + 3 * t), int(4 + 6 * t), int(10 + 12 * t)))

# 银河雾带：一条斜向的极淡蓝雾（大半径模糊圆斑叠加，再按亮度掩膜加亮底色）
haze = Image.new("L", (W, H), 0)
hd = ImageDraw.Draw(haze)
for i in range(260):
    t = i / 260
    cx = int(W * (0.15 + 0.75 * t) + random.gauss(0, 90))
    cy = int(H * (0.75 - 0.55 * t) + random.gauss(0, 110))
    rad = random.randint(60, 200)
    hd.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=random.randint(5, 11))
haze = haze.filter(ImageFilter.GaussianBlur(90))
tint = Image.new("RGB", (W, H), (10, 16, 30))
img = Image.composite(tint, img, haze.point(lambda p: min(255, p * 4)))

# 星点：三层（暗弱密集 / 中等 / 亮星带光晕）
draw = ImageDraw.Draw(img)
for _ in range(1500):
    x, y = random.random() * W, random.random() * H
    v = random.randint(28, 70)
    draw.point((x, y), fill=(v, v, min(255, v + 12)))
for _ in range(420):
    x, y = random.random() * W, random.random() * H
    v = random.randint(80, 150)
    s = random.choice([1, 1, 1, 2])
    draw.ellipse([x, y, x + s, y + s], fill=(v, v, min(255, v + 18)))

# 亮星：先画光晕（加法叠加），再画星核
glow = Image.new("RGB", (W, H), (0, 0, 0))
gd = ImageDraw.Draw(glow)
bright = []
for _ in range(46):
    x, y = random.random() * W, random.random() * H
    v = random.randint(170, 235)
    bright.append((x, y, v))
    gd.ellipse([x - 7, y - 7, x + 7, y + 7], fill=(v // 5, v // 5, v // 4))
glow = glow.filter(ImageFilter.GaussianBlur(6))
px, gp = img.load(), glow.load()
for x, y, _v in bright:  # 只在亮星周围 24×24 窗口内做加法叠加
    for yy in range(max(0, int(y) - 12), min(H, int(y) + 13)):
        for xx in range(max(0, int(x) - 12), min(W, int(x) + 13)):
            gr, gg, gb = gp[xx, yy]
            if gr or gg or gb:
                pr, pg, pb = px[xx, yy]
                px[xx, yy] = (min(255, pr + gr), min(255, pg + gg), min(255, pb + gb))
draw = ImageDraw.Draw(img)
for x, y, v in bright:
    s = random.choice([2, 2, 3])
    draw.ellipse([x - s, y - s, x + s, y + s], fill=(v, v, min(255, v + 10)))

img.save(OUT / "starfield.jpg", quality=88, optimize=True)
print(f"starfield.jpg {img.size} {(OUT / 'starfield.jpg').stat().st_size // 1024} KB")
