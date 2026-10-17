import { vi, type Mock } from 'vitest';

/**
 * Stubs fetch with an NBG that answers 503 to everything, and lists each request's per-try timeout: the milliseconds
 * of the AbortSignal.timeout whose signal the request carries. Undo with vi.unstubAllGlobals and vi.restoreAllMocks.
 */
export function failingNbg(): { readonly fetch: Mock<typeof fetch>; readonly timeouts: ReadonlyArray<number> } {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const issued = new Map<AbortSignal, number>();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const signal = timeout(ms);
        issued.set(signal, ms);
        return signal;
    });
    const timeouts: number[] = [];
    const fetchStub = vi.fn<typeof fetch>((_url, init) => {
        const signal = init?.signal ?? undefined;
        timeouts.push(signal === undefined ? Number.NaN : (issued.get(signal) ?? Number.NaN));
        return Promise.resolve(new Response('down', { status: 503 }));
    });
    vi.stubGlobal('fetch', fetchStub);
    return { fetch: fetchStub, timeouts };
}
