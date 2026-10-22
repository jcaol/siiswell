/**
 * redactSecrets: every credential format it claims to cover is scrubbed (dummy values only), and the
 * things that look secret-ish but are evidence or ordinary text survive untouched. The same function
 * runs on ledger rows, halt notices, pane tails and every dashboard payload.
 */
import { describe, expect, test } from "bun:test";
import { clipText, redactSecrets } from "../src/shared/redact";

const R = "[redacted]";

/** A realistic random-looking 43-char base64url string (what `openssl rand -base64 32 | tr +/ -_` gives). */
const RANDOM43 = "Xk9vQ2mLpR7sT4wZ1nB8cD5fGhJ3yUa6EoI0KtVrNqM";
const RANDOM44_STD = "q8Zr3Kx0Vd1LmN7bTp2YwHc5GjSa9UeF4oXiRt6BvEk=";   // standard base64 with = padding

describe("credential formats are redacted", () => {
  test("URL userinfo: credentials go, scheme and host stay", () => {
    expect(redactSecrets("connect postgres://admin:s3cr3tP@ss@db.internal:5432/app now")).toBe(`connect postgres://${R}@db.internal:5432/app now`);
    expect(redactSecrets("git clone https://deploy:hunter2@github.com/org/repo.git")).toBe(`git clone https://${R}@github.com/org/repo.git`);
    expect(redactSecrets("redis://:onlypass@cache:6379")).toBe(`redis://${R}@cache:6379`);   // empty user (redis style) is credentials too
    expect(redactSecrets("amqp://guest:guest@rabbit/vhost")).toBe(`amqp://${R}@rabbit/vhost`);
  });

  test("JWTs", () => {
    const jwt = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dummysignature_DUMMY-123"].join(".");
    expect(redactSecrets(`session=${jwt};`)).not.toContain("eyJ");
    expect(redactSecrets(`log: got ${jwt} from client`)).toBe(`log: got ${R} from client`);
    expect(redactSecrets(`Authorization: Bearer ${jwt}`)).toBe(`Authorization: Bearer ${R}`);
  });

  test("provider key prefixes", () => {
    // built at run time, so no file holds a complete provider-shaped string (secret scanners and push protection)
    const k = (prefix: string, rest: string) => prefix + rest;
    const keys: Record<string, string> = {
      google: k("AIza", "SyDUMMY0000000000000000000000000000"),
      gitlab: k("glpat-", "DUMMYDUMMYDUMMY12345"),
      npm: k("npm_", "DUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY"),
      huggingface: k("hf_", "DUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUM"),
      xai: k("xai-", "DUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY"),
      stripeSecret: k("sk_live_", "DUMMYDUMMY1234"),
      stripeRestricted: k("rk_live_", "DUMMYDUMMY1234"),
      stripePublishable: k("pk_live_", "DUMMYDUMMY1234"),
      stripeTest: k("sk_test_", "DUMMYDUMMY1234"),
      awsAccess: k("AKIA", "DUMMYDUMMYDUMMY"),
      awsSession: k("ASIA", "DUMMYDUMMYDUMMY12"),
      github: k("ghp_", "0123456789abcdefDUMMY"),
      openai: k("sk-", "DUMMYDUMMYDUMMYDUMMY"),
      chatAccess: k("syt_", "DUMMYDUMMYDUMMY"),
      slackBot: k("xoxb-", "1234567890-DUMMYDUMMY"),
    };
    for (const [name, key] of Object.entries(keys)) {
      expect(redactSecrets(`value ${key} end`)).toBe(`value ${R} end`);
      expect(redactSecrets(`${name}=${key}`)).not.toContain(key);
    }
  });

  test("dashboard tokens: oct_ + >= 32 chars", () => {
    expect(redactSecrets(`token oct_${RANDOM43} here`)).not.toContain(RANDOM43);
    expect(redactSecrets(`use oct_${RANDOM43}`)).toBe(`use ${R}`);
    expect(redactSecrets(`Bearer oct_${RANDOM43}`)).toBe(`Bearer ${R}`);
  });

  test("Authorization: Basic", () => {
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(`Authorization: Basic ${R}`);
    expect(redactSecrets("curl -H 'Proxy-Authorization: Basic dXNlcjpwYXNz'")).toContain(`Basic ${R}`);
    expect(redactSecrets("headers: authorization=Basic dXNlcjpwYXNz")).not.toContain("dXNlcjpwYXNz");
  });

  test("PEM private keys: the whole block, a block cut off by the pane tail, and the header line onward", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7DUMMY\nDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDU";
    const full = `before\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nafter`;
    expect(redactSecrets(full)).toBe("before\n[redacted private key]\nafter");
    expect(redactSecrets(`x -----BEGIN RSA PRIVATE KEY-----\n${body}`)).toBe("x [redacted private key]");           // END cut off
    expect(redactSecrets(`-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEAAAAA ⏎ more`)).toBe("[redacted private key]");
    expect(redactSecrets("-----BEGIN PGP PRIVATE KEY BLOCK-----\nxyz\n-----END PGP PRIVATE KEY BLOCK-----")).toBe("[redacted private key]");
    // a PUBLIC key / certificate is not a private key
    expect(redactSecrets("-----BEGIN CERTIFICATE-----\nMIIDdzCCAl\n-----END CERTIFICATE-----")).toContain("BEGIN CERTIFICATE");
  });

  test("Slack and Discord webhook URLs", () => {
    expect(redactSecrets("post to https://hooks.slack.com/services/T00000000/B00000000/DUMMYDUMMYDUMMY1234 ok"))
      .toBe(`post to https://hooks.slack.com/services/${R} ok`);
    expect(redactSecrets("https://discord.com/api/webhooks/123456789012345678/DUMMY-DUMMY_dummy1234")).toBe(`https://discord.com/api/webhooks/${R}`);
  });

  test('"password is X" phrasing and the existing `key: value` forms', () => {
    expect(redactSecrets("the password is hunter2hunter2 ok")).toBe(`the password is ${R} ok`);
    expect(redactSecrets("my passwd is: s3cret!")).toBe(`my passwd is: ${R}`);
    expect(redactSecrets("passphrase was 'correct horse'")).toContain(`passphrase was ${R}`);
    expect(redactSecrets("passwd: abc123")).toBe(`passwd: ${R}`);
    expect(redactSecrets("password=abc123 token=zzz999 api_key: k1")).toBe(`password=${R} token=${R} api_key: ${R}`);
  });

  test("fallback: a long opaque base64 / base64url run with upper + lower + digits", () => {
    expect(redactSecrets(`key: ${RANDOM43} done`)).toBe(`key: ${R} done`);
    expect(redactSecrets(`blob ${RANDOM44_STD}`)).toBe(`blob ${R}`);                          // trailing = padding goes with it
    expect(redactSecrets(`X-Api=${RANDOM43}`)).toBe(`X-Api=${R}`);
    expect(redactSecrets(`"${RANDOM43}"`)).toBe(`"${R}"`);
    expect(redactSecrets(`${RANDOM43}${RANDOM43}`)).toBe(R);                                  // longer runs too
  });

  test("redaction is idempotent and tolerates garbage input", () => {
    const messy = `Authorization: Basic dXNlcjpwYXNz token=abc ${RANDOM43} postgres://a:b@h/x -----BEGIN PRIVATE KEY-----\nzzz`;
    const once = redactSecrets(messy);
    expect(redactSecrets(once)).toBe(once);
    expect(redactSecrets(undefined as unknown as string)).toBe("");
    expect(redactSecrets("")).toBe("");
  });
});

