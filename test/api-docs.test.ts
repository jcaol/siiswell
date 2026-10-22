import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_MCP_MUTATIONS_PER_DAY, MAX_OPEN_MCP_TASKS, MAX_USAGE_ROWS_PER_HOST_DAY, MAX_USAGE_ROWS_PER_REQUEST } from "../src/env";
import { MAX_BATCH_MESSAGES, SUPPORTED_PROTOCOL_VERSIONS, TOOLS } from "../src/mcp";
import { MAX_TEXT, MAX_TITLE } from "../src/shared/schema";
import { route } from "../src/index";
import { addSource, makeCtx, makeEnv, request } from "./d1-shim";

const root = join(import.meta.dir, "..");
const openapi = readFileSync(join(root, "docs", "openapi.yaml"), "utf8");
const api = readFileSync(join(root, "docs", "api.md"), "utf8");

describe("client API docs stay in step with the code", () => {
  test("documented paths are exactly the client-facing routes", () => {
    const paths = [...openapi.matchAll(/^  (\/[^:]+):$/gm)].map((m) => m[1]).sort();
    expect(paths).toEqual(["/api/health", "/api/ingest/events", "/api/ingest/heartbeat", "/api/ingest/human", "/api/ingest/otlp", "/api/ingest/snapshot", "/api/ingest/usage", "/mcp"]);
  });
  test("tools, protocol versions and limits match the server", () => {
    for (const t of TOOLS) expect(openapi + api).toContain(t.name);
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(openapi).toContain(v);
      expect(api).toContain(v);
    }
    expect(api).toContain(`${MAX_OPEN_MCP_TASKS} open tasks`);
    expect(api).toContain(`${MAX_MCP_MUTATIONS_PER_DAY} mutating calls`);
    expect(api).toContain(`at most ${MAX_BATCH_MESSAGES} messages`);
    expect(api).toContain(`${MAX_USAGE_ROWS_PER_REQUEST} rows`);
    expect(api).toContain(`${MAX_USAGE_ROWS_PER_HOST_DAY} rows per host and day`);
    expect(api).toContain(`titles ${MAX_TITLE} and other text ${MAX_TEXT}`);
  });
});

describe("public docs tell the MCP + usage story; orchestrators appear only as one kind of client", () => {
  // fenced / inline code and YAML field names (wire keys such as `poller:`) are not prose
  const prose = (text: string, yaml: boolean) => {
    const t = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    return yaml ? t.replace(/required: \[[^\]]*\]/g, "").replace(/^(\s*)[A-Za-z]+:/gm, "$1:") : t;
  };
  const files = ["README.md", "CLIENTS.md", "docs/api.md", "docs/INSTALL-CLIENTS.md", "docs/openapi.yaml"];
  test("no orchestrator vocabulary in prose beyond the noun for a kind of client (code in backticks may stay)", () => {
    for (const f of files) {
      const hits = prose(readFileSync(join(root, f), "utf8"), f.endsWith(".yaml")).match(/orchestrat(?!ors?\b)\w*|discussions?\b|approvals?\b|\brelay(?:ed|s)?\b|chat room|\bpoller\b|multi-agent|\bdispatch(?:ed|es)?\b|\bhalt(?:s|ed)?\b/gi) ?? [];
      expect({ file: f, hits }).toEqual({ file: f, hits: [] });
    }
  });
  test("the appendix's minimal snapshot (no optional fields) is accepted by the server", async () => {
    const m = /```json\n([\s\S]*?)```/.exec(api.slice(api.indexOf("## Appendix")));
    const body = JSON.parse(m![1]!);
    const t = makeEnv();
    const token = await addSource(t.db, "build-box", "host");
    const now = body.sentAt + 1000;
    const res = await route(request("/api/ingest/snapshot", { token, body }), t.env, makeCtx(), { now });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tasks: number }).tasks).toBe(1);
  });
});
