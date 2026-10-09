import type { CalendarDate, CurrencyCode, HistoryPoint, HistorySeries } from '../core/types.js';

/** A day whose own publication is in force carries date and rate; a carried-over day adds where its rate came from. */
export type HistoryDayOutput =
    | { readonly date: CalendarDate; readonly rate: number }
    | {
          readonly date: CalendarDate;
          readonly rate: number;
          readonly effectiveDate: CalendarDate;
          readonly carriedOver: true;
      };

// A type alias, not an interface: the server's result helper needs a type assignable to Record<string, unknown>.
export type HistoryOutput = {
    readonly currency: CurrencyCode;
    readonly from: CalendarDate;
    readonly to: CalendarDate;
    readonly days: ReadonlyArray<HistoryDayOutput>;
};

export function historyDayOutput(point: HistoryPoint): HistoryDayOutput {
    return point.carriedOver
        ? { date: point.date, rate: point.rate, effectiveDate: point.effectiveDate, carriedOver: true }
        : { date: point.date, rate: point.rate };
}

/** The wire form of nbg_rate_history: about 40% smaller than full points, so a year stays near 6,000 tokens. */
export function historyOutput(series: HistorySeries): HistoryOutput {
    return { currency: series.currency, from: series.from, to: series.to, days: series.days.map(historyDayOutput) };
}
