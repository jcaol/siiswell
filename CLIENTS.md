# Connecting agents and tools to the dashboard

> Step-by-step install of the `siiswell` CLI (stdio MCP, hooks, usage collector) for Claude Code, Codex, Claude Desktop,
> agy and Gemini CLI: [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md). Wire protocol: [docs/api.md](docs/api.md) /
> [docs/openapi.yaml](docs/openapi.yaml).

> **macOS / zsh:** some command examples below end with a `# note`. bash ignores these notes; zsh ignores them only after
> `setopt interactivecomments` (run it once in the terminal, or add it to `~/.zshrc`). Without it, copy the command without
> the note.

## Overview: every way to connect

| Client type | How to connect | Token | What it reports |
|---|---|---|---|
| CLI agents: Claude Code, Codex, Gemini CLI, agy (Antigravity), opencode, grok, kilo | `scripts/setup-client.sh` ([INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md)), or by hand: remote HTTP MCP with a bearer header, or a stdio server (`siiswell mcp` or [the bridge](#the-stdio-bridge-bridgesiiswell-bridgemjs)); per-agent snippets in sections [1](#1-codex-cli-ide-extension-chatgpt-desktop-app) to [8](#8-opencode) | `client` | tasks over MCP (with [the rule](#the-instruction-rule-put-this-in-each-agents-global-instructions)); with the Claude Code / Codex hooks also "waiting for you" and your own pace |
| Any other agent with stdio MCP | `siiswell mcp` or the bridge as a local stdio server ([section 0](#the-stdio-bridge-bridgesiiswell-bridgemjs)) | `client` | tasks over MCP |
| Desktop apps and IDE extensions: Claude Desktop, ChatGPT desktop app, Codex IDE extension | stdio server ([section 3](#3-claude-desktop)); Codex desktop and IDE share the CLI's config ([section 1](#1-codex-cli-ide-extension-chatgpt-desktop-app)) | `client` | tasks over MCP |
| Any MCP client with remote HTTP and custom headers | `POST https://dash.example.com/mcp` with `Authorization: Bearer <token>` (MCP Streamable HTTP) | `client` | tasks over MCP |
| Scripts, cron jobs, CI, agents without MCP | the `siiswell` CLI: `report`, `update`, `tasks`, `heartbeat` ([section 10](#10-scripts-and-ci-the-siiswell-cli)) | `client` | tasks, heartbeats |
| Raw HTTP from any language | JSON-RPC to `POST /mcp` ([section 11](#11-raw-http)); the endpoints in [docs/openapi.yaml](docs/openapi.yaml) | `client` (`/mcp`), `host` (ingest) | tasks; with a host token also usage and host state |
| Token usage of Claude Code and Codex | `siiswell usage push` on a schedule ([INSTALL-CLIENTS.md section 7](docs/INSTALL-CLIENTS.md#7-usage-collector-tokens-and-api-equivalent-cost)) | `host` | token counts and API-equivalent cost (numbers and labels only) |
| OpenTelemetry (Claude Code metrics) | OTLP/HTTP JSON to `POST /api/ingest/otlp`, off unless the server sets `OTLP_INGEST=1` ([section 12](#12-opentelemetry)) | `host` | token counts and cost |
| Agent orchestrators and custom automation | the host integration endpoints `/api/ingest/{heartbeat,snapshot,events}`, plus a `.siiswell-agents` marker so the hooks leave those agents to it ([section 13](#13-agent-orchestrators-and-custom-automation)) | `host` | hosts, projects, agents, tasks, events |

Every MCP client reports its long-running work to `https://dash.example.com/mcp` (MCP over Streamable HTTP) with its
**own** bearer token, so a leaked or lost one is revoked alone. Five tools: `report_task`, `update_task`, `heartbeat`
and the read-only `list_tasks` and `operator_status`. The dashboard shows "last report" age per client because agents
can forget; the instruction rule below is what makes them remember. `siiswell mcp` is a drop-in for the bridge below
(same environment variable names) that also scrubs titles and summaries on your machine.

Status legend, checked in October 2026 against the official docs linked in each section:

- **verified** - the syntax was read in the vendor's own documentation (URL given).
- **unverified** - not confirmed in vendor documentation, or not tested on a real install. Check the
  linked page, or run the listed command, before relying on it.

None of these snippets have been run against a real client install; "verified" means the syntax matches
the documentation.

## Updating the CLI

`siiswell update` installs the CLI version your dashboard publishes (`siiswell update --check` only reports; `--yes` skips the
question). The installed file keeps its path, so the app registrations, hooks and usage schedule keep working; your tokens and
configuration are not touched. The dashboard shows a small note under a host or client whose CLI is older than the server. If a
release note says the hooks or rule text changed, run `scripts/setup-client.sh --reuse` from a checkout afterwards.

## 0. Common setup

1. Mint a client token (prints it once, registers nothing by itself):
   `bun scripts/new-token.ts client2 client`, then run the printed
   `wrangler d1 execute <db-name> --remote --command "INSERT ..."` line (`<db-name>` is the `database_name` in
   `wrangler.toml`; on Docker run the SQL with `scripts/db-exec.ts`, see [docs/deploy.md](docs/deploy.md)). This changes
   the live database, so check with the dashboard operator first. Use a distinct name per client and machine (`client2`, `client-desktop`, ...).
2. Keep the token out of repos and chat. Where a client can read it from an environment variable, do that;
   where it cannot, the config file holds it, so `chmod 600` that file and never commit it.
   The token's name is what the dashboard shows: every task and alert a client reports appears as
   `<agent>@<client name>` and every alert as ` · via <client name>`, so a client can never pass for an
   agent of a reporting host. Limits per client token: 60 requests/min (each message of a JSON-RPC batch counts as one request), 50 open tasks, 1000 calls that change something per 24-hour window (finished tasks cannot be re-opened: report a new one), `project` matching
   `[A-Za-z0-9._-]{1,64}` and the optional `agent` argument `[A-Za-z0-9._=/-]{1,31}` (anything else is an
   `isError` tool result that says which field to fix).
3. Check the token and URL from any shell before touching a client:
   ```sh
   curl -s https://dash.example.com/mcp \
     -H "Authorization: Bearer $SIISWELL_TOKEN" \
     -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```
   Expect the five tools. 401 = wrong/revoked token, 403 = a `host` token (clients need a `client` token).

### The stdio bridge (`bridge/siiswell-bridge.mjs`)

For clients that cannot do remote HTTP with a custom header (or where the config cannot read the token from
the environment). It is a zero-dependency Node >= 18 script that turns newline-delimited JSON-RPC on
stdin/stdout into HTTPS calls, so no third-party package ever sees the token (we ship our own instead of
`npx mcp-remote`). Configure it as a local stdio server:

```
command: node
args:    ["/absolute/path/to/siiswell/bridge/siiswell-bridge.mjs"]
env:     SIISWELL_URL   = https://dash.example.com
         SIISWELL_TOKEN = oct_...
```

GUI apps often start without your shell's `PATH`; if `node` is not found use its absolute path
(`which node`). The bridge refuses plain `http://` to a non-local host and writes logs to stderr only.

### The instruction rule (put this in each agent's global instructions)

> For any task that will take longer than about 10 minutes, you may use the `siiswell` MCP tools: call
> `report_task` (status `IN_PROGRESS`, with `eta_min`) when you start; call `update_task` with status
> `BLOCKED` when you are blocked and need me, and with `DONE` when you finish, reusing the
> `task_id` you were given. Always call `update_task` with `DONE` before your final reply,
> even for quick tests: a task left open shows as unfinished on the dashboard. Give each task a short plain description of
> the action as its title (for example "Fix login redirect bug", under 60 characters) and a `kind` (one of coding, debugging,
> testing, review, research, docs, deploy, ops, other). Never put prompt text, conversation content, file contents, customer data,
> secrets, credentials, tokens or links to private documents in any title or summary.
> (You can edit or remove this rule at any time; the `taskText` setting in the siiswell config limits what is sent: brief by
> default, or minimal / none for less.)
> Before you stop to ask me something, call `operator_status`: while I am away (winding down for the night), continue on
> your own with the safest reasonable choice instead of waiting.

**How much task text is sent (`taskText`).** The `siiswell` CLI, `siiswell mcp` and the hooks limit title and summary
on your machine, before upload. Set `"taskText"` in the config file (for example `claude-code.json`) or the
environment variable `SIISWELL_TASK_TEXT`:

| Value | Sent |
|---|---|
| `brief` (default) | the title, scrubbed of secrets and clipped to 60 characters; no summary (a hook's fixed mark is kept) |
| `minimal` | a generic title (`Task`) unless it is a hook's own fixed title; no summary |
| `none` | no title and no summary (the dashboard shows the placeholder `Task`; a hook's blocked task then has no marker and is not closed automatically) |
| `full` | the title and summary as written, clipped and scrubbed of secrets |

Order, from least to most text: `none` < `minimal` < `brief` < `full`. The task's `kind` (one word from a fixed list: coding, debugging,
testing, review, research, docs, deploy, ops, other) carries no free text and is sent in every mode; with `minimal` or `none` the dashboard
shows it with the project (for example `debugging · web`) instead of a bare `Task`. The server applies the lowest of its own
`ACCEPT_TASK_TEXT` and a per-client ceiling the operator can set (see docs/deploy.md).

What the dashboard does with those titles and summaries, when `full` is chosen: every link in them is cut down to its scheme and host
(`https://drive.google.com/file/d/...` is stored and shown as `https://drive.google.com/[link]`), because a shared
document link is itself the key to the document, and secret-looking values are redacted. So do not rely on a link
surviving in a title, and put the name of the thing, not its URL. The text-privacy modes of host integrations
(`full` / `titles` / `none`) apply to those hosts only; an MCP client chooses its own wording, so keep
amounts and client names out of what you report.

Where each agent reads global instructions:

| Client | Global instructions file | Status |
|---|---|---|
| Codex | `~/.codex/AGENTS.md` (`AGENTS.override.md` wins; `CODEX_HOME` relocates it) | verified: https://developers.openai.com/codex/guides/agents-md |
| Claude Code | `~/.claude/CLAUDE.md` | verified on this host (it is loaded into every session); docs: https://code.claude.com/docs/en/memory |
| Claude Desktop | no global instructions *file*; use the app's profile/preferences text or a Project's instructions | unverified: https://support.anthropic.com |
| Gemini CLI | `~/.gemini/GEMINI.md` | verified: https://geminicli.com/docs/cli/gemini-md/ |
| agy (Antigravity) | `~/.gemini/AGENTS.md` or `~/.gemini/GEMINI.md` | verified: https://antigravity.google/docs/rules |
| opencode | `~/.config/opencode/AGENTS.md` (falls back to `~/.claude/CLAUDE.md`) | verified: https://opencode.ai/docs/rules/ |
| grok | `~/.grok/AGENTS.md` (guess) | unverified: https://docs.x.ai/build |
| kilo | `~/.config/kilo/AGENTS.md` (guess, opencode lineage) | unverified: https://kilo.ai/docs |

The server also sends the same advice in the MCP `instructions` field on `initialize`, which clients that
surface it will show the model automatically.

## 1. Codex (CLI, IDE extension, ChatGPT desktop app)

Verified: https://learn.chatgpt.com/docs/extend/mcp?surface=cli (the old `developers.openai.com/codex/mcp`
redirects there) and the `codex mcp add` flag table at https://learn.chatgpt.com/docs/developer-commands?surface=cli.
The docs state the ChatGPT desktop app, Codex CLI and IDE extension share one configuration, so one entry
covers all three.

```sh
export SIISWELL_TOKEN=oct_...        # in the profile that launches Codex
codex mcp add siiswell --url https://dash.example.com/mcp --bearer-token-env-var SIISWELL_TOKEN
```

or in `~/.codex/config.toml` (project-local `.codex/config.toml` works for trusted projects):

```toml
[mcp_servers.siiswell]
url = "https://dash.example.com/mcp"
bearer_token_env_var = "SIISWELL_TOKEN"
```

`bearer_token_env_var` holds the *name* of the variable, not the token. A desktop app started from the
Dock does not inherit your shell exports (macOS: `launchctl setenv SIISWELL_TOKEN ...`, unverified).
The desktop app can also add servers under Settings -> MCP servers.

## 2. Claude Code

Verified: https://code.claude.com/docs/en/mcp (`--transport http`, `--header`, `${VAR}` expansion in
`.mcp.json` `url` and `headers`).

Project or user `.mcp.json` (keeps the token out of the file):

```json
{
  "mcpServers": {
    "siiswell": {
      "type": "http",
      "url": "https://dash.example.com/mcp",
      "headers": { "Authorization": "Bearer ${SIISWELL_TOKEN}" }
    }
  }
}
```

or via the CLI (single quotes so the shell does not expand the variable):

```sh
claude mcp add --transport http --scope user siiswell https://dash.example.com/mcp \
  --header 'Authorization: Bearer ${SIISWELL_TOKEN}'
```

The Claude Code IDE extensions (VS Code, JetBrains) run Claude Code itself and are expected to use the same MCP
configuration (unverified: check with `/mcp` inside the extension).

Unverified: the docs describe `${VAR}` expansion for `.mcp.json`; whether an entry stored in
`~/.claude.json` by `claude mcp add` is expanded at runtime is not stated. Run `claude mcp get siiswell`
and `/mcp` after adding; if the header shows unexpanded or the connection fails, use the `.mcp.json` form.
Do not name the variable like a credential Claude Code blanks out (`ANTHROPIC_API_KEY`, `NPM_TOKEN`, ...);
`SIISWELL_TOKEN` is fine. Never `--scope project` a file containing a literal token.

## 3. Claude Desktop

Verified: https://modelcontextprotocol.io/docs/develop/connect-local-servers (config file locations and
JSON shape) and https://modelcontextprotocol.io/docs/develop/connect-remote-servers (remote servers go
through *Custom Connectors*, authenticated with OAuth or similar).

`claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`;
the Linux path is not given in that page: unverified), using the bridge:

```json
{
  "mcpServers": {
    "siiswell": {
      "command": "node",
      "args": ["/absolute/path/to/siiswell/bridge/siiswell-bridge.mjs"],
      "env": {
        "SIISWELL_URL": "https://dash.example.com",
        "SIISWELL_TOKEN": "oct_..."
      }
    }
  }
}
```

Restart Claude Desktop completely after editing. The token sits in that file (the page does not document
`${VAR}` expansion for Claude Desktop: unverified), so `chmod 600` it. A *Custom Connector* pointing at the
URL is not used: the connector flow is built around OAuth and a static bearer header is not documented
(unverified); an Access OAuth template is a possible later step.

## 4. Gemini CLI

Verified: https://geminicli.com/docs/tools/mcp-server/ (`mcpServers.<name>.httpUrl` = Streamable HTTP,
`url` = SSE, `headers`; `gemini mcp add --transport http --header ... <name> <url>`; `-s user|project`;
`$VAR` / `${VAR}` expansion in the **`env`** block).

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "siiswell": {
      "httpUrl": "https://dash.example.com/mcp",
      "headers": { "Authorization": "Bearer oct_..." }
    }
  }
}
```

Unverified: the docs do not say that `headers` values expand environment variables (only `env` is
documented to), so the literal token lives in the file (`chmod 600`). To keep it out of the file, use the
bridge with an `env` block, whose expansion *is* documented:

```json
{
  "mcpServers": {
    "siiswell": {
      "command": "node",
      "args": ["/absolute/path/to/siiswell/bridge/siiswell-bridge.mjs"],
      "env": { "SIISWELL_URL": "https://dash.example.com", "SIISWELL_TOKEN": "$SIISWELL_TOKEN" }
    }
  }
}
```

(Gemini strips `*TOKEN*`-style variables from the inherited environment, but variables named explicitly in
`env` are trusted and kept: same page.) CLI form:
`gemini mcp add -s user --transport http --header "Authorization: Bearer $SIISWELL_TOKEN" siiswell https://dash.example.com/mcp`
(your shell expands the variable, so the literal token is stored).

## 5. agy (Antigravity CLI)

Verified: https://antigravity.google/docs/mcp?tab=cli : global config `~/.gemini/config/mcp_config.json`, workspace
`.agents/mcp_config.json`; remote servers use **`serverUrl`** (the old `url` / `httpUrl` are not supported)
plus optional `headers`; stdio servers use `command` / `args` / `env`.

```json
{
  "mcpServers": {
    "siiswell": {
      "serverUrl": "https://dash.example.com/mcp",
      "headers": { "Authorization": "Bearer oct_..." }
    }
  }
}
```

Unverified: environment-variable expansion inside `headers` (the page is silent), so the token is literal in
the file (`chmod 600`). Fallback, and the way to keep the token out of the file if `${VAR}` turns out not to
expand: the bridge as a stdio server (`command` / `args` / `env` as in section 0). Use `/mcp` inside agy to see
the server's state. (agy is reported to honour HTTP MCP configs.)

## 6. grok

Two documented routes (Grok Build CLI, https://docs.x.ai/build/features/mcp-servers): verified for that CLI,
**unverified which grok binary is installed on each machine**, and some grok builds have been seen to
ignore HTTP MCP config, so the bridge is the default.

Bridge, `~/.grok/config.toml`:

```toml
[mcp_servers.siiswell]
command = "node"
args = ["/absolute/path/to/siiswell/bridge/siiswell-bridge.mjs"]
env = { SIISWELL_URL = "https://dash.example.com", SIISWELL_TOKEN = "${SIISWELL_TOKEN}" }
```

(`${VAR}` and `${VAR:-default}` expand in `url`, `command`, `args`, `env` and `headers` per that page.)
Native alternative, if `grok mcp doctor siiswell` shows it works on your build:

```sh
grok mcp add --transport http siiswell https://dash.example.com/mcp --header "Authorization: Bearer ${SIISWELL_TOKEN}"
```

## 7. kilo

Verified: https://kilo.ai/docs/automate/mcp/using-in-kilo-code : global `~/.config/kilo/kilo.jsonc`, project
`kilo.jsonc` or `.kilo/kilo.jsonc`; top-level `mcp` key; local servers `type: "local"` with `command` as an
**array** and `environment`; remote servers `type: "remote"` with `url` and `headers`.

Bridge (default: kilo has been observed to ignore a generated HTTP MCP config):

```jsonc
{
  "mcp": {
    "siiswell": {
      "type": "local",
      "command": ["node", "/absolute/path/to/siiswell/bridge/siiswell-bridge.mjs"],
      "environment": { "SIISWELL_URL": "https://dash.example.com", "SIISWELL_TOKEN": "oct_..." },
      "enabled": true
    }
  }
}
```

Native remote form (documented, not tested here):
`"siiswell": { "type": "remote", "url": "https://dash.example.com/mcp", "headers": { "Authorization": "Bearer oct_..." }, "enabled": true }`.
Unverified: `{env:VAR}` substitution in kilo configs (it is the documented opencode syntax and kilo derives from
opencode, but the kilo page was not confirmed to say so), so the token is literal in the file (`chmod 600`).

## 8. opencode

Verified: https://opencode.ai/docs/mcp-servers/ : `mcp` key, `type: "remote"`, `url`, `headers`,
`enabled`, `{env:VAR}` substitution (their example is `"Authorization": "Bearer {env:MY_API_KEY}"`), and
`"oauth": false` to switch off the automatic OAuth detection for API-key servers.

`opencode.json` (project) or the global config:

```json
{
  "mcp": {
    "siiswell": {
      "type": "remote",
      "url": "https://dash.example.com/mcp",
      "headers": { "Authorization": "Bearer {env:SIISWELL_TOKEN}" },
      "oauth": false,
      "enabled": true
    }
  }
}
```

Unverified: the global location of the config file (`~/.config/opencode/opencode.json` is the usual one; the MCP page
only shows `opencode.json` / `opencode.jsonc`). The *rules* file path above is verified.

## 9. pi

pi has no MCP by design (unverified); it can call the CLI from a shell instead ([section 10](#10-scripts-and-ci-the-siiswell-cli)).

## 10. Scripts and CI: the `siiswell` CLI

For cron jobs, CI steps, shell scripts and agents without MCP. Install the CLI as in
[INSTALL-CLIENTS.md section 2](docs/INSTALL-CLIENTS.md#2-install-the-cli) and give it a `client` token through
`SIISWELL_URL` / `SIISWELL_TOKEN` or a config file (tokens are never accepted as flags). In CI, keep the token in the
CI system's secret store.

```sh
id=$(siiswell report "Nightly data import" --eta-min 40 --project etl --kind ops)   # prints the task_id
siiswell update "$id" --status BLOCKED --summary "waiting for the source export"
siiswell update "$id" --status DONE
siiswell tasks                     # this client's open tasks (and those closed as stale in the last 7 days)
siiswell heartbeat --project etl   # "still alive"; changes nothing
```

`report` also takes `--status`, `--summary`, `--agent` and `--json`; `update` takes `--summary`, `--kind`, `--eta-min`
and `--json`. `siiswell --help` lists everything. Exit code 0 means the dashboard accepted the call.

## 11. Raw HTTP

Any language that can send an HTTPS POST can use `/mcp` directly (stateless JSON-RPC, no session needed):

```sh
curl -s https://dash.example.com/mcp \
  -H "Authorization: Bearer $SIISWELL_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"report_task","arguments":{"project":"web","title":"Migrate the session store","kind":"coding","status":"IN_PROGRESS","eta_min":45}}}'
```

More examples, limits and error codes: [docs/api.md](docs/api.md#curl-examples). The ingest endpoints (usage, host
integration, OTLP) are described in [docs/openapi.yaml](docs/openapi.yaml). Never follow a redirect with the token
attached.

## 12. OpenTelemetry

Claude Code can export its token and cost counters as OTLP/HTTP JSON straight to `POST /api/ingest/otlp` with a `host`
token. It is off unless the server sets `OTLP_INGEST = "1"`. The exporter settings, the field mapping and the limits are
in [docs/otel.md](docs/otel.md). Send a host's Claude Code usage either this way or with `siiswell usage push`, not both.

## 13. Agent orchestrators and custom automation

A tool that runs agents for you (an agent orchestrator, a job runner, your own automation) can show its hosts,
projects, agents and tasks with a `host` token, without MCP:

- `POST /api/ingest/heartbeat` every couple of minutes,
- `POST /api/ingest/snapshot` with the full state of one project when something changes,
- `POST /api/ingest/events` for timestamped status lines.

The bodies, the cadence and an example snapshot are in the
[host integration appendix of docs/api.md](docs/api.md#appendix-host-integration-api-advanced). `siiswell heartbeat`
with a host token (`SIISWELL_HOST_TOKEN`, `--host` or `host` = the token's name) sends the heartbeat for you.

When such a tool types the prompts itself and reports its own tasks this way, mark its projects so the hooks and
`siiswell mcp` on the same machine leave those agents alone: a file named `.siiswell-agents` in the project root (its
agents work in `<project>/worktrees/...`), or `SIISWELL_AGENT=1` in the agents' environment. Then only a person's own
sessions count as human interaction, and nothing is reported twice. Details:
[INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md#agent-workspaces-run-by-an-orchestrator).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 401 from `/mcp` | token wrong, revoked, or the env var is empty in the process that launched the client; a token is `oct_` + 43 characters, anything else is refused before it is even looked up (lost it? ask for a rotated one: `new-token.ts <name> client --rotate`) |
| 429 from `/mcp` | over 60 requests/min (batches count per message), or `isError` "at most 1000 ... 24-hour window" for the mutation budget; `heartbeat` never counts against the budget and writes nothing |
| bridge logs "the server answered with a redirect, which is refused" | `SIISWELL_URL` points at a host that redirects (http -> https, a typo, a proxy); fix the URL, the bridge never follows a redirect with your token attached |
| 403 from `/mcp` | a `host` token was used; mint a `client` token |
| 403 `origin not allowed` | the client sends an `Origin` header that is not `https://dash.example.com`; set `MCP_ALLOWED_ORIGINS` (comma separated) in `wrangler.toml` `[vars]` if it is a trusted client |
| 400 `Unsupported protocol version` | the client sent an `MCP-Protocol-Version` the server does not know; see the `supported` list in the response |
| Tools never appear | the client cached an old config: restart it; run the curl check in section 0 |
| Task shows `unknown task_id` on update | `task_id`s belong to the token that created them; use the same client entry |
