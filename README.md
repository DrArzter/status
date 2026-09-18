# Status

[![Live status](https://img.shields.io/badge/live-status.drarzter.dev-0ea5e9?style=flat-square)](https://status.drarzter.dev)
[![Check](https://img.shields.io/github/actions/workflow/status/DrArzter/status/check.yml?branch=main&style=flat-square&label=check)](https://github.com/DrArzter/status/actions/workflows/check.yml)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-f38020?style=flat-square&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)

An independent status page for my projects, live at **[status.drarzter.dev](https://status.drarzter.dev)**.

It runs on Cloudflare Workers: a cron probes each project, a D1 database keeps the history, and the same Worker serves
the page. Nothing is always on, and nothing here depends on the projects it watches — a status page that dies with the
thing it monitors is useless, which is why this lives outside every account it reports on.

## What it is not

It is not part of any project it watches. Adding a project is a line in `config/projects.json`, never a code change.

## Shape

```
DESIGN.md                what this page decides for itself; the system is the console's
config/projects.json     the projects and how to check each one
src/worker.ts            two entries: scheduled (probe, roll up) and fetch (page + API)
src/checks/              one module per check type, behind a registry
src/store.ts             D1: write results, roll up, decide state, claim transitions
src/notify/              one module per alert channel, enabled by its own secrets
src/config.ts            tunables, read from Worker variables
public/                  the page, served as static assets
public/accent.js         one chosen colour turned into readable accent variables
src/incidents.ts         what the probes cannot say: opened by them, written by a person
src/access.ts            the token Cloudflare Access forwards, checked
public/admin/            the one page that writes, behind Access
migrations/              D1 schema
test/                    suites run inside workerd against a real D1
infra/                   Terraform: D1, the Worker's custom domain, branch protection
```

The page reads top to bottom: the window pills, an overview that answers everything at once, one strip holding every
service against a shared axis, then a card per service. The content sits in a centred column rather than filling the
viewport, because this page is read rather than operated. The reader picks the accent colour from the app bar; it is
kept in their browser, since this page has no sign-in to store it against. See [DESIGN.md](DESIGN.md).

There are two cron triggers, not one. The per-minute probe writes raw rows and does nothing else, because a scheduled
invocation has a small CPU budget and waiting on the network is the only thing that should happen in it. A nightly job
folds finished hours and days and drops what has aged out.

### Check types

A project declares what "healthy" means for it, because the answer differs:

| Type | Healthy when | For |
| --- | --- | --- |
| `http` | The URL answers with an expected status inside the timeout | A site or an API that should always answer |
| `json` | A field in the JSON body equals an expected value | A health endpoint that reports its own state |
| `heartbeat` | Something checked in more recently than `withinMinutes` | A cron, a batch job, anything that is off by design between runs |

The third one matters. Spawnpoint's game host is stopped most of the time on purpose; a plain uptime check would paint
that red every evening. Its control plane answers always, and that is what gets watched.

`expect` is part of that honesty. The access API is probed without a session, so its healthy answer is **401**: the
request reached the gateway, the gateway reached the control plane, and it replied. Expecting 200 there would be
expecting the API to hand a stranger a session.

## Incidents

The probes can say a service stopped answering. They cannot say why, or that
anybody knows. That is what an incident is for, and it has two states because
they answer to different authorities.

**The machine owns whether it answers.** An incident opens by itself the moment
a project is called down, and is stamped as ended when the checks pass again.
Neither is a person's to edit.

**A person owns what is being done** — `investigating`, `identified`,
`monitoring`, `resolved` — and the cause, which no probe can know. Those are
written at `/admin`.

The two stay out of each other's way through one rule: an incident nobody has
written in closes itself the moment the checks recover, which is what should
happen to a blip at four in the morning. Once somebody has written in it,
recovery no longer closes it — the page goes on saying what they said until they
say otherwise. Marking one resolved clears it even if the checks still fail,
because "known, and we are living with it" is a real answer.

### Setting up the door

`/admin` is guarded by [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/),
free for up to fifty users, so this repository holds no sign-in, no sessions and
no password. In the Zero Trust dashboard, add a self-hosted application for
`status.drarzter.dev/admin`, allow the emails that may write, and copy two
values into the Worker's `vars`:

| Variable | Where it comes from |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | `<your-team>.cloudflareaccess.com` |
| `ACCESS_AUD` | The application's Audience tag |

Both are public: neither opens anything without a token Access itself signed.
The Worker verifies that token on every write rather than trusting the path,
because Access is configured per hostname and a Worker outlives the hostnames it
was set up for. With the variables unset the admin surface refuses everybody,
which is the right way for a half-configured door to fail.

## Settings

Worker variables, supplied by the deploy from GitHub repository variables. Every one has a shipped default, so an unset
variable is never a broken deployment.

| Variable | Default | What it does |
| --- | --- | --- |
| `PROBE_ATTEMPTS` | 2 | Attempts inside one tick before a check counts as failed |
| `FAILURES_BEFORE_DOWN` | 3 | Consecutive failed checks before a project is called down |
| `PROBE_TIMEOUT_MS` | 8000 | Per-request timeout, unless a check overrides it |
| `RAW_RETENTION_DAYS` | 2 | How long per-minute rows are kept |
| `HOURLY_RETENTION_DAYS` | 90 | How long hourly rows are kept |

## Running it

```bash
npm install
npm test
npx wrangler d1 migrations apply status --local
npm run dev
```

Deploying needs a Cloudflare API token with Workers and D1 permissions. The production D1 database is provisioned once
and referenced by repository variable; the code and migrations are deployed by `wrangler`, because that is what bundles
the Worker.

Production keeps `CLOUDFLARE_ACCOUNT_ID` and `D1_DATABASE_ID` as GitHub repository variables and
`CLOUDFLARE_API_TOKEN` as an encrypted repository secret. The deploy renders a temporary Wrangler configuration,
applies D1 migrations, and publishes the exact commit that passed `Check`; resource identifiers are never duplicated
as production literals in the repository.
