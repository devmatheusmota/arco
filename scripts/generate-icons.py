#!/usr/bin/env python3
"""Generate Arco's directed-edge application icon with Pillow.

Every target is rasterized independently from one normalized graph drawing.
The continuous ``detail`` parameter thickens and simplifies that drawing as
the requested size approaches the critical 16 px case.
"""

from __future__ import annotations

import argparse
from io import BytesIO
from pathlib import Path
import struct

try:
    from PIL import Image, ImageDraw
except ImportError as exc:
    raise SystemExit(
        "Pillow is required. Install it with: python3 -m pip install Pillow"
    ) from exc


BACKGROUND = "#101114"
SURFACE = "#1f2125"
BORDER = "#2a2d33"
FOREGROUND = "#f3f4f6"
ACCENT = "#38bdf8"

SUPERSAMPLE = 8
SMALL_SIZE_THRESHOLD = 48

# Exact inherited src-tauri/icons inventory. The uncommon 49 px Android hdpi
# launchers are intentional and must remain unchanged for drop-in replacement.
PROJECT_PNG_SIZES: dict[str, int] = {
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "32x32.png": 32,
    "64x64.png": 64,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square30x30Logo.png": 30,
    "Square310x310Logo.png": 310,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "StoreLogo.png": 50,
    "android/mipmap-hdpi/ic_launcher.png": 49,
    "android/mipmap-hdpi/ic_launcher_foreground.png": 162,
    "android/mipmap-hdpi/ic_launcher_round.png": 49,
    "android/mipmap-mdpi/ic_launcher.png": 48,
    "android/mipmap-mdpi/ic_launcher_foreground.png": 108,
    "android/mipmap-mdpi/ic_launcher_round.png": 48,
    "android/mipmap-xhdpi/ic_launcher.png": 96,
    "android/mipmap-xhdpi/ic_launcher_foreground.png": 216,
    "android/mipmap-xhdpi/ic_launcher_round.png": 96,
    "android/mipmap-xxhdpi/ic_launcher.png": 144,
    "android/mipmap-xxhdpi/ic_launcher_foreground.png": 324,
    "android/mipmap-xxhdpi/ic_launcher_round.png": 144,
    "android/mipmap-xxxhdpi/ic_launcher.png": 192,
    "android/mipmap-xxxhdpi/ic_launcher_foreground.png": 432,
    "android/mipmap-xxxhdpi/ic_launcher_round.png": 192,
    "icon.png": 512,
    "ios/AppIcon-20x20@1x.png": 20,
    "ios/AppIcon-20x20@2x-1.png": 40,
    "ios/AppIcon-20x20@2x.png": 40,
    "ios/AppIcon-20x20@3x.png": 60,
    "ios/AppIcon-29x29@1x.png": 29,
    "ios/AppIcon-29x29@2x-1.png": 58,
    "ios/AppIcon-29x29@2x.png": 58,
    "ios/AppIcon-29x29@3x.png": 87,
    "ios/AppIcon-40x40@1x.png": 40,
    "ios/AppIcon-40x40@2x-1.png": 80,
    "ios/AppIcon-40x40@2x.png": 80,
    "ios/AppIcon-40x40@3x.png": 120,
    "ios/AppIcon-512@2x.png": 1024,
    "ios/AppIcon-60x60@2x.png": 120,
    "ios/AppIcon-60x60@3x.png": 180,
    "ios/AppIcon-76x76@1x.png": 76,
    "ios/AppIcon-76x76@2x.png": 152,
    "ios/AppIcon-83.5x83.5@2x.png": 167,
}

ICO_SIZES = (16, 24, 32, 48, 64, 256)
ICNS_TYPES = {
    16: b"icp4",
    32: b"icp5",
    64: b"icp6",
    128: b"ic07",
    256: b"ic08",
    512: b"ic09",
    1024: b"ic10",
}


def mix(small: float, large: float, detail: float) -> float:
    """Interpolate one geometry value from simplified to detailed rendering."""
    return small + (large - small) * detail


def detail_for_size(size: int) -> float:
    """Return the sole level-of-detail input used by the graph mark."""
    return max(0.0, min(1.0, (size - 16) / (SMALL_SIZE_THRESHOLD - 16)))


def quadratic_point(
    start: tuple[float, float],
    control: tuple[float, float],
    end: tuple[float, float],
    t: float,
) -> tuple[float, float]:
    inverse = 1.0 - t
    return (
        inverse * inverse * start[0]
        + 2 * inverse * t * control[0]
        + t * t * end[0],
        inverse * inverse * start[1]
        + 2 * inverse * t * control[1]
        + t * t * end[1],
    )


