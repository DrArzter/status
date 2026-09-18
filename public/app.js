import { loadingCard } from "./loading.js";
import { activeTheme, ADMIN_GLYPH, applyPreference, DOOR_GLYPH, icon, SETTINGS_GLYPH, setThemePreference, THEME_GLYPH, themePreference, watchSystem } from "./theme.js";

const NS = "http://www.w3.org/2000/svg";
const SPARK_WIDTH = 360;
const SPARK_HEIGHT = 128;
const LINE_WIDTH = 480;
const LINE_HEIGHT = 160;
const DONUT_R = 52;
const DONUT_C = 2 * Math.PI * DONUT_R;

const RANGE_LABEL = { day: "Day", week: "Week", month: "Month", quarter: "3 months", year: "9 months" };
const RANGE_START = { day: "24 hours ago", week: "7 days ago", month: "30 days ago", quarter: "90 days ago", year: "9 months ago" };

// The windows this page can draw, which is also what it may ask for. The
// address bar is somebody's input, so the name is looked up in this list and
// the list's own string is what travels on — never the one that was typed. The
// server refuses an unknown window too; agreeing here keeps a typed URL from
// selecting a tab that the answer is about to correct.
const WINDOWS = Object.keys(RANGE_LABEL);
const known = (name) => WINDOWS.find((window) => window === name);
let range = known(new URLSearchParams(location.search).get("range")) ?? "day";

// The same Material glyphs the console uses, so a status reads identically here.
const GLYPH = {
  up: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z",
  down: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z",
  unknown: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z",
};

const LABEL = { up: "Operational", down: "Down", unknown: "No data" };

const EMPTY_GLYPH = { unreachable: GLYPH.down, nothing: GLYPH.unknown };

const element = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

const clone = (id) => document.getElementById(id).content.cloneNode(true);

const totals = (buckets) => buckets.reduce(
  (sum, bucket) => ({ checks: sum.checks + bucket.checks, failures: sum.failures + bucket.failures }),
  { checks: 0, failures: 0 },
);

const percent = (checks, failures) => (checks === 0 ? "—" : `${(100 - (failures / checks) * 100).toFixed(2)}%`);

