# Deploying siiswell

Two ways to run the server: a Cloudflare Worker with D1 (below), or one Docker container with SQLite
([Deploy with Docker](#deploy-with-docker)). Upgrades between releases: [upgrade.md](upgrade.md). How the page and the
rules behave, limits and security notes: [reference.md](reference.md).

> **macOS / zsh:** some command examples below end with a `# note`. bash ignores these notes; zsh ignores them only after
> `setopt interactivecomments` (run it once in the terminal, or add it to `~/.zshrc`). Without it, copy the command without
> the note.

## Local development

Needs bun, and **Node >= 22 for `wrangler dev`** (wrangler 4.142 refuses Node 20; `wrangler dev` also
hangs when run under `bun --bun`, while `d1 migrations apply --local` / `d1 execute --local` work under
either). Nothing below talks to Cloudflare.

```sh
bun install
bun test                      # unit + integration tests (no network, no wrangler)
bun run typecheck             # tsc --noEmit -p .

# local database + dev server
export CI=1 WRANGLER_SEND_METRICS=false
# 0001_init.sql was edited in place before the first deploy: if you applied an earlier version
# locally, `rm -rf .wrangler/state` first, then re-apply.
bunx wrangler d1 migrations apply <db-name> --local    # <db-name>: database_name in wrangler.toml
printf 'DEV_NO_ACCESS=1\n' > .dev.vars      # gitignored; skips Access ONLY for localhost requests
bun scripts/vapid.ts mailto:you@example.com  # optional: add the 3 VAPID_* lines to .dev.vars for push
bunx wrangler dev --local                    # http://127.0.0.1:8787

# in another terminal
bun scripts/smoke-local.ts http://127.0.0.1:8787
curl http://127.0.0.1:8787/cdn-cgi/handler/scheduled     # run the cron once
```

`DEV_NO_ACCESS=1` is honoured only when `ACCESS_TEAM_DOMAIN` is empty **and** the request host is
`localhost`/`127.0.0.1`, so a stray copy of that variable in production is inert. The self-hosted Bun / Docker server never reads it: it
uses its own login or trusted-proxy check and does not copy the variable into its environment.

`ACCEPT_TASK_TEXT` (`full` | `brief` | `minimal` | `none`, default `brief`): the server limits task titles and summaries before storage, whatever
the client sends (`brief` keeps the title, clipped to 60 characters, and drops the summary); set `full` in your own config to keep descriptive text.
The ceiling that applies to a client is the lowest of this value, the client's own `sources.task_text` and the client's `taskText` setting.
A per-client value (migration 0014; empty = use `ACCEPT_TASK_TEXT`) is set in the database:

```sql
UPDATE sources SET task_text = 'full' WHERE name = '<client name>';   -- none | minimal | brief | full
UPDATE sources SET task_text = NULL WHERE name = '<client name>';     -- back to the server default
```

`scripts/new-token.ts <name> client --task-text full` prints the INSERT with that value already set.

`ACCEPT_HOST_TEXT` (default `minimal`): the server's ceiling for the free text of host snapshots and events, combined with the
source's own `task_text` (the stricter wins). `minimal` stores "Task for <agent>" instead of the title, "Approval pending" instead of
an approval summary, no discussion topics and fixed labels for event text; `none` stores "Task"; `brief` keeps titles scrubbed and
clipped to 60 characters; `full` keeps the text as sent. Migration 0015 applies the same labels to rows stored before.

`ACCEPT_LAST_LINE` (default off): host snapshots carry a `lastLine` per task; the server drops it before storage unless
this is `1`. The page simply shows no line when it is absent.

Mint tokens for local use with `bun scripts/new-token.ts <host-label|client-name> <host|client>` and run
the printed `wrangler d1 execute ... --local` line. **Delete `.dev.vars` and `.wrangler/` after a local
run**: they can hold a dev VAPID private key and local data (both are gitignored, never commit them).

## Deploy checklist

Every step marked **[outward]** changes something on Cloudflare or the public internet. Do them in
order, one at a time, and stop if anything looks wrong. Nothing here is done by the test suite or
by the helper scripts.

0. **Plan: Workers Paid is recommended** (the independent audit's recommendation: on Paid even a
   leaked host token cannot exhaust any quota; on Free it can exhaust the daily read quota until revoked
   and purged). Background: Workers *Free* gives 10 ms CPU per request and per cron run; ingest of a large
   snapshot or an Access JWT check can come close. Workers Paid (USD 5/month) gives 30 s and is
   the safe choice. D1 on the Free plan allows 5 M rows read and 100 k rows written per day and then
   REFUSES queries (the dashboard and its alerts go dark until 00:00 UTC): see
   [D1 quota estimate](reference.md#d1-quota-estimate-5-projects) for what this dashboard uses and when to upgrade.
1. **[outward] Log in:** `bunx wrangler login` (or export a scoped `CLOUDFLARE_API_TOKEN`).
2. **[outward] Create the database:** `bunx wrangler d1 create <db-name>`, then paste the
   `database_id` it prints into `wrangler.toml` (replace `REPLACE_AFTER_d1_create`). In every `wrangler d1` command in
   these docs, `<db-name>` is the `database_name` of the `[[d1_databases]]` block in `wrangler.toml` (keep the shipped
   value or choose your own before this step; the scripts read it from there for the commands they print).
3. **[outward] Apply the schema:** `bunx wrangler d1 migrations apply <db-name> --remote` (it applies every file in `migrations/`: `0002_project_seen.sql` too).
   On an installation that is already live, apply the new migration BEFORE deploying a Worker that reads it. A Worker deployed first keeps working
   (a missing `project_seen` table is treated as "no per-project data"), but records nothing and cannot alert until the table exists.
   **Exception: `0004_neutral_origins.sql` goes the other way round: deploy the Worker FIRST, then apply 0004 immediately.** The new Worker
   reads stored legacy `origin` values as their canonical ones, so the rows 0004 has not rewritten yet behave correctly; an older Worker
   would misread rewritten rows (see the header of the migration).
4. **VAPID keys + secrets** (the private key is a password: anyone with it can push to every
   subscribed device):
   ```sh
   bun scripts/vapid.ts mailto:you@example.com     # prints the pair once
   bunx wrangler secret put VAPID_PUBLIC_KEY       # [outward] paste when asked
   bunx wrangler secret put VAPID_PRIVATE_KEY
   bunx wrangler secret put VAPID_SUBJECT
   ```
5. **[outward] Cloudflare Access** (Zero Trust dashboard) for `dash.example.com`:
   - Self-hosted application on the hostname `dash.example.com`, policy **Allow** = your email.
   - A second self-hosted application (or path rule) for `dash.example.com/api/ingest/*` and
     `dash.example.com/mcp*` with a **Bypass** policy: those two carry bearer tokens instead. The CLI download
     for `siiswell update` (`/api/ingest/client/*`) sits under the same `/api/ingest/*` bypass; nothing extra is needed.
     Double-check that `/api/state`, `/api/push/*` and `/` are NOT covered by the bypass.
   - Copy the team domain (`<team>.cloudflareaccess.com`) and the main application's AUD tag into
     `wrangler.toml` `[vars]` as `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. While `ACCESS_TEAM_DOMAIN`
     is empty the Worker answers 403 on every Access-protected API route, by design.
   - **Set `ACCESS_ALLOWED_EMAILS`** (same `[vars]` block) to your address, or a comma-separated list. The
     Worker then checks the `email` claim of the Access JWT against it (case-insensitive, exact match) on
     `/api/state` and the push routes, so a policy that is widened by mistake in the Zero Trust UI (or a
     service token with no e-mail) still cannot read the dashboard: `403 access denied`. Empty = any
     identity the Access policy lets through; it is optional, but it is the cheapest second lock there is.
6. **Enable the route:** uncomment the `[[routes]]` block (`custom_domain = true`) in
   `wrangler.toml`. The zone `example.com` must be on Cloudflare; the DNS record is created for you.
7. **[outward] Deploy:** `bun run deploy -- --dry-run` first (builds, uploads nothing), then
   `bun run deploy` (`wrangler deploy` plus the build stamp and the embedded CLI bundle for `siiswell update`, which it builds and removes again from the working tree: the git short sha and build day shown in the page footer). `workers_dev` and preview URLs are off, so the custom domain is the only entry.
   The two `[[ratelimits]]` bindings (per-token budgets, see [Abuse limits](reference.md#abuse-limits)) are created by
   the deploy; their `namespace_id`s (`7311001`, `7311002`) must be unique in the account.
   The deploy also creates the `OrchTicker` Durable Object (migration `v1`, `new_sqlite_classes`), the once-a-minute clock
   that replaces the cron trigger (see Ticker); it arms itself on the first request after the deploy.
   **No rollback past this deploy.** Cloudflare refuses `wrangler rollback` to a version from before a Durable Object
   class change, so once migration `v1` is live the only way back is forward: fix and deploy again. Emergency stop of the
   ticker: set `TICKER_ENABLED = "0"` in `[vars]` and deploy (a var edited in the Cloudflare dashboard is overwritten by the
   next deploy); the opportunistic path takes over within 2 minutes. Never edit or remove the `v1` migration; retiring the
   class later takes a new migration with `deleted_classes = ["OrchTicker"]`. Deploy from a clean checkout of the release
   commit (the Worker bundles `src/shared/*.ts`, so uncommitted work there would ship too).
8. **Check it:**
   - `curl https://dash.example.com/api/health` -> `{"ok":true,...}`
   - `curl -i https://dash.example.com/api/state` without Access -> redirected to login / 403
   - `curl -i -X POST https://dash.example.com/api/ingest/snapshot` without a token -> 401
9. **Tokens, one per host and per client** (so each can be revoked alone):
   ```sh
   bun scripts/new-token.ts hosta host            # prints the token once + the SQL to register its hash
   bunx wrangler d1 execute <db-name> --remote --command "INSERT INTO sources ..."   # [outward] the printed line
   ```
   **A host token is bound to one host label, and the token's name (`sources.name`) IS that label.** It
   must equal the host label configured in the host agent, or `os.hostname()` when that is unset (compared
   raw and case-sensitively; `node -p "require('os').hostname()"` on the host shows it). Names are
   restricted to `[A-Za-z0-9._-]{1,64}` (same set as host and project labels) and are never redacted or
   rewritten, so a host called `sk-build-server` works. Every snapshot, event and heartbeat the
   token sends must carry that `host`, otherwise the dashboard answers
   `403 {"error":"host label '<x>' does not match this token"}` and writes nothing. All projects on one
   host share the host's token. Give it to the host integration in the way its own documentation describes
   (the wire format is in [api.md](api.md#appendix-host-integration-api-advanced)). Client tokens (any unique name) go to
   the agents and apps: see [`CLIENTS.md`](../CLIENTS.md).
10. **iPhone:** open `https://dash.example.com`, Share -> *Add to Home Screen*, open it from the
    Home Screen (iOS only allows Web Push for installed web apps), tap *Enable notifications*, then
    *Send test push*. A 180 px `apple-touch-icon.png` is a nice-to-have: iOS ignores SVG icons for the
    Home Screen, so add `public/apple-touch-icon.png` and a `<link rel="apple-touch-icon">` later.

**Retiring a host.** A host that stops for good keeps its critical `host-offline` alert until the retention purge removes
the host row and, a little later, the open alert (about 30 days). To retire one on purpose, revoke its token and run
`bun scripts/purge-source.ts <host-label>` (prints the DELETEs for everything it wrote, alerts included).

Revoke a token: `UPDATE sources SET revoked = 1 WHERE name = '<name>';` (or delete the row), run with
`wrangler d1 execute <db-name> --remote --command "..."`. Roll back the whole thing: remove the
route and `wrangler delete` (this also deletes the `OrchTicker` Durable Object and its alarm); D1 can be dropped
separately. A partial rollback to a Worker version from before the ticker is not possible (see step 7).

**Rotate a token** (lost, leaked, or revoked and needed again). Source names are unique, so minting
the same label again with the `INSERT` would fail; use the rotate form:

```sh
bun scripts/new-token.ts hosta host --rotate      # prints the new token ONCE and an UPDATE, runs nothing
bunx wrangler d1 execute <db-name> --remote --command "SELECT name, kind, revoked FROM sources WHERE name = 'hosta'"   # exactly one row
bunx wrangler d1 execute <db-name> --remote --command "UPDATE sources SET token_sha256 = '<sha>', revoked = 0 WHERE name = 'hosta' AND kind = 'host';"   # the printed line
```

The UPDATE swaps the hash and clears `revoked`; the row keeps its id, name and budgets, and the old token
stops working the moment it runs (so run it, then put the new token into the host agent's configuration /
the client's config). Other labels are untouched. A leaked token is therefore: revoke (or rotate)
straight away, then look at `sources.wr_count` / `mut_count` and the `events` it wrote.

**Token shape.** Tokens are `oct_` + 43 base64url characters (what `new-token.ts` prints). Anything else in
`Authorization: Bearer ...` is a `401` BEFORE any database lookup, so junk and malformed values cost no D1 read.

## Deploy with Docker

The same app also runs as one container: `src/server/bun.ts` serves the runtime-neutral `route()` with `Bun.serve`,
SQLite instead of D1, and its own browser login instead of Cloudflare Access (the Cloudflare deployment above is
unchanged and keeps Access). Ingest and MCP use the same bearer tokens either way.

| Cloudflare | Docker |
|---|---|
| D1 | SQLite file `/data/siiswell.sqlite` (`DB_PATH` / `DATA_DIR`), WAL; `migrations/*.sql` applied in order at startup, each in one transaction, recorded in `_migrations` (seeded from `d1_migrations` when the file is an imported D1 export; migration files must not contain BEGIN / COMMIT) |
| static assets + `_headers` | files of `public/` with the same `_headers` (CSP, nosniff, ...) and correct content types; HSTS only when `PUBLIC_URL` is https |
| Cloudflare Access | `AUTH_MODE=builtin` (default) or `AUTH_MODE=proxy`, below |
| Durable Object alarm / cron | `setInterval` every 60 s running the alarm's body (`runTick`). **Run ONE replica per database**: SQLite on a shared volume is not a cluster |
| Rate Limiting bindings | in-memory, 60 requests / min per token |

### 1. Build and configure

```sh
docker build -t siiswell:local .           # or: docker compose build
# optional: an admin password HASH instead of the plain ADMIN_PASSWORD below (read from stdin, nothing is stored)
printf '%s\n' 'a long admin password' | docker run --rm -i siiswell:local bun scripts/hash-password.ts
# optional phone pushes
docker run --rm siiswell:local bun scripts/vapid.ts mailto:you@example.com
```

`.env` next to `docker-compose.yml` (never commit it; `.gitignore` covers `*.env` and `.env*` is in `.dockerignore`):

```sh
PUBLIC_URL=https://dash.your-domain.example
AUTH_MODE=builtin
# the simple way: the password itself (12+ characters). It is hashed (argon2id) at startup and never stored as text;
# the hash is kept in the database so a restart with the same password keeps everyone signed in, and a new password
# ends every session. Single-quote it (then a "$" needs no escaping). Keep .env at mode 600. Database backups hold the
# password's hash, so keep them as private as .env.
ADMIN_PASSWORD='a long admin password'
# with a TLS proxy on this machine (docker-compose.yml as shipped); empty while testing on http://localhost:8787
TRUSTED_PROXY_CIDRS=172.28.0.1/32
# or a hash from scripts/hash-password.ts instead (it wins when both are set):
# ADMIN_PASSWORD_HASH='$argon2id$v=19$m=65536,t=2,p=1$...'
# VAPID_PUBLIC_KEY=...  VAPID_PRIVATE_KEY=...  VAPID_SUBJECT=mailto:you@example.com
```

Then `docker compose up -d`. The example publishes port 8787 on 127.0.0.1 only: put a TLS reverse proxy in front
(the dashboard's cookies and push need https; plain http works only for `http://localhost`).

> **Behind a reverse proxy you MUST set `TRUSTED_PROXY_CIDRS=<proxy address>/32`**, in builtin mode too. Otherwise
> every client reaches the container from the proxy's (or the Docker gateway's) address, shares one login rate-limit
> slot, and anyone could keep that slot exhausted. The server therefore REFUSES logins that carry `X-Forwarded-For`
> from a peer not in `TRUSTED_PROXY_CIDRS` (403, and a warning in the log at most once a minute).
> `ALLOW_UNTRUSTED_XFF=1` switches that refusal off; only use it if you understand that all clients then share one address.

Every setting is validated at startup; the container exits with ONE message listing every missing / invalid one.

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | (required) | The origin users open (https, or http://localhost). Used for the same-origin checks, MCP Origin check, and the cookie's `Secure` flag |
| `AUTH_MODE` | `builtin` | `builtin` or `proxy` |
| `ADMIN_PASSWORD` | (builtin: this or the hash) | the admin password, 12-1024 characters; hashed at startup, never stored as text |
| `ADMIN_PASSWORD_HASH` | (builtin: this or the password) | argon2id hash from `scripts/hash-password.ts`; wins over `ADMIN_PASSWORD` |
| `TRUSTED_PROXY_CIDRS` | (proxy: required) | comma-separated addresses / CIDRs of the reverse proxy. Also used in builtin mode to take the client IP (login rate limit) from `X-Forwarded-For` |
| `AUTH_PROXY_HEADER` | `X-Forwarded-Email` | proxy: the header carrying the signed-in identity |
| `ALLOWED_EMAILS` | (any) | proxy: comma-separated identities allowed in (case-insensitive) |
| `ALLOW_UNTRUSTED_XFF` | (unset) | builtin: `1` accepts logins with `X-Forwarded-For` from a peer not in `TRUSTED_PROXY_CIDRS` (not recommended) |
| `ALLOW_WIDE_PROXY_CIDR` | (unset) | `1` accepts trusted CIDRs wider than /24 / /64 (not recommended) |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | (unset) | proxy behind Cloudflare Access: verify the Access JWT (both or none) |
| `AUTH_PROXY_LOGOUT_URL` | (none) | proxy: where the page's "Sign out" link goes |
| `BIND` / `PORT` | `0.0.0.0` / `8787` in the image (`127.0.0.1` outside it) | listen address |
| `DATA_DIR` / `DB_PATH` | `/data` / `$DATA_DIR/siiswell.sqlite` | database location (the volume) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | (none) | phone pushes; all three or none |
| `RETENTION_DAYS`, `USAGE_RETENTION_DAYS`, `RULES_MIN_INTERVAL_MS`, `TICKER_ENABLED`, `OPPORTUNISTIC_MAINTENANCE`, `PUSH_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` | as on Cloudflare | same meaning as the Worker vars |

### 2. Browser sign-in

**`AUTH_MODE=builtin`**: one admin. `/auth/login` checks the password against `ADMIN_PASSWORD_HASH` (argon2id);
sessions are stored server-side in SQLite (`auth_sessions`, only a sha256 of the cookie value); the cookie is
`HttpOnly; SameSite=Lax; Path=/`, plus `Secure` and the `__Host-` prefix when `PUBLIC_URL` is https. A session ends
after 12 h without a request or 7 days after sign-in.

Login limits (all in memory, single replica):

- **Per address**: 5 failures per 15 minutes. **Per public /24 (IPv4) or /64 (IPv6)**: 50 per 15 minutes, so
  rotating addresses inside a prefix buys little while a guesser behind the admin's NAT or ISP prefix cannot lock the
  admin's own address. Loopback and private addresses (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7, fe80::/10)
  are never grouped. IPv4 written as IPv6 (`::ffff:a.b.c.d`, `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`)
  counts as that IPv4.
- **Global**: 100 failed attempts per minute across all clients; once spent, browsers without a known device get 429
  for the rest of the minute.
- **Known device**: every successful sign-in sets a "known device" cookie (HttpOnly, SameSite=Strict, 30 days,
  HMAC-signed with a secret kept in the database, bound to the password hash; not a session, it opens nothing). A
  browser that has one is counted on its own (5 failures per 15 minutes per device) instead of per address / prefix /
  globally, so nobody else's guessing can lock it out.
- At most 10 000 address / prefix counters are held, created only when an attempt is actually charged (a refused
  request creates none), and at most 64 addresses per /24 | /64 (beyond that the prefix counter alone limits them).
  When full, ended windows are dropped, but a counter still in force (a lockout) is never evicted; new addresses then
  share ONE overflow counter and are refused once it is spent (fail closed) until windows end. Known-device counters
  live apart and never overflow, so a signed-in browser is not affected. Unknown recovery codes count toward the global budget like wrong passwords.
- Every slot is reserved before the password check and given back on success (no race under concurrency). At most 2
  argon2 checks run at once, up to 32 wait, beyond that 503.
- **Recovery**: changing the password voids every known-device cookie. If the login page then refuses you because of
  somebody else's guessing, mint a one-time code with `docker compose exec siiswell bun scripts/recovery-token.ts`
  and enter it under "Recovery code" together with the password: that login skips the address, prefix and global
  limits once. Only its sha256 is stored; it expires after 24 h, one successful login or 5 wrong passwords (each try is
  reserved atomically before the password check), and tries of real codes are capped at 10 a minute in all. An unknown or expired code
  counts like a wrong password against the caller's own address and prefix, so a flood of bogus codes cannot block the real one.

**The real defence is a long random password**: the limits only slow a guesser down. `scripts/hash-password.ts`
refuses fewer than 12 characters; use 20+ random ones (a password manager, or `openssl rand -base64 24`). The server
refuses a hash cheaper than argon2id m=19456 KiB, t=2 (it cannot see the password itself).

Changing `ADMIN_PASSWORD_HASH` ends every existing session and known device. Login and logout must be same-origin. "Sign out" on the page leads to
`/auth/logout`. Change the password by replacing the hash and restarting; to end every session at once:
`docker compose exec siiswell bun scripts/db-exec.ts "DELETE FROM auth_sessions"`.

**`AUTH_MODE=proxy`**: a reverse proxy signs users in and names them in a header. The header is believed only when
the TCP peer is in `TRUSTED_PROXY_CIDRS` (anything else gets 403). Set it up like the compose example:

- give the proxy a **fixed address on a dedicated network** (`ipv4_address: 172.28.0.10` on `siiswell-internal`) and trust
  exactly that: `TRUSTED_PROXY_CIDRS=172.28.0.10/32`;
- **publish no dashboard port** in proxy mode (delete `ports:`): only the proxy is reachable from outside.

> **Warning.** Never trust a whole Docker range (`172.16.0.0/12`) or the bridge gateway. Traffic to a published port
> reaches the container FROM the gateway address, so trusting it lets anyone who can reach that port send any
> identity header. The server refuses to start with a CIDR wider than /24 (IPv4) or /64 (IPv6) unless
> `ALLOW_WIDE_PROXY_CIDR=1`, in builtin mode too (there the list decides whose `X-Forwarded-For` the login limits believe).

Common headers:

| Proxy | `AUTH_PROXY_HEADER` |
|---|---|
| oauth2-proxy (`--set-xauthrequest` / `--pass-user-headers`) | `X-Forwarded-Email` (default) |
| Tailscale serve (identity headers) | `Tailscale-User-Login` |
| Cloudflare Access in front of the container (tunnel) | `Cf-Access-Authenticated-User-Email`, plus `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`: the `Cf-Access-Jwt-Assertion` JWT is then verified like on the Worker (signature, aud, iss, exp, `ALLOWED_EMAILS`) and its e-mail must equal the header. Without them the header is trusted unverified and a warning is printed at startup |

### 3. Tokens and SQL

Tokens: `docker compose exec siiswell bun scripts/new-token.ts <name> <client|host> --apply` prints the token once and
registers it in the container's database directly (`--rotate --apply` replaces an existing one).
`scripts/purge-source.ts` (and `new-token.ts` without `--apply`) print SQL meant for `wrangler d1 execute`; run the same SQL with
`docker compose exec siiswell bun scripts/db-exec.ts "<sql>"`. Order does not matter: if the server has never run
(no database file yet), `db-exec.ts` (and `recovery-token.ts`) create it and apply the migrations exactly as the server
does at startup, so tokens can be registered before the first start (`docker compose run --rm siiswell bun
scripts/db-exec.ts "<sql>"` when the container is not running). Host agents and MCP clients are pointed at `PUBLIC_URL`
(see the host integration's documentation and [`CLIENTS.md`](../CLIENTS.md)); ingest and `/mcp` bypass the browser sign-in and use their tokens.

### Without Docker

`bun src/server/bun.ts` with the same environment (e.g. `DATA_DIR=./data PUBLIC_URL=http://localhost:8787`).
`HEALTHCHECK` / monitoring: `GET /api/health` (no auth, no data). SIGTERM finishes in-flight requests, the running
tick and every background push before exiting (`stop_grace_period: 30s` in the compose example).


### Deploying with your own wrangler wrapper

`bun run deploy` embeds the CLI bundle, runs wrangler and restores the stub. If you deploy through your own wrapper, do the
three steps yourself, with the same stamp for both the bundle and wrangler:

```sh
export SIISWELL_BUILD_SHA=$(git rev-parse --short=7 HEAD) SIISWELL_BUILD_DATE=$(date -u +%F)
bun scripts/embed-client.ts                  # writes the bundle into src/client-dist.ts
<your wrangler deploy> --define "__SIISWELL_BUILD__:{\"sha\":\"$SIISWELL_BUILD_SHA\",\"built\":\"$SIISWELL_BUILD_DATE\"}"
bun scripts/embed-client.ts --restore        # puts the empty stub back
```

`src/client-dist.ts` must be committed only as the stub. `embed-client.ts` refuses to run while that file has staged or
unstaged changes, and a test checks that the committed file is the stub (`CLIENT_DIST === null`, under 2 KB).
