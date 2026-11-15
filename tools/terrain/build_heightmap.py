"""Turn the colour-tinted topographic map into the game's heightmap.

The source (tools/terrain/source/overview.webp) is an OpenTopoMap view with an
elevation colour ramp: blue 489 m -> cyan -> green -> yellow -> orange ->
red 2,309 m -> pink -> white 2,873 m. Hue tracks elevation up to red; above
that the hue stays red and the colour fades toward white, so saturation
tracks elevation there. Hill shading changes brightness, not hue, so it
mostly drops out. Contour lines, labels and roads are dark: those pixels are
thrown away and filled from their neighbours.

Output: src/terrain-data.ts (deflated Uint16 metres, base64) plus a
shaded preview PNG next to this script for checking against the map.

Run: python3 tools/terrain/build_heightmap.py
"""

import base64
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).parent
SRC = HERE / "source" / "overview.webp"
OUT_TS = HERE.parent.parent / "src" / "terrain-data.ts"
PREVIEW = HERE / "preview.png"

# Legend (sampled from the map's own colour key): elevation -> hue / saturation.
LEGEND_HUE = [  # (hue degrees, metres), hue falls as elevation rises
    (195, 489), (188, 571), (178, 671), (167, 778), (155, 891), (144, 1007),
    (131, 1128), (118, 1251), (105, 1376), (91, 1504), (77, 1634), (63, 1766),
    (50, 1899), (34, 2034), (19, 2171), (4, 2309),
]
LEGEND_SAT = [  # (legend saturation, metres) for the red -> white top end
    (0.72, 2309), (0.59, 2448), (0.40, 2588), (0.21, 2730), (0.02, 2873),
]
MAP_SAT_SCALE = 0.66  # map tint is semi-transparent: ~0.66x the legend saturation
METRES_PER_PIXEL = 14.0  # from the 500 m scale bar on the close-ups (8 m/px at 1.79x zoom)
DOWNSAMPLE = 2  # heightmap cell = 28 m
ROBUST_BLOCK = 4  # robust median over 56 m blocks before smoothing


def interp(x, table):
    xs = np.array([t[0] for t in table], dtype=np.float64)
    ys = np.array([t[1] for t in table], dtype=np.float64)
    order = np.argsort(xs)
    return np.interp(x, xs[order], ys[order])


def colour_to_elevation(img):
    hsv = np.asarray(img.convert("HSV")).astype(np.float64)
    hue = hsv[..., 0] * 360 / 255
    sat = hsv[..., 1] / 255
    val = hsv[..., 2] / 255

    # Treat magenta-ish reds (hue 330-360) as just below 0 so reds are contiguous.
    hue = np.where(hue >= 300, hue - 360, hue)
    by_hue = interp(np.clip(hue, 4, 195), LEGEND_HUE)
    by_sat = interp(np.clip(sat / MAP_SAT_SCALE, 0.02, 0.72), LEGEND_SAT)

    reds = hue <= 12
    elev = np.where(reds, by_sat, by_hue)
    # Blend across the orange/red boundary so there is no seam at hue 12.
    blend = np.clip((hue - 4) / 8, 0, 1)
    edge = (hue > 4) & (hue < 12)
    elev = np.where(edge, by_sat * (1 - blend) + by_hue * blend, elev)

    # Dark ink (contours, text, roads), heavy shade, and washed-out non-red
    # pixels (label halos) don't carry the tint reliably.
    # Keep well-lit pixels whose tint strength looks like the ramp (not ink or halos).
    satn = sat / MAP_SAT_SCALE
    valid = (val > 0.62) & (((satn > 0.55) & (satn < 1.15)) | (reds & (val > 0.7)))
    return elev, valid


def block_median(elev, valid, k):
    h, w = elev.shape
    h2, w2 = h // k, w // k
    e = elev[: h2 * k, : w2 * k].reshape(h2, k, w2, k).transpose(0, 2, 1, 3).reshape(h2, w2, k * k)
    v = valid[: h2 * k, : w2 * k].reshape(h2, k, w2, k).transpose(0, 2, 1, 3).reshape(h2, w2, k * k)
    e = np.where(v, e, np.nan)
    out = np.nanmedian(e, axis=2)
    out[v.sum(axis=2) < 3] = np.nan  # too few trustworthy pixels: fill from neighbours
    return out


def upsample(a, k):
    """Bilinear resize by an integer factor."""
    h, w = a.shape
    ys = (np.arange(h * k) + 0.5) / k - 0.5
    xs = (np.arange(w * k) + 0.5) / k - 0.5
    y0 = np.clip(np.floor(ys).astype(int), 0, h - 2)
    x0 = np.clip(np.floor(xs).astype(int), 0, w - 2)
    ty = np.clip(ys - y0, 0, 1)[:, None]
    tx = np.clip(xs - x0, 0, 1)[None, :]
    a00 = a[y0][:, x0]
    a01 = a[y0][:, x0 + 1]
    a10 = a[y0 + 1][:, x0]
    a11 = a[y0 + 1][:, x0 + 1]
    return (a00 * (1 - tx) + a01 * tx) * (1 - ty) + (a10 * (1 - tx) + a11 * tx) * ty


