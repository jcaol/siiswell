/**
 * redactSecrets, round 2: (1) the WHOLE chain stays linear on hostile input (combinatorial ReDoS test: every
 * pattern-relevant prefix x repeated unit at 64 KB), (2) the shapes people really write (markdown, JSON,
 * tables, env files, CLI flags, CJK) are scrubbed, (3) evidence / ordinary text still survives.
 * Dummy values only.
 */
import { describe, expect, test } from "bun:test";
import { clipText, redactSecrets, CLIP_MAX_INPUT } from "../src/shared/redact";

const R = "[redacted]";

describe("redactSecrets is linear on hostile input (combinatorial ReDoS guard)", () => {
  const SIZE = CLIP_MAX_INPUT;          // 64 KB: the largest text any caller redacts
  const BUDGET_MS = 50;

  // Every prefix a pattern keys on, including the ones that open a multi-token match.
  const PREFIXES = [
    "", "-----BEGIN ", "-----END ", "-----BEGIN PRIVATE KEY-----\n", "postgres://", "https://a:", "a://", "a://x:",
    "Authorization: ", "Authorization: Basic ", "Authorization: Token ", "Bearer ", "password", "password is ", "passwd:",
    "**Password:** ", "**Password**: ", "\"password\": \"", "token=", "api_key=", "SECRET_KEY=", "MYSQL_PWD=", "| password | ",
    "eyJ", "hooks.slack.com/services/", "discord.com/api/webhooks/", "AIza", "glpat-", "xai-", "npm_", "hf_", "sk-", "SG.",
    "whsec_", "dop_v1_", "oct_", "AKIA", "Cookie: ", "Set-Cookie: ", "curl -u ", "--user ", "--password ", "mysql -h x ",
    "mysqldump ", "redis-cli ", "密碼", "密碼係 ",
  ];
  // Units repeated to fill the text: separators, wrappers, key words and look-alikes of every pattern's own alphabet.
  const UNITS = [
    "PRIVATE KEY ", "PRIVATE KEY", "a.", "a:", "a@", "a/", " ", "=", "aB1", "aB1=", "*", "|", "\"", "'", "`", ":", "：", "\n",
    "-", "_", "x", "://", "a://", "a://x:y", "@", "password", "password=", "password: ", "token ", "Token ", "Bearer ", "Basic ",
    "-p", " -p", " -u ", "--password ", "eyJabcde.", "aB1+/", "| ", "||", "**", "*:", "\":\"", "= \"", "\u200b",
  ];

  const once = (s: string): number => {
    const t = performance.now();
    redactSecrets(s);
    return performance.now() - t;
  };
  // A slow first run is measured again: a single GC pause or scheduler hiccup must not fail the suite, a
  // genuinely superlinear pattern is slow every time.
  const timeOf = (s: string): number => {
    const first = once(s);
    return first < BUDGET_MS ? first : Math.min(first, once(s), once(s));
  };

  test(`every prefix x unit at ${SIZE / 1024} KB takes < ${BUDGET_MS} ms through the WHOLE chain`, () => {
    redactSecrets("warm up the regex engine ".repeat(200));
    const slow: string[] = [];
    let cases = 0;
    let worst = 0;
    for (const prefix of PREFIXES) {
      for (const unit of UNITS) {
        const s = (prefix + unit.repeat(Math.ceil((SIZE - prefix.length) / unit.length))).slice(0, SIZE);
        const ms = timeOf(s);
        cases++;
        worst = Math.max(worst, ms);
        if (ms >= BUDGET_MS) slow.push(`${JSON.stringify(prefix)} + ${JSON.stringify(unit)}* = ${ms.toFixed(0)} ms`);
      }
    }
    expect(slow).toEqual([]);
    expect(cases).toBeGreaterThan(2000);
    expect(worst).toBeLessThan(BUDGET_MS);
  }, 120_000);

  test("the PEM pattern in particular (was O(n²) on 'BEGIN ' + 'PRIVATE KEY ' * n): all three shapes", () => {
    const fill = (pre: string, unit: string) => pre + unit.repeat(Math.floor((SIZE - pre.length) / unit.length));
    for (const s of [
      fill("-----BEGIN ", "PRIVATE KEY "),
      fill("-----BEGIN PRIVATE KEY-----\n-----END ", "PRIVATE KEY "),
      fill("-----BEGIN ", "PRIVATE KEYS AND MORE "),
    ]) expect(timeOf(s)).toBeLessThan(BUDGET_MS);
  });

  test("a real key block is still redacted in full, and a cut-off one to the end", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";
    expect(redactSecrets(`a ${pem} b`)).toBe("a [redacted private key] b");
    expect(redactSecrets(`a -----BEGIN RSA PRIVATE KEY-----\nMIIEow`)).toBe("a [redacted private key]");
  });
});

