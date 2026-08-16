#!/usr/bin/env python3
"""Generate the complete Arco application icon set using only Pillow.

The mark is a literal masonry arch with a cyan keystone. Every output size is
rasterized independently from normalized geometry; no output is made by
resizing another generated icon.
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


# Tokens copied from src/styles/theme.css in the Arco repository.
BACKGROUND = "#101114"  # default dark --bg; light --accent-on
SURFACE = "#1f2125"  # default dark --bg-elevated
BORDER = "#2a2d33"  # default dark --border / --panel
STONE = "#f3f4f6"  # default dark --fg / --accent
SMALL_STONE = "#ffffff"  # higher-contrast small-size foreground
KEYSTONE = "#38bdf8"  # default --focus-ring

SUPERSAMPLE = 8
SMALL_SIZE_THRESHOLD = 48

# Authoritative inventory read from src-tauri/icons. Keep unusual source sizes
# (notably the 49 px hdpi launchers) unchanged for exact drop-in replacement.
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


def quadratic_points(
    start: tuple[float, float],
    control: tuple[float, float],
    end: tuple[float, float],
    steps: int = 96,
) -> list[tuple[float, float]]:
    """Sample a quadratic Bezier in supersampled pixel coordinates."""
    points: list[tuple[float, float]] = []
    for index in range(steps + 1):
        t = index / steps
        inverse = 1.0 - t
        points.append(
            (
                inverse * inverse * start[0]
                + 2 * inverse * t * control[0]
                + t * t * end[0],
                inverse * inverse * start[1]
                + 2 * inverse * t * control[1]
                + t * t * end[1],
            )
        )
    return points


def render_icon(size: int) -> Image.Image:
    """Render an Arco icon directly at ``size`` from normalized geometry."""
    simplified = size < SMALL_SIZE_THRESHOLD
    extent = size * SUPERSAMPLE
    image = Image.new("RGBA", (extent, extent), BACKGROUND)
    draw = ImageDraw.Draw(image)

    def px(value: float) -> int:
        return round(value * extent)

    # The dark, opaque tile guarantees contrast in both light and dark shells.
    inset = px(0.015 if simplified else 0.035)
    draw.rounded_rectangle(
        (inset, inset, extent - inset - 1, extent - inset - 1),
        radius=px(0.120 if simplified else 0.205),
        fill=SURFACE,
        outline=BORDER,
        width=max(SUPERSAMPLE, px(0.012)),
    )

    # One shared U-shaped arch geometry with size-derived level of detail.
    # The simplified variant is wider and thicker, but moves its piers outward
    # so the negative-space opening remains distinct after antialiasing.
    stone_color = SMALL_STONE if simplified else STONE
    stroke = px(0.180 if simplified else 0.135)
    spring_x = 0.245 if simplified else 0.285
    spring_y = 0.455 if simplified else 0.485
    crown_y = 0.135 if simplified else 0.190
    control_x = 0.255 if simplified else 0.305
    control_y = 0.145 if simplified else 0.205
    pier_bottom = 0.855 if simplified else 0.775
    left_spring = (px(spring_x), px(spring_y))
    crown = (px(0.500), px(crown_y))
    right_spring = (px(1.0 - spring_x), px(spring_y))
    curve = quadratic_points(
        left_spring, (px(control_x), px(control_y)), crown
    ) + quadratic_points(
        crown, (px(1.0 - control_x), px(control_y)), right_spring
    )[1:]
    draw.line(curve, fill=stone_color, width=stroke, joint="curve")

    half_stroke = stroke // 2
    for spring_x, spring_y in (left_spring, right_spring):
        draw.ellipse(
            (
                spring_x - half_stroke,
                spring_y - half_stroke,
                spring_x + half_stroke,
                spring_y + half_stroke,
            ),
            fill=stone_color,
        )
        draw.rectangle(
            (
                spring_x - half_stroke,
                spring_y,
                spring_x + half_stroke,
                px(pier_bottom),
            ),
            fill=stone_color,
        )

    # Masonry feet are useful detail at normal sizes but become gray edge
    # noise below 48 px. The small path keeps only the clean arch silhouette.
    if not simplified:
        draw.rounded_rectangle(
            (px(0.185), px(0.735), px(0.385), px(0.825)),
            radius=px(0.018),
            fill=stone_color,
        )
        draw.rounded_rectangle(
            (px(0.615), px(0.735), px(0.815), px(0.825)),
            radius=px(0.018),
            fill=stone_color,
        )

    # The same keystone is enlarged by level of detail at small sizes so it
    # remains a distinct block rather than an antialiased speck.
    keystone_top = 0.390 if simplified else 0.450
    keystone_bottom = 0.355 if simplified else 0.425
    keystone_top_y = 0.065 if simplified else 0.145
    keystone_bottom_y = 0.365 if simplified else 0.300
    draw.polygon(
        (
            (px(keystone_top), px(keystone_top_y)),
            (px(1.0 - keystone_top), px(keystone_top_y)),
            (px(1.0 - keystone_bottom), px(keystone_bottom_y)),
            (px(keystone_bottom), px(keystone_bottom_y)),
        ),
        fill=KEYSTONE,
    )

    return image.resize((size, size), Image.Resampling.LANCZOS)


def png_bytes(image: Image.Image, *, optimize: bool = False) -> bytes:
    """Encode an in-memory icon as PNG bytes."""
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=optimize)
    return buffer.getvalue()


def write_pngs(output_root: Path, *, small_only: bool = False) -> int:
    icons_root = output_root / "icons"
    written = 0
    for relative_name, size in PROJECT_PNG_SIZES.items():
        if small_only and size >= SMALL_SIZE_THRESHOLD:
            continue
        destination = icons_root / relative_name
        destination.parent.mkdir(parents=True, exist_ok=True)
        render_icon(size).save(destination, format="PNG", optimize=True)
        written += 1

    # GNOME .desktop launcher asset requested in addition to the inherited set.
    if not small_only:
        render_icon(256).save(icons_root / "arco-256.png", format="PNG", optimize=True)
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
    """Write independently rendered ICO frames, optionally preserving large ones."""
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
    """Write an ICNS container with Pillow-encoded PNG representation chunks.

    Pillow 12 can read ICNS but has no ICNS save handler. Modern ICNS accepts
    PNG payloads for the standard icp4..ic10 representation types, so the
    minimal container is assembled here without an additional dependency.
    """
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
            chunks.append(chunk_type + struct.pack(">I", len(payload) + 8) + payload)
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
        "--small-only",
        action="store_true",
        help="regenerate only outputs and embedded frames smaller than 48 px",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_root = args.out.expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    png_count = write_pngs(output_root, small_only=args.small_only)
    write_ico(output_root, small_only=args.small_only)
    write_icns(output_root, small_only=args.small_only)
    print(f"Generated {png_count} PNGs under {output_root / 'icons'}")
    print(f"Generated {output_root / 'icon.ico'}")
    print(f"Generated {output_root / 'icon.icns'}")


if __name__ == "__main__":
    main()