def quadratic_points(
    start: tuple[float, float],
    control: tuple[float, float],
    end: tuple[float, float],
    steps: int = 96,
) -> list[tuple[float, float]]:
    return [quadratic_point(start, control, end, index / steps) for index in range(steps + 1)]


def render_icon(size: int) -> Image.Image:
    """Rasterize the shared source-to-worktrees graph directly at ``size``."""
    if size < 1:
        raise ValueError("Icon size must be positive")

    detail = detail_for_size(size)
    extent = size * SUPERSAMPLE
    image = Image.new("RGBA", (extent, extent), BACKGROUND)
    draw = ImageDraw.Draw(image)

    def px(value: float) -> int:
        return round(value * extent)

    # A nearly invisible tile boundary keeps the mark usable in arbitrary OS
    # chrome without adding the visual mass of a filled badge.
    if detail > 0.0:
        inset = px(mix(0.018, 0.035, detail))
        draw.rounded_rectangle(
            (inset, inset, extent - inset - 1, extent - inset - 1),
            radius=px(mix(0.15, 0.21, detail)),
            outline=BORDER,
            width=max(SUPERSAMPLE, px(mix(0.010, 0.012, detail))),
        )

    source = (0.205, 0.500)
    destinations = ((0.790, 0.285), (0.790, 0.715))
    # Keep the approved arc anchors fixed while strengthening only the small
    # nodes. This avoids pulling either curve toward the enlarged circles.
    connection_source_radius = mix(0.108, 0.078, detail)
    connection_destination_radius = mix(0.100, 0.068, detail)
    source_radius = mix(0.130, 0.078, detail)
    destination_radius = mix(0.118, 0.068, detail)
    stroke = max(SUPERSAMPLE, px(mix(0.105, 0.055, detail)))

    arcs = (
        (
            (
                source[0] + connection_source_radius * 0.72,
                source[1] - connection_source_radius * 0.34,
            ),
            (0.485, mix(0.255, 0.205, detail)),
            (
                destinations[0][0] - connection_destination_radius * 0.88,
                destinations[0][1] + connection_destination_radius * 0.24,
            ),
            ACCENT,
        ),
        (
            (
                source[0] + connection_source_radius * 0.72,
                source[1] + connection_source_radius * 0.34,
            ),
            (0.485, mix(0.745, 0.795, detail)),
            (
                destinations[1][0] - connection_destination_radius * 0.88,
                destinations[1][1] - connection_destination_radius * 0.24,
            ),
            FOREGROUND,
        ),
    )

    for start, control, end, color in arcs:
        curve = quadratic_points(
            (px(start[0]), px(start[1])),
            (px(control[0]), px(control[1])),
            (px(end[0]), px(end[1])),
        )
        draw.line(curve, fill=color, width=stroke, joint="curve")

        # Arrowheads appear only once detail can survive rasterization. At 16
        # px, the larger source node and smaller right-hand nodes retain flow
        # asymmetry without adding two dirty pixels to each arc.
        if detail >= 0.30:
            tip = quadratic_point(start, control, end, 0.91)
            before = quadratic_point(start, control, end, 0.75)
            dx = tip[0] - before[0]
            dy = tip[1] - before[1]
            length = (dx * dx + dy * dy) ** 0.5
            ux, uy = dx / length, dy / length
            nx, ny = -uy, ux
            head_length = mix(0.072, 0.050, detail)
            head_half_width = mix(0.048, 0.032, detail)
            base = (tip[0] - ux * head_length, tip[1] - uy * head_length)
            draw.polygon(
                (
                    (px(tip[0]), px(tip[1])),
                    (px(base[0] + nx * head_half_width), px(base[1] + ny * head_half_width)),
                    (px(base[0] - nx * head_half_width), px(base[1] - ny * head_half_width)),
                ),
                fill=color,
            )

    for center, radius in ((source, source_radius), *((point, destination_radius) for point in destinations)):
        draw.ellipse(
            (
                px(center[0] - radius),
                px(center[1] - radius),
                px(center[0] + radius),
                px(center[1] + radius),
            ),
            fill=FOREGROUND,
        )

    return image.resize((size, size), Image.Resampling.LANCZOS)


def png_bytes(image: Image.Image, *, optimize: bool = False) -> bytes:
    """Encode an in-memory icon as PNG bytes."""
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=optimize)
    return buffer.getvalue()


def write_pngs(output_root: Path, *, small_only: bool = False) -> int:
    """Write the inherited 48-path PNG matrix and the added launcher asset."""
    icons_root = output_root / "icons"
    written = 0
    for relative_name, size in PROJECT_PNG_SIZES.items():
        if small_only and size >= SMALL_SIZE_THRESHOLD:
            continue
        destination = icons_root / relative_name
        destination.parent.mkdir(parents=True, exist_ok=True)
        render_icon(size).save(destination, format="PNG", optimize=True)
        written += 1

    if not small_only:
        render_icon(256).save(
            icons_root / "arco-256.png", format="PNG", optimize=True
        )
        written += 1
    return written


