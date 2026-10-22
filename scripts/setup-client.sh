#!/usr/bin/env bash
# siiswell client setup: installs the CLI, writes one private config per app, registers the stdio MCP server
# (`node siiswell.mjs mcp`, config passed as SIISWELL_CONFIG) in the apps you choose, and optionally schedules the
# usage collector. Tokens are read hidden, never printed, and never written into an app's own config file.
#
#   scripts/setup-client.sh            interactive (an existing setup's URL, machine label and apps are the defaults)
#   scripts/setup-client.sh --reuse    no questions: re-install the MCP registration, the hooks and the rule for the apps
#                                      already configured in ~/.config/siiswell, then run doctor (never asks for a token)
#   scripts/setup-client.sh --dry-run  show what would change, change nothing
#   --force-hooks                      accepted for compatibility (the hooks skip agent workspaces by themselves)
#
# Optionally installs app hooks that only run the siiswell CLI (no AI, return at once, network in the background):
# Claude Code Notification -> the session's task BLOCKED ("waiting for you"), Stop -> back to IN_PROGRESS; Codex notify ->
# heartbeat.
# Works with bash 3.2 (macOS) and Linux. Re-running is safe: existing entries are replaced in place (Codex asks
# first), every edited file is backed up to <file>.bak-siiswell-<timestamp>, rules are appended only once.
# Non-interactive use (tests): answers are read from stdin, one per line, in the order the questions appear.
# SIISWELL_SETUP_NO_ACTIVATE=1 writes the schedule files without loading them (launchctl / systemctl).
# SIISWELL_SETUP_OS=Linux|Darwin overrides `uname -s` (tests).
set -u

DRY=0
REUSE=0
FORCE_HOOKS=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --reuse) REUSE=1 ;;
    --force-hooks) FORCE_HOOKS=1 ;;
    -h|--help) sed -n '2,/^set -u/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
LIB="$HOME/.local/lib/siiswell"
MJS="$LIB/siiswell.mjs"
CFG_DIR="$HOME/.config/siiswell"
SERVER="siiswell"
RULE_MARK="siiswell MCP tools"
OS="${SIISWELL_SETUP_OS:-$(uname -s)}"   # SIISWELL_SETUP_OS: tests pick the Linux or the macOS paths on any machine

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*"; }
act()  { if [ "$DRY" = 1 ]; then printf '[dry-run] would %s\n' "$*"; else printf '%s\n' "$*"; fi; }
ask()  { # ask <prompt> <default>: one line from stdin (empty = default)
  local ans=""
  printf '%s ' "$1" >&2
  IFS= read -r ans || ans=""
  [ -z "$ans" ] && ans="${2:-}"
  printf '%s' "$ans"
}
yes_no() { # yes_no <prompt>: default No
  local a
  a="$(ask "$1 [y/N]" "n")"
  case "$a" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}
