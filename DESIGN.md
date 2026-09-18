# Design

This page is a sibling of the Spawnpoint console, not a second visual world. The system is recorded once, in
[`spawnpoint/web/DESIGN.md`](https://github.com/DrArzter/spawnpoint/blob/main/web/DESIGN.md): the Google Cloud console
grammar, flat surfaces, status always an icon plus a label, and three faces — Google Sans Flex for titles, Roboto for
everything functional, Roboto Mono for anything meant to be compared.

What follows is only what this page decides for itself.

## Greys

Neutral, and a step apart: `#222` ground, `#333` cards, `#262626` for a well sunk into a card. No blue cast, which is
the visible difference from the console's older dark theme — the console now carries the same greys.

In dark there are effectively no borders. A card is told apart from its ground by being lighter, and the hairline
survives at 7% white for the places where lightness alone cannot do it. In light it is the other way round: white
cards on `#f1f1f1` still need the line, so the line stays.

## Accent

The reader picks it, from the well in the app bar. It is a browser preference here and nothing more — this page has no
sign-in, so there is nobody to store it against; the console stores the same choice against an identity instead.

A pick is a hue, not a contrast ratio, so `accent.js` never uses one directly. The fill keeps the chosen colour and
takes whichever of black or white can be read on it; the ink for links and labels is walked along its own lightness
until it clears 4.5:1 against **every** ground it can land on — the card and the canvas both, because clearing only the
lighter one is how a palette looks right on a card and fails behind it. The same maths lives in the console in
TypeScript, copied rather than shared: this page must not depend on anything it watches.

## The board

One window governs the page, so the pills that choose it sit in their own bar above everything.

Then three things, in the order a reader wants them: the verdict, every service at once, then each service on its own.

- **The overview** answers the whole page — a sentence, a ring of every check in the window, and the response trend
  beside it. The ring counts checks rather than services, because a service that failed twice in ninety days is not
  half a service.
- **The strip** is the reason the page is worth opening. Every service is one row, and all rows share one axis, so an
  hour that hit everything reads as a vertical band down the card. A stack of per-service cards cannot show that.
- **The cards** carry what the strip leaves out: response, uptime, last check, and the note a service needs.

## Bars

One bar is one bucket. A bucket with no checks is drawn unlit rather than skipped, and the window is drawn whole
before there is history to fill it: a service watched since yesterday shows ninety days of strip with the earlier part
standing empty, rather than a handful of bars huddled at one end pretending to be the window. An empty bar says "no
data yet" when a reader points at it. Colour never carries the meaning alone: every bar names the stretch it covers,
how long that is, and what it found, and each card states its condition in words. The axis carries its two ends and
nothing between them: a line under the strip restating how wide a bar is answered a question the reader had not asked,
in the one place the eye goes after the bars themselves. A reader who does want the figure gets it from any bar.

**Every window draws exactly the same number of bars**, and that is chosen ahead of precision. The server cuts each
window to roughly ninety buckets, and the page then folds every one of them to 84 — the smallest count any window
produces, so nothing ever has to stretch.

Equal counts are the whole point. The bars fill the track, so a different count is a different bar width: at 93 bars a
day and 84 a week, switching the window nudged every bar a fraction sideways. The strip should be the one thing on the
page that does not move when the window changes, and it now measures the same to the pixel in all five.

Folding is proportional rather than by a whole factor — 91 into 84 is a run of singles with a double every so often,
where a whole factor would give 46. It merges rather than clips, because clipping would silently drop the oldest end
of the window, which is exactly what the axis label promises. The same fold handles a phone, where a bar simply covers
more time.

A bar is five pixels wide, so its tooltip is the page's own rather than the browser's: the pointer's position along
the track picks the bar, which means the gaps between bars are not dead ground and nothing waits a second to appear.

## Two detector warnings that stand

The mechanical detector flags two things here. Both are deliberate:

- **Roboto is an overused face.** It is also the console's body face, pinned by its design system. Matching it is the
  point of this page.
- **The boot progress bar loops.** It is an indeterminate progress indicator copied from the console's boot card, not a
  marquee of content, and it is gone the moment the first answer arrives.
