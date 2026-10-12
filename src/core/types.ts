export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };
export type CalendarDate = string & { readonly __brand: 'CalendarDate' };
export type Language = 'en' | 'ka';

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
    return { ok: true, value };
}

export function err<E>(error: E): { readonly ok: false; readonly error: E } {
    return { ok: false, error };
}

export type RatesError =
    | { readonly kind: 'invalid_date'; readonly value: string; readonly reason: string }
    | { readonly kind: 'range_too_long'; readonly days: number; readonly max: number }
    | { readonly kind: 'unknown_currency'; readonly code: string }
    | { readonly kind: 'invalid_currency_code'; readonly value: string }
    | {
          readonly kind: 'result_out_of_range';
          readonly amount: number;
          readonly from: CurrencyCode;
          readonly to: CurrencyCode;
      }
    | { readonly kind: 'no_data_for_date'; readonly date: CalendarDate; readonly currency: CurrencyCode | undefined }
    | {
          readonly kind: 'rate_not_published';
          readonly date: CalendarDate;
          readonly latestEffectiveDate: CalendarDate | undefined;
          readonly today: CalendarDate;
      }
    | { readonly kind: 'upstream_unavailable'; readonly detail: string }
    | { readonly kind: 'upstream_shape_changed'; readonly detail: string };

export interface RateEntry {
    readonly code: CurrencyCode;
    readonly name: string;
    readonly rate: number;
    readonly diff: number;
    readonly nbgQuantity: number;
    readonly nbgRate: number;
}

export interface RatesSnapshot {
    readonly requestedDate: CalendarDate;
    readonly effectiveDate: CalendarDate;
    /** True when the rate in force on requestedDate took effect on an earlier day. */
    readonly carriedOver: boolean;
    readonly rates: ReadonlyArray<RateEntry>;
    readonly unknownCodes: ReadonlyArray<string>;
}

export interface Conversion {
    readonly amount: number;
    readonly from: CurrencyCode;
    readonly to: CurrencyCode;
    readonly result: number;
    /** result rounded half up to two decimals from the exact value; the amount to show. */
    readonly resultRounded: number;
    readonly rate: number;
    readonly via: 'direct' | 'GEL';
    readonly requestedDate: CalendarDate;
    readonly effectiveDate: CalendarDate;
    readonly carriedOver: boolean;
}

export interface HistoryPoint {
    readonly date: CalendarDate;
    readonly effectiveDate: CalendarDate;
    readonly rate: number;
    /** Units NBG quotes the raw rate for on this day (1, 10, 100, 1000 or 10000); rate is per one unit. */
    readonly nbgQuantity: number;
    readonly carriedOver: boolean;
}

export interface HistorySeries {
    readonly currency: CurrencyCode;
    readonly from: CalendarDate;
    readonly to: CalendarDate;
    readonly days: ReadonlyArray<HistoryPoint>;
}