ask_secret() { # hidden: nothing is echoed, the value only lands in the variable named $2
  local _as_val=""
  printf '%s ' "$1" >&2
  if [ -t 0 ]; then IFS= read -r -s _as_val || _as_val=""; printf '\n' >&2; else IFS= read -r _as_val || _as_val=""; fi
  eval "$2=\$_as_val"
}
valid_token() { printf '%s' "$1" | grep -Eq '^oct_[A-Za-z0-9_-]{43}$'; }
yes_default() { # yes_default <prompt>: default Yes
  local a
  a="$(ask "$1 [Y/n]" "y")"
  case "$a" in n|N|no|NO|No) return 1 ;; *) return 0 ;; esac
}
existing_token() { # existing_token <config file> <key>: the token this script wrote there before (never printed), or nothing
  [ -f "$1" ] || return 0
  sed -n 's/.*"'"$2"'":"\(oct_[A-Za-z0-9_-]\{43\}\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}
cfg_field() { # cfg_field <config file> <key>: a plain string value this script wrote there, or nothing
  [ -f "$1" ] || return 0
  sed -n 's/.*"'"$2"'":"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}
ALL_APPS="claude-code codex claude-desktop agy gemini usage"
# the apps this machine already has a siiswell config for (a previous run of this script)
EXISTING_APPS=""
for app in $ALL_APPS; do [ -f "$CFG_DIR/$app.json" ] && EXISTING_APPS="$EXISTING_APPS $app"; done
PREV_URL=""; PREV_MACHINE=""
for app in $EXISTING_APPS; do
  [ -z "$PREV_URL" ] && PREV_URL="$(cfg_field "$CFG_DIR/$app.json" url)"
  [ -z "$PREV_MACHINE" ] && [ "$app" != usage ] && PREV_MACHINE="$(cfg_field "$CFG_DIR/$app.json" machine)"
done
# Agent workspaces (marked with .siiswell-agents): their prompts are typed by an agent orchestrator, not by a person
PROJECTS_ROOT="${SIISWELL_SETUP_PROJECTS_ROOT:-/projects}"
AGENT_WS=0
for c in "$PROJECTS_ROOT"/*/.siiswell-agents; do [ -e "$c" ] && AGENT_WS=1 && break; done
AGENT_WS_NOTE="Agent workspaces found (.siiswell-agents): the hooks skip them automatically (<project>/worktrees/... of a marked project, or SIISWELL_AGENT=1), so only the sessions YOU type in are counted and no task is reported twice."
if [ "$REUSE" = 1 ] && [ -z "$EXISTING_APPS" ]; then
  say "this machine has no siiswell client setup yet — run setup-client.sh without --reuse"
  exit 1
fi
backup() { [ -f "$1" ] && { if [ "$DRY" = 1 ]; then act "back up $1"; else cp -p "$1" "$1.bak-siiswell-$TS"; fi; }; return 0; }

# ── 1. node + the CLI ─────────────────────────────────────────────────────────
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then say "Node.js 18 or later is required (https://nodejs.org). Install it, then run this again."; exit 1; fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then say "Node.js $NODE_MAJOR found; 18 or later is required."; exit 1; fi
say "Node.js $("$NODE" -v) at $NODE"

DIST="$REPO/cli/dist/siiswell.mjs"
if [ ! -f "$DIST" ]; then
  if [ "$REUSE" = 0 ] && command -v bun >/dev/null 2>&1 && yes_no "cli/dist/siiswell.mjs is not built. Run 'bun install && bun run build:cli' now?"; then
    if [ "$DRY" = 1 ]; then act "run bun install && bun run build:cli in $REPO"; else (cd "$REPO" && bun install && bun run build:cli) || { say "build failed"; exit 1; }; fi
  fi
fi
# the version (x.y.z) a CLI file reports, or nothing
cli_version() { [ -f "$1" ] && "$NODE" "$1" --version 2>/dev/null | sed -n 's/^\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1; }
# 0 when version $1 is older than $2 (an installed CLI from `siiswell update` must not be replaced by an older checkout)
older() { "$NODE" -e 'const p=(v)=>v.split(".").map(Number);const [a,b]=[p(process.argv[1]),p(process.argv[2])];for(let i=0;i<3;i++){if(a[i]!==b[i])process.exit(a[i]<b[i]?0:1)}process.exit(1)' "$1" "$2"; }
DIST_V="$(cli_version "$DIST")"; MJS_V="$(cli_version "$MJS")"
if [ ! -f "$DIST" ] && [ "$REUSE" = 1 ] && [ -f "$MJS" ]; then say "cli/dist/siiswell.mjs is not built: keeping the installed $MJS"
elif [ -n "$DIST_V" ] && [ -n "$MJS_V" ] && older "$DIST_V" "$MJS_V"; then
  say "keeping the installed CLI $MJS_V: this checkout's cli/dist is older ($DIST_V). To update the checkout: git pull && bun install && bun run build:cli"
else
  if [ ! -f "$DIST" ] && [ "$DRY" = 0 ]; then say "cli/dist/siiswell.mjs is missing: build it with 'bun install && bun run build:cli' (needs Bun)."; exit 1; fi
  act "install the CLI to $MJS"
  if [ "$DRY" = 0 ]; then mkdir -p "$LIB" && cp "$DIST" "$MJS" && chmod 755 "$MJS"; fi
fi
# the `siiswell` command: a symlink in ~/.local/bin (never replaces a file that is not our own link)
BIN_LINK="$HOME/.local/bin/siiswell"
if [ -f "$MJS" ] || [ "$DRY" = 1 ]; then
  CUR_LINK="$(readlink "$BIN_LINK" 2>/dev/null || true)"
  if [ -e "$BIN_LINK" ] && [ ! -L "$BIN_LINK" ]; then say "$BIN_LINK exists and is not a link: left alone (run the CLI as: node $MJS)"
  elif [ -L "$BIN_LINK" ] && [ -n "$CUR_LINK" ] && case "$CUR_LINK" in "$LIB"/*) false ;; *) true ;; esac; then
    say "$BIN_LINK points elsewhere ($CUR_LINK): left alone (run the CLI as: node $MJS)"
  elif [ "$CUR_LINK" != "$MJS" ]; then
    act "link the siiswell command: $BIN_LINK -> $MJS"
    [ "$DRY" = 0 ] && mkdir -p "$HOME/.local/bin" && ln -sfn "$MJS" "$BIN_LINK"
  fi
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "Tip: add ~/.local/bin to your PATH to type 'siiswell' (e.g. echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.profile)." ;; esac
fi

# ── 2. dashboard URL ──────────────────────────────────────────────────────────
URL=""
if [ "$REUSE" = 1 ]; then URL="$PREV_URL"; fi
while [ "$REUSE" = 0 ]; do
  URL="$(ask "Dashboard URL (e.g. https://dash.example.com)${PREV_URL:+ [$PREV_URL]}:" "$PREV_URL")"
  URL="${URL%/}"; URL="${URL%/mcp}"
  if printf '%s' "$URL" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' ||
     printf '%s' "$URL" | grep -Eq '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$'; then break; fi
  say "The URL must use https:// (plain http only for localhost / 127.0.0.1)."
  [ -t 0 ] || exit 1
done

# ── 3. which apps ─────────────────────────────────────────────────────────────
if [ "$OS" = Darwin ]; then DESKTOP_DIR="$HOME/Library/Application Support/Claude"; else DESKTOP_DIR="$HOME/.config/Claude"; fi
has_claude=0; command -v claude >/dev/null 2>&1 && has_claude=1
has_codex=0; { command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]; } && has_codex=1
has_desktop=0; [ -d "$DESKTOP_DIR" ] && has_desktop=1
has_agy=0; { command -v agy >/dev/null 2>&1 || [ -d "$HOME/.gemini/antigravity-cli" ]; } && has_agy=1
has_gemini=0; { command -v gemini >/dev/null 2>&1 || [ -f "$HOME/.gemini/settings.json" ]; } && has_gemini=1

APPS=""
pick() { # pick <id> <label> <installed?>: an app configured before is offered with Yes as the default
  if [ "$REUSE" = 1 ]; then case " $EXISTING_APPS " in *" $1 "*) APPS="$APPS $1" ;; esac; return 0; fi
  if [ "$3" != 1 ]; then say "$2: not found, skipped."; return 0; fi
  case " $EXISTING_APPS " in
    *" $1 "*) yes_default "Configure $2 (configured before)?" && APPS="$APPS $1" ;;
    *) yes_no "Configure $2?" && APPS="$APPS $1" ;;
  esac
  return 0
}
pick claude-code "Claude Code (CLI)" "$has_claude"
pick codex "Codex (CLI, IDE extension and desktop app)" "$has_codex"
pick claude-desktop "Claude Desktop" "$has_desktop"
pick agy "Antigravity (agy)" "$has_agy"
pick gemini "Gemini CLI" "$has_gemini"
pick usage "the usage collector (token counts of Claude Code / Codex logs, uploaded daily)" 1
[ -z "$APPS" ] && { say "Nothing chosen."; exit 0; }

# The machine label groups this machine's apps on the dashboard ("<machine> / <project>"), and is the usage collector's
# default host label. It is a label, not the OS host name: choose one that names no person.
MACHINE=""
[ "$REUSE" = 1 ] && MACHINE="$PREV_MACHINE"
[ "$REUSE" = 0 ] && case "$APPS" in *claude-code*|*codex*|*claude-desktop*|*agy*|*gemini*)
  mdef="${PREV_MACHINE:-machine-1}"   # never the OS host name: it often names a person
  say "Choose a machine label that names no person (for example laptop-1, studio, build-box)."
  MACHINE="$(ask "Machine label shown on the dashboard [$mdef]:" "$mdef")"
  printf '%s' "$MACHINE" | grep -Eq '^[A-Za-z0-9._-]{1,64}$' || { say "invalid machine label"; exit 1; } ;;
esac

# Project names: by default the dashboard never gets a folder name (it can be a client's name). Usage is labelled with a
# salted hash (h-..., the salt stays on this machine) and agents' tasks carry no inferred project. Names listed here are
# shown as they are, in usage and in the tasks the agents report.
KEEP=""
if [ -n "$APPS" ] && [ "$REUSE" = 0 ]; then
  kdef="$(for f in "$CFG_DIR"/*.json; do [ -f "$f" ] && sed -n 's/.*"keep":\[\([^]]*\)\].*/\1/p' "$f"; done 2>/dev/null | head -n 1 | tr -d '"' | tr ',' ' ')"
  say "Project folder names are NOT sent by default: usage shows a salted hash per project, and agents' tasks carry no folder name."
  KEEP="$(ask "Project folder names to show by name (space separated, empty = none)${kdef:+ [$kdef]}:" "$kdef")"
  for k in $KEEP; do printf '%s' "$k" | grep -Eq '^[A-Za-z0-9._-]{1,64}$' || { say "invalid project name: $k"; exit 1; }; done
fi
# the "usage" part of every config: names to keep (projects stay hashed otherwise); nothing at all when none are listed
USAGE_JSON=""
if [ -n "$KEEP" ]; then
  USAGE_JSON=",\"usage\":{\"projectNames\":\"hashed\",\"keep\":[$(printf '"%s",' $KEEP | sed 's/,$//')]}"
fi

# ── 4. one private config per app ─────────────────────────────────────────────
write_config() { # write_config <file> <json>: dir 0700, file 0600, content never printed
  act "write $1 (mode 0600)"
  [ "$DRY" = 1 ] && return 0
  mkdir -p "$CFG_DIR" && chmod 700 "$CFG_DIR"
  ( umask 077; printf '%s\n' "$2" > "$1.tmp.$$" ) && chmod 600 "$1.tmp.$$" && mv -f "$1.tmp.$$" "$1"
}
read_token() { # read_token <label> <var> (the local name must not be one a caller passes)
  local _rt_tok=""
  while :; do
    ask_secret "Client token for $1 (oct_..., input hidden):" _rt_tok
    valid_token "$_rt_tok" && break
    say "That is not a siiswell token (oct_ + 43 characters)."
    [ -t 0 ] || exit 1
  done
  eval "$2=\$_rt_tok"
}

HOST_LABEL=""
# --reuse: the configs (and their tokens) stay exactly as they are
for app in $( [ "$REUSE" = 1 ] || printf '%s' "$APPS" ); do
  file="$CFG_DIR/$app.json"
  if [ "$app" = usage ]; then
    def="${MACHINE:-$(hostname | cut -d. -f1 | tr -c 'A-Za-z0-9._\n-' '-')}"
    say "The host label must be unique per machine and must equal the NAME of the host token (the dashboard refuses anything else)."
    HOST_LABEL="$(ask "Host label [$def]:" "$def")"
    printf '%s' "$HOST_LABEL" | grep -Eq '^[A-Za-z0-9._-]{1,64}$' || { say "invalid host label"; exit 1; }
    t=""
    # a host token belongs to its label: only offered again for the same label
    old="$(existing_token "$file" hostToken)"
    if [ -n "$old" ] && grep -qF "\"host\":\"$HOST_LABEL\"" "$file" 2>/dev/null && yes_default "$file already has a host token for '$HOST_LABEL'. Keep the existing token?"; then t="$old"; fi
    old=""
    while [ -z "$t" ]; do
      ask_secret "Host token for '$HOST_LABEL' (oct_..., input hidden):" t
      valid_token "$t" && break
      t=""
      say "That is not a siiswell token (oct_ + 43 characters)."
      [ -t 0 ] || exit 1
    done
    write_config "$file" "{\"url\":\"$URL\",\"hostToken\":\"$t\",\"host\":\"$HOST_LABEL\"$USAGE_JSON}"
  else
    t=""
    old="$(existing_token "$file" token)"
    if [ -n "$old" ] && yes_default "$file already has a client token for $app. Keep the existing token?"; then t="$old"; fi
    old=""
    [ -n "$t" ] || read_token "$app" t
    write_config "$file" "{\"url\":\"$URL\",\"token\":\"$t\",\"machine\":\"$MACHINE\"$USAGE_JSON}"
  fi
  t=""
done

# ── 5. doctor ─────────────────────────────────────────────────────────────────
run_doctor() {
  for app in $APPS; do
    if SIISWELL_CONFIG="$CFG_DIR/$app.json" "$NODE" "$MJS" doctor >/dev/null 2>&1; then say "doctor $app: ok"
    else say "doctor $app: FAILED (run: SIISWELL_CONFIG=$CFG_DIR/$app.json node $MJS doctor)"; fi
  done
}
if [ "$DRY" = 0 ] && [ "$REUSE" = 0 ]; then
  for app in $APPS; do
    if SIISWELL_CONFIG="$CFG_DIR/$app.json" "$NODE" "$MJS" doctor >/dev/null 2>&1; then say "doctor $app: ok"
    else say "doctor $app: FAILED (run: SIISWELL_CONFIG=$CFG_DIR/$app.json node $MJS doctor)"; fi
  done
fi

# ── 6. register the MCP server ────────────────────────────────────────────────
merge_json() { # merge_json <file> <config file>: mcpServers.siiswell = stdio entry, everything else kept
  local f="$1" cfg="$2"
  if [ -f "$f" ] && ! "$NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" 2>/dev/null; then
    warn "$f is not valid JSON: left alone; add the server by hand (see docs/INSTALL-CLIENTS.md)"; return 0
  fi
  act "add mcpServers.$SERVER to $f"
  [ "$DRY" = 1 ] && return 0
  backup "$f"
  mkdir -p "$(dirname "$f")"
  "$NODE" - "$f" "$SERVER" "$NODE" "$MJS" "$cfg" <<'JS'
const fs = require("fs");
const [file, name, node, mjs, cfg] = process.argv.slice(2);
let doc = {};
try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { doc = {}; }
if (typeof doc !== "object" || doc === null || Array.isArray(doc)) doc = {};
if (typeof doc.mcpServers !== "object" || doc.mcpServers === null || Array.isArray(doc.mcpServers)) doc.mcpServers = {};
doc.mcpServers[name] = { command: node, args: [mjs, "mcp"], env: { SIISWELL_CONFIG: cfg } };
const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
fs.writeFileSync(file + ".tmp", JSON.stringify(doc, null, 2) + "\n", { mode });
fs.renameSync(file + ".tmp", file);
JS
}

toml_str() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

for app in $APPS; do
  cfg="$CFG_DIR/$app.json"
  case "$app" in
    claude-code)
      act "register '$SERVER' in Claude Code (claude mcp add --scope user, stdio)"
      if [ "$DRY" = 0 ]; then
        claude mcp remove --scope user "$SERVER" >/dev/null 2>&1 || true
        # the server name goes BEFORE -e: `-e` takes several values and would swallow the name
        if cm_err="$(claude mcp add --scope user "$SERVER" -e "SIISWELL_CONFIG=$cfg" -- "$NODE" "$MJS" mcp 2>&1 >/dev/null)"; then
          say "Claude Code: registered"
        else
          warn "claude mcp add failed; see docs/INSTALL-CLIENTS.md section 4. claude said:"
          printf '%s\n' "$cm_err" | head -n 20 | cut -c1-300 >&2
        fi
        cm_err=""
      fi ;;
    codex)
      f="$HOME/.codex/config.toml"
      block="[mcp_servers.$SERVER]
