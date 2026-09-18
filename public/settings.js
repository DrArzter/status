import { deriveAccent, parseHex } from "/accent.js";
import {
  accent, activeTheme, applyPreference, DEFAULT_ACCENT, icon, setAccent, setThemePreference,
  THEME_GLYPH, themePreference, THEMES, watchSystem,
} from "/theme.js";

const BACK_GLYPH = "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z";
const LABEL = { system: "System", light: "Light", dark: "Dark" };

/** A starting point, not a limit: the field beside it takes any colour. */
const SUGGESTED = ["#1a73e8", "#1e8e3e", "#8430ce", "#d93025", "#e8710a", "#00838f", "#c2185b", "#5f6368"];

document.getElementById("back").replaceChildren(icon(BACK_GLYPH));
document.getElementById("back").setAttribute("aria-label", "Back to the status page");

function paintThemes() {
  const chosen = themePreference();
  document.getElementById("themes").replaceChildren(...THEMES.map((name) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(name === chosen));
    chip.append(icon(THEME_GLYPH[name], 16), document.createTextNode(LABEL[name]));
    chip.addEventListener("click", () => {
      setThemePreference(name);
      paintThemes();
      paintAccent();
    });
    return chip;
  }));
}

function paintSwatches() {
  const chosen = accent();
  document.getElementById("swatches").replaceChildren(...SUGGESTED.map((colour) => {
    const swatch = document.createElement("button");
    swatch.className = "swatch";
    swatch.type = "button";
    swatch.style.background = colour;
    swatch.title = colour;
    swatch.setAttribute("aria-label", colour);
    swatch.setAttribute("aria-pressed", String(colour === chosen));
    swatch.addEventListener("click", () => choose(colour));
    return swatch;
  }));
}

/**
 * Says what the page will actually paint. A pick is a hue, not a contrast
 * ratio; when the two disagree the ink moves and this is where that is
 * admitted, rather than the page quietly using a different colour.
 */
function paintAccent() {
  const chosen = accent();
  const theme = activeTheme();
  document.getElementById("accent").value = chosen;
  const hex = document.getElementById("hex");
  if (document.activeElement !== hex) hex.value = chosen;
  document.getElementById("reset").disabled = chosen === DEFAULT_ACCENT;

  const derived = deriveAccent(chosen, theme);
  document.getElementById("note").textContent = derived === null
    ? ""
    : derived.adjusted
      ? `Moved for the ${theme} theme so text on it stays readable. Links and labels use ${derived.ink}.`
      : `Readable as picked. Links and labels use ${derived.ink}.`;
  paintSwatches();
}

function choose(colour) {
  if (parseHex(colour) === null) return;
  setAccent(colour.trim().toLowerCase());
  paintAccent();
}

document.getElementById("accent").addEventListener("input", (event) => choose(event.target.value));
document.getElementById("hex").addEventListener("input", (event) => choose(event.target.value));
document.getElementById("reset").addEventListener("click", () => choose(DEFAULT_ACCENT));

watchSystem(() => { paintThemes(); paintAccent(); });

applyPreference(themePreference());
paintThemes();
paintAccent();
