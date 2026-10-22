// SPDX-License-Identifier: Apache-2.0
/**
 * @file Secret scrubbing shared by the host-side agents and the dashboard Worker.
 * @module shared/redact
 *
 * Pure string functions only — no imports, no Node/Bun/Workers APIs — so the
 * Cloudflare Worker can bundle this file as-is. Host-side code imports `redactSecrets`
 * from a copy of this file kept identical to it, so there is exactly one implementation.
 */

const R = "[redacted]";

/**
 * Opaque-run fallback (see `redactSecrets`): a run of >= 40 base64 / base64url characters that is not
 * obviously a path, URL segment, hash, UUID or identifier. The look-behind keeps it from starting in the
 * middle of a word, after `/` (URL / file-path segment), after `.` (file name, dotted id), after `$` (chat
 * event id) or after `-`; the look-ahead keeps it off file names (`<run>.png`).
 */
const OPAQUE_RUN = /(?<![A-Za-z0-9+\/_$.\-])[A-Za-z0-9+\/_-]{40,}={0,2}(?![A-Za-z0-9+\/_-]|\.\w)/g;

const charClass = (c: string): number => (c >= "A" && c <= "Z" ? 1 : c >= "a" && c <= "z" ? 2 : c >= "0" && c <= "9" ? 3 : 0);

/**
 * Decide whether a long base64-ish run is a secret. Deliberately conservative: plain hex (git SHA-1 / SHA-256,
 * MD5 — the ledger's `hasEvidence` relies on commit hashes) is NEVER redacted, and a run must contain upper
 * case, lower case AND digits and switch character class often, which random keys do (~0.65 switches per
 * character) and camelCase / kebab-case / snake_case identifiers and long file names do not (~0.15).
 */
function looksOpaque(run: string): boolean {
  const core = run.replace(/=+$/, "");
  if (/^[0-9a-fA-F]+$/.test(core)) return false;
  // Separators (`-_+/`) are ignored when counting: kebab-case and snake_case words would otherwise look
  // "random" because every word boundary is a class change.
  const alnum = core.replace(/[-_+\/]/g, "");
  if (alnum.length < 30 || !/[a-z]/.test(alnum) || !/[A-Z]/.test(alnum) || !/\d/.test(alnum)) return false;
  let switches = 0;
  for (let i = 1; i < alnum.length; i++) if (charClass(alnum[i]) !== charClass(alnum[i - 1])) switches++;
  return switches / (alnum.length - 1) >= 0.4;
}

// ── Keyed values: `<key><separator><value>` in every shape people actually write ─────────────────────────────
// Every quantifier below is BOUNDED, and no two adjacent ones can match the same characters in more than one
// way: redaction runs on every dispatch / notice / pane tail, so a hostile input must never be superlinear
// (tests/dashboard-redact.test.ts times every pattern-relevant prefix x repeated unit at 64 KB).
const KEYS =
  /(?:password|passwd|passphrase|密碼|密码|口令|secret|token|api[ _-]?key|access[_-]?key|private[_-]?key|(?:secret|encryption|signing|master|auth)[_-]?key|\bcredentials?\b)/.source;