command = $(toml_str "$NODE")
args = [$(toml_str "$MJS"), \"mcp\"]
env = { SIISWELL_CONFIG = $(toml_str "$cfg") }"
      present=0; [ -f "$f" ] && grep -q "^\[mcp_servers\.$SERVER\]" "$f" && present=1
      if [ "$present" = 1 ] && [ "$REUSE" = 0 ] && ! yes_no "$f already has [mcp_servers.$SERVER]. Replace it?"; then
        say "Codex: kept the existing entry"
      else
        act "write [mcp_servers.$SERVER] to $f"
        if [ "$DRY" = 0 ]; then
          backup "$f"; mkdir -p "$HOME/.codex"
          tmp="$f.tmp.$$"
          if [ -f "$f" ]; then
            awk -v h="[mcp_servers.$SERVER]" '
              $0 == h { skip = 1; next }
              skip && /^\[/ && index($0, "[mcp_servers.'"$SERVER"'.") != 1 { skip = 0 }
              !skip { print }' "$f" > "$tmp"
          else : > "$tmp"; fi
          [ -s "$tmp" ] && [ -n "$(tail -c 1 "$tmp")" ] && printf '\n' >> "$tmp"
          printf '\n%s\n' "$block" >> "$tmp"
          if [ -f "$f" ]; then chmod "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" "$tmp"; else chmod 600 "$tmp"; fi
          mv -f "$tmp" "$f"
        fi
      fi ;;
    claude-desktop) merge_json "$DESKTOP_DIR/claude_desktop_config.json" "$cfg" ;;
    agy) merge_json "$HOME/.gemini/antigravity-cli/mcp_config.json" "$cfg" ;;
    gemini) merge_json "$HOME/.gemini/settings.json" "$cfg" ;;
  esac
