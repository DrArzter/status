/**
 * One chosen colour, turned into the accent variables the page reads.
 *
 * The console has the same maths in TypeScript. It is copied rather than
 * shared: this page must not depend on anything it watches, and a colour
 * function is a cheaper duplicate than a dependency.
 */

const GROUND = {
  light: { surface: [255, 255, 255], canvas: [241, 241, 241], onCandidates: [[255, 255, 255], [31, 31, 31]], stateAlpha: 0.08 },
  dark: { surface: [51, 51, 51], canvas: [34, 34, 34], onCandidates: [[34, 34, 34], [255, 255, 255]], stateAlpha: 0.14 },
};

export const DEFAULT_ACCENT = "#1a73e8";
const TEXT_CONTRAST = 4.5;
const STORAGE_KEY = "status.accent";

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function parseHex(value) {
  const hex = String(value).trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
}

export const toHex = (rgb) => `#${rgb.map((c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, "0")).join("")}`;

const channel = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export function contrast(a, b) {
  const first = luminance(a), second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function toHsl([r, g, b]) {
  const red = r / 255, green = g / 255, blue = b / 255;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const span = max - min;
  const s = l > 0.5 ? span / (2 - max - min) : span / (max + min);
  const h = max === red
    ? ((green - blue) / span + (green < blue ? 6 : 0))
    : max === green ? (blue - red) / span + 2 : (red - green) / span + 4;
  return [h / 6, s, l];
}

function fromHsl([h, s, l]) {
  if (s === 0) { const grey = Math.round(l * 255); return [grey, grey, grey]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const at = (offset) => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(at(1 / 3) * 255), Math.round(at(0) * 255), Math.round(at(-1 / 3) * 255)];
}

const shift = (colour, delta) => { const [h, s, l] = toHsl(colour); return fromHsl([h, s, clamp(l + delta, 0, 1)]); };

/** Readable on every ground it can land on, not just the lightest one. */
function readableOn(colour, grounds, target = TEXT_CONTRAST) {
  const worst = (candidate) => Math.min(...grounds.map((ground) => contrast(candidate, ground)));
  if (worst(colour) >= target) return { colour, adjusted: false };
  const lightest = grounds.reduce((a, b) => (luminance(a) >= luminance(b) ? a : b));
  const away = luminance(lightest) > 0.5 ? -0.01 : 0.01;
  let candidate = colour;
  for (let step = 0; step < 100; step += 1) {
    candidate = shift(candidate, away);
    if (worst(candidate) >= target) return { colour: candidate, adjusted: true };
  }
  const ends = [[0, 0, 0], [255, 255, 255]];
  return { colour: ends.reduce((a, b) => (worst(a) >= worst(b) ? a : b)), adjusted: true };
}

export function deriveAccent(accent, theme) {
  const picked = parseHex(accent);
  if (picked === null) return null;
  const ground = GROUND[theme];

  let fill = picked;
  let onFill = ground.onCandidates[0];
  for (let step = 0; step < 100; step += 1) {
    const best = [...ground.onCandidates].sort((a, b) => contrast(b, fill) - contrast(a, fill))[0];
    onFill = best;
    if (contrast(best, fill) >= TEXT_CONTRAST) break;
    fill = shift(fill, theme === "dark" ? 0.01 : -0.01);
  }

  const ink = readableOn(picked, [ground.surface, ground.canvas]);
  return {
    adjusted: ink.adjusted,
    ink: toHex(ink.colour),
    tokens: {
      "--primary": toHex(fill),
      "--primary-ink": toHex(ink.colour),
      "--on-primary": toHex(onFill),
      "--primary-state": `rgba(${fill[0]}, ${fill[1]}, ${fill[2]}, ${ground.stateAlpha})`,
    },
  };
}

export function applyAccent(root, accent, theme) {
  const derived = deriveAccent(accent, theme);
  if (derived === null) return null;
  for (const [name, value] of Object.entries(derived.tokens)) root.style.setProperty(name, value);
  return derived;
}

export function getStoredAccent() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored !== null && parseHex(stored) !== null ? stored.toLowerCase() : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function persistAccent(accent) {
  try {
    window.localStorage.setItem(STORAGE_KEY, accent);
  } catch {
    // The colour still applies for this visit when storage is blocked.
  }
}
