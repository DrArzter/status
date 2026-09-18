// The page that writes. Everything under /admin is behind Cloudflare Access, so
// there is no sign-in here and no token to keep: the request carries one that
// Access put there, and the Worker checks it again before it writes anything.

import { applyPreference, icon, themePreference, watchSystem } from "../theme.js";

// The two states this page can be empty in mean opposite things, so they must
// not wear the same face: nothing to write in is good news, and an API that did
// not answer is not.
const EMPTY_GLYPH = {
  quiet: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z",
  unreachable: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z",
};

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

const relative = (at) => {
  if (!at) return "never";
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

const clone = (id) => document.getElementById(id).content.cloneNode(true);

function showEmpty(kind, title, description) {
  const card = clone("empty-state");
  // The stylesheet draws a 56px disc around this slot. Left empty it is a grey
  // circle and nothing else, which reads as a picture that failed to load.
  card.querySelector(".empty-icon").replaceChildren(icon(EMPTY_GLYPH[kind], 28));
  card.querySelector("strong").textContent = title;
  card.querySelector("p").textContent = description;
  document.getElementById("state").replaceChildren(card);
}

async function post(incidentId, form, said) {
  const data = new FormData(form);
  // A form field is a string or a file, and a file coerced to a string is the
  // word "[object Object]" posted as somebody's incident update.
  const read = (field) => {
    const value = data.get(field);
    return typeof value === "string" ? value : "";
  };

  const body = read("body").trim();
  if (body.length === 0) return;

  said.textContent = "Posting…";
  const asked = { body };
  for (const field of ["handling", "cause"]) {
    const value = read(field);
    if (value !== "") asked[field] = value;
  }

  try {
    const response = await fetch(`/admin/api/updates?incident=${incidentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(asked),
    });
    if (!response.ok) throw new Error(await response.text());
    form.reset();
    said.textContent = "Posted.";
    await load();
  } catch (error) {
    // Nothing is retried on the reader's behalf: a status update posted twice
    // is worse than one posted late, and the words are still in the box.
    said.textContent = `Not posted. ${error instanceof Error ? error.message : ""}`.trim();
  }
}

/**
 * What the probes say, which is a separate fact from whether anybody has closed
 * this. An incident opened by hand sits on a service answering perfectly well,
 * so "still failing its checks" would be a lie about half of them.
 */
function checksSay(incident, state) {
  if (incident.endedAt !== null) return `answering again ${relative(incident.endedAt)}`;
  return state === "down" ? "still failing its checks" : "checks are passing";
}

function paint(incidents, projects) {
  const open = incidents.filter((incident) => incident.endedAt === null || incident.handling !== "resolved");
  const stateOf = new Map(projects.map((project) => [project.id, project.state]));
  if (open.length === 0) {
    document.getElementById("incidents").replaceChildren();
    showEmpty("quiet", "Nothing is broken", "An incident opens by itself the moment a service is called down. There is nothing to write in until then.");
    return;
  }

  document.getElementById("state").replaceChildren();
  document.getElementById("incidents").replaceChildren(...open.map((incident) => {
    const card = clone("incident-form");
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

    const form = card.querySelector(".incident-form");
    const said = card.querySelector(".incident-said");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void post(incident.id, form, said);
    });
    // Closing an incident is setting its handling to resolved, which is a thing
    // the select can already do. It is here as a button too because "resolved"
    // sitting fourth in a dropdown is not a way out that anybody finds while
    // something is on fire.
    form.querySelector("[data-resolve]").addEventListener("click", () => {
      form.querySelector("[name=handling]").value = "resolved";
      if (form.reportValidity()) void post(incident.id, form, said);
    });
    return card;
  }));
}

/**
 * The form that opens one. It is painted once and left alone: rebuilding it on
 * every poll would take a half-written sentence with it.
 */
function paintOpener(projects) {
  const card = clone("open-form");
  const form = card.querySelector(".incident-form");
  const said = card.querySelector(".incident-said");

  form.querySelector("[name=projectId]").replaceChildren(...projects.map((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name ?? project.id;
    return option;
  }));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void openOne(form, said);
  });
  document.getElementById("opener").replaceChildren(card);
}

async function openOne(form, said) {
  const data = new FormData(form);
  const read = (field) => {
    const value = data.get(field);
    return typeof value === "string" ? value : "";
  };

  const body = read("body").trim();
  if (body.length === 0) return;

  said.textContent = "Opening…";
  const asked = { projectId: read("projectId"), body };
  for (const field of ["handling", "cause"]) {
    const value = read(field);
    if (value !== "") asked[field] = value;
  }

  try {
    const response = await fetch("/admin/api/incidents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(asked),
    });
    if (!response.ok) throw new Error(await response.text());
    form.reset();
    said.textContent = "Opened.";
    await load();
  } catch (error) {
    said.textContent = `Not opened. ${error instanceof Error ? error.message : ""}`.trim();
  }
}

async function load() {
  try {
    const payload = await fetch("/api/status", { cache: "no-store" }).then((response) => response.json());
    paint(payload.incidents ?? [], payload.projects ?? []);
    if (document.getElementById("opener").childElementCount === 0) paintOpener(payload.projects ?? []);
  } catch (error) {
    showEmpty("unreachable", "The status API did not answer", error instanceof Error ? error.message : "");
  }
}

// The page inherits the reader's theme and accent like every other one here.
applyPreference(themePreference());
watchSystem(() => applyPreference(themePreference()));

await load();
// Slower than the page itself: this one is read while something is wrong, and
// an input being replaced under a half-typed sentence is worse than stale.
setInterval(() => { if (document.visibilityState === "visible" && document.activeElement?.tagName !== "TEXTAREA") void load(); }, 60000);
