"""深色发射背景缩放 + 卫星绿幕抠透明。"""
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
L = ROOT / "public" / "images" / "launch"
S = ROOT / "public" / "images" / "sat"

# 发射场背景由 launch-fx.js 代码绘制，无需照片背景。
raw = S / "_raw_sat.png"
if raw.exists():
    a = np.asarray(Image.open(raw).convert("RGB")).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    greenness = g - np.maximum(r, b)
    alpha = np.clip(255 - (greenness - 18) * 12, 0, 255).astype(np.uint8)
    alpha[greenness > 40] = 0
    im = Image.fromarray(np.dstack([a.astype(np.uint8), alpha]), "RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    w, h = im.size
    side = max(w, h) + 24
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    canvas.resize((512, 512), Image.LANCZOS).save(S / "sat.png", "PNG", optimize=True)
    raw.unlink()
    print("sat keyed")
