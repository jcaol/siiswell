# Contributing

Thanks for your interest in siiswell.

## Before you start

- Open an issue first for anything bigger than a small fix, so we can agree on the approach.
- siiswell never calls an AI model: no feature may send data to, or spend tokens of, any AI provider.
- No new data collection from client machines without a clear opt-in.

## Development

```sh
bun install
bun run typecheck
NODE_ENV=test bun test
```

Every change needs passing typecheck and tests, and new behaviour needs tests. CI runs them on Linux for every push and
pull request (`ci.yml`, the required check). A macOS run (`ci-macos.yml`) is optional: start it by hand from the Actions
tab, and it also runs weekly; it never blocks a merge, because macOS runners are often busy. Keep the page free of `innerHTML`, inline
scripts and external resources (the Content-Security-Policy stays strict).

## Licence of contributions (CLA)

The server and page are dual-licensed: AGPL-3.0-only for everyone ([LICENSE](LICENSE)) and a commercial licence on
request ([COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)). The client (`cli/`, `bridge/`, `src/shared/`) is Apache-2.0
([LICENSE-APACHE](LICENSE-APACHE)); a new file there starts with `// SPDX-License-Identifier: Apache-2.0`. To keep that possible, contributions are accepted only under a
Contributor License Agreement ([CLA.md](CLA.md)) that lets the maintainers license your contribution under both. You keep
your copyright. On your first pull request a bot asks you to sign: reply with the sentence it shows. You sign once; it
covers your later contributions too.

### For maintainers: enabling the CLA check

Turn on a CLA check for pull requests before the first outside contribution, for example the free
[CLA Assistant](https://cla-assistant.io/) GitHub app (link the repository and point it at `CLA.md`). Do not merge an outside pull request whose author has not signed.

## Questions

Anything else: [hello@siiswell.com](mailto:hello@siiswell.com).

## Security issues

Do not open public issues for vulnerabilities: see [SECURITY.md](SECURITY.md).