done

# ── 6b. app hooks (optional): they only run `siiswell hook ...`, which returns at once ─────────────
claude_hooks() { # claude_hooks <settings.json> <config file>: Notification, Stop, PostToolUse, UserPromptSubmit, SessionEnd -> siiswell hook, other hooks kept
  local f="$1" cfg="$2"
  if [ -f "$f" ] && ! "$NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" 2>/dev/null; then
    warn "$f is not valid JSON: left alone; add the hooks by hand (see docs/INSTALL-CLIENTS.md)"; return 0
  fi
  act "add Notification, Stop, PostToolUse, UserPromptSubmit and SessionEnd hooks (siiswell hook ...) to $f"
  [ "$DRY" = 1 ] && return 0
  backup "$f"
  mkdir -p "$(dirname "$f")"
  "$NODE" - "$f" "$NODE" "$MJS" "$cfg" <<'JS'
const fs = require("fs");
const [file, node, mjs, cfg] = process.argv.slice(2);
let doc = {};
try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { doc = {}; }
if (typeof doc !== "object" || doc === null || Array.isArray(doc)) doc = {};
if (typeof doc.hooks !== "object" || doc.hooks === null || Array.isArray(doc.hooks)) doc.hooks = {};
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const ours = (h) => h && typeof h.command === "string" && / hook (claude-notification|claude-stop|claude-post-tool|claude-prompt|claude-session-end)( |$)/.test(h.command) && h.command.includes("siiswell");
for (const [event, sub] of [["Notification", "claude-notification"], ["Stop", "claude-stop"], ["PostToolUse", "claude-post-tool"], ["UserPromptSubmit", "claude-prompt"], ["SessionEnd", "claude-session-end"]]) {
  const list = Array.isArray(doc.hooks[event]) ? doc.hooks[event] : [];
  // drop our earlier entries (idempotent), keep everything else
  const kept = list
    .map((m) => (m && Array.isArray(m.hooks) ? { ...m, hooks: m.hooks.filter((h) => !ours(h)) } : m))
    .filter((m) => !(m && Array.isArray(m.hooks) && m.hooks.length === 0));
  kept.push({ matcher: "", hooks: [{ type: "command", command: `${q(node)} ${q(mjs)} hook ${sub} --config ${q(cfg)}`, timeout: 5 }] });
  doc.hooks[event] = kept;
}
const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
fs.writeFileSync(file + ".tmp", JSON.stringify(doc, null, 2) + "\n", { mode });
fs.renameSync(file + ".tmp", file);
JS
}
codex_notify() { # codex_notify <config.toml> <config file>: top-level notify = [node, siiswell.mjs, hook, codex-notify, ...]
  local f="$1" cfg="$2"
  if [ -f "$f" ] && grep -Eq '^notify[[:space:]]*=' "$f" && ! grep -Eq '^notify[[:space:]]*=.*siiswell' "$f"; then
    warn "$f already has another 'notify' program (Codex allows one): left alone; see docs/INSTALL-CLIENTS.md"; return 0
  fi
  act "set notify (siiswell hook codex-notify) in $f"
  [ "$DRY" = 1 ] && return 0
  backup "$f"; mkdir -p "$(dirname "$f")"
  tmp="$f.tmp.$$"
  { printf 'notify = [%s, %s, "hook", "codex-notify", "--config", %s]\n' "$(toml_str "$NODE")" "$(toml_str "$MJS")" "$(toml_str "$cfg")"
    [ -f "$f" ] && grep -Ev '^notify[[:space:]]*=.*siiswell' "$f"; } > "$tmp"
  if [ -f "$f" ]; then chmod "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" "$tmp"; else chmod 600 "$tmp"; fi
  mv -f "$tmp" "$f"
}
case " $APPS " in *" claude-code "*)
  [ "$AGENT_WS" = 1 ] && say "$AGENT_WS_NOTE"
  if [ "$REUSE" = 1 ]; then
    claude_hooks "$HOME/.claude/settings.json" "$CFG_DIR/claude-code.json"
  elif { q="Install Claude Code hooks (needs permission / waiting for you -> BLOCKED on the dashboard; working again -> IN_PROGRESS; session ended -> DONE)?"
         if [ "$AGENT_WS" = 1 ]; then yes_default "$q"; else yes_no "$q"; fi; }; then
    claude_hooks "$HOME/.claude/settings.json" "$CFG_DIR/claude-code.json"
  fi ;;
