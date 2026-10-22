# Installing the siiswell client

This guide connects desktop agents to an existing siiswell deployment so that they can report long-running work,
and it sets up the token-usage collector. The setup script covers Claude Code, the Codex CLI and desktop app, Claude
Desktop, agy (Antigravity) and Gemini CLI; the sections below do the first three by hand.
[`CLIENTS.md`](../CLIENTS.md) lists every way to connect (other agents such as grok, kilo and opencode, scripts, raw HTTP,
OpenTelemetry, host integrations), and [`api.md`](api.md) describes the wire protocol.

The examples use `https://dash.example.com`. Replace it with your dashboard's address.

> **macOS / zsh:** some command examples below end with a `# note`. bash ignores these notes; zsh ignores them only after
> `setopt interactivecomments` (run it once in the terminal, or add it to `~/.zshrc`). Without it, copy the command without
> the note.

## Quick setup (recommended)

From a checkout of this repository, on the machine where the apps run (macOS or Linux, Node.js 18+):

```sh
bun install && bun run build:cli      # once: builds cli/dist/siiswell.mjs (the script offers to do it)
scripts/setup-client.sh --dry-run     # shows what it would change, changes nothing
scripts/setup-client.sh
```

Running it again on a machine that is already set up offers the earlier URL, machine label and apps as the defaults
(Enter keeps them) and asks whether to keep each token. After an update of the apps or of siiswell itself, the quickest way
is:

```sh
scripts/setup-client.sh --reuse       # asks nothing: re-installs the MCP registration, the hooks and the rule for the
                                      # apps already configured in ~/.config/siiswell, then runs doctor
```

`--reuse` never asks for a token and never rewrites the configs; on a machine without a client setup it stops with
"this machine has no siiswell client setup yet — run setup-client.sh without --reuse".

