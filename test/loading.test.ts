import { afterEach, describe, expect, it, vi } from "vitest";

import { loadingCard, LOADING_DELAY_MS, LOADING_MINIMUM_MS } from "../public/loading.js";

afterEach(() => vi.useRealTimers());

/**
 * A run of the guard against a clock we hold still. `finishAt` is when the
 * answer arrives; the result says whether a card was ever put on screen and
 * when the page was allowed to paint.
 */
function run(finishAt: number) {
  vi.useFakeTimers();
  const at = () => Date.now();
  let shown: number | null = null;
  let settled: number | null = null;

  const start = at();
  const publish = loadingCard(() => { shown = at() - start; });

  vi.advanceTimersByTime(finishAt);
  publish(() => { settled = at() - start; });
  vi.advanceTimersByTime(60_000);

  return { shown, settled };
}

describe("a loading state that neither flashes nor flickers", () => {
  it("shows nothing at all when the answer beats the wait", () => {
    const { shown, settled } = run(LOADING_DELAY_MS - 1);
    // The common case on this page: the API is cached for a minute, so most
    // loads are a blink and the reader should see no card whatsoever.
    expect(shown).toBeNull();
    expect(settled).toBe(LOADING_DELAY_MS - 1);
  });

  it("holds a card that did appear long enough to be read", () => {
    const { shown, settled } = run(LOADING_DELAY_MS + 50);
    expect(shown).toBe(LOADING_DELAY_MS);
    // The answer was ready 50 ms after the card went up, and the page still
    // waits out the floor rather than replacing a card nobody could read.
    expect(settled).toBe(LOADING_DELAY_MS + LOADING_MINIMUM_MS);
  });

  it("does not hold anything back once the floor is already past", () => {
    const slow = LOADING_DELAY_MS + LOADING_MINIMUM_MS + 800;
    const { shown, settled } = run(slow);
    expect(shown).toBe(LOADING_DELAY_MS);
    expect(settled).toBe(slow);
  });

  it("skips the wait for a state that continues one already on screen", () => {
    vi.useFakeTimers();
    const start = Date.now();
    let shown: number | null = null;
    let settled: number | null = null;

    const publish = loadingCard(() => { shown = Date.now() - start; }, { continues: true });
    expect(shown).toBe(0);

    vi.advanceTimersByTime(10);
    publish(() => { settled = Date.now() - start; });
    vi.advanceTimersByTime(60_000);

    // The reader has been looking at a card for 10 ms, so the floor still has
    // most of its time to run.
    expect(settled).toBe(LOADING_MINIMUM_MS);
  });
});