def block_mean(elev, valid, k):
    h, w = elev.shape
    h2, w2 = h // k, w // k
    e = elev[: h2 * k, : w2 * k].reshape(h2, k, w2, k)
    v = valid[: h2 * k, : w2 * k].reshape(h2, k, w2, k)
    count = v.sum(axis=(1, 3))
    total = (e * v).sum(axis=(1, 3))
    out = np.where(count > 0, total / np.maximum(count, 1), np.nan)
    return out


def fill_gaps(a):
    a = a.copy()
    for _ in range(200):
        hole = np.isnan(a)
        if not hole.any():
            break
        p = np.pad(a, 1, mode="edge")
        stack = np.stack([p[1 + dy : 1 + dy + a.shape[0], 1 + dx : 1 + dx + a.shape[1]]
                          for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx])
        mean = np.nanmean(np.where(np.isnan(stack), np.nan, stack), axis=0) if True else None
        a = np.where(hole & ~np.isnan(mean), mean, a)
    return a


def local_median(a, r):
    p = np.pad(a, r, mode="edge")
    win = np.lib.stride_tricks.sliding_window_view(p, (2 * r + 1, 2 * r + 1))
    return np.median(win.reshape(a.shape[0], a.shape[1], -1), axis=2)


def gaussian(a, sigma):
    r = int(3 * sigma)
    x = np.arange(-r, r + 1)
    k = np.exp(-(x**2) / (2 * sigma**2))
    k /= k.sum()
    p = np.pad(a, ((0, 0), (r, r)), mode="edge")
    a = sum(k[i] * p[:, i : i + a.shape[1]] for i in range(len(k)))
    p = np.pad(a, ((r, r), (0, 0)), mode="edge")
    a = sum(k[i] * p[i : i + a.shape[0], :] for i in range(len(k)))
    return a


def main():
    import warnings

    warnings.filterwarnings("ignore", category=RuntimeWarning)  # nanmean of all-NaN windows
    img = Image.open(SRC).convert("RGB")
    elev, valid = colour_to_elevation(img)
    print(f"source {img.size}, usable pixels {valid.mean():.0%}")

    coarse = block_median(elev, valid, ROBUST_BLOCK)
    coarse = fill_gaps(coarse)
    # Knock out leftovers from labels/symbols that disagree with their surroundings.
    med = local_median(coarse, 2)
    coarse = np.where(np.abs(coarse - med) > 60, med, coarse)
    coarse = gaussian(coarse, 1.0)
    grid = upsample(coarse, ROBUST_BLOCK // DOWNSAMPLE)
    grid = gaussian(grid, 1.0)

    h, w = grid.shape
    cell = METRES_PER_PIXEL * DOWNSAMPLE
    print(f"heightmap {w}x{h} cells of {cell:.0f} m = {w * cell / 1000:.1f} x {h * cell / 1000:.1f} km, "
          f"{grid.min():.0f}-{grid.max():.0f} m")

    # Flip so +y is north (image row 0 is the north edge).
    data = np.flipud(grid)
    dm = np.clip(np.round(data), 0, 65535).astype("<u2")
    packed = base64.b64encode(zlib.compress(dm.tobytes(), 9)).decode("ascii")
    OUT_TS.write_text(
        "// Generated by tools/terrain/build_heightmap.py from an OpenTopoMap view\n"
        "// (map data (c) OpenStreetMap contributors, SRTM; style (c) OpenTopoMap, CC-BY-SA).\n"
        "// Do not edit by hand.\n"
        f"export const TERRAIN_COLS = {w};\n"
        f"export const TERRAIN_ROWS = {h};\n"
        f"/** Metres per heightmap cell. */\n"
        f"export const TERRAIN_CELL_M = {cell};\n"
        f"/** Row 0 is the south edge. Deflate-compressed little-endian Uint16, metres. */\n"
        f'export const TERRAIN_DATA = "{packed}";\n'
    )
    print(f"wrote {OUT_TS} ({len(packed) / 1024:.0f} KB base64)")

    # Shaded preview, north up, same framing as the source map.
    gy, gx = np.gradient(grid, cell)
    shade = np.clip(0.7 + (-gx - gy) * 0.5, 0.25, 1)
    t = (grid - grid.min()) / (grid.max() - grid.min())
    ramp = np.stack([np.interp(t, [0, 0.35, 0.6, 0.8, 1], c) for c in
                     ([70, 120, 245, 240, 255], [200, 240, 240, 90, 250], [250, 120, 70, 70, 250])], -1)
    rgb = np.clip(ramp * shade[..., None], 0, 255).astype(np.uint8)
    Image.fromarray(rgb).save(PREVIEW)
    print(f"wrote {PREVIEW}")


if __name__ == "__main__":
    main()
