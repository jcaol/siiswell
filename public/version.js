/* The build line ("siiswell 0.3.0 · abc1234 · built 2026-10-18") from /api/health, read once per page; shown in the footer and Settings. */

/** The line for a /api/health body, or null. Pure. */
export function buildLine(h) {
  if (!h || typeof h.version !== "string" || !/^[0-9A-Za-z.+-]{1,32}$/.test(h.version)) return null;
  const sha = typeof h.sha === "string" && /^[0-9a-f]{7,12}$/.test(h.sha) ? h.sha : "dev";
  const built = typeof h.built === "string" && /^\d{4}-\d{2}-\d{2}$/.test(h.built) ? ` · built ${h.built}` : "";
  return `siiswell ${h.version} · ${sha}${built}`;
}

let pending = null;
/** The build line, fetched at most once (null when the server cannot be asked). */
export function loadBuildLine() {
  pending ??= fetch("/api/health", { cache: "no-store", credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null)).then(buildLine).catch(() => null);
  return pending;
}

/** Put the build line into `el` as text (never markup); the element stays empty without one. */
export function showBuildLine(el) {
  if (el) loadBuildLine().then((t) => { if (t) el.textContent = t; });
}

const parseV = (v) => {
  const m = typeof v === "string" ? /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[+-][0-9A-Za-z.+-]{0,30})?$/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** True when `stored` (a CLI version a source reported) is older than `server`. Anything unreadable on either side is false. Pure. */
export function updateAvailable(stored, server) {
  const a = parseV(stored);
  const b = parseV(server);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** The calm one-line note for a source, or null (no version reported, unreadable, or already current). Plain text, never markup. */
export function updateNote(stored, server) {
  return updateAvailable(stored, server) ? `CLI ${String(stored).split("+")[0]}: a newer version is available (siiswell update)` : null;
}

/** "CLI 0.5.3" for the version a source reported, or "CLI not reported" (no siiswell CLI on that machine, or an older one). Plain text. */
export function cliLabel(stored) {
  return parseV(stored) ? `CLI ${String(stored).split("+")[0]}` : "CLI not reported";
}
