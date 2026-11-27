"""品红绿幕 UI/目的地图标抠透明 + 裁剪居中缩放 256（三套风格 a/b/c）。
品红度 = min(r,b)-g：只移除品红背景，绿色/蓝色/白色主体均保留。"""
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
IDIR = ROOT / "public" / "images" / "icons"

def key_magenta(im: Image.Image) -> Image.Image:
    a = np.asarray(im.convert("RGB")).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mn = np.minimum(r, b) - g
    alpha = np.clip(255 - (mn - 18) * 12, 0, 255).astype(np.uint8)
    alpha[mn > 40] = 0
    return Image.fromarray(np.dstack([a.astype(np.uint8), alpha]), "RGBA")

def trim_square(im: Image.Image, size=256, pad=16) -> Image.Image:
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    w, h = im.size
    side = max(w, h) + pad * 2
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas.resize((size, size), Image.LANCZOS)

count = 0
for style in ("a", "b", "c"):
    for d in (IDIR / style, IDIR / style / "dest"):
        if not d.exists():
            continue
        for raw in sorted(d.glob("_raw_*.png")):
            name = raw.stem[len("_raw_"):]
            im = key_magenta(Image.open(raw))
            trim_square(im).save(d / f"{name}.png", "PNG", optimize=True)
            raw.unlink()
            count += 1
print("icons keyed:", count)