On a machine where an agent orchestrator also runs agents, see
[Agent workspaces run by an orchestrator](#agent-workspaces-run-by-an-orchestrator).

The script:

1. Installs the CLI to `~/.local/lib/siiswell/siiswell.mjs`.
2. Asks for the dashboard URL. It must use `https://`; plain `http://` is accepted only for `localhost`.
3. Asks which apps to set up: Claude Code, Codex (CLI and desktop app), Claude Desktop, Antigravity (agy), Gemini
   CLI, and the usage collector. Apps it cannot find are skipped, and the script says so. It then asks for a
   **machine label** (for example `laptop-1`): every app config gets it as `machine`, so the dashboard's Projects list
   shows this machine's work as "laptop-1 / web" whichever app reported it. It is also the default host label.
   Choose a label that names no person (the OS host name often does).
4. For each app you choose, asks for its token. The input is hidden, the token is checked against the `oct_` +
   43-character shape, and it is stored only in `~/.config/siiswell/<app>.json` (directory 0700, file 0600).
   For the usage collector, it also asks for the host label, which must equal the host token's name.
   On a re-run, an app whose config already holds a token asks "Keep the existing token? [Y/n]" instead (the host
   token only for the same host label); Enter keeps it, `n` asks for a new one. The token is never shown.
5. Runs `siiswell doctor` for each app and shows ok or FAILED.
6. Registers the stdio MCP server `siiswell` (`node siiswell.mjs mcp`, with `SIISWELL_CONFIG` pointing at that app's
   config file) in each chosen app:
   - Claude Code: `claude mcp add --scope user siiswell -e SIISWELL_CONFIG=... -- node siiswell.mjs mcp` (the name before
     `-e`). When it fails, the script prints what `claude` said.
   - Codex: `[mcp_servers.siiswell]` in `~/.codex/config.toml`. If an entry is already there, the script asks
     before replacing it.
   - Claude Desktop: `claude_desktop_config.json`.
   - agy: `~/.gemini/antigravity-cli/mcp_config.json`.
   - Gemini: `~/.gemini/settings.json`.

   Other servers and settings in those files are kept, every edited file is first backed up to
   `<file>.bak-siiswell-<timestamp>`, and no token is ever written into an app's own config.
7. Optionally installs **app hooks** (section 8a): Claude Code `Notification`, `Stop`, `PostToolUse`, `UserPromptSubmit` and `SessionEnd`, and the Codex `notify`
   program. They only run the siiswell CLI.
8. Optionally adds the long-task rule (section 8) to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` between `siiswell rule: start` / `end` markers. A re-run replaces an existing block (or the older unmarked rule paragraph) with the current text, with a backup, and writes nothing when it is already current.
9. Optionally schedules `siiswell usage push` every 15 minutes, after a successful dry run. On macOS this is a
   launchd agent; on Linux it is a systemd user timer.

Re-running the script is safe. The sections below describe the same steps by hand.

## 1. What you need

- **Node.js 18 or later**, or **Bun 1.x**. The client has no runtime dependencies.
- **Tokens from the dashboard operator.** Each token is shown once, so do not paste it into chat, a repository or a
  shared document.
  - One **`client` token per app** (for example `claude-code-laptop`, `codex-laptop` and `claude-desktop-laptop`).
    The dashboard shows each app's tasks as `<agent>@<token name>`, and a lost token can be revoked on its own.
  - For the usage collector, one **`host` token per machine** (for example `laptop`). The token's **name** is the host
    label that the collector must send. Never reuse the name of another host: a usage upload replaces that host's rows
    for the days it sends.

  The operator mints a token with `bun scripts/new-token.ts <name> client|host` and registers it with the
  `INSERT` line that the script prints.

## 2. Install the CLI

Build the single-file client from the repository. The build output is not committed, so you build it yourself:

```sh
git clone https://github.com/jcaol/siiswell.git && cd siiswell
bun install && bun cli/build.ts             # writes cli/dist/siiswell.mjs
mkdir -p ~/.local/lib/siiswell
cp cli/dist/siiswell.mjs ~/.local/lib/siiswell/
shasum -a 256 ~/.local/lib/siiswell/siiswell.mjs   # Linux: sha256sum; compare with the hash the operator publishes for this commit
node ~/.local/lib/siiswell/siiswell.mjs --version
```

Optional: `alias siiswell='node ~/.local/lib/siiswell/siiswell.mjs'`. Once the package is published,
`npx siiswell@<version> …` or `bunx siiswell@<version> …` will work the same way.

Apps launched from the Dock or Start menu do not get your shell's `PATH`. In their configs, use the absolute path to
`node` (find it with `which node`, for example `/opt/homebrew/bin/node`) and to `siiswell.mjs`.

## 3. Configure

The CLI reads its settings in this order: command-line flags, then environment variables, then the config file.
Tokens are never accepted as flags, because flags show up in the process list and in shell history.

| Setting | Environment | Config file key |
|---|---|---|
| Dashboard URL | `SIISWELL_URL` | `url` |
| Client token (`/mcp`) | `SIISWELL_TOKEN` | `token` |
| Host token (usage upload) | `SIISWELL_HOST_TOKEN` | `hostToken` |
| Host label (= the host token's name) | `SIISWELL_HOST` | `host` |
| Default project for `report` (else the same rule as `siiswell mcp`: the usage name policy, "other" when no name may be sent) | `SIISWELL_PROJECT` | `project` |
| Infer a project outside configured `usage.roots` (or with no roots) for `siiswell mcp` / hooks (git checkout, else folder name; default off: no folder name is sent unless it is in `usage.keep`) | n/a | `usage.inferProjectOutsideRoots` |
| Machine label added to MCP tasks (groups this machine's apps) | `SIISWELL_MACHINE` | `machine` (else an explicitly set `host`) |
| Config file location | `SIISWELL_CONFIG` | n/a |
| State directory | `SIISWELL_STATE_DIR` | `stateDir` (default `~/.local/state/siiswell`) |

The config file is `~/.config/siiswell/config.json`. **It must be mode 0600 and owned by you**, otherwise the CLI
refuses to read it:

```sh
mkdir -p ~/.config/siiswell
cat > ~/.config/siiswell/config.json <<'EOF'
{
  "url": "https://dash.example.com",
  "token": "oct_...client token...",
  "hostToken": "oct_...host token...",
  "host": "laptop",
  "usage": { "projectNames": "other", "keep": [], "roots": ["~/projects"] }
}
EOF
chmod 600 ~/.config/siiswell/config.json
```

**One token per app:** create one config file per app, for example `~/.config/siiswell/claude-desktop.json`
(also mode 0600). Then point each app at its own file with `SIISWELL_CONFIG`, as the sections below show.
This keeps the token out of the app's config file.

Check the setup:

```sh
siiswell config     # resolved settings; tokens show only as "set (from …)"
siiswell doctor     # URL, reachability, and whether each token is a client or a host token
```

The URL must use `https://`. Plain `http://` works only for `localhost`. The client never follows a redirect, so a
URL that redirects (for example `http://` to `https://`) fails with a message that
names the redirect.

## 4. Claude Code

**Recommended: local stdio.** The token stays in the siiswell config file, and titles and summaries are scrubbed
before they leave the machine:

```sh
claude mcp add --scope user siiswell -- /ABSOLUTE/PATH/TO/node /ABSOLUTE/PATH/.local/lib/siiswell/siiswell.mjs mcp
claude mcp get siiswell
```

To give Claude Code its own token, add `-e SIISWELL_CONFIG=/ABSOLUTE/PATH/.config/siiswell/claude-code.json`
before the `--`.

**Alternative (unverified): remote MCP over HTTP.** Claude Code sends the bearer header itself, and the token comes
from an environment variable:

```sh
export SIISWELL_TOKEN='oct_...'            # in the shell profile that starts Claude Code (chmod 600 that file)
claude mcp add --transport http --scope user siiswell https://dash.example.com/mcp \
  --header 'Authorization: Bearer ${SIISWELL_TOKEN}'
```

Keep the single quotes so that your shell does not expand the variable. Claude Code's documentation describes
`${VAR}` expansion for `.mcp.json`. It does not say whether entries stored by `claude mcp add` are expanded, and
this has not been tested. If `/mcp` shows the server as failing, use a user `.mcp.json` entry with
`"type": "http"`, `"url": "https://dash.example.com/mcp"` and
`"headers": {"Authorization": "Bearer ${SIISWELL_TOKEN}"}`, or use the stdio form above.

Check the connection with `/mcp` inside Claude Code. Then add the agent rule (section 8) to `~/.claude/CLAUDE.md`.

## 5. Codex CLI, IDE extension and desktop app

The three share one configuration, `~/.codex/config.toml`.

**Option A: remote MCP over HTTP.**

```toml
[mcp_servers.siiswell]
url = "https://dash.example.com/mcp"
bearer_token_env_var = "SIISWELL_TOKEN"   # the NAME of the variable, not the token
```

You can also add it with
`codex mcp add siiswell --url https://dash.example.com/mcp --bearer-token-env-var SIISWELL_TOKEN`.

The desktop app started from the Dock does not see your shell exports. On macOS, `launchctl setenv SIISWELL_TOKEN …`
works around this until the next reboot (not verified). For the desktop app, prefer option B.

**Option B: local stdio.** The desktop app needs no environment variables:

```toml
[mcp_servers.siiswell]
command = "/ABSOLUTE/PATH/TO/node"
args = ["/ABSOLUTE/PATH/.local/lib/siiswell/siiswell.mjs", "mcp"]
env = { SIISWELL_CONFIG = "/ABSOLUTE/PATH/.config/siiswell/codex.json" }
```

Restart Codex completely. Then add the agent rule (section 8) to `~/.codex/AGENTS.md`.

## 6. Claude Desktop

Claude Desktop connects to remote servers through Custom Connectors, which expect OAuth. Use the stdio server
instead. Edit `claude_desktop_config.json`, which is in `~/Library/Application Support/Claude/` on macOS and in
`%APPDATA%\Claude\` on Windows:

```json
{
  "mcpServers": {
    "siiswell": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/PATH/.local/lib/siiswell/siiswell.mjs", "mcp"],
      "env": { "SIISWELL_CONFIG": "/ABSOLUTE/PATH/.config/siiswell/claude-desktop.json" }
    }
  }
}
```

With this setup the token lives only in the siiswell config file (mode 0600). If you put `SIISWELL_URL` and
`SIISWELL_TOKEN` directly into the `env` block instead, run `chmod 600` on `claude_desktop_config.json`.

Quit Claude Desktop completely (Cmd+Q) and start it again. `siiswell` should appear in the tools list. Claude
Desktop has no global instructions file, so put the agent rule (section 8) in your profile preferences or in a
Project's instructions.

**The stdio bridge:** `bridge/siiswell-bridge.mjs` (see [CLIENTS.md](../CLIENTS.md#the-stdio-bridge-bridgesiiswell-bridgemjs))
does the same job without the CLI. `siiswell mcp` reads the same `SIISWELL_URL` and `SIISWELL_TOKEN` variables and, in
addition, scrubs titles and summaries before they leave the machine.

## 7. Usage collector (tokens and API-equivalent cost)

The collector reads only the **token-count fields** of local transcripts:

- Claude Code: `~/.claude/projects/**/*.jsonl`, including sub-agent transcripts.
- Codex: `~/.codex/sessions/**/rollout-*.jsonl`.

It never stores, prints or sends message content, prompts or file contents. It banks hourly and daily totals in the
state directory. The upload uses the dashboard's daily format plus an optional hourly block (an older dashboard ignores
it) and needs the **host** token and label. The dashboard keeps the hours for 90 days (its Day view) and the days for good.

**Which app.** Every request is labelled with the app that made it, and that label is the rows' `agent`:

| Label | Read from |
|---|---|
| `claude-cli` | Claude Code transcript lines with `entrypoint: "cli"` (the terminal) |
| `claude-desktop` | an `entrypoint` naming the desktop app |
| `claude-ide` | an `entrypoint` naming an editor extension (VS Code, JetBrains, ...) |
| `claude-sdk` | `entrypoint: "sdk-*"` (the Agent SDK, `claude -p` scripts) |
| `codex-cli` | a Codex rollout whose `session_meta.originator` is the terminal client (`codex_cli_rs`) |
| `codex-exec` | `originator: "codex_exec"` (`codex exec`) |
| `codex-desktop` | an `originator` naming the desktop app |
| `codex-ide` | an `originator` naming the IDE extension (`codex_vscode`, ...) |
| `unknown` | anything else, and everything banked before this version |

Values the collector does not recognise are counted (sessions per value, kept only in the local state) and listed by
`siiswell usage show`, so a new app version can be added to this table.

The labels are a fixed list that names no project, so they are sent whatever `usage.projectNames` says. Where project
names may be sent (`"all"` or `keep`), a worktree agent follows after a dot (`claude-cli.dev`); the project root is just
the app. The dashboard's usage table groups host > app > project > model.

**Changing `roots`.** The collector keeps the raw working directory of every bucket in its private state (mode 0600,
never uploaded) and works out the project again on every run. Changing `usage.roots` (or `projectNames` / `keep`)
therefore re-attributes the whole history: the next push sends it again under the new labels, and the dashboard replaces
those days. There is nothing to delete by hand. Totals banked by an older version are re-read from the logs once,
automatically, on the first run of this version (they get their app and cwd); only totals whose logs are gone stay
`unknown` with the project they were banked with. `siiswell usage collect --backfill` repeats that re-read at any time
without counting anything twice.

```sh
siiswell usage collect          # local only: read new transcript bytes, update the bank
siiswell usage show             # today's hours (tokens, requests, API-equivalent USD)
siiswell usage push --dry-run   # collect, then show how many rows would be sent; nothing is sent
siiswell usage push             # collect, then upload
```

**Privacy of project names.** A folder name can be a client's name, so by default no project name is sent. A new
install with nothing configured uses `"hashed"`; an install that configured `usage.roots` or `usage.keep`, or that
collected usage before this default, keeps `"other"`. The real names are visible only on this machine
(`siiswell usage show`), and on the dashboard only for names in `usage.keep` or with `"all"`:

| `usage.projectNames` | What the dashboard sees |
|---|---|
| `"hashed"` (new installs) | `h-` + 12 hex characters of a salted hash per project (the salt stays in the state directory) |
| `"other"` (earlier installs, or roots / keep configured) | every project as `(other)` |
| `"all"` | the folder names |

**Installs from before 0.2.x** keep their task project names (the folder name under the roots, as before); set
`usage.projectNames` to `"hashed"` or `"other"` to hide them. `siiswell doctor` prints a one-line reminder until you do.

**Changing the default later.** Adding `usage.keep` or `usage.roots` to a new install WITHOUT setting
`usage.projectNames` changes its default from `"hashed"` to `"other"`. That is a stricter policy, so the next push first
erases what this host label uploaded and then re-uploads the whole history once, with the new labels. To keep the
hashes, set `"projectNames": "hashed"` together with `keep` / `roots` (`scripts/setup-client.sh` does this when you
list names).

`"hashed"` hides the name but is still a stable identifier. Anyone who can read the dashboard can follow one
project's usage over time and correlate it with other information they have (for example, when that client's work
happened), and someone who knows the salt can test guesses. Choose it only when that trade-off is acceptable.
To opt in a single project, add its folder name to `usage.keep`. A project is the first-level folder under one of
`usage.roots`. Without roots (the default) every working directory counts: its git checkout, else its folder, names the
project. With roots, anything outside them is always `(other)`. (An install that collected usage before this default
changed keeps the earlier one, `~/projects` and `/projects`, until it sets `usage.roots`.) Model ids that
are not in the dashboard's price table are sent as `unknown`.

If the policy becomes stricter (for example `"all"` to `"other"`, or a name removed from `keep`), the next push first
**erases** what this host label uploaded, then uploads again. Setting `usage.enabled: false` or `SIISWELL_USAGE=off`
erases this host's usage on the dashboard and stops uploading.

**Time zone.** Days and hours are bucketed in `SIISWELL_USAGE_TZ` / `usage.tz` (default: this machine's time zone;
the dashboard shows its days in its own `DASHBOARD_TZ`, default UTC). The time zone is fixed when the bank is first written. If this machine also runs another
uploader (for example a host agent's own usage pusher), the two must use **the same time zone**, and each must have
its **own host token and label**. Otherwise they overwrite each other's days.

**After being offline.** Every push re-sends the days since 30 hours before the last successful upload, at most 35
days back, and the dashboard replaces those days. A machine that was asleep or offline for a while catches up on its
next run. Days that are older than that are only re-sent as part of a full-history upload (first run, a new price
table, time zone or privacy policy).

**Prices.** Costs are API-equivalent estimates from the dashboard's price table. To override a model's price, add
`"pricingOverrides": { "<part of the model id>": { "input": 3, "output": 15, "cacheRead": 0.3 } }` (USD per million
tokens) under `usage`. The bank is re-priced on every run.

**Schedule** a run every 15 minutes. Examples are in `cli/examples/`:

- macOS launchd: `com.example.siiswell-usage.plist`. Copy it to `~/Library/LaunchAgents/`, fix the two absolute
  paths, then run `launchctl load …`.
- Linux systemd user timer: `siiswell-usage.service` and `siiswell-usage.timer`. Copy both to
  `~/.config/systemd/user/`, then run `systemctl --user enable --now siiswell-usage.timer`.
- cron: `crontab.txt`.

Keep the tokens in the config file, not in the plist, unit or crontab. Exit code 75 means the dashboard asked the
client to slow down (429); the next run continues where this one stopped.

## 8a. App hooks (optional)

`setup-client.sh` can install hooks that tell the dashboard when an app is **waiting for you**, without the agent
having to call anything. They run only `siiswell hook ...` (no AI, nothing that uses tokens or plan quota), return at
once (the network call runs detached in the background with an 8 s timeout, and errors never reach the app), and send
no text from the app: titles are fixed sentences and the project is a folder name.

| Hook | What it does |
|---|---|
| Claude Code `Notification` (permission needed, or idle waiting for input) | The session's task becomes **BLOCKED** ("Waiting for your permission" / "Waiting for your input"); the first notification of a session reports that task |
| Claude Code `Stop` (a turn finished) | The session's hook task goes back to **IN_PROGRESS** (a heartbeat). A session without one sends nothing. With `--on-stop done` it is closed (**DONE**) instead |
| Claude Code `PostToolUse` / `UserPromptSubmit` (working again: the permission was granted, you answered) | A **BLOCKED** hook task goes back to **IN_PROGRESS**. Decided from the local state file: no request at all unless the task is BLOCKED, and at most one update every 30 s inside one BLOCKED episode (PostToolUse fires on every tool call; a new permission prompt starts a new episode). The background runs of a session take turns (a per-session lock) and the newest event wins |
| Claude Code `SessionEnd` (Ctrl-C, `/exit`, the terminal closed) | The session's hook task is closed (**DONE**). With `--on-end heartbeat` it only goes back to IN_PROGRESS |
| Codex `notify` (a turn finished) | An MCP `heartbeat` for the project |

How the hooks keep order and never lose a prompt: the hook the app runs only writes its event to a small file in the state
directory (time-stamped the moment it starts) and starts a background run; a background run takes the session's lock (it
waits up to 30 s; a lock older than 20 s is a dead run's and is broken) and handles every queued event of the session in time
order. A permission prompt always reaches the dashboard (BLOCKED), even when a later event in the same batch has already
answered it; when its report or update fails it stays queued and the next run of the session sends it. Events that fire
within about 100 ms of each other are truly simultaneous and have no defined order; from 200 ms apart the dashboard ends in
the state of the newest one.

A hook's task carries the fixed summary "reported by the siiswell hook". If it stays **BLOCKED** for 2 hours without any update
(an older install without the new hooks, or a session that died without SessionEnd), the dashboard closes it as `stale`
("Closed — no activity after the permission prompt" under Recent results). BLOCKED tasks an agent reports itself over MCP are
never closed that way.

By hand, in `~/.claude/settings.json` (other hooks stay as they are):

```json
{ "hooks": {
  "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "timeout": 5,
    "command": "'/ABSOLUTE/PATH/TO/node' '/ABSOLUTE/PATH/.local/lib/siiswell/siiswell.mjs' hook claude-notification --config '/ABSOLUTE/PATH/.config/siiswell/claude-code.json'" }] }],
  "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "timeout": 5,
    "command": "'/ABSOLUTE/PATH/TO/node' '/ABSOLUTE/PATH/.local/lib/siiswell/siiswell.mjs' hook claude-stop --config '/ABSOLUTE/PATH/.config/siiswell/claude-code.json'" }] }]
} }
```

and at the top of `~/.codex/config.toml` (Codex allows one `notify` program; the script leaves another one alone):

```toml
notify = ["/ABSOLUTE/PATH/TO/node", "/ABSOLUTE/PATH/.local/lib/siiswell/siiswell.mjs", "hook", "codex-notify", "--config", "/ABSOLUTE/PATH/.config/siiswell/codex.json"]
```

**Privacy.** siiswell records only that you interacted (time and type), never what you typed or what the agent did. The
files the hooks write (`human.log`, `human-*.pend`, the queued events `hook-*.ev.*.json`, `human-upload.json`) hold only
timestamps, event-type letters, numbers and a project label (as your usage policy shows it); every upload holds numbers
only. The prompt, the tool arguments, the command text, the tool output and the working directory are never written or
sent. `siiswell permissions suggest` reads your local transcripts but writes nothing, sends nothing and prints only
allowlist keys. The usage collector keeps folder paths in its local state (mode 0600) to label usage; paths never leave the
machine (they give `siiswell usage show` the real names and let a change of `usage.roots` re-label the history).

**Your own pace (the "You" line).** The Claude Code hooks also note, on this machine, WHEN you sent a prompt, when you
allowed a permission prompt (a permission Notification followed by the session's next tool call) and how long the app
waited for you (Notification -> your next prompt, or the tool call you allowed). Only times and kinds are kept (`<state dir>/human.log`, mode
0600, the last 72 h): never the prompt, a tool's arguments or a command. A background run uploads hourly COUNTS at most
every 10 minutes (`POST /api/ingest/human`, the app's client token): prompts, permission prompts you allowed, how many came < 30 s after the
previous one, the median response time (only after permission prompts: the idle "waiting for your input"
notice comes after about a minute of idle by itself, so it is not timed). Give every machine its OWN client token: the
hourly counts of one token replace each other, so two machines sharing a token would overwrite each other's hours. The dashboard's stress card then leads with "You" (your input) and shows
"Agents" (what your agents put on you) under it.

The per-session task ids are kept in `<state dir>/hook-sessions.json` (mode 0600, session ids hashed, dropped after 7 days).

## 8. The agent rule

Paste this into each agent's global instructions:

```
For any task that will take longer than about 10 minutes, you may use the `siiswell` MCP tools: call
`report_task` (status `IN_PROGRESS`, with `eta_min`) when you start; call `update_task` with status
`BLOCKED` when you are blocked and need me, and with `DONE` when you finish, reusing the
`task_id` you were given. Always call `update_task` with `DONE` before your final reply,
even for quick tests: a task left open shows as unfinished on the dashboard. Give each task a short plain description of
the action as its title (for example "Fix login redirect bug", under 60 characters) and a `kind` (one of coding, debugging,
testing, review, research, docs, deploy, ops, other). Never put prompt text, conversation content, file contents, customer data,
secrets, credentials, tokens or links to private documents in any title or summary.
(You can edit or remove this rule at any time; the `taskText` setting in the siiswell config limits what is sent: brief by
default, or minimal / none for less.)
Before you stop to ask me something, call `operator_status`: while I am away (winding down for the night), continue on
your own with the safest reasonable choice instead of waiting.
```

On a machine with agent workspaces, the script adds one more line to the rule (see
[Agent workspaces run by an orchestrator](#agent-workspaces-run-by-an-orchestrator)).

`operator_status` (read-only) answers `{"status":"away","until":...}` from the dashboard's wind-down time (settings on the
page, default 23:00) until its morning time (default 07:00), else `{"status":"available"}`.

Agents without MCP, and scripts, can call the CLI directly (the client token, as for `siiswell mcp`):

```sh
id=$(siiswell report "Nightly data import" --eta-min 40 --project etl --kind ops)   # prints the task_id
siiswell update "$id" --status DONE --summary "imported 3 sources"
siiswell tasks                                    # this client's open tasks
siiswell heartbeat --project etl                  # "still alive", changes nothing
```

`siiswell --help` lists every command and flag. More on scripts and CI in [CLIENTS.md](../CLIENTS.md#10-scripts-and-ci-the-siiswell-cli).

## 8b. Fewer permission prompts: `siiswell permissions suggest`

`siiswell permissions suggest [--top N] [--json]` reads your local Claude Code transcripts of the last 7 days, finds the
tool calls that your `permissions.allow` rules (`~/.claude/settings.json`, `settings.local.json`) did not cover, so each
asked you first, and prints the most frequent ones as allowlist keys (`Bash(npm test:*)`, `WebFetch(domain:...)`, an
MCP tool) with a snippet to paste. It runs on your machine only and sends nothing; only rule keys are printed, never a whole
command. Review each one before you add it: an allow rule lets the agent run it without asking. The dashboard points here
when you allow about 10 or more permission prompts a day.

## Agent workspaces run by an orchestrator

Agent orchestrators and other automation that type the prompts themselves usually report their own tasks through the
host integration ([api.md](api.md#appendix-host-integration-api-advanced)). So that only a person's own sessions count
as human interaction, and nothing is reported twice, the hooks and the write tools of `siiswell mcp` (`report_task`,
`update_task`, `heartbeat`) do nothing when:

- the working directory is inside `<project>/worktrees/...` of a project whose root contains a file named
  `.siiswell-agents` (the file's content does not matter: `touch <project>/.siiswell-agents`), or
- the environment variable `SIISWELL_AGENT=1` is set (for automation that starts its agents elsewhere).

Read-only tools (`list_tasks`, `operator_status`) still answer. Your own sessions on the same machine, for example in the
project folder itself or any checkout outside a `worktrees` folder, are counted as usual, so the hooks can be installed
there too.

`scripts/setup-client.sh` looks for `<projects root>/*/.siiswell-agents` (the projects root is
`$SIISWELL_SETUP_PROJECTS_ROOT`, default `/projects`). When it finds one, it says so and
adds this line to the agent rule, because the agents there read the same global instructions file:

```
Ignore this rule inside agent workspaces (<project>/worktrees/... of a project with a .siiswell-agents file, or where SIISWELL_AGENT=1): the host integration reports those tasks.
```

## 9. Check that it works

1. Run `siiswell doctor`. Every line should be `[ok]` or `[--]`.
2. Ask an agent to "report a test task with siiswell". It should appear on the dashboard under "Working now" as
   `agent@<token name>`.
3. Run `siiswell usage push`. The usage page should list the host label within a minute.

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `config file … is readable by other users` | Run `chmod 600` on that file |
| 401 | Wrong or revoked token, or the variable is empty in the process that started the app (common with desktop apps). Tokens are `oct_` + 43 characters |
| 403 on `/mcp` | A `host` token was used where a `client` token is needed. `siiswell doctor` shows each token's kind |
| 403 on usage push | The host label is not the host token's name. Set `SIISWELL_HOST` / `host` to that name |
| 403 `origin not allowed` | The app sends an `Origin` header that the dashboard does not allow. Ask the operator to add it to `MCP_ALLOWED_ORIGINS` |
| `… redirect, which is refused` | The URL redirects (http to https, a typo, a proxy). Use the final `https://` address. Behind Cloudflare Access (or another login proxy) `/mcp` and `/api/ingest/*` must be bypassed for token requests |
| doctor: `protected by an access proxy (fine)` | The page and `/api/health` sit behind a login, as they should; doctor then checks reachability through the token routes |
| 429 | Over 60 requests/min or over the daily budget. Usage push exits with 75 and resumes on the next run |
| Tools never appear | The app cached an old config. Restart it completely, then check with `siiswell doctor` |
| `unknown task_id` | Task ids belong to the token that created them. Update from the same app |
| `another siiswell usage collect is running` | Two schedules overlap. The lock expires after 10 minutes |