describe("keyed values in the shapes people write", () => {
  const cases: Array<[string, string, string]> = [
    // [label, input, the secret that must not survive]
    ["markdown bold key", "**Password:** Hunter2xyz", "Hunter2xyz"],
    ["markdown bold key, colon outside", "**Password**: Hunter2xyz", "Hunter2xyz"],
    ["markdown italic key", "_password_: Hunter2xyz", "Hunter2xyz"],
    ["backticked value", "Password: `Hunter2xyz`", "Hunter2xyz"],
    ["table row", "| DB password | Hunter2xyz |", "Hunter2xyz"],
    ["table row with a spaced value", "| admin password | Hunter2 xyz 9 |", "Hunter2 xyz"],
    ["JSON password", `{"password": "Tr0ub4dor&3"}`, "Tr0ub4dor&3"],
    ["JSON client_secret, no space", `{"client_secret":"AbCdEf123456GhIjKl"}`, "AbCdEf123456GhIjKl"],
    ["JSON token with spaces around the colon", `{"token" : "abc def ghi"}`, "abc def ghi"],
    ["single-quoted value with spaces", "secret='two words here'", "two words"],
    ["double-quoted value with spaces", `password="two words"`, "words"],
    ["arrow", "- token → Hunter2xyz", "Hunter2xyz"],
    ["fat arrow", "password => Hunter2xyz", "Hunter2xyz"],
    ["full-width colon", "token：Hunter2xyz", "Hunter2xyz"],
    ["value on the next line", "Password:\nHunter2xyz", "Hunter2xyz"],
    ["PGPASSWORD", "export PGPASSWORD=Hunter2xyz", "Hunter2xyz"],
    ["MYSQL_PWD", "MYSQL_PWD=Hunter2xyz", "Hunter2xyz"],
    ["SMTP_PASS", "SMTP_PASS=Hunter2xyz", "Hunter2xyz"],
    ["SECRET_KEY", "SECRET_KEY=Hunter2xyzHunter2", "Hunter2xyz"],
    ["ENCRYPTION_KEY", "ENCRYPTION_KEY=Hunter2xyzHunter2", "Hunter2xyz"],
    ["generic *_TOKEN env name", "DEPLOY_HOOK_TOKEN=Hunter2xyz", "Hunter2xyz"],
    ["quoted env value with spaces", `APP_SECRET="two words here"`, "two words"],
    ["lower-case secret_key", "secret_key: Hunter2xyz", "Hunter2xyz"],
    ["signing_key", "signing_key=Hunter2xyz", "Hunter2xyz"],
    ["Cantonese 'password is'", "密碼係 Hunter2xyz", "Hunter2xyz"],
    ["密碼: value", "密碼: Hunter2xyz", "Hunter2xyz"],
    ["密码 = value", "密码 = Hunter2xyz", "Hunter2xyz"],
    ["口令是 value", "口令是 Hunter2xyz", "Hunter2xyz"],
  ];
  for (const [label, input, secret] of cases) {
    test(label, () => {
      const out = redactSecrets(input);
      expect(out).not.toContain(secret);
      expect(out).toContain(R);
    });
  }

  test("the key and the surrounding structure are kept (only the value goes)", () => {
    expect(redactSecrets("**Password:** Hunter2xyz")).toBe(`**Password:** ${R}`);
    expect(redactSecrets("| DB password | Hunter2xyz |")).toBe(`| DB password | ${R} |`);
    expect(redactSecrets(`{"password": "Tr0ub4dor"}`)).toBe(`{"password": "${R}"}`);
    expect(redactSecrets("MYSQL_PWD=Hunter2xyz mysql -h db")).toBe(`MYSQL_PWD=${R} mysql -h db`);
  });
});

