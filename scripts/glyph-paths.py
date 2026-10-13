r"""Print one SVG path that draws a run of text set in a TrueType font.

Usage: uv run --no-project --with fonttools==4.66.1 python3 scripts/glyph-paths.py \
    --font <ttf> --size <px> --x <px> --baseline <px> [--anchor start|middle] [--fill <colour>] <text>

The SVGs under assets/ draw their text with this, so they render the same
with or without the font installed. Each character goes through the font's
best cmap; glyphs advance by their hmtx width, with no kerning. With
--anchor middle the run is centred on --x by its total advance.
Coordinates are rounded to two decimals. Exits 2 when the font has no
glyph for a character.
"""

import argparse
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont


def number(value: float) -> str:
    """A coordinate rounded to two decimals, without trailing zeros."""
    text = f'{value:.2f}'.rstrip('0').rstrip('.')
    return '0' if text == '-0' else text


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--font', required=True, help='path to a TrueType font file')
    parser.add_argument('--size', required=True, type=float, help='font size in pixels')
    parser.add_argument('--x', required=True, type=float, help='x of the run start, or of its centre with middle')
    parser.add_argument('--baseline', required=True, type=float, help='y of the baseline')
    parser.add_argument('--anchor', choices=['start', 'middle'], default='start')
    parser.add_argument('--fill', help='fill colour of the path')
    parser.add_argument('text')
    arguments = parser.parse_args()

    font = TTFont(arguments.font)
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    metrics = font['hmtx']
    scale = arguments.size / font['head'].unitsPerEm

    glyph_names = []
    for character in arguments.text:
        glyph_name = cmap.get(ord(character))
        if glyph_name is None:
            print(
                f'glyph-paths.py: {arguments.font} has no glyph for {character!r} (U+{ord(character):04X})',
                file=sys.stderr,
            )
            return 2
        glyph_names.append(glyph_name)

    x = arguments.x
    if arguments.anchor == 'middle':
        x -= sum(metrics[glyph_name][0] for glyph_name in glyph_names) * scale / 2

    path_pen = SVGPathPen(glyph_set, ntos=number)
    for glyph_name in glyph_names:
        glyph_set[glyph_name].draw(TransformPen(path_pen, (scale, 0, 0, -scale, x, arguments.baseline)))
        x += metrics[glyph_name][0] * scale

    fill = f' fill="{arguments.fill}"' if arguments.fill else ''
    print(f'<path{fill} d="{path_pen.getCommands()}"/>')
    return 0


if __name__ == '__main__':
    sys.exit(main())
