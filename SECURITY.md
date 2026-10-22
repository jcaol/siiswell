# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not in public issues or pull requests: use GitHub's private vulnerability
reporting (the repository's **Security** tab, "Report a vulnerability"). Include a description, the affected version or
commit, and steps to reproduce. If that is not available, e-mail [hello@siiswell.com](mailto:hello@siiswell.com) and ask for a
private channel; do not include exploit details in the first message.

You will get an acknowledgement within a few working days. Please give us a reasonable time to fix the issue before
any public disclosure; we will credit you in the release notes unless you prefer otherwise.

## Scope

In scope: the server (Cloudflare Worker and the self-hosted Bun server), the web page, the `siiswell` CLI (stdio MCP server,
hooks, usage collector), the stdio bridge (`bridge/siiswell-bridge.mjs`) and the deployment examples in this repository.

Out of scope: vulnerabilities in third-party services (Cloudflare, your reverse proxy, your identity provider) and
findings that need an already compromised host or a stolen token, unless the product makes the impact worse.

## Single-tenant model

One deployment serves one operator. Client tokens identify a device or app; they are not a tenant boundary, and any
client token can read the operator's status (for example through `operator_status`). Do not share a deployment between
people who should not see each other's activity: run one deployment each.

## Required rate-limit bindings

`RATE_LIMIT_HOST` and `RATE_LIMIT_CLIENT` must be configured (see `wrangler.toml`; the self-hosted server provides
in-memory limiters). Without a binding the per-minute limiter fails open and does not limit requests; the daily
budgets still apply.

## Client update: integrity and authenticity

`siiswell update` checks the downloaded file's size and sha256 against the manifest the same dashboard publishes, over https,
and test-runs it before replacing the installed copy. This protects against a damaged or truncated download. It does not, by
itself, prove who built the file: the manifest and the bundle come from the same server, so trust rests on that server and on
the token-protected, https-only channel. A detached signature (a publisher key whose public half is pinned in the CLI) is a
possible future step that would add that proof; it is not part of the current design.

## Handling secrets

Never include real tokens, passwords, VAPID keys or personal data in a report; redact them. Tokens can be rotated
(`bun scripts/new-token.ts <label> <kind> --rotate`).

## Task text policy

The server limits the free text of tasks before storage (`ACCEPT_TASK_TEXT`: `brief` by default, `minimal`, `none`, or `full`) and ignores
unknown arguments of `report_task` / `update_task`. Text typed by a person or an agent's reply (`lastLine`, status text from other agent integrations)
is kept only when the operator sets `ACCEPT_LAST_LINE=1`. Hosts have a server ceiling as well (`ACCEPT_HOST_TEXT`: `minimal` by default, `brief`, `none` or `full`, combined with the
source's own `task_text`, the stricter wins): by default a host's task titles, approval summaries, discussion topics and event text are replaced by neutral labels before storage, because
they can be the operator's own request text; otherwise a fixed label is stored. A task's `kind` (a fixed list of words, no free text) is kept in every mode. Operators can choose `full` in their own
configuration when they want descriptive titles.