esac
case " $APPS " in *" codex "*)
  if [ "$REUSE" = 1 ] || yes_no "Install the Codex notify hook (turn finished -> heartbeat on the dashboard)?"; then
    codex_notify "$HOME/.codex/config.toml" "$CFG_DIR/codex.json"
  fi ;;
esac

# ── 7. the reporting rule ─────────────────────────────────────────────────────
RULE="For any task that will take longer than about 10 minutes, you may use the \`$SERVER\` MCP tools ($RULE_MARK): call
\`report_task\` (status \`IN_PROGRESS\`, with \`eta_min\`) when you start; call \`update_task\` with status
\`BLOCKED\` when you are blocked and need me, and with \`DONE\` when you finish, reusing the
\`task_id\` you were given. Always call \`update_task\` with \`DONE\` before your final reply,
even for quick tests: a task left open shows as unfinished on the dashboard. Give each task a short plain description of
the action as its title (for example \"Fix login redirect bug\", under 60 characters) and a \`kind\` (one of coding, debugging,
testing, review, research, docs, deploy, ops, other). Never put prompt text, conversation content, file contents, customer data,
secrets, credentials, tokens or links to private documents in any title or summary.
(You can edit or remove this rule at any time; the \`taskText\` setting in the siiswell config limits what is sent: brief by
default, or minimal / none for less.)
Before you stop to ask me something, call \`operator_status\`: while I am away (winding down for the night), continue on
your own with the safest reasonable choice instead of waiting."
# agent workspaces: the agents read the same global file; `siiswell mcp` answers their write calls locally anyway
[ "$AGENT_WS" = 1 ] && RULE="$RULE
Ignore this rule inside agent workspaces (<project>/worktrees/... of a project with a .siiswell-agents file, or where SIISWELL_AGENT=1): the host integration reports those tasks."
RULE_START="<!-- siiswell rule: start (setup-client.sh replaces this block) -->"
RULE_END="<!-- siiswell rule: end -->"
# The first line of the rule as earlier versions of this script wrote it (no markers): only a line EQUAL to it (any server
# name) is taken for the old rule, never a user's own sentence that mentions $RULE_MARK.
LEGACY_RULE_RE="^For any task that will take longer than about 10 minutes, use the \`[A-Za-z0-9._-]*\` MCP tools \\($RULE_MARK\\): call\$"
has_rule() { # has_rule <file>: a marked block or the old rule's exact first line
  grep -q -F -x -e "$RULE_START" "$1" || grep -q -E -e "$LEGACY_RULE_RE" "$1"
}
# The file with the siiswell rule block replaced by the current one (stdout). Exit 3 when a start marker has no end marker
# (nothing may be written then: the rest of the file would be lost).
rule_replaced() { # rule_replaced <file>
  RS_START="$RULE_START" RS_END="$RULE_END" RS_LEGACY="$LEGACY_RULE_RE" RS_BLOCK="$RULE_START
$RULE
$RULE_END" awk '
    BEGIN { start = ENVIRON["RS_START"]; end = ENVIRON["RS_END"]; legacy = ENVIRON["RS_LEGACY"]; block = ENVIRON["RS_BLOCK"]; mode = 0; done = 0 }
    mode == 1 { if ($0 == end) mode = 0; next }
    mode == 2 { if ($0 == "") { mode = 0; print; next } if ($0 ~ /file contents in either\.$/) mode = 0; next }
    !done && $0 == start { print block; mode = 1; done = 1; next }
    !done && $0 ~ legacy { print block; done = 1; mode = 2; next }
    { print }
    END { if (mode == 1) exit 3 }
  ' "$1"
}
add_rule() { # add_rule <file>
  if [ -f "$1" ] && has_rule "$1"; then
    tmp=$(mktemp) || return 1
    if ! rule_replaced "$1" > "$tmp"; then
      rm -f "$tmp"
      if grep -q -F -x -e "$RULE_START" "$1" && ! grep -q -F -x -e "$RULE_END" "$1"; then warn "$1: rule block has no end marker; left unchanged"
      else warn "$1: could not rewrite the rule block; left unchanged"; fi
      return 0
    fi
    if [ ! -s "$tmp" ]; then rm -f "$tmp"; warn "$1: rewriting the rule block gave nothing; left unchanged"; return 0; fi
    if cmp -s "$tmp" "$1"; then rm -f "$tmp"; say "$1: rule up to date"; return 0; fi
    act "replace the siiswell rule block in $1 with the current text"
    if [ "$DRY" = 1 ]; then rm -f "$tmp"; return 0; fi
    backup "$1"
    cat "$tmp" > "$1"; rm -f "$tmp" # in place: keeps the file's mode and owner
    return 0
  fi
  act "append the long-task rule to $1"
  [ "$DRY" = 1 ] && return 0
  backup "$1"; mkdir -p "$(dirname "$1")"
  printf '\n%s\n%s\n%s\n' "$RULE_START" "$RULE" "$RULE_END" >> "$1"
}
case " $APPS " in *" claude-code "*|*" codex "*)
  if [ "$REUSE" = 1 ] || yes_no "Append the long-task reporting rule to the agents' global instructions?"; then
    case " $APPS " in *" claude-code "*) add_rule "$HOME/.claude/CLAUDE.md" ;; esac
    case " $APPS " in *" codex "*) add_rule "$HOME/.codex/AGENTS.md" ;; esac
  fi ;;
esac

# ── 8. usage schedule ─────────────────────────────────────────────────────────
[ "$REUSE" = 0 ] && case " $APPS " in *" usage "*)
  if yes_no "Schedule the usage collector every 15 minutes (after a successful dry run)?"; then
    ucfg="$CFG_DIR/usage.json"
    if [ "$DRY" = 0 ] && ! SIISWELL_CONFIG="$ucfg" "$NODE" "$MJS" usage push --dry-run >/dev/null 2>&1; then
      warn "'siiswell usage push --dry-run' failed: not scheduled (run it by hand to see why)"
    elif [ "$OS" = Darwin ]; then
      plist="$HOME/Library/LaunchAgents/com.siiswell.usage.plist"
      act "write $plist and load it"
      if [ "$DRY" = 0 ]; then
        backup "$plist"; mkdir -p "$(dirname "$plist")"
        cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.siiswell.usage</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$MJS</string><string>usage</string><string>push</string></array>
  <key>EnvironmentVariables</key><dict><key>SIISWELL_CONFIG</key><string>$ucfg</string></dict>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/.local/state/siiswell-usage.log</string>
  <key>StandardErrorPath</key><string>$HOME/.local/state/siiswell-usage.log</string>
</dict>
</plist>
EOF
        if [ "${SIISWELL_SETUP_NO_ACTIVATE:-0}" != 1 ]; then launchctl unload "$plist" >/dev/null 2>&1; launchctl load "$plist" && say "launchd: scheduled"; fi
      fi
    else
      udir="$HOME/.config/systemd/user"
      act "write $udir/siiswell-usage.service + .timer and enable the timer"
      if [ "$DRY" = 0 ]; then
        mkdir -p "$udir"; backup "$udir/siiswell-usage.service"; backup "$udir/siiswell-usage.timer"
        cat > "$udir/siiswell-usage.service" <<EOF
[Unit]
Description=siiswell: collect and upload token usage

[Service]
Type=oneshot
Environment=SIISWELL_CONFIG=$ucfg
ExecStart=$NODE $MJS usage push
Nice=10
IOSchedulingClass=idle
SuccessExitStatus=75
EOF
        sed -n '1,$p' "$REPO/cli/examples/siiswell-usage.timer" > "$udir/siiswell-usage.timer"
        if [ "${SIISWELL_SETUP_NO_ACTIVATE:-0}" != 1 ]; then
          systemctl --user daemon-reload && systemctl --user enable --now siiswell-usage.timer && say "systemd: scheduled"
        fi
      fi
    fi
  fi ;;
esac

[ "$REUSE" = 1 ] && [ "$DRY" = 0 ] && run_doctor
say "Done."
[ "$DRY" = 1 ] && say "(dry run: nothing was changed)"
exit 0