describe("headers, flags and provider formats", () => {
  test("Authorization schemes and Cookie lines", () => {
    expect(redactSecrets("Authorization: Token YTKcOug5yptoh3Sk0t31HqiPayD5nm")).toBe(`Authorization: Token ${R}`);
    expect(redactSecrets("Authorization: ApiKey abcdef123456")).toBe(`Authorization: ApiKey ${R}`);
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe(`Authorization: Basic ${R}`);
    expect(redactSecrets("Cookie: session=lEKOJC8aDbrESY6kiahXCPUH0GhgBBdB; csrf=abc123\nnext line")).toBe(`Cookie: ${R}\nnext line`);
    expect(redactSecrets("Set-Cookie: sid=abc123; HttpOnly")).toBe(`Set-Cookie: ${R}`);
  });

  test("CLI: curl -u, --user, --password X / --password=X, mysql -pX, redis-cli -a X", () => {
    expect(redactSecrets("curl -u admin:S3cr3tPw https://api.example.com")).toBe(`curl -u ${R} https://api.example.com`);
    expect(redactSecrets("curl --user admin:S3cr3tPw https://x")).toBe(`curl --user ${R} https://x`);
    expect(redactSecrets("curl --user=admin:S3cr3tPw https://x")).toBe(`curl --user=${R} https://x`);
    expect(redactSecrets("mysql --password S3cr3tPw -h db")).toBe(`mysql --password ${R} -h db`);
    expect(redactSecrets("mysql --password=S3cr3tPw -h db")).toBe(`mysql --password=${R} -h db`);
    expect(redactSecrets("tool --token S3cr3tPw")).toBe(`tool --token ${R}`);
    expect(redactSecrets("mysql -h db -u root -pS3cr3tPw app")).toBe(`mysql -h db -u root -p${R} app`);
    expect(redactSecrets("mysqldump -pS3cr3tPw db > out.sql")).toBe(`mysqldump -p${R} db > out.sql`);
    expect(redactSecrets("redis-cli -h cache -a S3cr3tPw ping")).toBe(`redis-cli -h cache -a ${R} ping`);
  });

  test("bare -pX is NOT redacted outside a mysql command (-p is a port for psql / ssh / servers)", () => {
    for (const s of ["psql -p 5432 -h db", "ssh -p2222 host", "server -p3000", "git push -p origin", "python -m http.server -p 8080"]) {
      expect(redactSecrets(s)).toBe(s);
    }
    expect(redactSecrets("mysql -h db -p 3306")).toBe("mysql -h db -p 3306");        // -p followed by a space = prompt, port goes to -P
    expect(redactSecrets("mysql --protocol=tcp -h db")).toBe("mysql --protocol=tcp -h db");
    expect(redactSecrets("curl --user-agent foo https://x")).toBe("curl --user-agent foo https://x");
    expect(redactSecrets("docker login --password-stdin")).toBe("docker login --password-stdin");
    // `-u` / `-a` followed by a URL is an argument, not credentials
    expect(redactSecrets('run `tool -u "https://docs.example.org/some-page"`')).toBe('run `tool -u "https://docs.example.org/some-page"`');
    expect(redactSecrets('redis-cli ping; grep -a "https://docs.example.org/x"')).toBe('redis-cli ping; grep -a "https://docs.example.org/x"');
  });

  test("URL userinfo: empty user, a user part containing @, and the usual shapes", () => {
    expect(redactSecrets("redis://:S3cr3tPw@redis.example.com:6379")).toBe(`redis://${R}@redis.example.com:6379`);
    expect(redactSecrets("ftp://me@mail.com:S3cr3tPw@ftp.example.com")).toBe(`ftp://${R}@ftp.example.com`);
    expect(redactSecrets("postgres://app:S3cr3tPw@db.internal:5432/prod")).toBe(`postgres://${R}@db.internal:5432/prod`);
    expect(redactSecrets("amqp://guest:guest@rabbit/vhost")).toBe(`amqp://${R}@rabbit/vhost`);
  });

  test("SendGrid, Stripe webhook secret, DigitalOcean tokens", () => {
    expect(redactSecrets(["SG", "a".repeat(22), "b".repeat(43)].join("."))).toBe(R);
    expect(redactSecrets("whsec_M76DJNyurKQdUppeV7ZH1XAH8GrXwz1F")).toBe(R);
    expect(redactSecrets("dop_v1_" + "0123456789abcdef".repeat(4))).toBe(R);
    expect(redactSecrets("doo_v1_" + "0123456789abcdef".repeat(4))).toBe(R);
  });
});

