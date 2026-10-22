# siiswell usage fields and OpenTelemetry names

siiswell's usage rows (`usage_daily`, `usage_hourly`; the collector's upload, [api.md](api.md#usage-upload)) map onto the OpenTelemetry
**GenAI semantic conventions** and the metrics **Claude Code** exports with `CLAUDE_CODE_ENABLE_TELEMETRY=1`. Use this table
to compare the dashboard with your own OTel backend, or to send Claude Code's metrics straight to the dashboard (below).

| siiswell field | Claude Code metric (attributes) | OTel GenAI semantic convention |
|---|---|---|
| `input` (fresh input tokens) | `claude_code.token.usage` (`type=input`, `model`) | `gen_ai.client.token.usage` (`gen_ai.token.type=input`), `gen_ai.usage.input_tokens` |
| `output` | `claude_code.token.usage` (`type=output`) | `gen_ai.client.token.usage` (`gen_ai.token.type=output`), `gen_ai.usage.output_tokens` |
| `cacheRead` | `claude_code.token.usage` (`type=cacheRead`) | no stable name yet (vendor attribute) |
| `cacheWrite5m` + `cacheWrite1h` | `claude_code.token.usage` (`type=cacheCreation`; the 5 min / 1 h split is not exported) | no stable name yet |
| `usd` (API-equivalent, the price table) | `claude_code.cost.usage` (USD, `model`) | none |
| `model` | the `model` attribute | `gen_ai.request.model` / `gen_ai.response.model` |
| `requests` | not exported as a counter (`claude_code.api_request` events carry them) | `gen_ai.client.operation.duration` count |
| `agent` (the app: `claude-cli`, `codex-cli`, ...) | the resource (`service.name = claude-code`) | `gen_ai.system` / `gen_ai.provider.name` |
| `project` | not exported | none |
| `host` (the host token's name) | resource `host.name` (not read: the token decides) | `host.name` |

## Optional: `POST /api/ingest/otlp`

Off by default. With `OTLP_INGEST = "1"` in the server's environment, the dashboard takes OTLP/HTTP **JSON** metrics with a
**host** token and adds the `claude_code.token.usage` and `claude_code.cost.usage` counters to `usage_hourly` and `usage_daily`
(project `(other)`, agent `claude-cli`, source `claude`, the host's local hour and day), so the month view, the KPIs and the
insights see it too. Only DELTA sums are read; set Claude Code to export deltas:

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://dash.example.com/api/ingest/otlp
export OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer $SIISWELL_HOST_TOKEN"
export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta
```

Limits: 256 KiB per request, 2000 data points, hours inside the hourly retention (90 days), the host's write budget (one unit
per row). Cumulative series, other metrics, points with an unreadable time and every other attribute are ignored (counted in the
answer's `skipped`). Exporters deliver at least once and retry: each data point is remembered for 2 days by a hash of (host,
metric, attributes, start time, time) in `otlp_seen` (migration 0009), so a retried export adds nothing (`skipped.duplicate`).
Edge (under-count): the key holds no value, so two DIFFERENT data points that share the metric, every attribute, the start time
and the time (to the nanosecond) count once; Claude Code's points differ in their attributes (session, model, type) or times, so
this needs a mis-configured exporter. The write budget is charged per accepted data point (each is one `otlp_seen` row) or per
usage row written, whichever is more. The values are ADDED to the hour and the day: send a host's Claude Code usage either through the collector (`siiswell usage
push`) or through OTLP, not both (the collector's authoritative days would also replace the OTLP rows of those days).
