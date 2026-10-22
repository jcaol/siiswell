# siiswell: rules for agents working in this repository

## Hard rules
- **Zero AI.** The dashboard, CLI, MCP server, hooks and collector never call an AI model or spend AI tokens. They report; they do not interpret.
- **Privacy.** Never log or store prompts or file contents. The only signal taken from a person's use of an agent is that an interaction happened (for well-being analysis). Local paths used by the collector stay on the machine, and state files holding them are mode 0600. Tokens are never printed or logged.
- **Calm wording.** User-facing text (UI, push, docs) is neutral and supportive. Avoid alarmist words ("danger", "critical failure", "you must") and shaming of work patterns.
- **No internal names.** No private hostnames, internal paths, company emails or product names of other systems in code, tests, docs or examples. Use placeholders such as `example.com`, `<root>/<project>`.

## Gate by risk
- **Minor** change (copy, docs, small UI, refactor with tests): typecheck + the test suite (`bun run typecheck`, `bun test`).
- **Critical** change: anything touching auth, tokens, privacy, redaction, SQL or migrations, hooks, or push. Needs full review, tests that prove the property, and a security pass before merge.

## Deployment
- Deploy through your documented deploy process; never point tooling at accounts or resources outside this project, and never push to the main branch without the operator's approval.
- Do not touch another deployment's data or configuration from an experiment.

## Conventions
- One deployment is single-tenant (see SECURITY.md). Client tokens are not a tenant boundary.
- Free text from clients is clipped and redacted on the client and again on the server.
