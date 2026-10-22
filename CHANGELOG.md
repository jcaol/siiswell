# Changelog

## 0.6.0 (server and CLI) — first public release

- Secret scanning: provider-shaped fake values in the redaction tests are built at run time, and `.gitleaks.toml`
  allowlists the redaction test files (their values are deliberately fake), so `gitleaks dir .` reports no leaks.
- Owner named everywhere as siiswell.com: `CLA.md` is final (no placeholder or maintainer note; questions and
  corporate agreements via hello@siiswell.com), package `author`, CONTRIBUTING gains a contact line.
- Page headers: `Permissions-Policy` (no camera, microphone, location, payment, USB) and `Cross-Origin-Opener-Policy`.
  CI checkouts keep no credentials (`persist-credentials: false`).
- CI: an optional macOS workflow (`ci-macos.yml`: by hand and weekly, never on push, never required); the Linux CI
  stays the gate.
- README (all eight languages): every shell example is safe to paste in bash and zsh (no trailing `# notes`; the task
  example captures its own id instead of a `<task_id>` placeholder); `.env` examples are marked as such. INSTALL-CLIENTS,
  deploy and CLIENTS docs say how zsh users handle the `# notes` in their examples. The full test suite and the local
  server / client checks pass on macOS as well as Linux.
- Copyright is "siiswell.com"; contacts hello@siiswell.com (general) and license@siiswell.com (licensing) in the README,
  NOTICE, COMMERCIAL-LICENSE.md and SECURITY.md (fallback contact). The README footers say "Contact" instead of an address.
- Links to the public repository https://github.com/jcaol/siiswell (README clone commands, footers, package metadata).
- README: a one-paragraph definition at the top (AI agent dashboard, LLM token usage and cost, developer well-being), what
  "SI" means, and team features named as the next step (single user today); package keywords for search.

## 0.5.7 (server and CLI)

- CLI: a command typed by hand (`siiswell tasks`, `report`, `usage push` ...) uses the per-app config setup-client.sh
  wrote when there is no `config.json` (a client token for task commands, a host token for `usage`).
- `scripts/vapid.ts` also prints the three lines ready for `.env`; `setup-client.sh --help` shows its whole header.
- `CLA.md` (draft, to be completed and reviewed before the first outside contribution) and how to turn on a CLA check.
- README: a short glossary, a six-step Docker guide (check it runs, HTTPS with a Caddy example and
  `TRUSTED_PROXY_CIDRS`, phone pushes, tokens per app and per computer, connecting a computer), and how to update, stop
  and back up; `.env.example`, deploy.md and upgrade.md match it.
