#!/usr/bin/env python3
"""Measure line contrast and cyan-highlight survival at Arco's critical sizes."""

from __future__ import annotations

import argparse
import importlib.util
import math
from pathlib import Path
from types import ModuleType

from PIL import Image


# These gates detect an actually lost line/highlight without imposing the old
# masonry icon's much larger 3% keystone coverage on this intentionally light
# directed-edge mark.
MIN_CONTRAST_RATIO = 12.0
MIN_HIGHLIGHT_FRACTION = 0.01
COLOR_DISTANCE_LIMIT = 24.0
BACKGROUND_DISTANCE_LIMIT = 12.0


def load_generator(script_path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("arco_icon_generator", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load generator: {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rgb(hex_color: str) -> tuple[int, int, int]:
    value = hex_color.removeprefix("#")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))


def color_distance(
    first: tuple[int, int, int], second: tuple[int, int, int]
) -> float:
    return math.sqrt(
        sum((left - right) ** 2 for left, right in zip(first, second))
    )


def relative_luminance(color: tuple[float, float, float]) -> float:
    """Return WCAG 2 relative luminance for an sRGB color."""
    linear = []
    for channel in color:
        value = channel / 255.0
        linear.append(
            value / 12.92
            if value <= 0.04045
            else ((value + 0.055) / 1.055) ** 2.4
        )
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def average_color(
    pixels: list[tuple[int, int, int]],
) -> tuple[float, float, float]:
    if not pixels:
        raise ValueError("No pixels matched the requested color sample")
    return tuple(
        sum(pixel[channel] for pixel in pixels) / len(pixels)
        for channel in range(3)
    )


def measure(
    image: Image.Image,
    stroke: tuple[int, int, int],
    background: tuple[int, int, int],
    highlight: tuple[int, int, int],
) -> tuple[float, float, int, int]:
    """Apply the original checker's distance-sampled measurement method."""
    pixels = [
        pixel[:3]
        for pixel in image.convert("RGBA").get_flattened_data()
        if pixel[3] > 0
    ]
    stroke_pixels = [
        pixel
        for pixel in pixels
        if color_distance(pixel, stroke) <= COLOR_DISTANCE_LIMIT
    ]
    background_pixels = [
        pixel
        for pixel in pixels
        if color_distance(pixel, background) <= BACKGROUND_DISTANCE_LIMIT
    ]
    highlight_pixels = [
        pixel
        for pixel in pixels
        if color_distance(pixel, highlight) <= COLOR_DISTANCE_LIMIT
    ]

    stroke_luminance = relative_luminance(average_color(stroke_pixels))
    background_luminance = relative_luminance(average_color(background_pixels))
    lighter, darker = sorted(
        (stroke_luminance, background_luminance), reverse=True
    )
    contrast = (lighter + 0.05) / (darker + 0.05)
    highlight_fraction = len(highlight_pixels) / len(pixels)
    return contrast, highlight_fraction, len(highlight_pixels), len(pixels)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="generated output root (default: this script's directory)",
    )
    return parser.parse_args()


def main() -> None:
    root = parse_args().root.expanduser().resolve()
    generator = load_generator(root / "generate-icons.py")
    stroke = rgb(generator.FOREGROUND)
    background = rgb(generator.BACKGROUND)
    highlight = rgb(generator.ACCENT)

    with Image.open(root / "icon.ico") as ico:
        icon_16 = ico.ico.getimage((16, 16)).convert("RGBA")
    images = {
        16: icon_16,
        32: Image.open(root / "icons/32x32.png").convert("RGBA"),
    }

    failed = False
    for size, image in images.items():
        contrast, highlight_fraction, highlight_count, total = measure(
            image, stroke, background, highlight
        )
        passed = (
            contrast >= MIN_CONTRAST_RATIO
            and highlight_fraction >= MIN_HIGHLIGHT_FRACTION
        )
        failed = failed or not passed
        print(
            f"{size}x{size}: contrast={contrast:.3f}:1 "
            f"highlight_fraction={highlight_fraction * 100:.3f}% "
            f"highlight_pixels={highlight_count}/{total} "
            f"thresholds=({MIN_CONTRAST_RATIO:.1f}:1, "
            f"{MIN_HIGHLIGHT_FRACTION * 100:.1f}%) "
            f"{'PASS' if passed else 'FAIL'}"
        )

    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
