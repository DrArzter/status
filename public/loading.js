/**
 * Two guards on a loading state, from opposite sides, as the console has them.
 *
 * It waits before appearing, so an answer that arrives in a blink shows nothing
 * at all; once it has appeared it stays long enough to be read, so it never
 * flickers past. This page is cached for a minute and asks every minute, so
 * most answers arrive in a blink: without the first guard the card would flash
 * on nearly every load, which is worse than no card at all.
 */
export const LOADING_DELAY_MS = 200;
export const LOADING_MINIMUM_MS = 450;

/**
 * Arms a loading state and hands back the way to finish with it.
 *
 * `settle` is given the revealing and the painting together rather than being
 * run after them: the bars measure the width of their element, and an element
 * still inside something hidden measures zero. So nothing is painted until the
 * loading state is actually done with.
 *
 * `continues` is for a state that follows one already on screen. It skips the
 * wait, because the reader is already looking at a card, and keeps only the
 * floor.
 */
export function loadingCard(show, { continues = false, now = () => Date.now() } = {}) {
  let shownAt = null;
  let timer = null;

  if (continues) {
    shownAt = now();
    show();
  } else {
    timer = setTimeout(() => {
      shownAt = now();
      timer = null;
      show();
    }, LOADING_DELAY_MS);
  }

  return function publish(settle) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const remaining = shownAt === null ? 0 : Math.max(0, LOADING_MINIMUM_MS - (now() - shownAt));
    if (remaining === 0) settle();
    else setTimeout(settle, remaining);
  };
}