- Copyright notice "The siiswell Authors" (README footers, `NOTICE`, `cli/NOTICE`, the built CLI's header).
- Page and sign-in: the title is "siiswell dashboard" with the line "SI is well, I am well, all is well."
- Public-repo tidy-up: generic `wrangler.toml` names (`siiswell`), neutral wording in the helper scripts, sample tokens
  in tests that are clearly fake, a contact for the commercial licence.

## 0.5.6 (server and CLI)

- Self-hosted (Docker): `ADMIN_PASSWORD` in `.env` is enough to sign in. It is hashed (argon2id) at startup and never
  stored as text; the hash is kept in the database, so a restart with the same password keeps sessions, and a new
  password ends them. `ADMIN_PASSWORD_HASH` still works and wins when both are set.
- `scripts/new-token.ts ... --apply` registers the token in the self-hosted database directly (no SQL to copy).
- `scripts/setup-client.sh` links the `siiswell` command into `~/.local/bin` (never over a file of your own).
- README: a "Which way is for me?" table and a four-step Docker quick start.
- README: copy-paste prompts for agents (the reporting rule, update, connection check), cloud agents (Manus, Grok, Dots,
  ChatGPT custom connectors) via the remote `/mcp` endpoint, fresh screenshots, and translations: 日本語, Deutsch, Español,
  Português (Brasil), Français, 한국어, 繁體中文.

## 0.5.5 (server and CLI)

- Licence: the client (`cli/`, `bridge/`, `src/shared/`) is now Apache-2.0 (`LICENSE-APACHE`, `cli/LICENSE`, an SPDX line in
  every client file and in the built CLI); the server and page stay AGPL-3.0-only with the commercial licence on request.
- Page, in the style of a health app: a Highlights row (the week in plain sentences with sparklines); one W / M / 6M / Y
  range control for the usage chart (W / M for the You trends); each indicator shows your usual range (middle half of
  7 days) and its 7-day average instead of the radar; the chosen value appears large in the chart header; one colour per
  category (Tasks, Usage, You, Rest) in light and dark; shorter state labels (OK / Watch / Rest); big numbers with small
  units; pin cards to the front (per browser). `/api/wellbeing` indicator series carry `lo` / `hi` (additive).
- README: tagline "SI is well, I am well.", a larger How it works diagram, and a section on what makes siiswell different.
- `scripts/setup-client.sh` keeps an installed CLI that is newer than the checkout's `cli/dist` (one from `siiswell update`)
  instead of replacing it with the older build, and says how to update the checkout.

## 0.5.4 (server and CLI)

- Agent workspaces are recognised by a neutral marker: a hook (and the write tools of `siiswell mcp`) does nothing inside
  `<project>/worktrees/...` of a project whose root holds a `.siiswell-agents` file, or wherever `SIISWELL_AGENT=1` is set.
  Agent orchestrators that report their own tasks mark their projects this way. A machine that relied on the earlier,
  tool-specific detection needs the marker file in each such project, then `scripts/setup-client.sh --reuse` for the rule text.
- `siiswell doctor` says when `SIISWELL_AGENT` is set. `scripts/demo-seed.ts` checks a database read-only before it touches it.
- UI: the task kind chip has its own style; the 30-day trend detail no longer shows "null"; the "Your apps" contribution has a
  label; the stress gauge and energy battery stay inside their column on wide screens.
- The stdio bridge is now `bridge/siiswell-bridge.mjs` and reads `SIISWELL_URL` / `SIISWELL_TOKEN` only. A client config
  that starts it by path needs the new path (or `siiswell mcp`, which does the same job).
- `scripts/new-token.ts` and `scripts/purge-source.ts` print `wrangler d1 execute` lines with the `database_name` from
  `wrangler.toml`.
- New README with a feature overview, client table and FAQ; `scripts/demo-seed.ts` fills a local database with demo data.
- Docs: an overview of every way to connect (CLIENTS.md), `kind` documented as required in `report_task`.

## 0.5.3 (server and CLI)

- The server is now the ceiling for the free text of host snapshots too. A host's task titles are often the operator's own request
  text, so the new `ACCEPT_HOST_TEXT` (`full` | `brief` | `minimal` | `none`, default `minimal`) limits them before anything is
  stored, hashed, evaluated or pushed. `minimal` stores a neutral label built from structured fields ("Task for <agent>"; `none`:
  "Task"), approval summaries as "Approval pending", drops discussion topics, and uses fixed labels for event text. `brief` keeps
  titles scrubbed and clipped to 60 characters. `full` keeps today's behaviour. Ids, states, ETAs, agents and projects are kept.
  The stricter of this value and the source's own `task_text` applies. Set `ACCEPT_HOST_TEXT=full` to keep descriptive titles.
- Migration 0015 replaces text already stored from host snapshots with the same labels (tasks reported through the MCP endpoint are
  not touched) and resolves open alerts built from that text; the rules re-open them with the new wording.

## 0.5.2 (server and CLI)

- New task text level `brief`, now the default for both the client `taskText` setting and the server `ACCEPT_TASK_TEXT`: the title is kept
  (scrubbed of secrets first, then clipped to 60 characters); the summary is dropped (a hook's fixed mark is kept). Order from least to
  most text: `none` < `minimal` < `brief` < `full`. A deployment that wants the old behaviour sets `ACCEPT_TASK_TEXT=minimal`.
- New task field `kind`: one word from a fixed list (coding, debugging, testing, review, research, docs, deploy, ops, other; an unknown word
  is stored as `other`). Accepted by `report_task` / `update_task` (and `siiswell report|update --kind`), stored by migration 0014
  (`tasks.kind`), kept in every text mode because it carries no free text. The dashboard shows it as a small chip next to the title, and
  as `<kind> · <project>` where the title is only the generic `Task`.
- Per-client ceiling: migration 0014 also adds `sources.task_text` (empty = the server default). The server applies the lowest of
  `ACCEPT_TASK_TEXT` and that value. Set it with `UPDATE sources SET task_text = 'full' WHERE name = '<client name>';` or with
  `scripts/new-token.ts <name> client --task-text full`.
- The suggested agent rule asks for a short plain description of the action (for example "Fix login redirect bug") plus a kind, and
  repeats what never to include. **Because the rule text changed, run `scripts/setup-client.sh --reuse` once from a checkout** on each
  machine (after `siiswell update`); it replaces only the siiswell-owned rule block. People who prefer less can set `taskText` to
  `minimal` or `none`.

## 0.5.1 (server and CLI)

- `siiswell update`: the downloaded file is test-run as an ES module (its temporary name now ends in `.mjs`), so the
  update installs instead of stopping at the test run. Clients on 0.5.0 install 0.5.1 once by hand; later updates use
  `siiswell update`.

## 0.5.0 (server and CLI)

- `siiswell update [--check] [--yes]` (also `siiswell self-update`): installs the CLI build the dashboard publishes. It downloads
  `/api/ingest/client/siiswell.mjs`, checks size and sha256 against `/api/ingest/client/latest`, test-runs the file, then replaces the installed
  script atomically (same path and mode, so registrations and hooks keep working). `--check` only reports. https only (localhost
  excepted). `siiswell update <task_id> --status ...` is unchanged.
- Server: `GET /api/ingest/client/latest` (manifest `{version, sha, sha256, size}`) and `GET /api/ingest/client/siiswell.mjs`, bearer token of
  kind client or host, same rate limits; not a public asset. The bundle is embedded into the Worker at deploy time
  (`bun run deploy` does it; Docker builds run `scripts/embed-client.ts`). The routes sit under `/api/ingest/`, so the existing Access bypass
  for `/api/ingest/*` already covers them.
- The CLI sends `X-Siiswell-Client: <version>+<sha>` with its requests. Migration 0013 stores the last value per source
  (`sources.client_version`); the dashboard shows a small note under a host or client that reports an older version.

## Server 0.4.0 (privacy-minimal)

- `ACCEPT_TASK_TEXT` (`full` | `minimal` | `none`, default `minimal`): the server limits the title and summary of `report_task` /
  `update_task` before storage, with the same rules as the client `taskText` setting. It is the ceiling: a client set to `full`
  cannot exceed a server set to `minimal`. Operators who want descriptive titles set `ACCEPT_TASK_TEXT=full` in their own config.
  Unknown argument keys are ignored (never stored).
- Without `ACCEPT_LAST_LINE=1`, status events from other agent integrations keep only the fixed label "Status update" (task row and event text), and
  `/api/state` never returns `lastLine` (the hook's own fixed lines excepted).
- Migration 0012 clears `last_line` stored by earlier versions (the hook's fixed lines are kept).
- Task tool names are matched case-insensitively by the client policy.

## 0.4.0

- `taskText` client setting (`full` | `minimal` | `none`, env `SIISWELL_TASK_TEXT`, default `minimal`): the CLI, the MCP
  stdio relay and the hooks limit task title and summary on the machine, before upload. `minimal` sends a generic title
  and no summary; `none` sends neither. The server accepts a task without a title (stored as `Task`).
- Server option `ACCEPT_LAST_LINE` (default off): the `lastLine` of host snapshots is dropped before storage unless set to `1`.
- The self-hosted server never reads `DEV_NO_ACCESS` (it uses its own login / trusted-proxy check).
- The suggested agent instruction is neutral: titles and summaries are optional, short and generic.
- SECURITY.md: single-tenant model and required rate-limit bindings. Added CLAUDE.md with the repository's working rules.

Upgrade note: clients now send a generic title by default. Set `taskText` to `full` to keep descriptive titles.
