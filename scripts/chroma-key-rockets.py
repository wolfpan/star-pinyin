"""绿幕火箭抠透明 + 裁剪居中缩放 512；发射背景缩放。"""
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RDIR = ROOT / "public" / "images" / "rockets"
LDIR = ROOT / "public" / "images" / "launch"

def key_green(im: Image.Image) -> Image.Image:
    a = np.asarray(im.convert("RGB")).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    greenness = g - np.maximum(r, b)
    alpha = np.clip(255 - (greenness - 18) * 12, 0, 255).astype(np.uint8)
    alpha[greenness > 40] = 0
    out = np.dstack([a.astype(np.uint8), alpha])
    return Image.fromarray(out, "RGBA")

def trim_square(im: Image.Image, size=512, pad=24) -> Image.Image:
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    w, h = im.size
    side = max(w, h) + pad * 2
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas.resize((size, size), Image.LANCZOS)

count = 0
for raw in sorted(RDIR.glob("_raw_*.png")):
    rid = raw.stem[len("_raw_"):]
    im = key_green(Image.open(raw))
    trim_square(im).save(RDIR / f"{rid}.png", "PNG", optimize=True)
    raw.unlink()
    count += 1
    print("keyed", rid)

bg_raw = LDIR / "_raw_bg.png"
if bg_raw.exists():
    bg = Image.open(bg_raw).convert("RGB")
    bg = bg.resize((768, 1152), Image.LANCZOS)
    bg.save(LDIR / "bg.png", "PNG", optimize=True)
    bg_raw.unlink()
    print("bg saved")
print("rockets keyed:", count)
