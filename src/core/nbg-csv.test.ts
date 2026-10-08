import { describe, expect, it } from 'vitest';
import { csvExport } from '../../test/helpers/fixtures.js';
import { NBG_CSV_HEADER, parseNbgCsv } from './nbg-csv.js';

const BOM = '\uFEFF';

function shapeDetail(text: string): string {
    const result = parseNbgCsv(text);
    if (result.ok || result.error.kind !== 'upstream_shape_changed') {
        throw new Error(`expected a shape change, got ${JSON.stringify(result)}`);
    }
    return result.error.detail;
}

describe('parseNbgCsv', () => {
    it('parses a recorded USD export, newest first, with ISO dates', () => {
        const result = parseNbgCsv(csvExport(['USD'], '2026-08-01', '2026-10-07'));
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.length).toBeGreaterThan(40);
            expect(result.value.every((row) => row.code === 'USD' && row.quantity === 1)).toBe(true);
            expect(result.value[0]).toMatchObject({ validFrom: '2026-10-07', publishedOn: '2026-10-06' });
        }
    });

    it('keeps the raw quantity of a currency quoted per 1000 units', () => {
        const result = parseNbgCsv(csvExport(['AMD'], '2026-10-03', '2026-10-03'));
        expect(result).toEqual({
            ok: true,
            value: [{ code: 'AMD', quantity: 1000, rate: 7.1762, publishedOn: '2026-10-02', validFrom: '2026-10-03' }],
        });
    });

    it('parses a header-only answer (unknown code) as no rows', () => {
        expect(parseNbgCsv(csvExport(['XXX'], '2026-10-01', '2026-10-07'))).toEqual({ ok: true, value: [] });
    });

    it('accepts LF and CRLF line endings and a missing byte-order mark', () => {
        const text = `${NBG_CSV_HEADER}\nUSD,1,2.6039,0.0003,აშშ დოლარი,10/2/2026,10/3/2026\n`;
        expect(parseNbgCsv(text).ok).toBe(true);
        expect(parseNbgCsv(text.replaceAll('\n', '\r\n')).ok).toBe(true);
    });

    it('rejects a changed header', () => {
        expect(shapeDetail(`${BOM}Code,Quantity,Rate,Name,Date\r\n`)).toContain('header');
        expect(shapeDetail('')).toContain('header');
    });

    it('rejects a quoted field and a wrong field count', () => {
        expect(shapeDetail(`${NBG_CSV_HEADER}\nUSD,1,2.6039,0.0003,"US, Dollar",10/2/2026,10/3/2026\n`)).toContain(
            'quoted',
        );
        expect(shapeDetail(`${NBG_CSV_HEADER}\nUSD,1,2.6039,0.0003,US,Dollar,10/2/2026,10/3/2026\n`)).toContain(
            'fields',
        );
    });

    it('rejects malformed values', () => {
        const malformed = [
            'USD,1,2.6039,0.0003,x,2026-10-02,10/3/2026',
            'USD,1,2.6039,0.0003,x,10/2/2026,2/30/2026',
            'USD,3,2.6039,0.0003,x,10/2/2026,10/3/2026',
            'USD,1,2.60.39,0.0003,x,10/2/2026,10/3/2026',
            'usd,1,2.6039,0.0003,x,10/2/2026,10/3/2026',
            'USD,1,2.60391,0.0003,x,10/2/2026,10/3/2026',
            'USD,1,0.0000,0.0003,x,10/2/2026,10/3/2026',
        ];
        for (const line of malformed) {
            expect(parseNbgCsv(`${NBG_CSV_HEADER}\n${line}\n`).ok, line).toBe(false);
        }
    });
});
