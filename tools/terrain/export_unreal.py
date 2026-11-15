"""Write the heightmap for the Unreal Engine project.

Reads the same data the web game uses (src/terrain-data.ts) and writes it as
raw little-endian uint16 metres (1000 x 594, row 0 = south edge) to
Unreal/Content/Data/Terrain.u16, which the C++ simulation loads at start-up.

    python3 tools/terrain/export_unreal.py
"""

import base64
import re
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src" / "terrain-data.ts"
OUT = ROOT / "Unreal" / "Content" / "Data" / "Terrain.u16"


def main() -> int:
    text = SRC.read_text()
    cols = int(re.search(r"TERRAIN_COLS = (\d+)", text).group(1))
    rows = int(re.search(r"TERRAIN_ROWS = (\d+)", text).group(1))
    data = re.search(r'TERRAIN_DATA = "([^"]+)"', text).group(1)
    raw = zlib.decompress(base64.b64decode(data + "=" * (-len(data) % 4)))
    if len(raw) != cols * rows * 2:
        print(f"unexpected size {len(raw)} for {cols} x {rows}", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(raw)
    print(f"wrote {OUT.relative_to(ROOT)}: {cols} x {rows}, {len(raw)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
