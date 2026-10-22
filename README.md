<div align="center">

**English** · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [한국어](README.ko.md) · [繁體中文](README.zh-Hant.md)

# siiswell

### SI is well, I am well.

**One calm page for what your AI agents are doing, what it costs, and how you are doing.**

<sub><b>SI</b> = super intelligence: the AI agents working for you. When they are well and you are well, all is well.</sub>

Open source · self-hosted · works with any MCP client · zero AI calls · privacy by default

[Why](#why-siiswell) · [How it works](#how-it-works) · [What's different](#what-makes-siiswell-different) · [Features](#features) · [Clients](#works-with-the-tools-you-already-use) · [Quick start](#quick-start) · [Prompts](#copy-paste-prompts-for-your-agents) · [Privacy](#privacy-what-leaves-your-machine) · [FAQ](#faq) · [Docs](#documentation)

<img src="docs/img/overview.png" alt="The siiswell dashboard: health, the summary strip (needs you, working, blocked, done) and the You card" width="900">

</div>

---

**siiswell** is a free, open-source, self-hosted **dashboard for AI coding agents** such as Claude Code, Codex and Gemini
CLI. It shows which agent tasks are running or waiting for you, tracks **LLM token usage and API-equivalent cost**, sends
calm phone notifications, and looks after the person in the middle with rule-based **developer well-being** signals —
without ever calling an AI model or reading your prompts and code. Built for one person today; team features are planned.

## Why siiswell

AI coding agents now run for minutes or hours on their own, often several at once, across terminals, desktop apps,
servers and CI. That is great for throughput and hard on the person in the middle.

| The everyday pain | What siiswell does about it |
|---|---|
| **"Is it still working, or waiting for me?"** You check five terminal tabs to find the one agent that has been asking for permission for 40 minutes. | Every agent reports its long tasks (started, blocked, done, ETA). The **Needs you** list and a push to your phone tell you the moment something waits. |
| **Agents in many places.** Claude Code on the laptop, Codex on a server, a desktop app, a nightly script. No single view. | One dashboard for every machine, app and project, grouped as `machine / project`. |
| **"What did this month cost?"** Token counts are buried in local logs; subscription plans hide the API-equivalent price. | The usage collector reads the token **numbers** from local logs and shows tokens and API-equivalent cost by day, hour, host, app, project and model. |
| **Notification noise.** Either you miss the important prompt, or your phone buzzes all evening. | Pushes are tiered: urgent items now, the rest in a digest; quiet hours, a Focus switch and calendar-based Focus. |
| **Long days creep up on you.** Agents never get tired; people do. | A gentle, rule-based **You** card: how busy today really was, a nudge to take a break, a wind-down message in the evening. No scores, no streaks. |
| **"Can I trust another dashboard with my code?"** | It never sees prompts, code or file contents. It never calls an AI model. You host it yourself. |

## How it works

<p align="center"><img src="docs/img/how-it-works.svg" alt="How siiswell works: agents, scripts, orchestrators and the usage collector report across a privacy line to your self-hosted server, which evaluates fixed rules every minute and reaches you through the dashboard and Web Push" width="760"></p>

1. **Agents report.** A short rule in each agent's instructions asks it to call `report_task` when it starts something
   long, `update_task` when it is blocked or done. Claude Code and Codex hooks can also report "waiting for you" by
   themselves.
2. **Numbers, not content, are collected.** The usage collector turns local logs into hourly token totals per model. The
   hooks keep only *that* you interacted and when.
3. **The server decides, deterministically.** Fixed rules (blocked, overdue, a permission prompt waiting, host offline, plan
   limit near) open alerts; the push policy decides what reaches your phone now, later, or not at all.
4. **You look once.** One page, on your desk or your phone, with the answer at the top.

## What makes siiswell different

| | |
|---|---|
| 🧘 **It looks after the person, not only the agents** | Most agent tools count tokens. siiswell also notices the human: how long you have been at it, how fast you are answering, whether the evening is still yours. It nudges gently and never scores you. |
| 🔕 **Fewer, better-timed notifications** | Urgent items reach your phone at once; everything else waits for a summary. Quiet hours, Focus and your calendar decide the rest, and agents are told when you are away so they keep going instead of waiting. |
| 🔒 **A privacy line you can read** | Only counts, times and short scrubbed titles leave your machine. Text is scrubbed twice (client and server) and the server enforces its own ceiling. Prompts, code and file contents never cross. |
| 🧮 **Zero AI, fully explainable** | No model is ever called, so it costs nothing to run and every alert comes from a threshold you can read in the code. |
| 🔌 **Any agent, any place** | One small rule in an agent's instructions is enough. MCP, a CLI, plain HTTP or OpenTelemetry: terminals, desktop apps, servers, CI and agent orchestrators all land on one page. |
| 🏠 **Yours to host** | One Cloudflare Worker or one Docker container, single-tenant by design. Your data stays in your account. |

## Features

<table>
<tr><td width="50%" valign="top">

### Agent tasks
- **Needs you** inbox: blocked tasks and permission prompts waiting for you, oldest first
- **Working now**: every open task with ETA, overdue marker and start time
- **Recent results** of the last 24 hours
- Grouped by machine, app and project; stale tasks close themselves after 24 h
- Five MCP tools, including read-only `list_tasks` and `operator_status`

</td><td width="50%" valign="top">

### Usage and cost
- 12-month calendar heatmap and any day's 24 hours
- Tokens and **API-equivalent cost** by host, app, project and model
- Claude Code and Codex logs, plus OpenTelemetry ingest
- Plan-limit forecast: "At this pace the 5 h window fills around 16:40"
- Per-model price table with your own overrides

</td></tr>
<tr><td valign="top">

### Calm notifications
- Web Push to phone and desktop (installable PWA)
- **Time-Sensitive** items now, everything else in a **Scheduled Summary**
- Quiet hours, weekends, **Focus 60 min**, Focus from your calendar
- Related alerts grouped into one push; a reminder ladder instead of repeats
- Optional inbox mode: pending permission prompts arrive together every 15 or 30 minutes

</td><td valign="top">

### You, the person
- **Calm / Busy / Overloaded**, always with the reasons
- An estimated workload level (0–100) from eight transparent signals
- **Highlights**: the week in plain sentences, with your usual range shown on every indicator
- Today's timeline, 7- and 30-day trends, weekly reflection; pin the cards you care about
- Gentle nudges (break, pace, quiet hours), each with "Not today" and "Never"
- Wind-down and good-morning messages; agents learn you are away

</td></tr>
<tr><td valign="top">

### Privacy and security
- No prompts, code, tool arguments or file contents, ever
- Project names hashed by default; text scrubbed on client **and** server
- One token per machine and app, revocable alone
- Server-side ceilings on how much task text is accepted

</td><td valign="top">

### Runs where you want
- **Cloudflare** Worker + D1, or **Docker** with SQLite
- Cloudflare Access, built-in login, or your own auth proxy
- Zero-dependency CLI (Node ≥ 18) that updates itself
- AGPL-3.0, commercial licence on request

</td></tr>
</table>

## Screenshots

<p align="center"><img src="docs/img/highlights.png" alt="Highlights: this week's usage, workload, evenings and active hours, each with one plain sentence and a sparkline" width="880"><br/><b>Highlights</b> — the week in four plain sentences; pin the ones you care about</p>

| | |
|---|---|
| <img src="docs/img/usage.png" alt="Usage: calendar heatmap and breakdown by host, app, project and model" width="440"><br/>**Usage and cost** — a year at a glance, then drill into a day | <img src="docs/img/wellbeing.png" alt="The You card: state, workload level and today's timeline" width="440"><br/>**You** — how the day is going, with the reasons |
| <img src="docs/img/tasks.png" alt="Needs you and Working now" width="440"><br/>**Tasks** — what waits for you, what is running | <img src="docs/img/overview-dark.png" alt="The dashboard in dark theme" width="440"><br/>**Dark theme** — follows your device, or pick one |
| <img src="docs/img/usage-month.png" alt="Usage month view: totals, daily stacked bars, top projects and models" width="440"><br/>**Month view** — totals, top projects and models, weekday × hour | <img src="docs/img/phone.png" alt="The dashboard on a phone" width="220"><br/>**On the phone** — install it as an app and get pushes |

<sub>Screenshots use demo data from <code>scripts/demo-seed.ts</code>.</sub>

## Works with the tools you already use

Anything that speaks MCP can report tasks. Anything that can run a command or send HTTP can too.

| Client type | Examples | How it connects | What appears on the dashboard |
|---|---|---|---|
| **CLI agents** | Claude Code, Codex, Gemini CLI, Antigravity (agy), opencode, grok, kilo | `siiswell mcp` (stdio) registered by the setup script, or remote MCP with a bearer header | Tasks; with Claude Code / Codex hooks also "waiting for you" and your own pace |
| **Desktop apps and IDEs** | Claude Desktop, ChatGPT desktop app, Codex IDE extension | stdio MCP server (`siiswell mcp`) | Tasks |
| **Any remote MCP client** | anything with Streamable HTTP + custom headers | `POST /mcp` with `Authorization: Bearer <token>` | Tasks |
| **Cloud agents** | Manus, Grok (API remote MCP), OpenAI Dots, ChatGPT custom connectors | add `https://<your-dashboard>/mcp` as a custom MCP server with a bearer token / API key header ([details](#cloud-agents-manus-grok-dots-chatgpt)) | Tasks |
| **Scripts, cron and CI** | build jobs, long migrations, nightly tasks | `siiswell report` / `update` / `heartbeat` | Tasks and heartbeats |
| **Raw HTTP / API** | any language | JSON-RPC to `/mcp`; ingest endpoints in [OpenAPI](docs/openapi.yaml) | Tasks, usage, host state |
| **Agent orchestrators** | your own agent runner, automation servers | host integration endpoints `/api/ingest/{snapshot,events,heartbeat}`; a `.siiswell-agents` marker keeps the hooks out of its workspaces | Hosts, projects, agents, tasks, events |
| **Token usage** | Claude Code and Codex logs | `siiswell usage push` on a schedule | Tokens and API-equivalent cost |
| **OpenTelemetry** | Claude Code metrics | OTLP/HTTP JSON to `/api/ingest/otlp` (opt-in) | Tokens and cost |

Per-app snippets and status: [CLIENTS.md](CLIENTS.md). Step-by-step install: [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md).

## Quick start

### Words you will see

| Word | Meaning |
|---|---|
| **Server** | the dashboard itself: one Docker container (or a Cloudflare Worker) that stores reports and shows the page |
| **Client** | the small `siiswell` program on each computer where your agents run |
| **MCP** | the standard way AI agents call tools; siiswell gives agents a "report my task" tool |
| **Client token** | a key that lets one agent app (Claude Code on your laptop, say) report tasks |
| **Host token** | a key that lets one computer's usage collector send token counts; its name must equal that computer's label |
| **Hooks** | small commands Claude Code / Codex run on events (a prompt, a permission request), used for "waiting for you" |

### Which way is for me?

| | **Docker** (recommended for most people) | **Cloudflare** (for people who already use Workers) |
|---|---|---|
| Runs on | any machine with Docker: a home server, a VPS, a NAS | your Cloudflare account (the free tier is usually enough) |
| Sign-in | built in: one admin password in `.env` | Cloudflare Access (your Google / GitHub / e-mail login) |
| Phone pushes | yes, once it has an HTTPS address | yes |
| Time to first task | about 10 minutes on one machine; about 30 with HTTPS | about 30 minutes |

### Docker, step by step

You need: a machine with Docker and Docker Compose for the server; Node.js 18+ and [Bun](https://bun.sh) on each computer
whose agents you want to connect. To use it from other computers or your phone you also need an HTTPS address (step 3).

**1. Get it and set a password** (on the server machine)

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
cp .env.example .env && chmod 600 .env
```

For a first try, only two lines in `.env` matter:

```dotenv
# the address you open; your https://… address after step 3
PUBLIC_URL=http://localhost:8787
# 12+ characters; to change it: edit, then docker compose up -d
ADMIN_PASSWORD='a long password you keep'
```

**2. Start it and check it**

```sh
docker compose up -d --build
docker compose ps
curl -s http://localhost:8787/api/health
```

After a few seconds `docker compose ps` shows **healthy** and the health check answers `{"ok":true,…}`. Open
<http://localhost:8787> and sign in. If it does not start, `docker compose logs siiswell` lists every setting
that needs fixing. On a remote server without a browser, open a tunnel from your laptop first:
`ssh -L 8787:127.0.0.1:8787 you@your-server`, then open <http://localhost:8787> on the laptop.

**3. Give it an HTTPS address** (needed for other computers and the phone)

The container listens on `127.0.0.1:8787` only. Put a reverse proxy with HTTPS in front of it, for example
[Caddy](https://caddyserver.com/), which gets the certificate by itself:

```text
# /etc/caddy/Caddyfile  (point the DNS name at this machine first)
dash.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Then in `.env`:

```dotenv
PUBLIC_URL=https://dash.example.com
# the proxy reaches the container from this address
TRUSTED_PROXY_CIDRS=172.28.0.1/32
```

and `docker compose up -d`. No domain? A private HTTPS name from a VPN such as Tailscale works too. More options:
[docs/deploy.md](docs/deploy.md#deploy-with-docker).

**4. Phone pushes** (optional)

```sh
docker compose exec siiswell bun scripts/vapid.ts mailto:you@example.com
```

Paste the three `VAPID_…=` lines it prints into `.env`, then `docker compose up -d`. On an iPhone, open the dashboard in
Safari, choose Share → **Add to Home Screen**, open it from there, then tap **Enable notifications**.

**5. Create tokens** (on the server; each token is printed once, so keep the window open for step 6)

```sh
docker compose exec siiswell bun scripts/new-token.ts laptop-1-claude client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1-codex client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1 host --apply
```

One client token per agent app you use (here Claude Code and Codex), one host token per computer. The host token's name
(`laptop-1`) is the machine label you will type in step 6.

**6. Connect a computer** (on each laptop or desktop)

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```

It asks for the dashboard URL (`https://dash.example.com`), a machine label (`laptop-1`), which apps to connect, and
one token per app (input is hidden). It installs the `siiswell` command in `~/.local/bin`, adds the reporting rule to
your agents, and can add the hooks and the hourly usage collector. You should see `doctor claude-code: ok` at the end.

Try it (open a new terminal first if `siiswell` is not found). The task appears under **Working now**, `siiswell tasks`
lists it, and the last line closes it:

```sh
ID=$(siiswell report "Try the dashboard" --kind testing --eta-min 5 | tail -1)
siiswell tasks
siiswell update "$ID" --status DONE
```

Or ask an agent to run the connection check ([prompt 3](#copy-paste-prompts-for-your-agents)).

### Keeping it running

| Task | Command |
|---|---|
| Update the server | `git pull && docker compose up -d --build` (database changes apply by themselves) |
| Update a computer's client | `siiswell update` (without a task id it installs the version your dashboard publishes) |
| Stop / start | `docker compose down` / `docker compose up -d` (your data stays) |
| Back up | `docker compose stop`, copy `/data/siiswell.sqlite` out of the `siiswell-data` volume (`docker volume ls` shows its full name), `docker compose start`. Keep backups as private as `.env`: they hold the password's hash |

⚠️ `docker compose down -v` deletes the volume, which is all your data.

<details>
<summary><b>Cloudflare (Worker + D1)</b></summary>

```sh
bun install
bunx wrangler d1 create siiswell
```

Put the printed `database_id` into `wrangler.toml`, then:

```sh
bunx wrangler d1 migrations apply siiswell --remote
bun run deploy
bun scripts/new-token.ts laptop-1-claude client
```

The last command prints a token and a `wrangler d1 execute` line: run that line to register the token.

Protect the page with Cloudflare Access: until it is set up, the dashboard shows no data to anyone. The full checklist,
with every outward-facing step marked, is in [docs/deploy.md](docs/deploy.md). Then connect your computers as in step 6.
</details>

## Copy-paste prompts for your agents

Agents do the reporting, so they need to be told. These prompts are safe to paste into any agent: none of them asks
for, or contains, a token. **Never paste a token into a chat**: tokens go into the config file or the connector settings.

<details open>
<summary><b>1. The reporting rule</b> (put it in each agent's global instructions; <code>setup-client.sh</code> does this for you)</summary>

```text
For any task that will take longer than about 10 minutes, you may use the `siiswell` MCP tools: call
`report_task` (status `IN_PROGRESS`, with `eta_min`) when you start; call `update_task` with status
`BLOCKED` when you are blocked and need me, and with `DONE` when you finish, reusing the `task_id` you
were given. Always call `update_task` with `DONE` before your final reply. Give each task a short plain
description of the action as its title (under 60 characters) and a `kind` (one of coding, debugging,
testing, review, research, docs, deploy, ops, other). Never put prompt text, conversation content, file
contents, customer data, secrets, credentials, tokens or links to private documents in any title or summary.
Before you stop to ask me something, call `operator_status`: while I am away, continue on your own with
the safest reasonable choice instead of waiting.
```
</details>

<details>
<summary><b>2. "Update siiswell on this machine"</b></summary>

```text
Update the siiswell client on this machine: run `siiswell update --yes`, then `siiswell doctor`.
Tell me the installed version and any line of the doctor output that is not [ok] or [--].
Do not print, read or change any token or config file.
```
</details>

<details>
<summary><b>3. "Check that siiswell works"</b></summary>

```text
Check the siiswell connection: call the siiswell `report_task` tool with title "Connection check",
kind "testing", status IN_PROGRESS and eta_min 1, then call `update_task` with status DONE for the
task_id you got. Tell me whether both calls succeeded.
```
</details>

<details>
<summary><b>4. Set up a new machine</b> (you run this one yourself: it asks for tokens with hidden input; needs Node.js 18+ and Bun)</summary>

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```
</details>

### Cloud agents (Manus, Grok, Dots, ChatGPT)

Agents that run in a vendor's cloud cannot start a local `siiswell` process, but most of them can call a **remote MCP
server over HTTPS**, which is what `https://<your-dashboard>/mcp` is.

| Agent | What it needs from siiswell | Status |
|---|---|---|
| **Manus** | custom MCP server: URL + `Authorization: Bearer <token>` (Settings → Integrations → Custom MCP) | should work; not yet tested by us |
| **Grok** | Grok Build CLI: `siiswell mcp` or the remote URL ([CLIENTS.md](CLIENTS.md#6-grok)); Grok API: remote MCP tool with a bearer header | CLI documented; API not yet tested |
| **OpenAI Dots** | a remote MCP server reachable over HTTPS | MCP support not yet documented by the vendor; try when it is |
| **ChatGPT custom connectors** | a remote MCP server; plan and auth options depend on the vendor | works only where a bearer token / API key can be set; OAuth-only setups are not supported yet |

1. Create a separate client token for each cloud agent (`new-token.ts <name> client`), so it can be revoked alone.
2. In the agent's connector settings enter the URL and the header `Authorization: Bearer <token>`.
3. Add the reporting rule (prompt 1) to the agent's custom instructions.

Good to know: the dashboard must be reachable from the internet over HTTPS (behind Cloudflare Access, `/mcp` is
already bypassed for token requests). A cloud agent does not run the local client, so its titles are limited and
scrubbed by the **server** only (`ACCEPT_TASK_TEXT`); Claude Code hooks and the usage collector do not apply there.

## Privacy: what leaves your machine

siiswell records **that** you and your agents did something, never **what**.

| Sent to your server | Never sent, never stored |
|---|---|
| Task status, ETA and a fixed `kind` (coding, docs, …) | Prompts, replies, conversations |
| A short task title, scrubbed and clipped to 60 characters (default `brief`; `minimal` or `none` send less) | Code, diffs, file contents, tool output |
| Token counts per hour, model and app | Tool arguments, command text |
| Time and type of your own interactions (a prompt, an allowed permission) | Working directories and local paths |
| Project labels: a salted hash unless you list a name to show | Real project names (unless you opt in) |

- Text is scrubbed of secrets (tokens, keys, passwords, URLs) **on the client and again on the server**, and the server
  enforces its own ceiling (`ACCEPT_TASK_TEXT`, `ACCEPT_HOST_TEXT`), so a client cannot send more than you allow.
- Each machine and app has its own token; a lost one is revoked alone.
- `siiswell permissions suggest` is the only command that reads local transcripts. It sends nothing and prints only
  allowlist keys.
- Self-hosted: the data stays in your Cloudflare account or your container, with 30-day retention by default.

Details: [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) and [SECURITY.md](SECURITY.md).

## Zero AI

siiswell never calls an AI model and never spends your plan or tokens. The dashboard, CLI, hooks, MCP server and
collector only read local counters and send small reports. Every rule is a fixed threshold you can read in the code,
so every alert and every number on the page can be explained.

## FAQ

<details>
<summary><b>Do my agents need special support?</b></summary>

No. Any agent that can use MCP tools can report tasks: add the server and the short instruction rule
([CLIENTS.md](CLIENTS.md#the-instruction-rule-put-this-in-each-agents-global-instructions)). Without MCP, use the
`siiswell` CLI or a plain HTTP call.
</details>

<details>
<summary><b>Does it work with cloud agents such as Manus, Grok, Dots or ChatGPT?</b></summary>

For task reporting, yes where the agent can add a remote MCP server with a bearer token or API key header: see
[Cloud agents](#cloud-agents-manus-grok-dots-chatgpt). Token usage and the "You" signals come from local logs and hooks,
so they cover the agents you run on your own machines.
</details>

<details>
<summary><b>Does it slow my agents down or cost tokens?</b></summary>

Barely. A tool call is a few hundred bytes, made only for tasks longer than about 10 minutes. Hooks return at once and
do their network work in the background. The dashboard itself spends no AI tokens.
</details>

<details>
<summary><b>What if an agent forgets to report, or crashes?</b></summary>

Each client shows its "last report" age. A task without an update for 24 hours is closed as stale and listed in
`siiswell tasks`. Claude Code hooks report "waiting for you" and session end without relying on the agent.
</details>

<details>
<summary><b>How accurate is the cost?</b></summary>

It is the **API-equivalent** price: token counts from local logs multiplied by a per-model price table
(`src/shared/model-prices.json`, overridable per machine). On a subscription plan it shows what the same work would
cost on the API, not what you pay.
</details>

<details>
<summary><b>I run an agent orchestrator. Will its agents be counted as "me"?</b></summary>

No, if you mark its projects. Put a `.siiswell-agents` file in a project root (its agents work in
`<project>/worktrees/...`) or start the agents with `SIISWELL_AGENT=1`. The hooks then record nothing there and the MCP
write tools are answered locally, so only your own sessions count and the orchestrator's host integration reports the
tasks. See [Agent workspaces](docs/INSTALL-CLIENTS.md#agent-workspaces-run-by-an-orchestrator).
</details>

<details>
<summary><b>Is the "You" card a health tool?</b></summary>

No. It counts timestamps and events with fixed thresholds and says so on the page. It is there to make a long day
visible, not to judge it. Every nudge can be switched off.
</details>

<details>
<summary><b>Is siiswell for teams?</b></summary>

Today siiswell is built for one person: one installation, one owner (single-tenant; client tokens identify apps, they are
not a tenant boundary, see [SECURITY.md](SECURITY.md)). Team features — shared views of agents and LLM costs, with each
person's well-being data kept private to them — are on the roadmap.
</details>

<details>
<summary><b>What does "SI is well, I am well" mean?</b></summary>

SI stands for super intelligence: the AI agents working for you. "SI is well" means your agents are running smoothly; "I
am well" means you are not overloaded. siiswell watches both.
</details>

<details>
<summary><b>What does it cost to run?</b></summary>

On Cloudflare, a personal installation stays well inside the D1 free-tier limits
([estimate](docs/reference.md#d1-quota-estimate-5-projects)). With Docker, it is one small container and a SQLite file.
</details>

<details>
<summary><b>How do I update?</b></summary>

Docker: `git pull && docker compose up -d --build` (database changes apply at start). Cloudflare: pull, apply new
migrations, deploy ([docs/upgrade.md](docs/upgrade.md)). Clients: `siiswell update` installs the CLI version your
dashboard publishes; the dashboard shows a small note under any client that is behind.
</details>

## Documentation

| Topic | Where |
|---|---|
| Deploy: local development, Cloudflare checklist, Docker | [docs/deploy.md](docs/deploy.md) |
| Upgrade an existing installation | [docs/upgrade.md](docs/upgrade.md) |
| Install the CLI, hooks and usage collector | [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) |
| MCP setup per app, every way to connect | [CLIENTS.md](CLIENTS.md) |
| Wire protocol and endpoints | [docs/api.md](docs/api.md), [docs/openapi.yaml](docs/openapi.yaml) |
| OpenTelemetry ingest | [docs/otel.md](docs/otel.md) |
| What the page shows, rules, cadence, limits, quota | [docs/reference.md](docs/reference.md) |
| Security model and reporting | [SECURITY.md](SECURITY.md) |

## Development

```sh
bun install
bun run typecheck
NODE_ENV=test bun test
bun run dev
```

`bun run dev` starts a local Worker on <http://localhost:8787>; `bun scripts/demo-seed.ts --help` explains the demo data
used for the screenshots.

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## Licence

| Part | Licence | Why |
|---|---|---|
| The server and the page (everything not listed below) | [AGPL-3.0-only](LICENSE) | Improvements to a hosted siiswell stay open |
| The client: `cli/`, `bridge/`, and `src/shared/` (the code bundled into the CLI) | [Apache-2.0](LICENSE-APACHE) | Install it on any machine, including company laptops, without licence questions |

A commercial licence for the AGPL part is available on request: see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)
([license@siiswell.com](mailto:license@siiswell.com)). Everything else: [hello@siiswell.com](mailto:hello@siiswell.com). Contributions are welcome under the [Contributor License Agreement](CLA.md) (see [CONTRIBUTING.md](CONTRIBUTING.md)).
Each client source file carries an `SPDX-License-Identifier: Apache-2.0` line. Copyright and licence summary: [NOTICE](NOTICE).

<div align="center"><sub>© 2026 <a href="https://siiswell.com">siiswell.com</a> · <a href="https://github.com/jcaol/siiswell">GitHub</a> · <a href="mailto:hello@siiswell.com">Contact</a></sub></div>