describe("evidence and ordinary text survive the broader patterns", () => {
  const keep = (s: string) => expect(redactSecrets(s)).toBe(s);

  test("git hashes, UUIDs, paths, chat ids, oct-2026-report", () => {
    keep("commit 0123456789abcdef0123456789abcdef01234567 and 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    keep("550e8400-e29b-41d4-a716-446655440000");
    keep("/srv/app/.worktrees/agent-ab09ed6f82e335968/src/dashboard/redact.ts:58");
    keep("$Xk9vQ2mLpR7sT4wZ1nB8cD5fGhJ3yUa6EoI0KtVrNqM and !AbCdEfGhIjKlMnOpQr:example.org");
    keep("oct-2026-report");
    keep("https://github.com/org/repo/blob/0123456789abcdef0123456789abcdef01234567/src/File.ts");
  });

  test("words that merely contain a key word, or use it in another sense", () => {
    keep("passwordless login and secretary and tokens are counted: 12 tokens");
    keep("the --protocol flag and --password-stdin and --user-agent");
    keep("max_tokens=4096");
    keep("the key is in the lock; sort_key: name; primary_key: id");
    keep("PWD=/home/alice OLDPWD=/tmp PATH=/usr/bin SSH_KEY_PATH=/home/alice/.ssh/id_ed25519");
    keep("pass: 12 fail: 0 (672 pass)");
    keep("| Name | Value |\n|---|---|\n| port | 8080 |");
  });

  test("known display-only false positives are documented, not hidden", () => {
    expect(redactSecrets("the password is required for login")).toBe(`the password is ${R} for login`);
    expect(redactSecrets("context token: 52k of 200k")).toBe(`context token: ${R} of 200k`);
    // a table header names a secret column: the next header cell goes too (the data rows are the point)
    expect(redactSecrets("| User | Password | Notes |")).toBe(`| User | Password | ${R} |`);
  });

  test("redaction is idempotent for every new shape", () => {
    const messy = [
      "**Password:** Hunter2xyz", "| DB password | Hunter2xyz |", `{"client_secret":"AbCdEf123456GhIjKl"}`, "SMTP_PASS=Hunter2xyz",
      "Cookie: a=b", "curl -u admin:pw https://x", "mysql -h db -pS3cr3t", "redis://:pw@h", "密碼係 Hunter2xyz",
    ].join("\n");
    const once = redactSecrets(messy);
    expect(redactSecrets(once)).toBe(once);
    expect(clipText(messy, 80).length).toBeLessThanOrEqual(80);
  });
});

describe("late additions (auditor's Part-1 delta)", () => {
  test("API key with a space, credentials, docker login -p, sshpass -p", () => {
    for (const [inp, secret] of [
      ["API key: sk9F2kq0zz", "sk9F2kq0zz"],
      ["api key = abcDEF123", "abcDEF123"],
      ["credentials: s3cr3tValue", "s3cr3tValue"],
      ["docker login -u bot -p Pa55word registry.example.com", "Pa55word"],
      ["sshpass -p 'Sup3rS3cret' ssh admin@host", "Sup3rS3cret"],
    ]) {
      const out = redactSecrets(inp);
      expect(out).not.toContain(secret);
      expect(out).toContain("[redacted]");
    }
  });
  test("no new false positives on ordinary text", () => {
    for (const s of ["the pwd command prints the directory", "cd $(pwd)/src", "PWD=/home/u OLDPWD=/tmp", "ssh -p 2222 host", "docker run -p 8080:80 nginx", "see credentials.md for setup"]) {
      expect(redactSecrets(s)).toBe(s);
    }
  });
});
