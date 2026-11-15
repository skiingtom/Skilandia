"""Draws build/icon.png (512x512), the app icon electron-builder turns into icon.ico.

Run: python3 build/make_icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

S = 4  # supersample, then shrink for smooth edges
N = 512 * S
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)


def p(x, y):
    return (x * S, y * S)


# Rounded sky tile
d.rounded_rectangle([p(16, 16), p(496, 496)], radius=96 * S, fill=(63, 132, 186, 255))
d.rounded_rectangle([p(16, 16), p(496, 300)], radius=96 * S, fill=(120, 180, 222, 255))
d.rectangle([p(16, 200), p(496, 300)], fill=(120, 180, 222, 255))

# Back ridge and main peak
d.polygon([p(40, 430), p(150, 250), p(250, 430)], fill=(205, 222, 236, 255))
d.polygon([p(90, 440), p(270, 110), p(450, 440)], fill=(244, 248, 252, 255))
d.polygon([p(270, 110), p(450, 440), p(330, 440), p(300, 260)], fill=(214, 226, 238, 255))
# Rock band on the steep face
d.polygon([p(300, 200), p(345, 270), p(318, 300), p(292, 240)], fill=(94, 98, 104, 255))

# Runs: green, blue, black
d.line([p(255, 150), p(205, 260), p(240, 330), p(180, 430)], fill=(60, 177, 114, 255), width=18 * S, joint="curve")
d.line([p(275, 150), p(300, 300), p(270, 430)], fill=(59, 130, 214, 255), width=16 * S, joint="curve")
d.line([p(310, 200), p(372, 330), p(360, 430)], fill=(27, 27, 27, 255), width=14 * S, joint="curve")

# Snowy base
d.rounded_rectangle([p(16, 420), p(496, 496)], radius=60 * S, fill=(236, 242, 247, 255))
d.rectangle([p(16, 420), p(496, 450)], fill=(236, 242, 247, 255))

# A few pines
for x in (70, 110, 400, 440):
    d.polygon([p(x, 380), p(x - 22, 440), p(x + 22, 440)], fill=(36, 92, 64, 255))

img = img.resize((512, 512), Image.LANCZOS)
out = Path(__file__).with_name("icon.png")
img.save(out)
print("wrote", out)