const DECOR = /["'`*_|]/.source;                       // markdown / JSON / table decoration around key, separator and value
const SEP = /(?:=>|[=:：→])/.source;                   // `=` `:` full-width `：` `→` `=>`
const BEFORE_SEP = `${DECOR}{0,4}[ \\t]{0,8}`;         // `**Password**:`  `"password" :`
const AFTER_SEP = `[ \\t]{0,8}(?:\\r?\\n[ \\t]{0,8})?${DECOR}{0,4}[ \\t]{0,4}`;   // `** `  ` "`  one line break
const VALUE = "[^\\s\"'`|]{1,500}";

/** `"password": "two words"`, `secret='x y'`: the quoted value up to its closing quote. */
const QUOTED_KEYED = new RegExp(`(${KEYS})(${BEFORE_SEP}${SEP}[ \\t]{0,8}["'\`])([^"'\`\\n]{1,200})(["'\`])`, "gi");
/** `**Password:** X`, `password=X`, `"client_secret":X`, `- token → X`. */
const BARE_KEYED = new RegExp(`(${KEYS})(${BEFORE_SEP}${SEP}${AFTER_SEP})(${VALUE})`, "gi");
/** `密碼係 X` / `密碼是 X` ("the password is X" in Chinese). */
const CJK_IS = /(密碼|密码|口令)([ \t]{0,3}(?:係|是|為|为|喺)[ \t]{0,3}["'`*_|]{0,3})([^\s"'`|]{1,200})/g;
/** Env-style names (upper case, ending in a secret word): `MYSQL_PWD=`, `SMTP_PASS=`, `ENCRYPTION_KEY=`. */
const ENV_NAME = "\\b[A-Za-z][A-Za-z0-9_]{0,60}_(?:KEY|SECRET|TOKEN|PASS|PASSWORD|PWD)";
const ENV_QUOTED = new RegExp(`(${ENV_NAME}[ \\t]{0,3}=[ \\t]{0,3})(["'])([^"'\\n]{1,200})(["'])`, "gi");
const ENV_BARE = new RegExp(`(${ENV_NAME}[ \\t]{0,3}=[ \\t]{0,3})([^\\s"']{1,500})`, "gi");
/** A markdown table row: `| DB password | X |` — the cell AFTER a cell that names a secret. */
const TABLE_CELL = new RegExp(`(\\|[ \\t]{0,4}[^|\\n]{0,40}?${KEYS}[^|\\n]{0,20}\\|[ \\t]{0,4})([^\\s|][^|\\n]{0,200}?)([ \\t]{0,4}\\|)`, "gi");

/**
 * Scrub credentials from text that is about to leave the box (ledger rows, chat notices, pane tails,
 * dashboard payloads). Also defuses `@room` so a quoted screen can never ping the room.
 *
 * Covered, in this order:
 * - PEM private-key blocks (through END, or to the end of a cut-off tail);
 * - URL userinfo (`scheme://user:pass@host` → `scheme://[redacted]@host`; empty user `redis://:pw@h` and a
 *   user part that itself contains `@` are handled); Slack / Discord webhook URLs; JWTs;
 * - well-known key prefixes: sk- ghp_ gho_ ghu_ ghs_ ghr_ xox*- syt_ mdt_ mct_, Stripe rk_/pk_ live|test and
 *   `whsec_`, `oct_` dashboard tokens (>= 32 chars), Google `AIza…`, `glpat-`, `xai-`, `npm_`, `hf_`,
 *   SendGrid `SG.…`, DigitalOcean `dop_v1_` / `doo_v1_` / `dor_v1_`, AWS `AKIA…` / `ASIA…`;
 * - `Authorization: Basic|Token|ApiKey …`, `Bearer …`, `Cookie:` / `Set-Cookie:` header lines;
 * - CLI flags: `curl -u user:pass`, `--user user:pass`, `--password X` / `--token X` / … (value after a space),
 *   `mysql … -pX` (ONLY mysql / mysqldump / mysqladmin / mariadb: `-p` is a port for psql / ssh / servers),
 *   `redis-cli … -a X`;
 * - keyed values (key = password passwd passphrase secret token api_key access_key private_key secret_key
 *   encryption_key signing_key master_key auth_key 密碼 密码 口令; separator `=` `:` `：` `→` `=>`; markdown / JSON /
 *   quote decoration and spaces allowed between key, separator and value): `**Password:** X`, `**Password**: X`,
 *   `"password": "X"`, `"client_secret":"X"`, `token → X`, quoted values with spaces, `密碼係 X`, env-style names
 *   (`MYSQL_PWD=`, `SMTP_PASS=`, `SECRET_KEY=` …) and the cell after a secret-named cell of a markdown table;
 * - the phrase "password is X";
 * - finally the opaque-run fallback (>= 40 base64-ish characters with upper + lower + digits).
 *
 * NOT redacted on purpose (they are evidence or ordinary text): git SHA-1 / SHA-256 / MD5 hex, UUIDs, file
 * paths, URLs without userinfo, chat event ids (`$…`) and room ids (`!…:server`), ordinary identifiers and
 * prose such as "oct-2026-report". Known display-only false positives (the text is only shown, never acted on):
 * "the password is required" → "the password is [redacted]", "context token: 52k" → "context token: [redacted]",
 * the other cells of a table whose header cell names a secret, `sk-build-server`, and npm `sha512-…` integrity
 * strings. Known gaps: a bare `-pX` outside a mysql command, `login admin / X`, random keys shorter than 40
 * characters without a keyword or prefix, and 40+ character secrets that follow a `/` or `.`.
 */
export function redactSecrets(s: string): string {
  return (s ?? "")
    .replace(/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----|$)/g, "[redacted private key]")
    .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s\/"'<>:]{0,256}:[^\s\/"'<>]{0,512}@/gi, `$1${R}@`)   // bounded (a scheme without a bound was O(n²) on "a.a.a…")
    .replace(/\bhooks\.slack\.com\/services\/[A-Za-z0-9\/_-]+/g, `hooks.slack.com/services/${R}`)
    .replace(/\b(discord(?:app)?\.com\/api\/webhooks)\/\d+\/[A-Za-z0-9_-]+/g, `$1/${R}`)
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, R)
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|xox[bpas]|syt|mdt|mct)[-_][A-Za-z0-9_\-$]{8,}/g, R)
    .replace(/\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, R)
    .replace(/\bwhsec_[A-Za-z0-9]{16,}/g, R)
    .replace(/\boct_[A-Za-z0-9_-]{32,}/g, R)
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, R)
    .replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, R)
    .replace(/\bdo[opr]_v1_[A-Za-z0-9]{32,}/g, R)
    .replace(/\b(?:glpat-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{30,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,})/g, R)
    .replace(/\b(?:AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{16,})/g, R)
    .replace(/((?:Proxy-)?Authorization[ \t]{0,3}[:=][ \t]{0,3}["']?)(Basic|Token|ApiKey|Api-Key)[ \t]+[^\s"']+/gi, `$1$2 ${R}`)
    .replace(/Bearer\s+[A-Za-z0-9._\-+\/=]{8,}/gi, `Bearer ${R}`)
    .replace(/\b((?:Set-)?Cookie[ \t]{0,3}:[ \t]{0,3})[^\n]{1,2000}/gi, `$1${R}`)
    .replace(/(\s(?:-u|--user)(?:[ \t]+|=)["']?)[^\s:"']{1,64}:(?!\/\/)[^\s"']{1,200}/g, `$1${R}`)   // not `-u https://…`
    .replace(/(--(?:password|passwd|pass|pwd|token|secret|api-key|auth-token|access-token)[ \t]+["']?)[^\s"'-][^\s"']{0,300}/gi, `$1${R}`)
    .replace(/(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n|;&]{0,200}?[ \t]-p)(?=\S)[^\s"']{1,200}/gi, `$1${R}`)
    .replace(/(\b(?:docker[ \t]+login|sshpass)\b[^\n|;&]{0,200}?[ \t]-p[ \t]+["']?)[^\s"']{1,200}/gi, `$1${R}`)   // `docker login -u u -p X`, `sshpass -p X ssh …`
    .replace(/(\bredis-cli\b[^\n|;&]{0,200}?[ \t]-a[ \t]+["']?)(?!https?:\/\/|\/)[^\s"']{1,200}/gi, `$1${R}`)   // not a URL / path: `grep -a "https://…"` in the same line
    .replace(CJK_IS, `$1$2${R}`)
    .replace(QUOTED_KEYED, `$1$2${R}$4`)
    .replace(BARE_KEYED, `$1$2${R}`)
    .replace(ENV_QUOTED, `$1$2${R}$4`)
    .replace(ENV_BARE, `$1${R}`)
    .replace(TABLE_CELL, `$1${R}$3`)
    .replace(/\b(password|passwd|passphrase)([ \t]{1,8}(?:is|was|are)[ \t]{0,8}:?[ \t]{0,8})["']?[^\s"']+/gi, `$1$2${R}`)   // bounded: `\s*:?\s*` was O(n²) on a long run of spaces
    .replace(OPAQUE_RUN, (run) => (looksOpaque(run) ? R : run))
    .replace(/@room\b/g, "＠room");
}

// ── Links: a document link is a capability ──────────────────────────────────────────────────────────────────
// A shared document is usually one URL (a presigned S3 / GCS / Azure link, a pCloud `publink/show?code=`, a Google
// Drive `file/d/<id>`, a Dropbox `rlkey=`, an OAuth `?code=`): whoever holds the URL holds the document. The
// dashboard never needs more than "there was a link to host X", so every URL keeps its scheme and host and loses its
// path, query and fragment: `https://host/anything?x#y` becomes `https://host/[link]`.

const LINK = "[link]";

/** Characters that end a URL when its tail is scanned: whitespace, quotes, backtick, angle brackets, full-width punctuation. */
const URL_STOP = new Set([...' \t\r\n\f\v\u00a0\u2028\u2029\u3000"\'`<>，。；：！？、）】》」』”’']);
/** `data:` / `javascript:` bodies may hold a single quote (`alert('x')`), so they do not end at one. */
const OPAQUE_STOP = new Set([...' \t\r\n\f\v\u00a0\u2028\u2029\u3000"`<>，。；：！？、）】》」』”']);
const OPENER_INDEX: Record<string, number> = { "(": 0, "[": 1, "{": 2 };
const CLOSER_INDEX: Record<string, number> = { ")": 0, "]": 1, "}": 2 };
/** Sentence punctuation (and a JSON escape backslash) that follows a URL without belonging to it. */
const URL_TRAILING = new Set([...".,;:!?*~…\\"]);

/**
 * Index just past the URL whose tail starts at `from`: it runs to the first stop character, or to a closing bracket
 * with no opener inside the URL (`[text](https://h/p)`, `(see https://h/p)`), then gives back trailing sentence
 * punctuation. One forward pass: the caller resumes scanning at the returned index, so a text full of URLs stays
 * linear. Brackets that balance inside the URL stay part of it (`https://en.wikipedia.org/wiki/Foo_(bar)`).
 */
function linkEnd(s: string, from: number, stop: Set<string> = URL_STOP): number {
  const depth = [0, 0, 0];
  let i = from;
  for (; i < s.length; i++) {
    const c = s[i];
    if (stop.has(c)) break;
    const open = OPENER_INDEX[c];
    if (open !== undefined) {
      depth[open]++;
      continue;
    }
    const close = CLOSER_INDEX[c];
    if (close !== undefined) {
      if (depth[close] === 0) break;
      depth[close]--;
    }
  }
  while (i > from && URL_TRAILING.has(s[i - 1])) i--;
  return i;
}

/** A word that carries a query string or a fragment: `f.pdf?code=X`, `p?x=1`, `page#frag`. */
const QUERYISH = /\?[\w.%[\]-]+=|#\S/;
/** A word that is a link of its own (`u.pcloud.link/x`, `host:8080/y`): never part of the previous URL. */
const HOST_LIKE = /^[^\s/?#]+\.[A-Za-z]{2,}(?::\d{1,5})?\//;

/**
 * A path that contains spaces (`https://h/My Docs/Q3 report.pdf?code=X`) ends at its first space for `linkEnd`.
 * When one of the next few single-space-separated words carries a query string or a fragment, the words up to it
 * are the rest of the URL: return the end of that word (else `end`). Bounded: 6 words of at most 80 characters, none
 * a URL of its own, and each word is looked at once per URL.
 */
function pathWithSpaces(s: string, end: number): number {
  let i = end;
  // a link that continues on the next line (a wrapped pane): the first word of the next line belongs to it when it
  // carries a path / query character, or is an opaque identifier (letters AND digits, 8+ characters)
  const nl = s.startsWith("\r\n", i) ? 2 : s[i] === "\n" ? 1 : 0;
  if (nl > 0) {
    let j = i + nl;
    while (j < s.length && !URL_STOP.has(s[j])) j++;
    const word = s.slice(i + nl, j);
    const opaque = word.length >= 8 && /^[A-Za-z0-9_-]+$/.test(word) && /\d/.test(word) && /[A-Za-z]/.test(word);
    return word && word.length <= 120 && !word.includes("://") && !HOST_LIKE.test(word) && (/[\/?=#]/.test(word) || opaque) ? linkEnd(s, i + nl) : end;
  }
  for (let n = 0; n < 6; n++) {
    if (s[i] !== " " || i + 1 >= s.length || /\s/.test(s[i + 1])) return end;
    let j = i + 1;
    while (j < s.length && !URL_STOP.has(s[j])) j++;
    const word = s.slice(i + 1, j);
    if (!word || word.length > 80 || word.includes("://") || HOST_LIKE.test(word)) return end;
    if (QUERYISH.test(word)) return linkEnd(s, i + 1);
    i = j;
  }
  return end;
}

/**
 * Replace every match of `re` (the scheme + host part of a URL, followed, by lookahead, by where its path begins) plus
 * the tail `linkEnd` finds with `head(match)<sep>[link]`. A URL with nothing after its host (`https://host/`, or a `?`
 * that ends a sentence) is left as it is: there is nothing to hide.
 */
function replaceLinks(s: string, re: RegExp, head: (m: RegExpExecArray) => string, sep = "/"): string {
  re.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const tail = m.index + m[0].length;
    let end = linkEnd(s, tail);
    re.lastIndex = Math.max(end, tail);
    const rest = s.slice(tail, end).replace(/\\/g, "");
    if (rest === "" || rest === "/") continue;
    end = pathWithSpaces(s, end);
    re.lastIndex = Math.max(end, tail);
    out += s.slice(last, m.index) + head(m) + sep + LINK;
    last = end;
  }
  return last === 0 ? s : out + s.slice(last);
}

/**
 * `scheme://host…` for any scheme (http, https, ftp, s3, gs, file, …), also `https:\/\/host\/…` (JSON) and
 * `https://host\path` (a backslash path). NO word boundary in front: `_https://…` (markdown italics), `1https://…`
 * and `link_https://…` are URLs too (the scheme is the longest run of scheme characters before `://`, whatever
 * glued text precedes it stays visible text in front of the match).
 */
const SCHEME_URL = /([a-z][a-z0-9+.-]{0,31}:(?:\\?\/){2})([^\s\/\\?#"'`<>，。；：！？、）】》」』”’]{0,253})(?=\\|[\/?#])/gi;
/** A fully percent-encoded URL: `https%3A%2F%2Fhost%2Fpath%3Fcode%3DX`. */
const PCT_URL = /([a-z][a-z0-9+.-]{0,31})%3A%2F%2F((?:[a-z0-9.-]|%(?!2F)[0-9a-f]{2}){0,253})(?=%2F|%3F|%23)/gi;
/** A Windows network path: `\\server\share\file`. */
const UNC_URL = /(?<![\w\\])\\\\[A-Za-z0-9_.-]{1,63}(?=\\)/g;
/**
 * Keeps a bare host from starting inside a word or a file path (`my.project/x`, `a/b.com/x`, `foo.drive.google.com`).
 * `_` (markdown italics), `@` (a mention, `user@host/path`), `:` (`Docs:docs.google.com/x`) and a percent-escape
 * (`see%20drive.google.com/x`) do not hide a host.
 */
const NOT_INSIDE = "(?:(?<![A-Za-z0-9\\/.~-])|(?<=%[0-9A-Fa-f]{2}))";
const PORT = "\\.?(?::[A-Za-z0-9]{1,6})?"; // (an absolute host name may end in a dot: `drive.google.com./file`)
/** `www.host/…`. */
const WWW_URL = new RegExp(`${NOT_INSIDE}www\\.[a-z0-9-]{1,63}(?:\\.[a-z0-9-]{1,63}){0,5}${PORT}(?=[\\/?#])`, "gi");
/**
 * Public share / short-link hosts, with or without a scheme and with any subdomain (`u.pcloud.link`, `www.dropbox.com`):
 * the link IS the capability here, so they are named instead of relying on the suffix list below (which leaves out
 * suffixes that are also file extensions, such as `.so`).
 */
const SHARE_HOSTS = [
  "1drv.ms", "onedrive.live.com", "sharepoint.com", "we.tl", "wetransfer.com", "mega.nz", "mega.io", "notion.so", "notion.site",
  "forms.gle", "goo.gl", "bit.ly", "t.co", "tinyurl.com", "is.gd", "ow.ly", "buff.ly", "rebrand.ly", "cutt.ly", "lnkd.in",
  "dropbox.com", "db.tt", "dropboxusercontent.com", "drive.google.com", "docs.google.com", "pcloud.link", "pcloud.com",
  "box.com", "icloud.com", "sync.com", "mediafire.com", "zoom.us", "wa.me", "t.me",
];
const SHARE_URL = new RegExp(
  `${NOT_INSIDE}(?:[a-z0-9-]{1,63}\\.){0,4}(?:${SHARE_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|")})${PORT}(?=[\\/?#])`,
  "gi",
);
/**
 * `drive.google.com/…`, `u.pcloud.link/…`: a bare host with a well-known public suffix. File extensions (.ts .md .json
 * .py .sh …) are deliberately NOT in the list, so `README.md/` or `lib.so/x` is never taken for a host.
 */
const BARE_HOST_URL = new RegExp(
  `${NOT_INSIDE}(?:[a-z0-9-]{1,63}\\.){1,6}(?:com|net|org|io|co|app|dev|link|me|ai|cloud|xyz|info|biz|edu|gov|hk|cn|tw|jp|uk|de|fr|us|ca|au|sg|ly|to|tv|ws|page|site|online|store|tech|top|media|ms|nz|gl|tl|gle|gg|fm|im|st|vc|ru|kr|br|nl|ch|se|la|by|ua|cz|club|shop|live|life|world|network|email|digital|works|group|company|agency|studio|design|blog|news|space|fun|pro|name|mobi|xn--[a-z0-9-]{2,59})${PORT}(?=[\\/?#])`,
  "gi",
);
/**
 * Characters of an internationalised host label: ASCII letters and digits and the letter blocks of the other scripts, as FIXED
 * ranges (not `\p{L}`: the Unicode version of the property differs between engines, a newly assigned letter must not make
 * two of them answer differently). Punctuation blocks (U+2000-2BFF, U+3000-303F, ...) are not in it.
 */
const IDN_CHAR = "A-Za-z0-9\\u00c0-\\u1fff\\u2c00-\\u2dff\\u2e80-\\u2fdf\\u3040-\\u312f\\u3131-\\u318e\\u31a0-\\u9fff\\ua000-\\ud7ff\\uf900-\\ufdff\\ufe70-\\ufefc\\uff66-\\uffdc\\u{20000}-\\u{3ffff}";
/**
 * `例子.中国/…`: a bare internationalised host (letters of any script) with an IDN suffix (中国 中國 香港 台灣 公司 网络 …) or
 * one of the suffixes above. A Chinese sentence such as `完成.測試/部署` is not a host: `測試` is not a suffix. A host starts at
 * the beginning of a run of letters (a long run of CJK text is therefore tried once, not at every character).
 */
const IDN_HINT = /\.(?:中国|中國|香港|台灣|台湾|公司|网络|網絡|网址|商店|商城|在线|新加坡|信息|みんな|コム|com|net|org|io|co|hk|cn|tw|jp)\.?(?::[A-Za-z0-9]{1,6})?\//i;
const IDN_URL = new RegExp(
  `(?:(?<![${IDN_CHAR}\\/.~-])|(?<=%[0-9A-Fa-f]{2}))(?:[${IDN_CHAR}-]{1,253}\\.){1,5}(?:中国|中國|香港|台灣|台湾|公司|网络|網絡|网址|商店|商城|在线|新加坡|信息|みんな|コム|com|net|org|io|co|hk|cn|tw|jp)${PORT}(?=\\/)`,
  "giu",
);
/** `10.0.0.5:8080/admin/…`. */
const IPV4_URL = new RegExp(`${NOT_INSIDE}(?:\\d{1,3}\\.){3}\\d{1,3}${PORT}(?=\\/)`, "g");
/** The other spellings of an IPv4 host: `127.1:8080/`, hex `0x7f.1/`, octal `0177.0.0.1/`, a plain 32-bit number `2130706433/`. */
const NUMERIC_HOST_URL = new RegExp(
  `${NOT_INSIDE}(?:\\d{1,3}(?:\\.\\d{1,3}){1,2}:\\d{1,5}|0[xX][0-9a-fA-F]+(?:\\.(?:0[xX][0-9a-fA-F]+|\\d+)){0,3}(?::\\d{1,5})?|0\\d+(?:\\.\\d+){1,3}(?::\\d{1,5})?|\\d{9,10})(?=\\/)`,
  "g",
);
/** `[2001:db8::1]:8080/admin/…` (an IPv6 literal has at least one colon; a zone id `%eth0` / `%25eth0` is part of the host). */
const IPV6_URL = new RegExp(`${NOT_INSIDE}\\[(?=[0-9A-Fa-f.]*:)[0-9A-Fa-f:.]{2,45}(?:%(?:25)?[0-9A-Za-z._~-]{1,32})?\\]${PORT}(?=\\/)`, "g");

/** `user@host` keeps no user part: a token in the userinfo is a credential whatever it looks like. */
const hideUserinfo = (host: string): string => (host.includes("@") ? host.replace(/^.*@/, `${R}@`) : host);

/** Schemes whose whole body is the payload: `data:text/plain,…`, `mailto:jo@x.com?subject=…`, `javascript:…`, `tel:`, `sms:`. */
const OPAQUE_SCHEME = /\b(?:data|mailto|javascript|vbscript|tel|sms):(?=[^\s"'`<>])/gi;

function stripOpaqueSchemes(s: string): string {
  OPAQUE_SCHEME.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let m = OPAQUE_SCHEME.exec(s); m; m = OPAQUE_SCHEME.exec(s)) {
    const start = m.index + m[0].length;
    const end = linkEnd(s, start, OPAQUE_STOP);
    OPAQUE_SCHEME.lastIndex = Math.max(end, start);
    if (end <= start) continue;
    out += s.slice(last, start) + LINK;
    last = end;
  }
  return last === 0 ? s : out + s.slice(last);
}

/**
 * URL-independent: the VALUE of a query / fragment / `;key=` path parameter that is a credential or a signed-URL part is
 * redacted wherever it appears (`…?code=X`, `&sig=X`, `;key=X`, `#access_token=X`, `?code%3DX`, `?code =X`), also when
 * the URL around it was not recognised as one (a path with spaces, a truncated link). The value runs to whitespace,
 * `&`, a quote or `<>` (a `)` or `]` inside it belongs to it: `?sig=ab)X`; ONE trailing `)` / `]` is given back, it
 * closes the text around). A value that is exactly `[redacted]` is left alone, so the rule is idempotent (the Worker
 * runs it a second time), while `[redacted]X` (a forged marker) is redacted whole.
 */
const SECRET_PARAM =
  /([?&;#](?:code|key|token|sig|signature|rlkey|pwd|password|auth|access_token|id_token|refresh_token|api_key|apikey|client_secret|secret|x-amz-signature|x-goog-signature|x-amz-credential|sv|se|sp)[ \t]{0,4}(?:=|%3D))(?!\[redacted\](?![^\s&"'`<>]))([^\s&"'`<>]+)/gi;

function redactSecretParams(s: string): string {
  return s.replace(SECRET_PARAM, (_m, key: string, value: string) => {
    const last = value[value.length - 1];
    // a closing `)` / `]` with no opener inside the value closes the text around it: give it back
    const closes = (last === ")" && !value.includes("(")) || (last === "]" && !value.includes("["));
    return `${key}${R}${closes ? last : ""}`;
  });
}

/**
 * Strip the path, query and fragment from every URL in `s`: `scheme://…` (http, https, ftp, `s3://bucket/key`,
 * `gs://`, `file:///`, …), `www.host/…`, share / short-link hosts (`1drv.ms/…`, `we.tl/…`, `mega.nz/file/x#key`,
 * `notion.so/…`, `forms.gle/…`, `bit.ly/…`, `drive.google.com/…`, `u.pcloud.link/…`) and `host.tld/…` for the common
 * public suffixes, IPv4 `10.0.0.5:8080/…`, also inside markdown `[text](url)`, `<url>`, JSON-escaped text, backslash
 * paths (`https://host\share\x`, `\\server\share\x`), fully percent-encoded URLs (`https%3A%2F%2F…`) and URLs whose
 * path contains spaces followed by a query string; the user part of `user@host` goes too. Everything after `data:`,
 * `mailto:`, `javascript:`, `tel:` and `sms:` goes. Finally the value of any credential-looking query parameter is
 * redacted wherever it is. Pure, linear time (each URL is scanned once), idempotent. Deliberately NOT part of
 * `redactSecrets`: the ledger, the chat notices and the pane excerpts that use that want to show real links to the
 * operator. Only what leaves for the dashboard (`clipText`) must never carry one.
 */
/** The special schemes a browser's URL parser accepts WITHOUT `//` (`https:host/x`, `https:/host/x`, `https:\\host\x`, `https:/\host/x`) and with tabs / line breaks inside (it strips them). */
const SPECIAL_SLASHLESS = /((?:https?|ftp|wss?|file):[\/\\]{0,3})((?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+|\[[^\]\s]{2,64}\])(?::\d{1,5})?\.?(?=[\\/?#])/gi;
/** `//host.tld/path` (protocol-relative). */
const PROTOCOL_RELATIVE = /(?<![A-Za-z0-9\/\\.~-])(?:(?:https?|ftp|wss?)[;:]?|:)?\/\/(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+\.?(?::\d{1,5})?(?=[\/?#])/gi;
const WS_IN_URL = /[\t\r\n]/;
const SCHEME_WITH_WS = /\b(h[\t\r\n]*t[\t\r\n]*t[\t\r\n]*p[\t\r\n]*s?|f[\t\r\n]*t[\t\r\n]*p|w[\t\r\n]*s[\t\r\n]*s?)[\t\r\n]*:/gi;
const HOST_WITH_WS = /((?:https?|ftp|wss?):(?:[\/\\]|[\t\r\n]){0,8})((?:[A-Za-z0-9.-]|[\t\r\n]){1,253})(?=[\/\\?#])/gi;
/** A browser strips tab, CR and LF from a URL before parsing it: `ht<TAB>tps://drive.goo<LF>gle.com/x`. */
function joinWhitespaceInUrls(s: string): string {
  if (!WS_IN_URL.test(s)) return s;
  return s
    .replace(SCHEME_WITH_WS, (m) => m.replace(/[\t\r\n]/g, ""))
    .replace(HOST_WITH_WS, (m) => (WS_IN_URL.test(m) ? m.replace(/[\t\r\n]/g, "") : m));
}

/** `scheme://token@host`: the user part is a credential whatever follows the host (`git push https://TOKEN@github.com`). */
const USERINFO = /([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)(?!\[redacted\]@)[^\s\/\\?#@"'`<>\[\]()]{1,256}@/g;

/** Every link detector needs at least one of these characters; text without any (most prose, emoji, CJK) skips them all. */
const LINKY = /[\/\\:@=?#%]/;

export function redactLinks(s: string): string {
  let t = joinWhitespaceInUrls(wellFormed(s ?? ""));
  if (t.length === 0 || !LINKY.test(t)) return t;
  // each pass only runs when the text holds the characters it needs (a scan of 64 KB costs 2-5 ms)
  const has = (re: RegExp): boolean => re.test(t);
  if (t.includes("://")) t = t.replace(USERINFO, `$1${R}@`);
  if (has(/[\/\\]/)) t = replaceLinks(t, SCHEME_URL, (m) => `${m[1].replace(/\\/g, "")}${hideUserinfo(m[2])}`);
  if (has(/(?:http|ftp|ws)s?:|file:/i)) t = replaceLinks(t, SPECIAL_SLASHLESS, (m) => m[0].replace(/\\/g, "/"));
  if (t.includes("//")) t = replaceLinks(t, PROTOCOL_RELATIVE, (m) => m[0]);
  if (has(/%3a/i)) t = replaceLinks(t, PCT_URL, (m) => `${m[1]}://${m[2]}`);
  if (t.includes("\\\\")) t = replaceLinks(t, UNC_URL, (m) => m[0], "\\");
  if (has(/www\./i)) t = replaceLinks(t, WWW_URL, (m) => m[0]);
  if (has(/[\/?#]/)) {
    t = replaceLinks(t, SHARE_URL, (m) => m[0]);
    t = replaceLinks(t, BARE_HOST_URL, (m) => m[0]);
    if (IDN_HINT.test(t)) t = replaceLinks(t, IDN_URL, (m) => m[0]); // (the `u`-flag pattern is slow on long non-Latin text: only when a suffix + `/` is there at all)
    t = replaceLinks(t, IPV4_URL, (m) => m[0]);
    t = replaceLinks(t, NUMERIC_HOST_URL, (m) => m[0]);
  }
  if (t.includes("[")) t = replaceLinks(t, IPV6_URL, (m) => m[0]);
  if (t.includes(":")) t = stripOpaqueSchemes(t);
  return has(/=|%3d/i) ? redactSecretParams(t) : t;
}

/**
 * Inputs longer than this are not displayed at all. Redaction must always see the WHOLE text before any
 * cut: truncating first can split a secret so its pattern no longer matches, and if redaction then
 * shortens earlier text the fragment slides into the visible window (truncate-before-redact). Every
 * redaction regex is linear, so 64 KB costs a few ms; anything larger is refused instead of clipped.
 */
export const CLIP_MAX_INPUT = 64 * 1024;
const OMITTED = "[omitted: text over 64 KB]";

/**
 * Characters NFKC is applied to. NFKC is NOT applied to the whole text: Unicode versions differ between the engines
 * this code runs on (JavaScriptCore under Bun, V8 in workerd), and a normalisation of everything would let a character
 * that one ICU maps and the other does not make `clipText` answer differently. These are the long-established
 * compatibility blocks (Latin-1 / Latin ligatures, spaces, super / subscripts, letterlike symbols, number forms,
 * enclosed alphanumerics, CJK compatibility, presentation / vertical / small forms, full- and half-width forms,
 * mathematical alphanumerics) whose mappings have not changed for decades; everything else is left alone.
 */
const COMPAT_RANGES: Array<[number, number]> = [
  [0xa0, 0xa0], [0xaa, 0xaa], [0xb2, 0xb3], [0xb5, 0xb5], [0xb9, 0xba], [0xbc, 0xbe], [0x132, 0x133], [0x13f, 0x140], [0x149, 0x149],
  [0x17f, 0x17f], [0x1c4, 0x1cc], [0x1f1, 0x1f3], [0x2b0, 0x2b8], [0x2e0, 0x2e4], [0x1d2c, 0x1d6a], [0x1d78, 0x1d78], [0x1d9b, 0x1dbf],
  [0x1e9a, 0x1e9b], [0x2000, 0x200a], [0x202f, 0x202f], [0x205f, 0x205f], [0x2070, 0x209f], [0x2100, 0x218f], [0x2460, 0x24ff],
  [0x3000, 0x3000], [0x3200, 0x33ff], [0xfb00, 0xfb06], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xffef], [0x37e, 0x37e], [0x2024, 0x2024], [0x203c, 0x203c], [0x2047, 0x2049], [0x20a8, 0x20a8], [0x2a74, 0x2a76], [0x2c7c, 0x2c7d], [0xa7f2, 0xa7f4], [0xfb29, 0xfb29],
  [0x107a5, 0x107a5], [0x1d400, 0x1d7ff], [0x1f100, 0x1f10a], [0x1f110, 0x1f129], [0x1f12b, 0x1f12e], [0x1f130, 0x1f14f], [0x1f16a, 0x1f16c], [0x1f190, 0x1f190], [0x1fbf0, 0x1fbf9],
];
const COMPAT_ASTRAL = COMPAT_RANGES.filter(([lo]) => lo >= 0x10000);
const COMPAT_BMP = new Uint8Array(0x10000);
for (const [lo, hi] of COMPAT_RANGES) if (hi < 0x10000) for (let c = lo; c <= hi; c++) COMPAT_BMP[c] = 1;

/**
 * NFKC over every maximal run of compatibility characters (COMPAT_RANGES). A plain scan, not a regular expression: a
 * `u`-flag character class this wide made JavaScriptCore skip the first characters of some runs (`ﬃ１２８` -> `ﬃ１28`).
 */
/** Characters mapped by hand, because only some engines' NFKC knows them (Unicode 16 outlined letters / digits, U+A7F1). */
function handMapped(cp: number): string | undefined {
  if (cp >= 0x249c && cp <= 0x24b5) return String.fromCharCode(97 + cp - 0x249c); // (a) .. (z) -> a .. z
  if (cp >= 0x1f110 && cp <= 0x1f129) return String.fromCharCode(65 + cp - 0x1f110); // (A) .. (Z) -> A .. Z
  if (cp === 0x2048) return "?"; // ?! (the `!` would end the parameter name)
  if (cp === 0x2025) return "."; // .. between host labels
  if (cp >= 0x1ccd6 && cp <= 0x1ccef) return String.fromCharCode(65 + cp - 0x1ccd6);
  if (cp >= 0x1ccf0 && cp <= 0x1ccf9) return String.fromCharCode(48 + cp - 0x1ccf0);
  return cp === 0xa7f1 ? "S" : undefined;
}

/**
 * A compatibility character whose fold is white space or something that ENDS a link (a closing bracket, a quote, an angle
 * bracket: U+2000-200A, `＂`, `﹚`, `＞`, `、` ...) must not end it: the link tail runs over the ORIGINAL character. In
 * detection text such a character is swapped for a private-use stand-in (put back in the output), so that no
 * detector sees a space or a stop there; without stand-ins (`placeholders` null) it simply stays unfolded.
 */
const STOPPING_FOLD = /[\s)\]}"'`<>、」』】》]/;
function keepsTail(c: string): boolean {
  return STOPPING_FOLD.test(c.normalize("NFKC"));
}

function foldCompat(s: string, placeholders: Map<string, string> | null): string {
  let out = "";
  let copied = 0; // s[0, copied) is already in `out`
  let run = -1; // start of the current run, -1 outside one
  const flush = (end: number): void => {
    const seg = s.slice(run, end);
    const folded = seg.normalize("NFKC");
    const keep = (c: string): string => {
      if (!placeholders) return c;
      let ph = placeholders.get(c);
      if (ph === undefined && placeholders.size < 0xff) {
        ph = String.fromCharCode(0xe100 + placeholders.size);
        placeholders.set(c, ph);
      }
      return ph ?? c;
    };
    out += s.slice(copied, run) + (STOPPING_FOLD.test(folded) ? [...seg].map((c) => (keepsTail(c) ? keep(c) : c.normalize("NFKC"))).join("") : folded);
    copied = end;
    run = -1;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let hit = c < 0x10000 && COMPAT_BMP[c] === 1;
    let width = 1;
    let cp = c;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        cp = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000;
        hit = COMPAT_ASTRAL.some(([lo, hi]) => cp >= lo && cp <= hi);
        width = 2;
      }
    }
    const hand = handMapped(cp);
    if (hand !== undefined) {
      if (run >= 0) flush(i);
      out += s.slice(copied, i) + hand;
      copied = i + width;
      i += width - 1;
      continue;
    }
    if (hit) {
      if (run < 0) run = i;
    } else if (run >= 0) {
      flush(i);
    }
    i += width - 1;
  }
  if (run >= 0) flush(s.length);
  return copied === 0 ? s : out + s.slice(copied);
}
/** Invisible whatever the engine renders: format characters, default-ignorable code points (Hangul fillers, CGJ, variation selectors, tag characters, invisible operators, Khmer inherent vowels ...) and the braille blank. */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}⠀\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu;
/** Lookalikes of the URL separators that NFKC leaves alone (IDNA / UTS-46 and chat clients read some of them as the ASCII one). */
const LOOKALIKE_SLASH = /[⁄∕⧸╱〳]/g;
const LOOKALIKE_COLON = /[꞉∶ː։︓﹕]/g;
const LOOKALIKE_EQUALS = /[═꞊]/g;
/** `ʔ` (glottal stop) is only a `?` in front of a parameter (`x.foo/yʔcode=S`). */
const LOOKALIKE_QUESTION = /ʔ(?=[A-Za-z0-9_-]{1,40}[ \t]{0,4}=)/g;
/** IDNA label separators (`。` `｡` `．` ...) between two host-like labels. */
const IDEOGRAPHIC_DOT = /(?<=[A-Za-z0-9-])[。｡．․﹒](?=[A-Za-z0-9-])/g;
/** Combining marks (fixed ranges: diacritics and their extensions / supplements, symbols, Cyrillic, half marks). */
const MARK = "[\\u0300-\\u036f\\u0483-\\u0489\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff\\u2de0-\\u2dff\\ua66f-\\ua67d\\ua69e\\ua69f\\ufe20-\\ufe2f]";
const MARKS = new RegExp(MARK, "g");
/** Marks on an ASCII character. When the pair composes into ONE character (`e` + acute: a real accent, text from a decomposing file system) it stays; when it does not (`t` + acute, `e` + a combining solidus) the mark is a decoration with nothing visible to lose. */
const ASCII_MARKS = new RegExp(`([\\x21-\\x7e])(${MARK}+)`, "g");
/** The precomposed Latin letters (Latin-1 Supplement ... Latin Extended-B, Latin Extended Additional): their canonical decompositions have not changed for decades. */
const PRECOMPOSED_LATIN = /[\u00c0-\u024f\u1e00-\u1eff]/g;
/** A word that is, or contains, the shape of a link: `scheme://`, `?name=`, `host.tld/`. */
const LINKISH = /:\/\/|[?&;#][A-Za-z_-]{1,40}=|[A-Za-z0-9-]\.[A-Za-z]{2,}[/:?#]/;

/**
 * A lone surrogate (invalid UTF-16 that JSON and chat can carry) becomes U+FFFD. JavaScriptCore does not continue a
 * global `u`-flag regex match after one (`"ｈ\ud83d；".replace(/[\uff00-\uffef]+/gu, …)` skips the `；`, V8 does not), so
 * every `u`-flag pattern below would answer differently in the two engines; a well-formed string is the same in both.
 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const wellFormed = (s: string): string => s.replace(LONE_SURROGATE, "\ufffd");

function normalizeOnce(s: string, placeholders: Map<string, string> | null): string {
  let t = s
    // full-width sentence punctuation ends a sentence, so a space follows it once it is ASCII (`https://x.com/a，謝謝`),
    // except inside a number (`128，500`) and in front of a parameter (`？code=`, `；key=`)
    .replace(/[，；！？]/g, (m, i: number, str: string) => {
      const next = str[i + 1] ?? "";
      if (/[0-9\uff10-\uff19]/.test(str[i - 1] ?? "") && /[0-9\uff10-\uff19]/.test(next)) return m;
      if ((m === "？" || m === "；") && /^[A-Za-z0-9_-]{1,40}[ \t]{0,4}=/.test(str.slice(i + 1, i + 48))) return m;
      return `${m} `;
    });
  t = foldCompat(t, placeholders)
    .replace(INVISIBLE, "")
    .replace(LOOKALIKE_SLASH, "/")
    .replace(LOOKALIKE_COLON, ":")
    .replace(LOOKALIKE_EQUALS, "=")
    .replace(LOOKALIKE_QUESTION, "?")
    .replace(IDEOGRAPHIC_DOT, ".")
    .replace(ASCII_MARKS, (m: string, base: string, marks: string) => (`${base}${marks}`.normalize("NFC").length === 1 ? m : base));
  if (/[^\x00-\x7f]/.test(t)) {
    // an accented letter standing in for an ASCII one inside something shaped like a link (`coḿ/`, `ćode=`, `httpś://`):
    // that word is read without its marks. Other words keep their accents.
    t = t.replace(/\S+/g, (word) => {
      if (!/[^\x00-\x7f]/.test(word)) return word;
      const plain = word.replace(PRECOMPOSED_LATIN, (c) => c.normalize("NFD")).replace(MARKS, "");
      return plain !== word && LINKISH.test(plain) ? plain : word;
    });
  }
  return t;
}

/**
 * What an attacker (or a chat client) can do to hide a link from a pattern, undone on dashboard text (NOT in
 * `redactSecrets`: chat notices and the ledger keep their text as it is):
 *  - full-width and compatibility forms (`https：//`, `ｈｔｔｐｓ://`, `drive．google．com`, `／`, `Ⓗ`) are folded by NFKC,
 *    but only over the stable compatibility blocks (COMPAT_RUN), so two engines with different ICU cannot disagree;
 *  - invisible characters are removed (INVISIBLE; combining marks on an ASCII letter too, and the accents of a word
 *    that looks like a link, see `normalizeOnce`);
 *  - lookalike separators fold to the ASCII ones (`。` `｡` between labels, `⁄ ∕ ⧸ ╱ 〳` for `/`, `꞉ ∶ ː ։` for `:`,
 *    `═ ꞊` for `=`, `ʔ` for `?` before a parameter).
 * The steps can enable each other (a mark removed makes a dot sit between labels), so they run until nothing changes
 * (at most 4 rounds): the result is stable, which makes `clipText(clipText(x)) === clipText(x)`. Linear.
 */
export function normalizeDashboardText(s: string, placeholders: Map<string, string> | null = null): string {
  let t = wellFormed(s);
  for (let round = 0; round < 4; round++) {
    const next = normalizeOnce(t, placeholders);
    if (next === t) break;
    t = next;
    if (!needsNormalising(t)) break; // nothing left that another round could change
  }
  return t;
}

/**
 * Everything the dashboard does to text except the cut: normalise (see above), redact secrets, strip link paths /
 * queries / fragments. Input over CLIP_MAX_INPUT characters, before or after normalisation (NFKC can expand a
 * character up to 18-fold), is replaced by a short notice instead of being processed.
 */
/**
 * STAGE 1: the production pipeline of c852c1e, frozen verbatim (`redactLinks(redactSecrets(x))`, no cut). Do NOT improve
 * it: whatever it hides can never come back, so the dashboard never redacts LESS than that version did, by construction.
 * Stage 2 (the rest of this file) only ever hides more.
 */
const legacy = (() => {
  const R = "[redacted]";

  /**
   * Opaque-run fallback (see `redactSecrets`): a run of >= 40 base64 / base64url characters that is not
   * obviously a path, URL segment, hash, UUID or identifier. The look-behind keeps it from starting in the
   * middle of a word, after `/` (URL / file-path segment), after `.` (file name, dotted id), after `$` (chat
   * event id) or after `-`; the look-ahead keeps it off file names (`<run>.png`).
   */
  const OPAQUE_RUN = /(?<![A-Za-z0-9+\/_$.\-])[A-Za-z0-9+\/_-]{40,}={0,2}(?![A-Za-z0-9+\/_-]|\.\w)/g;

  const charClass = (c: string): number => (c >= "A" && c <= "Z" ? 1 : c >= "a" && c <= "z" ? 2 : c >= "0" && c <= "9" ? 3 : 0);

  /**
   * Decide whether a long base64-ish run is a secret. Deliberately conservative: plain hex (git SHA-1 / SHA-256,
   * MD5 — the ledger's `hasEvidence` relies on commit hashes) is NEVER redacted, and a run must contain upper
   * case, lower case AND digits and switch character class often, which random keys do (~0.65 switches per
   * character) and camelCase / kebab-case / snake_case identifiers and long file names do not (~0.15).
   */
  function looksOpaque(run: string): boolean {
    const core = run.replace(/=+$/, "");
    if (/^[0-9a-fA-F]+$/.test(core)) return false;
    // Separators (`-_+/`) are ignored when counting: kebab-case and snake_case words would otherwise look
    // "random" because every word boundary is a class change.
    const alnum = core.replace(/[-_+\/]/g, "");
    if (alnum.length < 30 || !/[a-z]/.test(alnum) || !/[A-Z]/.test(alnum) || !/\d/.test(alnum)) return false;
    let switches = 0;
    for (let i = 1; i < alnum.length; i++) if (charClass(alnum[i]) !== charClass(alnum[i - 1])) switches++;
    return switches / (alnum.length - 1) >= 0.4;
  }

  // ── Keyed values: `<key><separator><value>` in every shape people actually write ─────────────────────────────
  // Every quantifier below is BOUNDED, and no two adjacent ones can match the same characters in more than one
  // way: redaction runs on every dispatch / notice / pane tail, so a hostile input must never be superlinear
  // (tests/dashboard-redact.test.ts times every pattern-relevant prefix x repeated unit at 64 KB).
  const KEYS =
    /(?:password|passwd|passphrase|密碼|密码|口令|secret|token|api[ _-]?key|access[_-]?key|private[_-]?key|(?:secret|encryption|signing|master|auth)[_-]?key|\bcredentials?\b)/.source;
  const DECOR = /["'`*_|]/.source;                       // markdown / JSON / table decoration around key, separator and value
  const SEP = /(?:=>|[=:：→])/.source;                   // `=` `:` full-width `：` `→` `=>`
  const BEFORE_SEP = `${DECOR}{0,4}[ \\t]{0,8}`;         // `**Password**:`  `"password" :`
  const AFTER_SEP = `[ \\t]{0,8}(?:\\r?\\n[ \\t]{0,8})?${DECOR}{0,4}[ \\t]{0,4}`;   // `** `  ` "`  one line break
  const VALUE = "[^\\s\"'`|]{1,500}";

  /** `"password": "two words"`, `secret='x y'`: the quoted value up to its closing quote. */
  const QUOTED_KEYED = new RegExp(`(${KEYS})(${BEFORE_SEP}${SEP}[ \\t]{0,8}["'\`])([^"'\`\\n]{1,200})(["'\`])`, "gi");
  /** `**Password:** X`, `password=X`, `"client_secret":X`, `- token → X`. */
  const BARE_KEYED = new RegExp(`(${KEYS})(${BEFORE_SEP}${SEP}${AFTER_SEP})(${VALUE})`, "gi");
  /** `密碼係 X` / `密碼是 X` ("the password is X" in Chinese). */
  const CJK_IS = /(密碼|密码|口令)([ \t]{0,3}(?:係|是|為|为|喺)[ \t]{0,3}["'`*_|]{0,3})([^\s"'`|]{1,200})/g;
  /** Env-style names (upper case, ending in a secret word): `MYSQL_PWD=`, `SMTP_PASS=`, `ENCRYPTION_KEY=`. */
  const ENV_NAME = "\\b[A-Z][A-Z0-9_]{0,60}_(?:KEY|SECRET|TOKEN|PASS|PASSWORD|PWD)";
  const ENV_QUOTED = new RegExp(`(${ENV_NAME}[ \\t]{0,3}=[ \\t]{0,3})(["'])([^"'\\n]{1,200})(["'])`, "g");
  const ENV_BARE = new RegExp(`(${ENV_NAME}[ \\t]{0,3}=[ \\t]{0,3})([^\\s"']{1,500})`, "g");
  /** A markdown table row: `| DB password | X |` — the cell AFTER a cell that names a secret. */
  const TABLE_CELL = new RegExp(`(\\|[ \\t]{0,4}[^|\\n]{0,40}?${KEYS}[^|\\n]{0,20}\\|[ \\t]{0,4})([^\\s|][^|\\n]{0,200}?)([ \\t]{0,4}\\|)`, "gi");

  /**
   * Scrub credentials from text that is about to leave the box (ledger rows, chat notices, pane tails,
   * dashboard payloads). Also defuses `@room` so a quoted screen can never ping the room.
   *
   * Covered, in this order:
   * - PEM private-key blocks (through END, or to the end of a cut-off tail);
   * - URL userinfo (`scheme://user:pass@host` → `scheme://[redacted]@host`; empty user `redis://:pw@h` and a
   *   user part that itself contains `@` are handled); Slack / Discord webhook URLs; JWTs;
   * - well-known key prefixes: sk- ghp_ gho_ ghu_ ghs_ ghr_ xox*- syt_ mdt_ mct_, Stripe rk_/pk_ live|test and
   *   `whsec_`, `oct_` dashboard tokens (>= 32 chars), Google `AIza…`, `glpat-`, `xai-`, `npm_`, `hf_`,
   *   SendGrid `SG.…`, DigitalOcean `dop_v1_` / `doo_v1_` / `dor_v1_`, AWS `AKIA…` / `ASIA…`;
   * - `Authorization: Basic|Token|ApiKey …`, `Bearer …`, `Cookie:` / `Set-Cookie:` header lines;
   * - CLI flags: `curl -u user:pass`, `--user user:pass`, `--password X` / `--token X` / … (value after a space),
   *   `mysql … -pX` (ONLY mysql / mysqldump / mysqladmin / mariadb: `-p` is a port for psql / ssh / servers),
   *   `redis-cli … -a X`;
   * - keyed values (key = password passwd passphrase secret token api_key access_key private_key secret_key
   *   encryption_key signing_key master_key auth_key 密碼 密码 口令; separator `=` `:` `：` `→` `=>`; markdown / JSON /
   *   quote decoration and spaces allowed between key, separator and value): `**Password:** X`, `**Password**: X`,
   *   `"password": "X"`, `"client_secret":"X"`, `token → X`, quoted values with spaces, `密碼係 X`, env-style names
   *   (`MYSQL_PWD=`, `SMTP_PASS=`, `SECRET_KEY=` …) and the cell after a secret-named cell of a markdown table;
   * - the phrase "password is X";
   * - finally the opaque-run fallback (>= 40 base64-ish characters with upper + lower + digits).
   *
   * NOT redacted on purpose (they are evidence or ordinary text): git SHA-1 / SHA-256 / MD5 hex, UUIDs, file
   * paths, URLs without userinfo, chat event ids (`$…`) and room ids (`!…:server`), ordinary identifiers and
   * prose such as "oct-2026-report". Known display-only false positives (the text is only shown, never acted on):
   * "the password is required" → "the password is [redacted]", "context token: 52k" → "context token: [redacted]",
   * the other cells of a table whose header cell names a secret, `sk-build-server`, and npm `sha512-…` integrity
   * strings. Known gaps: a bare `-pX` outside a mysql command, `login admin / X`, random keys shorter than 40
   * characters without a keyword or prefix, and 40+ character secrets that follow a `/` or `.`.
   */
  function redactSecrets(s: string): string {
    return (s ?? "")
      .replace(/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----|$)/g, "[redacted private key]")
      .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s\/"'<>:]{0,256}:[^\s\/"'<>]{0,512}@/gi, `$1${R}@`)   // bounded (a scheme without a bound was O(n²) on "a.a.a…")
      .replace(/\bhooks\.slack\.com\/services\/[A-Za-z0-9\/_-]+/g, `hooks.slack.com/services/${R}`)
      .replace(/\b(discord(?:app)?\.com\/api\/webhooks)\/\d+\/[A-Za-z0-9_-]+/g, `$1/${R}`)
      .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, R)
      .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|xox[bpas]|syt|mdt|mct)[-_][A-Za-z0-9_\-]{8,}/g, R)
      .replace(/\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, R)
      .replace(/\bwhsec_[A-Za-z0-9]{16,}/g, R)
      .replace(/\boct_[A-Za-z0-9_-]{32,}/g, R)
      .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, R)
      .replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, R)
      .replace(/\bdo[opr]_v1_[A-Za-z0-9]{32,}/g, R)
      .replace(/\b(?:glpat-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{30,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,})/g, R)
      .replace(/\b(?:AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{16,})/g, R)
      .replace(/((?:Proxy-)?Authorization[ \t]{0,3}[:=][ \t]{0,3}["']?)(Basic|Token|ApiKey|Api-Key)[ \t]+[^\s"']+/gi, `$1$2 ${R}`)
      .replace(/Bearer\s+[A-Za-z0-9._\-+\/=]{8,}/gi, `Bearer ${R}`)
      .replace(/\b((?:Set-)?Cookie[ \t]{0,3}:[ \t]{0,3})[^\n]{1,2000}/gi, `$1${R}`)
      .replace(/(\s(?:-u|--user)(?:[ \t]+|=)["']?)[^\s:"']{1,64}:(?!\/\/)[^\s"']{1,200}/g, `$1${R}`)   // not `-u https://…`
      .replace(/(--(?:password|passwd|pass|pwd|token|secret|api-key|auth-token|access-token)[ \t]+["']?)[^\s"'-][^\s"']{0,300}/gi, `$1${R}`)
      .replace(/(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n|;&]{0,200}?[ \t]-p)(?=\S)[^\s"']{1,200}/gi, `$1${R}`)
      .replace(/(\b(?:docker[ \t]+login|sshpass)\b[^\n|;&]{0,200}?[ \t]-p[ \t]+["']?)[^\s"']{1,200}/gi, `$1${R}`)   // `docker login -u u -p X`, `sshpass -p X ssh …`
      .replace(/(\bredis-cli\b[^\n|;&]{0,200}?[ \t]-a[ \t]+["']?)(?!https?:\/\/|\/)[^\s"']{1,200}/gi, `$1${R}`)   // not a URL / path: `grep -a "https://…"` in the same line
      .replace(CJK_IS, `$1$2${R}`)
      .replace(QUOTED_KEYED, `$1$2${R}$4`)
      .replace(BARE_KEYED, `$1$2${R}`)
      .replace(ENV_QUOTED, `$1$2${R}$4`)
      .replace(ENV_BARE, `$1${R}`)
      .replace(TABLE_CELL, `$1${R}$3`)
      .replace(/\b(password|passwd|passphrase)([ \t]{1,8}(?:is|was|are)[ \t]{0,8}:?[ \t]{0,8})["']?[^\s"']+/gi, `$1$2${R}`)   // bounded: `\s*:?\s*` was O(n²) on a long run of spaces
      .replace(OPAQUE_RUN, (run) => (looksOpaque(run) ? R : run))
      .replace(/@room\b/g, "＠room");
  }

  // ── Links: a document link is a capability ──────────────────────────────────────────────────────────────────
  // A shared document is usually one URL (a presigned S3 / GCS / Azure link, a pCloud `publink/show?code=`, a Google
  // Drive `file/d/<id>`, a Dropbox `rlkey=`, an OAuth `?code=`): whoever holds the URL holds the document. The
  // dashboard never needs more than "there was a link to host X", so every URL keeps its scheme and host and loses its
  // path, query and fragment: `https://host/anything?x#y` becomes `https://host/[link]`.

  const LINK = "[link]";

  /** Characters that end a URL when its tail is scanned: whitespace, quotes, backtick, angle brackets, full-width punctuation. */
  const URL_STOP = new Set([...' \t\r\n\f\v\u00a0\u2028\u2029\u3000"\'`<>，。；：！？、）】》」』”’']);
  const OPENER_INDEX: Record<string, number> = { "(": 0, "[": 1, "{": 2 };
  const CLOSER_INDEX: Record<string, number> = { ")": 0, "]": 1, "}": 2 };
  /** Sentence punctuation (and a JSON escape backslash) that follows a URL without belonging to it. */
  const URL_TRAILING = new Set([...".,;:!?*~…\\"]);

  /**
   * Index just past the URL whose tail starts at `from`: it runs to the first stop character, or to a closing bracket
   * with no opener inside the URL (`[text](https://h/p)`, `(see https://h/p)`), then gives back trailing sentence
   * punctuation. One forward pass: the caller resumes scanning at the returned index, so a text full of URLs stays
   * linear. Brackets that balance inside the URL stay with it (`https://en.wikipedia.org/wiki/Foo_(bar)`).
   */
  function linkEnd(s: string, from: number): number {
    const depth = [0, 0, 0];
    let i = from;
    for (; i < s.length; i++) {
      const c = s[i];
      if (URL_STOP.has(c)) break;
      const open = OPENER_INDEX[c];
      if (open !== undefined) {
        depth[open]++;
        continue;
      }
      const close = CLOSER_INDEX[c];
      if (close !== undefined) {
        if (depth[close] === 0) break;
        depth[close]--;
      }
    }
    while (i > from && URL_TRAILING.has(s[i - 1])) i--;
    return i;
  }

  /**
   * Replace every match of `re` (the scheme + host part of a URL, followed by lookahead by `/`, `?` or `#`) plus the
   * tail `linkEnd` finds with `head(match)/[link]`. A URL with nothing after its host (`https://host/`, or a `?`
   * that ends a sentence) is left as it is: there is nothing to hide.
   */
  function replaceLinks(s: string, re: RegExp, head: (m: RegExpExecArray) => string): string {
    re.lastIndex = 0;
    let out = "";
    let last = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      const tail = m.index + m[0].length;
      const end = linkEnd(s, tail);
      re.lastIndex = Math.max(end, tail);
      const rest = s.slice(tail, end).replace(/\\/g, "");
      if (rest === "" || rest === "/") continue;
      out += s.slice(last, m.index) + head(m) + "/" + LINK;
      last = end;
    }
    return last === 0 ? s : out + s.slice(last);
  }

  /** `scheme://host…` for any scheme (http, https, ftp, s3, gs, file, …), also the JSON-escaped form `https:\/\/host\/…`. */
  const SCHEME_URL = /\b([a-z][a-z0-9+.-]{0,31}:(?:\\?\/){2})([^\s\/\\?#"'`<>，。；：！？、）】》」』”’]{0,253})(?=\\?[\/?#])/gi;
  /** Keeps a bare host from starting inside a word, a file path, an e-mail address or another URL. */
  const NOT_INSIDE = "(?<![\\w\\/.@:%~-])";
  /** `www.host/…`. */
  const WWW_URL = new RegExp(`${NOT_INSIDE}www\\.[a-z0-9-]{1,63}(?:\\.[a-z0-9-]{1,63}){0,5}(?=[\\/?#])`, "gi");
  /**
   * `drive.google.com/…`, `u.pcloud.link/…`: a bare host with a well-known public suffix. File extensions (.ts .md .json
   * .py .sh …) are deliberately NOT in the list, so `README.md/` or `lib.so/x` is never taken for a host.
   */
  const BARE_HOST_URL = new RegExp(
    `${NOT_INSIDE}(?:[a-z0-9-]{1,63}\\.){1,6}(?:com|net|org|io|co|app|dev|link|me|ai|cloud|xyz|info|biz|edu|gov|hk|cn|tw|jp|uk|de|fr|us|ca|au|sg|ly|to|tv|ws|page|site|online|store|tech|top|media)(?=\\/)`,
    "gi",
  );

  /** `user@host` keeps no user part: a token in the userinfo is a credential whatever it looks like. */
  const hideUserinfo = (host: string): string => (host.includes("@") ? host.replace(/^.*@/, `${R}@`) : host);

  /**
   * Strip the path, query and fragment from every URL in `s`: `scheme://…` (http, https, ftp, `s3://bucket/key`,
   * `gs://`, `file:///`, …), `www.host/…` and `host.tld/…` for the common public suffixes, also inside markdown
   * `[text](url)`, `<url>` and JSON-escaped text; the user part of `user@host` goes too. Pure, linear time (each URL
   * is scanned once), idempotent. Deliberately NOT part of `redactSecrets`: the ledger, the chat notices and the
   * pane excerpts that use that want to show real links to the operator. Only what leaves for the dashboard
   * (`clipText`) must never carry one.
   */
  function redactLinks(s: string): string {
    let t = s ?? "";
    if (t.length === 0) return t;
    t = replaceLinks(t, SCHEME_URL, (m) => `${m[1].replace(/\\/g, "")}${hideUserinfo(m[2])}`);
    t = replaceLinks(t, WWW_URL, (m) => m[0]);
    t = replaceLinks(t, BARE_HOST_URL, (m) => m[0]);
    return t;
  }

  return { redactSecrets, redactLinks };
})();

/**
 * Our own markers count as OUR output only when something that ends a word follows them. Whatever is glued behind one
 * (`[redacted]SECRET`, `code=[redacted]SECRET`) is not ours: it is cut off, up to the next delimiter.
 */
const UNICODE_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
const UNICODE_SPACES = new RegExp(UNICODE_SPACE.source, "g");
const MARKER_GLUE = /(\[redacted\]|\[amount\]|\[link\])(?=[A-Za-z0-9_$%+=~#-])[^\s&;"'`<>)\]]*/g;
const unglue = (s: string): string => (s.includes("[") ? s.replace(MARKER_GLUE, "$1") : s);

/**
 * Everything the dashboard does to text except the cut (see `scanText`), FAIL-CLOSED: the text is checked as it came in
 * (secrets by the plain patterns on the whole text, as before any normalisation existed; links and parameters on the
 * original words) AND in the folded copy of each word, and a word is replaced when EITHER finds something, so that
 * folding can never remove a boundary the original had (`港元_<ZWSP>ghp_KEY`).
 */
export function scrubDashboardText(s: string | undefined | null, extra?: (detect: string) => string, window = Infinity): string {
  let raw = String(s ?? "");
  if (raw.length > CLIP_MAX_INPUT) return OMITTED;
  // stage 1 (frozen production pass) on the WHOLE text, BEFORE the window: a redaction that shortens the text (a long link
  // becoming `https://host/[link]`) pulls later text towards the visible part, so cutting first would let a key / value pair
  // that straddles the window edge into the output unredacted (truncate-before-redact). It is linear and cheap (~7 ms / 64 KB).
  raw = legacy.redactLinks(legacy.redactSecrets(raw));
  if (raw.length > window) {
    // only the first `window` characters of stage 1's output can reach the output: cut there (at a space, so no word is
    // split) before the expensive stage 2
    const cut = raw.slice(0, window);
    const ws = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"), cut.lastIndexOf("\t"));
    raw = ws > 0 ? cut.slice(0, ws) : cut;
  }
  let text = redactSecrets(wellFormed(raw));
  // a secret rule whose key and value are separated by a Unicode space (NBSP from a web page, U+2000.., U+3000, a BOM): the
  // rules want an ordinary space there, links do not (their tails run over such characters), so the secrets get a copy
  if (UNICODE_SPACE.test(text)) {
    const spaced = text.replace(UNICODE_SPACES, " ");
    const found = redactSecrets(spaced);
    if (found !== spaced) text = found;
  }
  text = scanText(text, true, extra);
  // what the folded copy missed but the words as written show (folding removed a boundary): the folded result is
  // preferred wherever it found something, the as-written result fills the gaps
  return /[^\x00-\x7f]/.test(text) ? scanText(text, false) : text;
}

/** One detection round over `text`: words examined as they are (`fold` false) or in their folded copy (`fold` true). */
function scanText(text: string, fold: boolean, extra?: (detect: string) => string): string {
  // 1. the DETECTION text: every word normalised on its own (the whitespace between words stays as it is)
  const parts = text.split(/([\t\n\v\f\r ]+)/); // word, space, word, space, ... word: ASCII white space only (a link tail runs over U+2000.. U+3000 and the like)
  const placeholders: Map<string, string> | null = !fold || /[\ue100-\ue1ff]/.test(text) ? null : new Map();
  const nWords: string[] = [];
  const owner: number[] = []; // detection word -> index of the original word it came from
  const firstN: number[] = [];
  const endN: number[] = [];
  let detect = "";
  for (let k = 0; k < parts.length; k++) {
    if (k % 2 === 1) {
      detect += parts[k];
      continue;
    }
    const w = parts[k];
    const shadow = fold && needsNormalising(w) ? normalizeDashboardText(w, placeholders) : w;
    detect += shadow;
    firstN.push(nWords.length);
    if (shadow === w) {
      if (w !== "") {
        nWords.push(w);
        owner.push(k / 2);
      }
    } else {
      for (const t of shadow.match(/\S+/g) ?? []) {
        nWords.push(t);
        owner.push(k / 2);
      }
    }
    endN.push(nWords.length);
  }
  if (detect.length > CLIP_MAX_INPUT) return OMITTED;
  // 2. what the redactors make of it (glued URLs can need a second look at what the first pass left: iterate to a fixed point)
  let r = unglue(redactSecrets(detect));
  for (let round = 0; round < 4; round++) {
    if (!LINKY.test(r)) break;
    const next = unglue(linkSafetyNet(redactLinks(r)));
    if (next === r) break;
    r = next;
  }
  if (extra) r = extra(r); // (e.g. money masking in titles mode: applied to the detection text, spliced back the same way)
  if (r === detect) return text; // nothing found: the text is returned exactly as it came in
  // 3. only the words the redactors changed are replaced (by their redacted, normalised form); every other word stays byte for byte
  const spliced = spliceRedacted(parts, nWords, owner, firstN, endN, r);
  if (!placeholders || placeholders.size === 0) return spliced;
  const back = new Map([...placeholders].map(([c, ph]) => [ph, c] as const));
  return spliced.replace(/[\ue100-\ue1ff]/g, (ph) => back.get(ph) ?? ph);
}

/** Words that need the detection-time normalisation at all (anything else is its own shadow). */
const FLAGGED = new Uint8Array(0x10000);
for (const [lo, hi] of [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0xa0, 0xa0], [0xad, 0xad], [0xaa, 0xaa], [0xb2, 0xb3], [0xb5, 0xb5], [0xb9, 0xba], [0xbc, 0xbe],
  [0x300, 0x36f], [0x483, 0x489], [0x600, 0x605], [0x61c, 0x61c], [0x6dd, 0x6dd], [0x70f, 0x70f], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x20d0, 0x20ff], [0x2de0, 0x2dff], [0x2044, 0x2044], [0x2215, 0x2215], [0x2236, 0x2236],
  [0x2550, 0x2550], [0x2571, 0x2571], [0x29f8, 0x29f8], [0x2800, 0x2800], [0x3002, 0x3002], [0x3033, 0x3033], [0x3164, 0x3164], [0xa66f, 0xa67d], [0xa69e, 0xa69f],
  [0xa789, 0xa789], [0xa78a, 0xa78a], [0x2025, 0x2025], [0xa7f1, 0xa7f1], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0xfff0, 0xfffb], [0x2d0, 0x2d0], [0x294, 0x294], [0x589, 0x589],
] as Array<[number, number]>) for (let c = lo; c <= hi; c++) FLAGGED[c] = 1;
for (let c = 0; c < 0x10000; c++) if (COMPAT_BMP[c] === 1) FLAGGED[c] = 1;
function needsNormalising(w: string): boolean {
  let accent = false;
  for (let i = 0; i < w.length; i++) {
    const c = w.charCodeAt(i);
    if (c < 0x80) continue;
    if (FLAGGED[c] === 1) return true;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < w.length) {
      const d = w.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        const cp = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000;
        if ((cp >= 0x1d400 && cp <= 0x1d7ff) || (cp >= 0x1f100 && cp <= 0x1f1ff) || (cp >= 0x1fbf0 && cp <= 0x1fbf9) || (cp >= 0xe0000 && cp <= 0xe0fff) || (cp >= 0x1ccd6 && cp <= 0x1ccf9) || cp === 0x107a5 || (cp >= 0x1bca0 && cp <= 0x1bca3) || (cp >= 0x1d173 && cp <= 0x1d17a) || (cp >= 0x13430 && cp <= 0x1343f) || cp === 0x110bd || cp === 0x110cd) return true;
        i++;
      }
    } else if (c >= 0xd800 && c <= 0xdfff) return true; // a lone surrogate
    if ((c >= 0xc0 && c <= 0x24f) || (c >= 0x1e00 && c <= 0x1eff)) accent = true;
  }
  return accent && /[:\/\\?#=.%]/.test(w); // an accent only matters inside something shaped like a link
}

/**
 * Put the redacted detection words back into the text. The detection words and the redacted ones are lined up by
 * a greedy word diff (a redaction replaces a few neighbouring words by a few others); an original word is dirty when
 * one of its detection words was replaced, and a run of dirty words is replaced as a whole by the redacted words
 * (joined by single spaces). Clean words and the white space around them are copied as they were.
 */
function spliceRedacted(parts: string[], a: string[], owner: number[], firstN: number[], endN: number[], redacted: string): string {
  const b = redacted.match(/\S+/g) ?? [];
  const n = a.length;
  const m = b.length;
  const eq = new Int32Array(n).fill(-1); // detection word -> the equal redacted word
  const segOf = new Int32Array(n).fill(-1);
  const segs: Array<[number, number, number, number]> = []; // [a0, a1) -> [b0, b1)
  const push = (a0: number, a1: number, b0: number, b1: number): void => {
    if (a1 === a0 && a0 > 0) {
      a0--;
      b0--;
      eq[a0] = -1;
    }
    for (let x = a0; x < a1; x++) segOf[x] = segs.length;
    segs.push([a0, a1, b0, b1]);
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      eq[i++] = j++;
      continue;
    }
    let found = false;
    for (let t = 2; t <= 40 && !found; t++) {
      for (let di = 1; di < t; di++) {
        const dj = t - di;
        if (i + di < n && j + dj < m && a[i + di] === b[j + dj]) {
          push(i, i + di, j, j + dj);
          i += di;
          j += dj;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      push(i, n, j, m);
      i = n;
      j = m;
    }
  }
  if (i < n || j < m) push(i, n, j, m);
  const words = Math.ceil(parts.length / 2);
  const dirty = new Uint8Array(words);
  for (let x = 0; x < n; x++) if (segOf[x] >= 0) dirty[owner[x]] = 1;
  const bStart = (x: number): number => (segOf[x] >= 0 ? segs[segOf[x]][2] : eq[x]);
  const bEnd = (x: number): number => (segOf[x] >= 0 ? segs[segOf[x]][3] : eq[x] + 1);
  let out = "";
  for (let t = 0; t < words; ) {
    if (!dirty[t]) {
      out += parts[2 * t] + (parts[2 * t + 1] ?? "");
      t++;
      continue;
    }
    let q = t;
    while (q + 1 < words && dirty[q + 1]) q++;
    out += b.slice(bStart(firstN[t]), bEnd(endN[q] - 1)).join(" ") + (parts[2 * q + 1] ?? "");
    t = q + 1;
  }
  return out;
}

/**
 * The last line of defence, run on the finished text: whatever a browser's URL parser (WHATWG) would still read as a
 * link and the detectors above did not recognise is replaced by `[link]`, WORD BY WORD. The redactor's own output
 * (`scheme://host/[link]`, `host/[link]`, `data:[link]`, `[link]`, `[redacted]`) is masked first and put back after, so
 * it is never touched (idempotent). A word is link-like when it (a) contains `:/` or `:\`, or starts with a special /
 * common scheme (`http: https: ftp: ws: wss: file: s3: gs: data: mailto: javascript: tel: sms: smb: sftp:`) followed
 * by something, (b) holds a host name (`label.tld`, the suffix not a file extension) directly followed by `/` `\` `?` `#`
 * or `:<digit>`, (c) holds two or more `%XX` escapes, or (d) starts with `//host.tld` or `\\host`. Words are the
 * pieces between whitespace and `()<>[]{}"'\`,;|`; ordinary text (`src/core/x.ts`, `v1.0.4`, `e.g.`, `10:30`,
 * `50%`, `A/B`, `HK$1,200`, CJK) is none of those. One pass over the text, no backtracking.
 */
const OWN_MARK = /[\/\\]\[link\]|[A-Za-z]{2,10}:\[link\]/g;
const OWN_STOP = /[\s()<>"'`\[\]{},;|]/;
const OWN_PREFIX = /^(?:\\\\|\/\/)?(?:[^\/\\:]*:[\/\\]{0,3})?[^\/\\]*$/;
const NET_WORD = /[^\s()<>"'`\[\]{},;|]+/g;
const NET_SCHEME_INSIDE = /(?:[^A-Za-z0-9+.-]|^)(?:https?|ftp|wss?|file|s3|gs|data|mailto|javascript|vbscript|tel|sms|smb|sftp):[^\s]/i;
const NET_SCHEME = /^(?:https?|ftp|wss?|file|s3|gs|data|mailto|javascript|vbscript|tel|sms|smb|sftp):[^\s]/i;
const FILE_SUFFIX = new Set("ts tsx js jsx mjs cjs json md py rs go sh css html htm txt yml yaml toml log sql c h cc cpp java rb php lua svg png jpg jpeg gif pdf csv lock conf cfg ini env map zip gz tar swift kt xml mp3 mp4 mov avi wav webm ogg flac pptx docx xlsx ipynb tsv rst".split(" "));
const HOST_CHAR = /[A-Za-z0-9.-]/;
/** `label.tld` (the suffix not a file extension) right before position `i`, found by looking back from the terminator: linear. */
function hostBefore(word: string, i: number): boolean {
  let j = i;
  while (j > 0 && HOST_CHAR.test(word[j - 1])) j--;
  const run = word.slice(j, i).replace(/\.$/, ""); // (an absolute host name may end in a dot)
  const dot = run.lastIndexOf(".");
  if (dot <= 0 || !/[A-Za-z0-9-]/.test(run[dot - 1])) return false;
  const tld = run.slice(dot + 1);
  return /^(?:[A-Za-z][A-Za-z0-9]+|xn--[A-Za-z0-9-]{2,})$/.test(tld) && !FILE_SUFFIX.has(tld.toLowerCase());
}
function linkLike(word: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/\ue001@[A-Za-z0-9.:-]*[\/?]?$/.test(word)) return false; // `scheme://[redacted]@host`: the user part is already gone
  if (word.includes(":/") || word.includes(":\\")) return true;
  if (NET_SCHEME.test(word) || NET_SCHEME_INSIDE.test(word) || /(?:^|[^A-Za-z0-9.-])[A-Za-z][A-Za-z0-9-]*:\d{1,5}\//.test(word)) return true;
  if (/^\/\/[A-Za-z0-9-]+\./.test(word) || /^\\\\[A-Za-z0-9]/.test(word)) return true;
  if ((word.match(/%[0-9A-Fa-f]{2}/g)?.length ?? 0) >= 2) return true;
  for (let i = 1; i < word.length; i++) {
    const c = word[i];
    if ((c === "/" || c === "\\" || c === "?" || c === "#" || (c === ":" && /\d/.test(word[i + 1] ?? ""))) && hostBefore(word, i)) return true;
  }
  return false;
}
function linkSafetyNet(input: string): string {
  // `[redacted]` is one unit (`postgres://[redacted]@host/[link]`); private-use code points of the input are not ours
  const s = input.replace(/[\ue000\ue001]/g, "\ufffd").replace(/\[redacted\]/g, "\ue001");
  return restoreRedacted(sweep(s)).replace(/(?:\[link\]){2,}/g, LINK);
}
const restoreRedacted = (s: string): string => s.replace(/\ue001/g, "[redacted]");
function sweep(s: string): string {
  if (!s.includes("[link]")) return s.replace(NET_WORD, (w) => (linkLike(w) ? LINK : w));
  // mask the redactor's own output (`scheme://host/[link]`, `host/[link]`, `data:[link]`) so it is not touched
  const own: string[] = [];
  let masked = "";
  let copied = 0;
  OWN_MARK.lastIndex = 0;
  for (let m = OWN_MARK.exec(s); m; m = OWN_MARK.exec(s)) {
    let start = m.index;
    const floor = Math.max(copied, start - 300);
    while (start > floor && !OWN_STOP.test(s[start - 1])) start--;
    const stretch = s.slice(start, m.index);
    if (!OWN_PREFIX.test(stretch)) start = m.index; // something else in front of it: only the marker itself is ours
    own.push(s.slice(start, m.index + m[0].length));
    masked += s.slice(copied, start) + "";
    copied = m.index + m[0].length;
  }
  masked += s.slice(copied);
  const swept = masked.replace(NET_WORD, (w) => (linkLike(w) ? LINK : w));
  let i = 0;
  return swept.replace(//g, () => own[i++]);
}

/**
 * Scrub (`scrubDashboardText`), collapse whitespace runs, and cut to `max` chars (adds "…" only when cut). The one
 * function every dashboard text field goes through: on the host agent side before sending and again in the Worker
 * before storing.
 */
export function clipText(s: string | undefined | null, max: number): string {
  const tidy = (x: string): string => x.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const cut = (x: string): string => {
    if (x.length <= max) return x;
    let end = Math.max(0, max - 1);
    if (end > 0 && /[\uD800-\uDBFF]/.test(x[end - 1] ?? "")) end--; // never leave half of a surrogate pair
    return `${x.slice(0, end)}…`;
  };
  const raw = String(s ?? "");
  const window = Math.max(4096, max * 16);
  const first = scrubDashboardText(raw, undefined, window);
  if (first === OMITTED) return OMITTED.slice(0, Math.max(0, max));
  if (first === raw || (raw.length > window && raw.startsWith(first))) return cut(tidy(first)); // nothing was redacted: tidying only removes white space
  let t = tidy(first);
  // tidying joins what a tab or a line break held apart: look once more until nothing changes, so a second pass (the Worker re-clips) finds nothing new
  for (let round = 0; round < 3; round++) {
    const next = tidy(scrubDashboardText(t, undefined, window));
    if (next === t) break;
    t = next;
  }
  let out = cut(t);
  // the cut itself can leave half a link in view ("https://u.pcloud.li…"): the shown text must be a fixed point too, or a
  // second clip (the Worker clips again) would redact it and the two clips would differ
  for (let round = 0; round < 3 && out.length < 4096; round++) {
    const next = cut(tidy(scrubDashboardText(out, undefined, window)));
    if (next === out) break;
    out = next;
  }
  return out;
}