def read_ico_payloads(path: Path) -> dict[int, bytes]:
    """Read raw embedded frame payloads from a PNG-based ICO file."""
    data = path.read_bytes()
    reserved, image_type, count = struct.unpack_from("<HHH", data)
    if reserved != 0 or image_type != 1:
        raise ValueError(f"Not an ICO file: {path}")
    payloads: dict[int, bytes] = {}
    for index in range(count):
        entry_offset = 6 + index * 16
        width, height, _, _, _, _, length, offset = struct.unpack_from(
            "<BBBBHHII", data, entry_offset
        )
        frame_width = width or 256
        frame_height = height or 256
        if frame_width != frame_height:
            raise ValueError(f"Non-square ICO frame in {path}")
        payloads[frame_width] = data[offset : offset + length]
    return payloads


def write_ico_payloads(path: Path, payloads: dict[int, bytes]) -> None:
    """Assemble an ICO while preserving supplied frame bytes verbatim."""
    missing = set(ICO_SIZES) - set(payloads)
    if missing:
        raise ValueError(f"Missing ICO frame sizes: {sorted(missing)}")
    header = struct.pack("<HHH", 0, 1, len(ICO_SIZES))
    offset = len(header) + len(ICO_SIZES) * 16
    entries: list[bytes] = []
    bodies: list[bytes] = []
    for size in ICO_SIZES:
        payload = payloads[size]
        entries.append(
            struct.pack(
                "<BBBBHHII",
                size if size < 256 else 0,
                size if size < 256 else 0,
                0,
                0,
                0,
                32,
                len(payload),
                offset,
            )
        )
        bodies.append(payload)
        offset += len(payload)
    path.write_bytes(header + b"".join(entries) + b"".join(bodies))


def write_ico(output_root: Path, *, small_only: bool = False) -> None:
    """Write independently rendered ICO frames, preserving large ones if asked."""
    path = output_root / "icon.ico"
    payloads = read_ico_payloads(path) if small_only else {}
    for size in ICO_SIZES:
        if not small_only or size < SMALL_SIZE_THRESHOLD:
            payloads[size] = png_bytes(render_icon(size))
    write_ico_payloads(path, payloads)


def read_icns_chunks(path: Path) -> dict[bytes, bytes]:
    """Read complete ICNS chunks so unchanged representations can be retained."""
    data = path.read_bytes()
    if data[:4] != b"icns" or struct.unpack_from(">I", data, 4)[0] != len(data):
        raise ValueError(f"Invalid ICNS container: {path}")
    chunks: dict[bytes, bytes] = {}
    offset = 8
    while offset < len(data):
        chunk_type = data[offset : offset + 4]
        chunk_length = struct.unpack_from(">I", data, offset + 4)[0]
        chunks[chunk_type] = data[offset : offset + chunk_length]
        offset += chunk_length
    return chunks


def write_icns(output_root: Path, *, small_only: bool = False) -> None:
    """Write a modern ICNS container containing PNG representation chunks."""
    path = output_root / "icon.icns"
    existing = read_icns_chunks(path) if small_only else {}
    chunks: list[bytes] = []
    for size, chunk_type in ICNS_TYPES.items():
        if small_only and size >= SMALL_SIZE_THRESHOLD:
            if chunk_type not in existing:
                raise ValueError(f"Missing ICNS chunk {chunk_type!r} in {path}")
            chunks.append(existing[chunk_type])
        else:
            payload = png_bytes(render_icon(size), optimize=True)
            chunks.append(
                chunk_type + struct.pack(">I", len(payload) + 8) + payload
            )
    body = b"".join(chunks)
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="output root (default: the script's directory)",
    )
    parser.add_argument(
        "--preview-size",
        type=int,
        help="render one PNG to preview/arco-<size>.png",
    )
    parser.add_argument(
        "--small-only",
        action="store_true",
        help="regenerate only outputs and embedded frames smaller than 48 px",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_root = args.out.expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    if args.preview_size is not None:
        destination = output_root / "preview" / f"arco-{args.preview_size}.png"
        destination.parent.mkdir(parents=True, exist_ok=True)
        render_icon(args.preview_size).save(destination, format="PNG", optimize=True)
        print(f"Generated {destination}")
        return

    png_count = write_pngs(output_root, small_only=args.small_only)
    write_ico(output_root, small_only=args.small_only)
    write_icns(output_root, small_only=args.small_only)
    print(f"Generated {png_count} PNGs under {output_root / 'icons'}")
    print(f"Generated {output_root / 'icon.ico'}")
    print(f"Generated {output_root / 'icon.icns'}")


if __name__ == "__main__":
    main()
