import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    APPLE_TOUCH_ICON_PNG_BASE64,
    FAVICON_ICO_BASE64,
    ICON_PNG_BASE64,
    ICON_SVG_SHA256,
    OG_PNG_BASE64,
    OG_SVG_SHA256,
} from './assets.generated.js';

const ROOT = new URL('../../../', import.meta.url);

function sha256(path: string): string {
    return createHash('sha256')
        .update(readFileSync(new URL(path, ROOT)))
        .digest('hex');
}

function bytes(base64: string): Buffer {
    return Buffer.from(base64, 'base64');
}

/** Width and height from a PNG's IHDR chunk, after checking the signature. */
function pngSize(png: Buffer): { width: number; height: number } {
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The square sizes listed in an ICO directory (a 0 byte means 256). */
function icoSizes(ico: Buffer): number[] {
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    return Array.from({ length: ico.readUInt16LE(4) }, (_, index) => ico.readUInt8(6 + 16 * index) || 256);
}

describe('the generated assets', () => {
    it('were rendered from the committed SVG sources', () => {
        expect(ICON_SVG_SHA256).toBe(sha256('assets/icon.svg'));
        expect(OG_SVG_SHA256).toBe(sha256('assets/og.svg'));
    });

    it('carry the same 512 pixel icon as the Claude Desktop bundle', () => {
        expect(bytes(ICON_PNG_BASE64).equals(readFileSync(new URL('assets/icon.png', ROOT)))).toBe(true);
    });

    it('have the sizes the paths table names', () => {
        expect(pngSize(bytes(ICON_PNG_BASE64))).toEqual({ width: 512, height: 512 });
        expect(pngSize(bytes(APPLE_TOUCH_ICON_PNG_BASE64))).toEqual({ width: 180, height: 180 });
        expect(pngSize(bytes(OG_PNG_BASE64))).toEqual({ width: 1200, height: 630 });
        expect(icoSizes(bytes(FAVICON_ICO_BASE64)).sort((a, b) => a - b)).toEqual([16, 32, 48]);
    });

    it('draw every glyph as a path, so no font is needed to render them', () => {
        for (const source of ['assets/icon.svg', 'assets/og.svg']) {
            const svg = readFileSync(new URL(source, ROOT), 'utf8');
            expect(svg).not.toMatch(/<text\b|font-family/);
        }
    });
});