describe("things that are NOT secrets survive untouched", () => {
  const keep = (s: string) => expect(redactSecrets(s)).toBe(s);

  test("file paths", () => {
    keep("/srv/app/.worktrees/agent-ab09ed6f82e335968/tests/dashboard-snapshot.test.ts");
    keep("see /Users/Alice/Documents/ProjectsAlpha/Site2/SrcComponents/HeaderNavigationBar.tsx for details");
    keep("C:\\Users\\Alice\\Documents\\ProjectsAlpha\\Site2\\SrcComponents\\HeaderNavigationBar2.tsx");
    keep("src/components/VeryLongComponentNameWithManyWords2/AnotherNestedFolderName/index.tsx");
  });

  test("URLs without userinfo (incl. long ids in the path and an @ after the host)", () => {
    keep("https://example.com:8443/a/b?x=1&y=2#frag");
    keep("https://github.com/org/repo/blob/0123456789abcdef0123456789abcdef01234567/src/File.ts");
    keep("https://medium.com/@user/post-title-here");
    keep("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf/edit");
    keep("http://localhost:8787/api/ingest/snapshot");
    keep("mxc://example.org/AbCdEfGhIjKlMnOpQrStUvWx");
  });

  test("git hashes (the ledger's evidence): SHA-1, SHA-256, short", () => {
    keep("commit 0123456789abcdef0123456789abcdef01234567 fixes it");
    keep("sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    keep("c5bbf89");
    keep("0123456789ABCDEF0123456789ABCDEF01234567");      // all-upper hex
  });

  test("UUIDs", () => {
    keep("session 550e8400-e29b-41d4-a716-446655440000 started");
    keep("550E8400-E29B-41D4-A716-446655440000");
  });

  test("ordinary prose, identifiers and kebab / snake / camel-case names", () => {
    keep("Please review the quarterly report and make sure the numbers are consistent across all the regions.");
    keep("this-is-a-very-long-kebab-case-branch-name-with-Numbers2-and-more-words");
    keep("a_very_long_snake_case_identifier_name_with_Numbers2_and_more_words_x");
    keep("myVeryLongFunctionNameThatDoesSomethingUseful2HandleTheThing");
    keep("the basic configuration works; basic authentication is documented");
    keep("The token expires soon but no value is given");
  });

  test('"oct-2026-report" and other oct_ prose are no longer mistaken for dashboard tokens', () => {
    keep("oct-2026-report");
    keep("see oct-2026-report-final for the numbers");
    keep("oct_report_2026_final");
    keep("oct_abcdefghij");                                   // shorter than any real token (43 chars)
  });

  test("chat event ids ($…) and room ids (!…:server)", () => {
    keep("$Xk9vQ2mLpR7sT4wZ1nB8cD5fGhJ3yUa6EoI0KtVrNqM");      // v3+ event id: $ + 43 base64url
    keep("!AbCdEfGhIjKlMnOpQr:example.org");
    keep("reply to $Xk9vQ2mLpR7sT4wZ1nB8cD5fGhJ3yUa6EoI0KtVrNqM in !AbCdEfGhIjKlMnOpQr:example.org");
    keep("https://chat.example.org/#/!AbCdEfGhIjKlMnOpQr:example.org/$Xk9vQ2mLpR7sT4wZ1nB8cD5fGhJ3yUa6EoI0KtVrNqM?via=example.org");
  });

  test("prefix look-alikes that are ordinary identifiers", () => {
    keep("hf_tokenizer_config_name_for_the_model");
    keep("npm_config_registry_override");
    keep("pk_user_id_field");
    keep("xai-grok-build-cli");
    keep("sk_value");
    keep("task-management-system-overview");
  });
});

describe("clipText still redacts first, then clips", () => {
  test("a secret straddling the cut cannot leak its prefix", () => {
    const t = clipText(`${"x ".repeat(20)}postgres://admin:hunter2@db/app`, 60);
    expect(t).not.toContain("hunter2");
  });
  test("long opaque value inside a clipped summary", () => {
    expect(clipText(`deploy key ${RANDOM43} now`, 200)).toBe(`deploy key ${R} now`);
  });
});

describe("redaction never backtracks catastrophically (ReDoS)", () => {
  const N = 100_000;
  const hostile = [
    "eyJ" + "a.".repeat(N / 2),            // was 5.6 s: unbounded URL scheme over "a.a.a…"
    "a+".repeat(N / 2),
    "a:".repeat(N / 2),
    "http://" + "a:".repeat(N / 2),
    "-----BEGIN ".repeat(N / 11),
    "aB1".repeat(N / 3),
    "password is ".repeat(N / 12),
    "Bearer " + " ".repeat(N),
  ];
  for (const s of hostile) {
    test(`100 KB hostile input ${JSON.stringify(s.slice(0, 12))}… redacts in < 600 ms`, () => {
      const a = performance.now();
      redactSecrets(s);
      expect(performance.now() - a).toBeLessThan(600);
    });
  }

  test("URL credentials are still redacted for real schemes after bounding the pattern", () => {
    for (const [inp, out] of [
      ["postgres://app:hunter2@db.internal:5432/x", "postgres://[redacted]@db.internal:5432/x"],
      ["mongodb+srv://u:p%40ss@cluster0.example.net", "mongodb+srv://[redacted]@cluster0.example.net"],
      ["https://bot:ghx-token-value@git.example.com/repo", "https://[redacted]@git.example.com/repo"],
    ]) expect(redactSecrets(inp)).toBe(out);
  });

  test("clipText refuses input over 64 KB instead of clipping it before redaction", () => {
    const huge = "Bearer abcdefgh12345678 " + "eyJ" + "a.".repeat(500_000);
    const a = performance.now();
    const out = clipText(huge, 300);
    expect(performance.now() - a).toBeLessThan(600);
    expect(out).toBe("[omitted: text over 64 KB]");
    expect(out).not.toContain("abcdefgh");
  });

  test("no truncate-before-redact differential: a long redacted run never pulls a cut secret fragment into view", () => {
    // A long opaque run shrinks to "[redacted]" on redaction; whatever follows it moves forward. Because the
    // WHOLE text is redacted before the cut, the token after it is redacted whole, never shown as a fragment.
    // 45 000-char opaque run (deterministic pseudo-random base64url, so it is redacted as a secret)
    const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let seed = 42;
    const run = Array.from({ length: 45_000 }, () => ALPHA[(seed = (seed * 1103515245 + 12345) % 2147483648) % 62]).join("");
    expect(redactSecrets(run)).toBe("[redacted]");
    const text = `x ${run} Bearer abcdefgh12345678 postgres://app:hunter2@db/x`;
    const a = performance.now();
    const out = clipText(text, 300);
    expect(performance.now() - a).toBeLessThan(600);
    expect(out).not.toMatch(/abcdefgh|hunter2|hunt/);
    // (the input is cut to a window of 4096 characters first: the run is not even looked at past that)
    expect(out.length).toBeLessThanOrEqual(300);
  });
});
