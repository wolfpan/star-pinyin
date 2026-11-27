"""生成 PWA 图标（深空背景 + 火箭）。零外部素材，使用 Pillow 程序化绘制。
运行：python scripts/gen_icons.py  → 输出到 public/icons/
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def draw_icon(size: int) -> Image.Image:
    s = size / 512.0
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角深空背景
    r = int(96 * s)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=(7, 11, 24, 255))
    # 背景光晕
    d.ellipse([int(120*s), int(-120*s), int(560*s), int(300*s)], fill=(20, 34, 64, 255))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, outline=(36, 51, 82, 255), width=max(1, int(6*s)))

    # 星星
    for (x, y, rr) in [(90, 110, 5), (420, 90, 4), (120, 400, 4), (430, 380, 6), (300, 60, 3), (60, 260, 3)]:
        d.ellipse([int((x-rr)*s), int((y-rr)*s), int((x+rr)*s), int((y+rr)*s)], fill=(215, 227, 255, 230))

    cx = 256 * s
    # 尾焰
    d.polygon([(cx-34*s, 360*s), (cx+34*s, 360*s), (cx, 470*s)], fill=(255, 120, 30, 255))
    d.polygon([(cx-18*s, 360*s), (cx+18*s, 360*s), (cx, 430*s)], fill=(255, 210, 80, 255))
    # 尾翼
    d.polygon([(cx-46*s, 300*s), (cx-92*s, 372*s), (cx-46*s, 360*s)], fill=(200, 60, 70, 255))
    d.polygon([(cx+46*s, 300*s), (cx+92*s, 372*s), (cx+46*s, 360*s)], fill=(200, 60, 70, 255))
    # 箭体
    d.rounded_rectangle([cx-46*s, 150*s, cx+46*s, 366*s], radius=int(20*s), fill=(226, 233, 245, 255))
    # 鼻锥
    d.polygon([(cx-46*s, 158*s), (cx+46*s, 158*s), (cx, 70*s)], fill=(230, 70, 80, 255))
    # 舷窗
    d.ellipse([cx-26*s, 196*s, cx+26*s, 248*s], fill=(20, 40, 70, 255))
    d.ellipse([cx-20*s, 202*s, cx+20*s, 242*s], fill=(76, 201, 240, 255))
    # 装饰条
    d.rectangle([cx-46*s, 300*s, cx+46*s, 318*s], fill=(76, 201, 240, 255))
    return img


for sz, name in [(180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")]:
    draw_icon(sz).save(OUT / name, "PNG")
    print("written", OUT / name)