const relative = (at) => {
  if (!at) return "never";
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

const DAY_MS = 86_400_000;

/** How long one bar covers, in the coarsest unit that stays a whole number. */
function spanLabel(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  // Folding makes the average a fraction, and "8.67 hours" is not how anybody
  // says it. The label already carries "about" when the bars are uneven.
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(minutes / 1440);
  return days === 1 ? "1 day" : `${days} days`;
}

/** The stretch of time a bar stands for, said as a reader would say it. */
function coverLabel(at, span) {
  const start = new Date(at);
  const dayOnly = { day: "numeric", month: "short" };
  const clock = { hour: "2-digit", minute: "2-digit" };
  if (span < DAY_MS) {
    const end = new Date(at + span);
    return `${start.toLocaleDateString(undefined, dayOnly)}, ${start.toLocaleTimeString(undefined, clock)} – ${end.toLocaleTimeString(undefined, clock)}`;
  }
  if (span === DAY_MS) return start.toLocaleDateString(undefined, dayOnly);
  const last = new Date(at + span - 1);
  return `${start.toLocaleDateString(undefined, dayOnly)} – ${last.toLocaleDateString(undefined, dayOnly)}`;
}

function paintStatus(target, state, detail) {
  const icon = element("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
  icon.append(element("path", { d: GLYPH[state] }));
  const label = document.createElement("span");
  label.textContent = detail ? `${LABEL[state]} · ${detail}` : LABEL[state];
  target.className = `status status-${state}`;
  target.replaceChildren(icon, label);
}

// A failure is a state with an explanation and a way out, never an empty box.
function showEmpty(kind, title, description, action) {
  const card = clone("empty-state");
  const icon = element("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
  icon.append(element("path", { d: EMPTY_GLYPH[kind] }));
  card.querySelector(".empty-icon").append(icon);
  card.querySelector("strong").textContent = title;
  card.querySelector("p").textContent = description;
  if (action) {
    const button = document.createElement("button");
    button.className = "btn";
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", action.onClick);
    card.querySelector(".empty").append(button);
  }
  document.getElementById("state").replaceChildren(card);
  for (const id of ["overview", "strip", "board"]) document.getElementById(id).hidden = true;
}

/**
 * Keeps a finger's drag with the element it started on, so the reading follows
 * a finger that wanders off. It is an improvement on the drag and never a
 * condition of it: a refused capture must not cost the reader the tap that
 * asked for it.
 */
function capture(element, event) {
  if (event.pointerType === "mouse") return;
  try {
    element.setPointerCapture(event.pointerId);
  } catch { /* the pointer is gone, or was never ours to hold */ }
}

const tip = document.createElement("div");
tip.className = "bar-tip";
tip.hidden = true;

function trackTip(strip) {
  // Slack above and below each track, so a finger aimed at a twenty-pixel strip
  // of bars inside a forty-six-pixel row still lands on it.
  const REACH = 12;

  /**
   * Which service the pointer is over, found by where it is rather than by what
   * it is on top of. Once the pointer is captured every event reports the strip
   * itself as its target, so asking the target which row it belongs to answers
   * "none" for the whole of a drag — which is what made this useless to a
   * finger while it worked perfectly under a mouse.
   */
  const trackAt = (y) => [...strip.querySelectorAll(".bars")].find((bars) => {
    const box = bars.getBoundingClientRect();
    return y >= box.top - REACH && y <= box.bottom + REACH;
  });

  const follow = (event) => {
    const bars = trackAt(event.clientY);
    if (bars === undefined || bars.children.length === 0) { tip.hidden = true; return; }
    const track = bars.getBoundingClientRect();
    // The index comes from where the pointer is along the track, so the gaps
    // between bars answer as the bar beside them.
    const along = (event.clientX - track.left) / track.width;
    const bar = bars.children[Math.min(bars.children.length - 1, Math.max(0, Math.floor(along * bars.children.length)))];
    tip.textContent = bar.dataset.tip ?? "";
    tip.hidden = false;

    const card = strip.getBoundingClientRect();
    const width = tip.getBoundingClientRect().width;
    const left = Math.min(Math.max(event.clientX - card.left - width / 2, 8), card.width - width - 8);
    tip.style.left = `${Math.max(left, 8)}px`;
    tip.style.top = `${track.top - card.top - 34}px`;
  };

  const hide = () => { tip.hidden = true; };
  const lifted = (event) => { if (event.pointerType !== "mouse") hide(); };
  strip.addEventListener("pointerdown", (event) => {
    capture(strip, event);
    follow(event);
  });
  strip.addEventListener("pointermove", follow);
  // A finger lifted is a finger gone, and the reading goes with it. A mouse
  // button released is a click in the middle of a hover: the pointer is still
  // sitting on the bar it is asking about, so clearing the reading there just
  // makes the page blink at somebody for pressing it.
  strip.addEventListener("pointerup", lifted);
  strip.addEventListener("pointercancel", lifted);
  strip.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse") hide(); });
}

/**
 * The narrowest a bar may be, which is what decides how many fit.
 *
 * A mouse can sit on a two-pixel sliver and a finger cannot. On a touch screen
 * the same track was drawing seventy-five bars two pixels wide: unreadable, and
 * nothing anybody could aim at. Wider bars mean fewer of them, which is the
 * right trade — a phone is not where you count individual quarter hours.
 */
const coarse = window.matchMedia("(pointer: coarse)");
const MIN_BAR = () => (coarse.matches ? 8 : 2);
/**
 * The bar count every window is folded to.
 *
 * It is the smallest count the server produces (the week, at 84), so no window
 * ever has to stretch. Equal counts are the whole point: the bars fill the
 * track, so a different count means a different bar width, and switching the
 * window would shift every bar a fraction. The strip should be the one thing
 * on the page that does not move when the window changes.
 */
const BARS = 84;

/**
 * Folds a series to exactly `count` bars, by proportion rather than by a whole
 * number of buckets each: 91 into 84 is a run of singles with a double every
 * so often, and the alternative — a whole factor — would give 46.
 *
 * Merging rather than clipping keeps the axis honest. Clipping would quietly
 * drop the oldest end of the window, which is exactly what the label promises.
 */
function fold(buckets, count) {
  if (buckets.length <= count) return buckets.map((bucket) => ({ ...bucket, span: 1 }));
  const folded = [];
  for (let bar = 0; bar < count; bar += 1) {
    const from = Math.floor((bar * buckets.length) / count);
    const to = Math.floor(((bar + 1) * buckets.length) / count);
    const slice = buckets.slice(from, Math.max(to, from + 1));
    const checks = slice.reduce((sum, bucket) => sum + bucket.checks, 0);
    folded.push({
      at: slice[0].at,
      span: slice.length,
      checks,
      failures: slice.reduce((sum, bucket) => sum + bucket.failures, 0),
      // Weighted, so a bar holding one quiet check does not outvote a busy one.
      p50_ms: checks === 0 ? 0 : Math.round(slice.reduce((sum, bucket) => sum + bucket.p50_ms * bucket.checks, 0) / checks),
    });
  }
  return folded;
}

/** How many bars this width can hold, never more than the standard count. */
const roomFor = (width, gap) => Math.max(1, Math.min(BARS, Math.floor((width + gap) / (MIN_BAR() + gap))));

// One bucket is one bar. An empty bucket is drawn unlit rather than left out,
// so a gap in the history stays visible instead of closing over itself.
function drawBars(target, series, bucketMs) {
  const gap = 2;
  const buckets = fold(series, roomFor(target.clientWidth || target.getBoundingClientRect().width, gap));
  target.replaceChildren(...buckets.map((bucket) => {
    const ratio = bucket.checks > 0 ? bucket.failures / bucket.checks : null;
    const bar = document.createElement("i");
    bar.className = `bar ${ratio === null ? "" : ratio === 0 ? "bar-ok" : ratio < 0.1 ? "bar-warn" : "bar-down"}`.trim();
    // Every bar says what it covers as well as what it found: a coloured
    // sliver a reader cannot date is decoration. It goes in a data attribute
    // rather than `title`, because a native tooltip on a five-pixel target is
    // a tooltip nobody sees.
    const span = bucket.span * bucketMs;
    bar.dataset.tip = bucket.checks === 0
      ? `${coverLabel(bucket.at, span)} · no data yet`
      : `${coverLabel(bucket.at, span)} · ${spanLabel(span)} · ${bucket.checks - bucket.failures} of ${bucket.checks} passed · median ${bucket.p50_ms} ms`;
    return bar;
  }));
}

// Median response over the window. One line, no axes: it answers "is it getting
// slower", which is the only question a status page asks of it. The readings
// come back with it, each carrying where it was drawn, so the pointer can name
// one without the chart being measured a second time.
function drawSpark(target, buckets) {
  const known = buckets.filter((bucket) => bucket.checks > 0);
  const peak = known.length === 0 ? 0 : Math.max(...known.map((bucket) => bucket.p50_ms), 1);
  const series = plot(buckets, peak, SPARK_HEIGHT, 16);
  if (known.length < 2) { target.replaceChildren(); return { peak, series }; }
  const points = series
    .filter((point) => point.value !== null)
    .map((point) => `${(point.x * SPARK_WIDTH).toFixed(2)},${(point.y * SPARK_HEIGHT).toFixed(2)}`)
    .join(" ");
  target.replaceChildren(element("polyline", { points, class: "spark-line" }));
  return { peak, series };
}

/**
 * Where each bucket lands, as fractions of the box rather than as its
 * coordinates: the same numbers place the line inside a stretched viewBox and
 * the crosshair on top of it in CSS pixels, so the two cannot drift apart.
 * A bucket nobody measured keeps its place on the axis and carries no height.
 */
function plot(buckets, peak, height, pad) {
  const last = Math.max(buckets.length - 1, 1);
  return buckets.map((bucket, index) => ({
    at: bucket.at,
    value: bucket.checks === 0 ? null : bucket.p50_ms,
    x: index / last,
    y: bucket.checks === 0 || peak === 0
      ? null
      : (height - pad - (bucket.p50_ms / peak) * (height - pad * 2)) / height,
  }));
}

const HANDLING_LABEL = {
  investigating: "Investigating",
  identified: "Cause found",
  monitoring: "Watching it",
  resolved: "Resolved",
};

const CAUSE_LABEL = {
  cloudflare: "Cloudflare",
  aws: "AWS",
  upstream: "an upstream service",
  us: "us",
  unknown: "not known yet",
};

/**
 * What the probes say, which is a separate fact from whether anybody has closed
 * this. An incident opened by hand sits on a service answering perfectly well,
 * so "still failing its checks" would be a lie about half of them.
 */
function checksSay(incident, state) {
  if (incident.endedAt !== null) return `answering again ${relative(incident.endedAt)}`;
  return state === "down" ? "still failing its checks" : "checks are passing";
}

/**
 * What the probes cannot say, above everything they can.
 *
 * Two facts sit side by side and are not the same: whether the service answers,
 * which the strip below already shows, and what is being done about it, which
 * only a person can write. An incident whose checks have recovered but which
 * nobody has closed says both — the service is back, somebody is still on it.
 */
function paintIncidents(payload) {
  const open = (payload.incidents ?? []).filter((incident) => incident.endedAt === null || incident.handling !== "resolved");
  const stateOf = new Map((payload.projects ?? []).map((project) => [project.id, project.state]));
  document.getElementById("incidents").replaceChildren(...open.map((incident) => {
    const card = clone("incident-card");
    card.querySelector(".incident").classList.add(incident.endedAt === null ? "incident-live" : "incident-recovered");
    card.querySelector(".incident-name").textContent = incident.name ?? incident.projectId;

    const handling = card.querySelector(".incident-handling");
    handling.textContent = HANDLING_LABEL[incident.handling] ?? incident.handling;
    handling.className = `incident-handling handling-${incident.handling}`;

    const since = `since ${relative(incident.startedAt)}`;
    const back = checksSay(incident, stateOf.get(incident.projectId));
    const cause = incident.cause === null ? null : `cause: ${CAUSE_LABEL[incident.cause] ?? incident.cause}`;
    card.querySelector(".incident-when").textContent = [since, back, cause].filter(Boolean).join(" · ");

    card.querySelector(".incident-updates").replaceChildren(...incident.updates.map((update) => {
      const item = document.createElement("li");
      const when = document.createElement("span");
      when.className = "incident-at";
      when.textContent = relative(update.at);
      const body = document.createElement("span");
      body.textContent = update.body;
      item.append(when, body);
      return item;
    }));
    return card;
  }));
}

/**
 * The window in one card: the verdict, a ring of every check behind it, and
 * the response trend beside it. The ring counts checks rather than services,
 * because a service that failed twice in ninety days is not half a service.
 */
function paintOverview(payload) {
  const card = clone("overview-card");
  const down = payload.projects.filter((project) => project.state === "down");
  const unknown = payload.projects.filter((project) => project.state === "unknown");
  const state = down.length > 0 ? "down" : payload.projects.some((project) => project.state === "up") ? "up" : "unknown";

  const verdict = card.querySelector(".verdict");
  verdict.className = `verdict verdict-${state}`;
  verdict.textContent = state === "down"
    ? down.map((project) => project.name).join(", ")
    : state === "up" ? "Everything is running" : "Nothing has been checked yet";

  const counted = [
    `${payload.projects.length} ${payload.projects.length === 1 ? "service" : "services"}`,
    down.length > 0 ? `${down.length} down` : null,
    unknown.length > 0 ? `${unknown.length} without data` : null,
  ].filter(Boolean).join(" · ");
  const checked = payload.projects.map((project) => project.checkedAt).filter(Boolean);
  card.querySelector(".verdict-sub").textContent =
    `${counted} · checked ${checked.length === 0 ? "never" : relative(Math.max(...checked))}`;

  const across = payload.projects.reduce((sum, project) => {
    const one = totals(project.buckets);
    return { checks: sum.checks + one.checks, failures: sum.failures + one.failures };
  }, { checks: 0, failures: 0 });

  const ring = card.querySelector(".donut svg");
  if (across.checks > 0) {
    const failed = (across.failures / across.checks) * DONUT_C;
    // Failures first, so the eye lands on the gap rather than hunting for it.
    ring.append(element("circle", {
      class: "donut-arc donut-down", cx: 60, cy: 60, r: DONUT_R,
      "stroke-dasharray": `${failed.toFixed(2)} ${(DONUT_C - failed).toFixed(2)}`,
    }));
    ring.append(element("circle", {
      class: "donut-arc donut-ok", cx: 60, cy: 60, r: DONUT_R,
      "stroke-dasharray": `${(DONUT_C - failed).toFixed(2)} ${failed.toFixed(2)}`,
      "stroke-dashoffset": `${-failed.toFixed(2)}`,
    }));
  }
  card.querySelector(".donut-count").textContent = across.checks.toLocaleString();
  card.querySelector(".donut-label").textContent = across.checks === 1 ? "check" : "checks";
  card.querySelector(".donut-rate").textContent = across.checks === 0
    ? "nothing checked in this window"
    : `${percent(across.checks, across.failures)} of them passed`;

  const line = drawLine(card.querySelector(".line-chart"), payload.projects);
  const linePlot = card.querySelector(".overview-chart .plot");
  paintAxes(linePlot, line.series, line.peak, LINE_HEIGHT, 16);
  trackPlot(linePlot, line.series, payload.bucketMs);
  card.querySelector(".chart-window").textContent =
    `${RANGE_LABEL[payload.range] ?? payload.range} · from ${RANGE_START[payload.range] ?? "the start"}`;

  document.getElementById("overview").replaceChildren(card);
  return across;
}

/**
 * One line for the whole page: every project's median, averaged per bucket and
 * placed at the bucket's own time. Placing readings by their position among the
 * measured ones instead would spread an hour of history across ninety days.
 */
function drawLine(target, projects) {
  const longest = projects.reduce((found, project) => project.buckets.length > found.length ? project.buckets : found, []);
  const merged = longest.map((bucket, index) => {
    let weight = 0;
    let total = 0;
    for (const project of projects) {
      const one = project.buckets[index];
      if (one === undefined || one.checks === 0) continue;
      weight += one.checks;
      total += one.p50_ms * one.checks;
    }
    return { at: bucket.at, checks: weight, p50_ms: weight === 0 ? 0 : total / weight };
  });
  const known = merged.filter((bucket) => bucket.checks > 0);
  const peak = known.length === 0 ? 0 : Math.max(...known.map((bucket) => bucket.p50_ms), 1);
  const series = plot(merged, peak, LINE_HEIGHT, 16);
  if (known.length < 2) { target.replaceChildren(); return { peak, series }; }

  const drawn = series.filter((point) => point.value !== null);
  const points = drawn.map((point) => `${(point.x * LINE_WIDTH).toFixed(2)},${(point.y * LINE_HEIGHT).toFixed(2)}`);
  const from = (drawn[0].x * LINE_WIDTH).toFixed(2);
  const to = (drawn[drawn.length - 1].x * LINE_WIDTH).toFixed(2);
  target.replaceChildren(
    element("polygon", { class: "line-area", points: `${from},${LINE_HEIGHT} ${points.join(" ")} ${to},${LINE_HEIGHT}` }),
    element("polyline", { class: "line-path", points: points.join(" ") }),
  );
  return { peak, series };
}

/**
 * A tick on the time axis. What it should say follows the window, not the
 * bucket: a week is read in days however finely it was measured, and a clock
 * time on a seven-day axis names a moment that comes round seven times.
 */
const tickLabel = (at, windowMs) => {
  const when = new Date(at);
  return windowMs <= 2 * DAY_MS
    ? when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/**
 * The axes. The line is normalised to its own peak, so without a number beside
 * it a busy window and a quiet one draw the same shape — two readings up the
 * side say which is which, and three along the bottom say when. Drawn in the
 * box rather than around it: the card has no room for a gutter, and the
 * stretched viewBox would distort any text put inside the drawing itself.
 */
function paintAxes(container, series, peak, height, pad) {
  const vertical = container.querySelector(".axis-y");
  const horizontal = container.querySelector(".axis-x");
  vertical.replaceChildren();
  horizontal.replaceChildren();
  const measured = series.filter((point) => point.value !== null);
  if (peak === 0 || measured.length === 0) return;

  for (const value of [peak, peak / 2]) {
    const at = `${((height - pad - (value / peak) * (height - pad * 2)) / height) * 100}%`;
    const rule = document.createElement("i");
    rule.className = "grid";
    rule.style.top = at;
    const label = document.createElement("span");
    label.className = "grid-label";
    label.style.top = at;
    label.textContent = value === peak ? `${Math.round(value)} ms` : `${Math.round(value)}`;
    vertical.append(rule, label);
  }

  const last = series[series.length - 1];
  const middle = series[Math.floor((series.length - 1) / 2)];
  const windowMs = last.at - series[0].at;
  for (const [point, place] of [[series[0], "start"], [middle, "middle"], [last, "end"]]) {
    const tick = document.createElement("span");
    tick.className = `tick tick-${place}`;
    tick.textContent = tickLabel(point.at, windowMs);
    horizontal.append(tick);
  }
}

/** A single moment, short enough to sit under a crosshair. */
const momentLabel = (at, span) => {
  const when = new Date(at);
  const date = when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return span < DAY_MS
    ? `${date}, ${when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : date;
};

/**
 * The crosshair. The charts carry a median and nothing else — no band, no
 * extremes — so the one thing a reader can ask of a point is when it was and
 * what it read, and pointing at it should answer both on the axis it belongs to.
 */
function trackPlot(container, series, span) {
  const chart = container.querySelector("svg");
  const parts = ["cross-v", "cross-h", "cross-dot", "cross-value", "cross-time"]
    .map((name) => container.querySelector(`.${name}`));
  const hide = () => { for (const part of parts) part.hidden = true; };
  const [vertical, horizontal, dot, value, time] = parts;
  if (series.length === 0) { hide(); return; }

  const follow = (event) => {
    const box = chart.getBoundingClientRect();
    if (box.width === 0) return;
    const along = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    const point = series[Math.round(along * (series.length - 1))];
    if (point === undefined) { hide(); return; }

    vertical.hidden = false;
    vertical.style.left = `${point.x * 100}%`;
    time.hidden = false;
    time.textContent = momentLabel(point.at, span);
    time.style.left = `${point.x * 100}%`;

    const measured = point.value !== null;
    horizontal.hidden = !measured;
    dot.hidden = !measured;
    value.hidden = false;
    value.textContent = measured ? `${Math.round(point.value)} ms` : "no data yet";
    if (measured) {
      horizontal.style.top = `${point.y * 100}%`;
      dot.style.left = `${point.x * 100}%`;
      dot.style.top = `${point.y * 100}%`;
      value.style.top = `${point.y * 100}%`;
    } else {
      value.style.top = "50%";
    }
  };

  // A finger that wanders off the chart mid-drag would otherwise hand the
  // gesture back to the page, and the crosshair would stop following it. The
  // capture keeps the pointer ours until it is lifted; `touch-action: pan-y` in
  // the stylesheet is what lets the page still be scrolled downwards from here.
  container.addEventListener("pointerdown", (event) => {
    capture(container, event);
    follow(event);
  });
  container.addEventListener("pointermove", follow);
  // See the strip: only a finger leaving takes the reading with it.
  const lifted = (event) => { if (event.pointerType !== "mouse") hide(); };
  container.addEventListener("pointerup", lifted);
  container.addEventListener("pointercancel", lifted);
  container.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse") hide(); });
}

/**
 * Every service in one card, sharing one axis. A bad hour that hit everything
 * reads as a vertical band down the card, and that is the thing a stack of
 * per-service cards cannot show.
 */
let painted = null;

function paintStrip(payload) {
  painted = payload;
  const strip = document.getElementById("strip");
  const rows = payload.projects.map((project) => {
    const row = clone("strip-row");
    row.querySelector(".dot").className = `dot dot-${project.state}`;
    const name = row.querySelector(".strip-name span");
    name.textContent = project.name;
    name.title = `${project.name} — ${LABEL[project.state]}`;
    const sums = totals(project.buckets);
    row.querySelector(".bars").setAttribute("aria-label", `${project.name}: ${percent(sums.checks, sums.failures)} up over the window`);
    return row;
  });

  const axis = document.createElement("div");
  axis.className = "strip-axis";
  const scale = document.createElement("span");
  scale.className = "strip-scale";
  const from = document.createElement("span");
  from.textContent = RANGE_START[payload.range] ?? "";
  const now = document.createElement("span");
  now.textContent = "now";
  scale.append(from, now);
  // The empty first cell holds the axis under the bars, not under the names.
  axis.append(document.createElement("span"), scale);

  strip.replaceChildren(...rows, axis);
  // Only now: how many bars fit is measured from the element, and an element
  // that is not in the document yet measures zero.
  strip.querySelectorAll(".bars").forEach((bars, index) => {
    const project = payload.projects[index];
    if (project !== undefined) drawBars(bars, project.buckets, payload.bucketMs);
  });
  strip.append(tip);
  strip.setAttribute("aria-busy", "false");
}

/** The numbers the strip leaves out, one card per service. */
function paintBoard(payload) {
  const template = document.getElementById("project-row");
  document.getElementById("board").replaceChildren(...payload.projects.map((project) => {
    const row = template.content.cloneNode(true);
    const sums = totals(project.buckets);

    const name = row.querySelector(".row-link");
    name.textContent = project.name;
    if (project.link) {
      name.href = project.link.href;
      name.title = project.link.label;
    } else {
      name.replaceWith(Object.assign(document.createElement("strong"), { textContent: project.name, className: "row-name-plain" }));
    }
    const note = row.querySelector(".note");
    if (project.note) note.textContent = project.note;
    else note.remove();

    paintStatus(row.querySelector(".status"), project.state, project.detail);
    const spark = drawSpark(row.querySelector(".spark"), project.buckets);
    const sparkPlot = row.querySelector(".plot");
    paintAxes(sparkPlot, spark.series, spark.peak, SPARK_HEIGHT, 16);
    trackPlot(sparkPlot, spark.series, payload.bucketMs);

    row.querySelector(".ms").textContent = project.ms === null ? "—" : `${project.ms} ms`;
    row.querySelector(".uptime").textContent = percent(sums.checks, sums.failures);
    row.querySelector(".checked").textContent = relative(project.checkedAt);
    return row;
  }));
}

function render(payload) {
  revealShell();
  document.getElementById("state").replaceChildren();
  range = known(payload.range) ?? range;
  paintRanges(payload);

  const empty = payload.projects.length === 0;
  document.getElementById("controls").hidden = empty;
  if (empty) {
    showEmpty("nothing", "No projects are watched yet", "Add one to config/projects.json and deploy; the first check follows within a minute.");
    return;
  }

  for (const id of ["overview", "strip", "board"]) document.getElementById(id).hidden = false;
  paintIncidents(payload);
  paintOverview(payload);
  paintStrip(payload);
  paintBoard(payload);
}

// One tap in the bar flips the theme on screen; the three-way choice, and the
// accent, live on the settings page where there is room to explain them.
function paintThemeButton() {
  const button = document.getElementById("theme");
  const next = activeTheme() === "dark" ? "light" : "dark";
  button.replaceChildren(icon(THEME_GLYPH[next]));
  button.setAttribute("aria-label", `Switch to the ${next} theme`);
  button.title = `Switch to the ${next} theme`;
}

document.getElementById("theme").addEventListener("click", () => {
  setThemePreference(activeTheme() === "dark" ? "light" : "dark");
  paintThemeButton();
});

document.getElementById("settings").replaceChildren(icon(SETTINGS_GLYPH));
document.getElementById("settings").setAttribute("aria-label", "Settings");

/** The third button in the bar, in whichever of its two states applies. */
function paintAdminButton(known) {
  const button = document.getElementById("admin");
  const label = known ? "Admin panel" : "Sign in";
  button.replaceChildren(icon(known ? ADMIN_GLYPH : DOOR_GLYPH));
  button.setAttribute("aria-label", label);
  button.title = label;
}

/**
 * Whether this browser may write, asked of a path Access guards. A reader is
 * redirected to a sign-in page on another origin, which a same-origin fetch is
 * not allowed to read — the same answer as no, and so is a network error. Only
 * a signed-in browser reaches the Worker and comes back with an email.
 */
async function mayWrite() {
  try {
    const response = await fetch("/admin/api/whoami", { cache: "no-store", redirect: "manual" });
    return response.ok;
  } catch {
    return false;
  }
}



watchSystem(paintThemeButton);

// Two loading states, as the console has them. The boot card covers the first
// answer, when nothing is known yet; the skeleton covers a reload that has no
// rows to keep. A refresh with rows on screen shows neither: it replaces them.

function revealShell() {
  const boot = document.getElementById("boot");
  if (boot) boot.remove();
  document.getElementById("shell").hidden = false;
}

function showSkeleton({ replace = false } = {}) {
  const strip = document.getElementById("strip");
  const rows = strip.querySelectorAll(".strip-row").length;
  // A periodic refresh keeps its rows and swaps them in place. A window change
  // replaces them, because what is on screen belongs to a different window.
  if (rows > 0 && !replace) return;
  const template = document.getElementById("skeleton-row");
  strip.replaceChildren(...Array.from({ length: rows || 2 }, () => template.content.cloneNode(true)));
  strip.setAttribute("aria-busy", "true");
}

function paintRanges(payload) {
  const tabs = document.getElementById("ranges");
  tabs.replaceChildren(...payload.ranges.map((name) => {
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.type = "button";
    tab.role = "tab";
    tab.textContent = RANGE_LABEL[name] ?? name;
    tab.setAttribute("aria-selected", String(name === payload.range));
    tab.addEventListener("click", () => {
      if (name === range) return;
      range = name;
      // Move the selection on the click, not when the answer lands: the window
      // has already changed, and the skeleton below says so.
      for (const other of tabs.children) other.setAttribute("aria-selected", String(other === tab));
      const url = new URL(location.href);
      url.searchParams.set("range", name);
      history.replaceState(null, "", url);
      load({ replace: true });
    });
    return tab;
  }));
}

/** The page could not read the checks, which is not the same as their failing. */
function failed(error) {
  revealShell();
  // The whole bar, not the pills inside it: hiding only the tabs leaves the
  // card they sit in as an empty stripe above the message.
  document.getElementById("controls").hidden = true;
  showEmpty(
    "unreachable",
    "The status API did not answer",
    `Checks keep running; this page could not read them. ${error instanceof Error ? error.message : ""}`.trim(),
    { label: "Try again", onClick: () => void load() },
  );
}

// Asked once, on the first load. Whether this browser may write does not change
// while somebody is looking at the page, and a poll a minute should not carry a
// question that has already been answered.
let identified = false;

async function load({ replace = false } = {}) {
  const publish = document.getElementById("boot") === null
    ? loadingCard(() => showSkeleton({ replace }))
    : bootPublish;
  try {
    // Never from the browser's own store. The answer is good for half a minute
    // and the page asks once a minute, so a cache can only ever hand back
    // something staler than what is waiting — and a zone-level browser TTL has
    // already frozen this page once. Repeat asks cost nothing that matters:
    // the Worker answers them from its own cache without reading the database.
    // Both, before anything is drawn. They do not depend on each other, so they
    // are asked at once rather than in turn; what they share is that the page
    // should not appear until both are known. The third button in the bar would
    // otherwise change its face a moment after the reader started looking at
    // it, which is the same flicker this card exists to prevent.
    const [response, known] = await Promise.all([
      fetch(`/api/status?range=${range}`, { cache: "no-store" }),
      identified ? Promise.resolve(null) : mayWrite(),
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    publish(() => {
      if (known !== null) {
        paintAdminButton(known);
        identified = true;
      }
      render(payload);
    });
  } catch (error) {
    publish(() => failed(error));
  }
}

applyPreference(themePreference());
paintThemeButton();
// Armed before the first ask, so the 200 ms is counted from the page opening
// rather than from whenever the fetch happened to start.
const bootPublish = loadingCard(() => { document.getElementById("boot").hidden = false; });
load();

// How many bars fit is a function of the width, so a resize is a repaint.
new ResizeObserver(() => { if (painted !== null) paintStrip(painted); }).observe(document.getElementById("strip"));
trackTip(document.getElementById("strip"));
// Refreshed while somebody is looking, and not while nobody is.
setInterval(() => { if (document.visibilityState === "visible") load(); }, 60000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });
