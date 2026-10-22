<div align="center">

[English](README.md) · [日本語](README.ja.md) · **Deutsch** · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [한국어](README.ko.md) · [繁體中文](README.zh-Hant.md)

# siiswell

### SI is well, I am well.

<sub>(Geht es der SI gut, geht es mir gut.)</sub>

**Eine ruhige Seite dafür, was Ihre KI-Agents gerade tun, was es kostet und wie es Ihnen geht.**

<sub><b>SI</b> = Superintelligenz: die KI-Agents, die für Sie arbeiten. Wenn es ihnen gut geht und Ihnen gut geht, ist alles gut.</sub>

Open Source · selbst gehostet · funktioniert mit jedem MCP-Client · null KI-Aufrufe · Datenschutz als Standard

[Warum](#warum-siiswell) · [So funktioniert es](#so-funktioniert-es) · [Was anders ist](#was-siiswell-anders-macht) · [Funktionen](#funktionen) · [Clients](#funktioniert-mit-den-tools-die-sie-bereits-nutzen) · [Schnellstart](#schnellstart) · [Prompts](#prompts-zum-kopieren-für-ihre-agents) · [Datenschutz](#datenschutz-welche-daten-ihren-rechner-verlassen) · [FAQ](#faq) · [Doku](#dokumentation)

<img src="docs/img/overview.png" alt="Das siiswell-Dashboard: Zustand, die Übersichtsleiste (wartet auf Sie, in Arbeit, blockiert, erledigt) und die Karte „Sie“" width="900">

</div>

---

**siiswell** ist ein kostenloses, quelloffenes, selbst gehostetes **Dashboard für KI-Coding-Agents** wie Claude Code, Codex und Gemini
CLI. Es zeigt, welche Agent-Aufgaben laufen oder auf Sie warten, erfasst **LLM-Token-Nutzung und API-äquivalente Kosten**, sendet
ruhige Benachrichtigungen aufs Smartphone und achtet mit regelbasierten Signalen zum **Wohlbefinden von Entwicklern** auf den Menschen in der Mitte —
ohne je ein KI-Modell aufzurufen oder Ihre Prompts und Ihren Code zu lesen. Heute für eine Person gebaut; Team-Funktionen sind geplant.

## Warum siiswell

KI-Coding-Agents arbeiten heute minuten- oder stundenlang selbstständig, oft mehrere gleichzeitig, verteilt auf Terminals, Desktop-Apps,
Server und CI. Das ist großartig für den Durchsatz und anstrengend für den Menschen in der Mitte.

| Das alltägliche Problem | Was siiswell dagegen tut |
|---|---|
| **„Arbeitet es noch oder wartet es auf mich?“** Sie prüfen fünf Terminal-Tabs, um den einen Agent zu finden, der seit 40 Minuten um eine Berechtigung bittet. | Jeder Agent meldet seine langen Aufgaben (gestartet, blockiert, erledigt, ETA). Die Liste **Wartet auf Sie** und ein Push auf Ihr Handy sagen Ihnen sofort, wenn etwas wartet. |
| **Agents an vielen Orten.** Claude Code auf dem Laptop, Codex auf einem Server, eine Desktop-App, ein nächtliches Skript. Keine gemeinsame Ansicht. | Ein Dashboard für jeden Rechner, jede App und jedes Projekt, gruppiert als `machine / project`. |
| **„Was hat dieser Monat gekostet?“** Token-Zahlen stecken in lokalen Logs; Abo-Pläne verbergen den API-äquivalenten Preis. | Der Usage-Collector liest die Token-**Zahlen** aus lokalen Logs und zeigt Tokens und API-äquivalente Kosten nach Tag, Stunde, Host, App, Projekt und Modell. |
| **Benachrichtigungsflut.** Entweder verpassen Sie den wichtigen Prompt, oder Ihr Handy vibriert den ganzen Abend. | Pushes sind gestaffelt: Dringendes sofort, der Rest in einer Zusammenfassung; Ruhezeiten, ein Fokus-Schalter und Fokus nach Kalender. |
| **Lange Tage schleichen sich an.** Agents werden nie müde, Menschen schon. | Eine behutsame, regelbasierte Karte **Sie**: wie voll der Tag wirklich war, ein Hinweis auf eine Pause, eine Feierabend-Nachricht am Abend. Keine Punktzahlen, keine Streaks. |
| **„Kann ich einem weiteren Dashboard meinen Code anvertrauen?“** | Es sieht nie Prompts, Code oder Dateiinhalte. Es ruft nie ein KI-Modell auf. Sie hosten es selbst. |

## So funktioniert es

<p align="center"><img src="docs/img/how-it-works.svg" alt="So funktioniert siiswell: Agents, Skripte, Orchestratoren und der Usage-Collector melden über eine Datenschutzgrenze an Ihren selbst gehosteten Server, der jede Minute feste Regeln auswertet und Sie über das Dashboard und Web Push erreicht" width="760"></p>

1. **Agents melden.** Eine kurze Regel in den Anweisungen jedes Agents bittet ihn, `report_task` aufzurufen, wenn er etwas
   Langes beginnt, und `update_task`, wenn er blockiert oder fertig ist. Hooks für Claude Code und Codex können „wartet auf Sie“ auch
   selbst melden.
2. **Erfasst werden Zahlen, keine Inhalte.** Der Usage-Collector macht aus lokalen Logs stündliche Token-Summen pro Modell. Die
   Hooks speichern nur, *dass* Sie interagiert haben, und wann.
3. **Der Server entscheidet deterministisch.** Feste Regeln (blockiert, überfällig, ein wartender Berechtigungs-Prompt, Host offline, Plan-Limit
   in Sicht) öffnen Alerts; die Push-Richtlinie entscheidet, was Ihr Handy jetzt, später oder gar nicht erreicht.
4. **Sie schauen einmal hin.** Eine Seite, am Schreibtisch oder auf dem Handy, mit der Antwort ganz oben.

## Was siiswell anders macht

| | |
|---|---|
| 🧘 **Es achtet auf den Menschen, nicht nur auf die Agents** | Die meisten Agent-Tools zählen Tokens. siiswell nimmt auch den Menschen wahr: wie lange Sie schon dabei sind, wie schnell Sie antworten, ob der Abend noch Ihnen gehört. Es gibt sanfte Hinweise und bewertet Sie nie. |
| 🔕 **Weniger, besser getimte Benachrichtigungen** | Dringendes erreicht Ihr Handy sofort; alles andere wartet auf eine Zusammenfassung. Ruhezeiten, Fokus und Ihr Kalender regeln den Rest, und Agents erfahren, wenn Sie nicht da sind, sodass sie weiterarbeiten statt zu warten. |
| 🔒 **Eine Datenschutzgrenze, die Sie nachlesen können** | Nur Zählwerte, Zeiten und kurze bereinigte Titel verlassen Ihren Rechner. Text wird zweimal bereinigt (Client und Server), und der Server setzt seine eigene Obergrenze durch. Prompts, Code und Dateiinhalte überqueren die Grenze nie. |
| 🧮 **Null KI, vollständig nachvollziehbar** | Es wird nie ein Modell aufgerufen, daher kostet der Betrieb nichts, und jeder Alert stammt von einem Schwellenwert, den Sie im Code nachlesen können. |
| 🔌 **Jeder Agent, überall** | Eine kleine Regel in den Anweisungen eines Agents genügt. MCP, eine CLI, einfaches HTTP oder OpenTelemetry: Terminals, Desktop-Apps, Server, CI und Agent-Orchestratoren landen alle auf einer Seite. |
| 🏠 **Sie hosten es selbst** | Ein Cloudflare Worker oder ein Docker-Container, bewusst Single-Tenant. Ihre Daten bleiben in Ihrem Konto. |

## Funktionen

<table>
<tr><td width="50%" valign="top">

### Agent-Aufgaben
- Posteingang **Wartet auf Sie**: blockierte Aufgaben und Berechtigungs-Prompts, die auf Sie warten, älteste zuerst
- **In Arbeit**: jede offene Aufgabe mit ETA, Überfällig-Markierung und Startzeit
- **Letzte Ergebnisse** der vergangenen 24 Stunden
- Gruppiert nach Rechner, App und Projekt; veraltete Aufgaben schließen sich nach 24 h selbst
- Fünf MCP-Tools, darunter die nur lesenden `list_tasks` und `operator_status`

</td><td width="50%" valign="top">

### Nutzung und Kosten
- 12-Monats-Kalender-Heatmap und die 24 Stunden eines beliebigen Tages
- Tokens und **API-äquivalente Kosten** nach Host, App, Projekt und Modell
- Logs von Claude Code und Codex, dazu OpenTelemetry-Ingest
- Prognose für Plan-Limits: „In diesem Tempo ist das 5-h-Fenster gegen 16:40 voll“
- Preistabelle pro Modell mit eigenen Überschreibungen

</td></tr>
<tr><td valign="top">

### Ruhige Benachrichtigungen
- Web Push auf Handy und Desktop (installierbare PWA)
- **Zeitkritisches** sofort, alles andere in einer **geplanten Zusammenfassung**
- Ruhezeiten, Wochenenden, **Fokus 60 Min.**, Fokus aus Ihrem Kalender
- Zusammengehörige Alerts in einem Push gebündelt; eine Erinnerungsstaffel statt Wiederholungen
- Optionaler Posteingangsmodus: offene Berechtigungs-Prompts kommen gesammelt alle 15 oder 30 Minuten

</td><td valign="top">

### Sie, der Mensch
- **Ruhig / Beschäftigt / Überlastet**, immer mit den Gründen
- Eine geschätzte Arbeitslast (0–100) aus acht transparenten Signalen
- **Highlights**: die Woche in einfachen Sätzen, mit Ihrem üblichen Bereich bei jedem Indikator
- Zeitleiste von heute, Trends über 7 und 30 Tage, Wochenrückblick; heften Sie die Karten an, die Ihnen wichtig sind
- Sanfte Hinweise (Pause, Tempo, Ruhezeiten), jeweils mit „Heute nicht“ und „Nie“
- Feierabend- und Guten-Morgen-Nachrichten; Agents erfahren, dass Sie nicht da sind

</td></tr>
<tr><td valign="top">

### Datenschutz und Sicherheit
- Niemals Prompts, Code, Tool-Argumente oder Dateiinhalte
- Projektnamen standardmäßig gehasht; Text auf dem Client **und** dem Server bereinigt
- Ein Token pro Rechner und App, einzeln widerrufbar
- Serverseitige Obergrenzen dafür, wie viel Aufgabentext angenommen wird

</td><td valign="top">

### Läuft, wo Sie wollen
- **Cloudflare** Worker + D1 oder **Docker** mit SQLite
- Cloudflare Access, eingebaute Anmeldung oder Ihr eigener Auth-Proxy
- CLI ohne Abhängigkeiten (Node ≥ 18), die sich selbst aktualisiert
- AGPL-3.0, kommerzielle Lizenz auf Anfrage

</td></tr>
</table>

## Screenshots

<p align="center"><img src="docs/img/highlights.png" alt="Highlights: Nutzung, Arbeitslast, Abende und aktive Stunden dieser Woche, jeweils mit einem einfachen Satz und einer Sparkline" width="880"><br/><b>Highlights</b> — die Woche in vier einfachen Sätzen; heften Sie die an, die Ihnen wichtig sind</p>

| | |
|---|---|
| <img src="docs/img/usage.png" alt="Nutzung: Kalender-Heatmap und Aufschlüsselung nach Host, App, Projekt und Modell" width="440"><br/>**Nutzung und Kosten** — ein Jahr auf einen Blick, dann in einen Tag hineinzoomen | <img src="docs/img/wellbeing.png" alt="Die Karte „Sie“: Zustand, Arbeitslast und Zeitleiste von heute" width="440"><br/>**Sie** — wie der Tag läuft, mit den Gründen |
| <img src="docs/img/tasks.png" alt="Wartet auf Sie und In Arbeit" width="440"><br/>**Aufgaben** — was auf Sie wartet, was gerade läuft | <img src="docs/img/overview-dark.png" alt="Das Dashboard im dunklen Design" width="440"><br/>**Dunkles Design** — folgt Ihrem Gerät, oder wählen Sie selbst |
| <img src="docs/img/usage-month.png" alt="Monatsansicht der Nutzung: Summen, gestapelte Tagesbalken, Top-Projekte und -Modelle" width="440"><br/>**Monatsansicht** — Summen, Top-Projekte und -Modelle, Wochentag × Stunde | <img src="docs/img/phone.png" alt="Das Dashboard auf einem Handy" width="220"><br/>**Auf dem Handy** — als App installieren und Pushes erhalten |

<sub>Die Screenshots verwenden Demodaten aus <code>scripts/demo-seed.ts</code>.</sub>

## Funktioniert mit den Tools, die Sie bereits nutzen

Alles, was MCP spricht, kann Aufgaben melden. Alles, was einen Befehl ausführen oder HTTP senden kann, ebenfalls.

| Client-Typ | Beispiele | Wie die Verbindung entsteht | Was im Dashboard erscheint |
|---|---|---|---|
| **CLI-Agents** | Claude Code, Codex, Gemini CLI, Antigravity (agy), opencode, grok, kilo | `siiswell mcp` (stdio), vom Setup-Skript registriert, oder Remote-MCP mit Bearer-Header | Aufgaben; mit Hooks für Claude Code / Codex auch „wartet auf Sie“ und Ihr eigenes Tempo |
| **Desktop-Apps und IDEs** | Claude Desktop, ChatGPT-Desktop-App, Codex-IDE-Erweiterung | stdio-MCP-Server (`siiswell mcp`) | Aufgaben |
| **Jeder Remote-MCP-Client** | alles mit Streamable HTTP + eigenen Headern | `POST /mcp` mit `Authorization: Bearer <token>` | Aufgaben |
| **Cloud-Agents** | Manus, Grok (API-Remote-MCP), OpenAI Dots, ChatGPT Custom Connectors | `https://<your-dashboard>/mcp` als eigenen MCP-Server mit Bearer-Token- / API-Key-Header hinzufügen ([Details](#cloud-agents-manus-grok-dots-chatgpt)) | Aufgaben |
| **Skripte, Cron und CI** | Build-Jobs, lange Migrationen, nächtliche Aufgaben | `siiswell report` / `update` / `heartbeat` | Aufgaben und Heartbeats |
| **Reines HTTP / API** | jede Sprache | JSON-RPC an `/mcp`; Ingest-Endpunkte in [OpenAPI](docs/openapi.yaml) | Aufgaben, Nutzung, Host-Zustand |
| **Agent-Orchestratoren** | Ihr eigener Agent-Runner, Automatisierungsserver | Host-Integrations-Endpunkte `/api/ingest/{snapshot,events,heartbeat}`; eine `.siiswell-agents`-Markierung hält die Hooks aus deren Workspaces heraus | Hosts, Projekte, Agents, Aufgaben, Ereignisse |
| **Token-Nutzung** | Logs von Claude Code und Codex | `siiswell usage push` nach Zeitplan | Tokens und API-äquivalente Kosten |
| **OpenTelemetry** | Metriken von Claude Code | OTLP/HTTP JSON an `/api/ingest/otlp` (Opt-in) | Tokens und Kosten |

Snippets und Status pro App: [CLIENTS.md](CLIENTS.md) (Englisch). Installation Schritt für Schritt: [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md).

## Schnellstart

### Begriffe, die Ihnen begegnen

| Begriff | Bedeutung |
|---|---|
| **Server** | das Dashboard selbst: ein Docker-Container (oder ein Cloudflare Worker), der Meldungen speichert und die Seite anzeigt |
| **Client** | das kleine `siiswell`-Programm auf jedem Rechner, auf dem Ihre Agents laufen |
| **MCP** | der Standardweg, über den KI-Agents Tools aufrufen; siiswell gibt Agents ein Tool „meine Aufgabe melden“ |
| **Client-Token** | ein Schlüssel, mit dem eine Agent-App (etwa Claude Code auf Ihrem Laptop) Aufgaben melden darf |
| **Host-Token** | ein Schlüssel, mit dem der Usage-Collector eines Rechners Token-Zahlen senden darf; sein Name muss der Bezeichnung dieses Rechners entsprechen |
| **Hooks** | kleine Befehle, die Claude Code / Codex bei Ereignissen ausführen (ein Prompt, eine Berechtigungsanfrage); sie werden für „wartet auf Sie“ genutzt |

### Welcher Weg passt zu mir?

| | **Docker** (für die meisten empfohlen) | **Cloudflare** (für alle, die bereits Workers nutzen) |
|---|---|---|
| Läuft auf | jedem Rechner mit Docker: Heimserver, VPS, NAS | Ihrem Cloudflare-Konto (der Free Tier reicht meist aus) |
| Anmeldung | eingebaut: ein Admin-Passwort in `.env` | Cloudflare Access (Ihr Google- / GitHub- / E-Mail-Login) |
| Pushes aufs Handy | ja, sobald es eine HTTPS-Adresse hat | ja |
| Zeit bis zur ersten Aufgabe | etwa 10 Minuten auf einem Rechner; etwa 30 mit HTTPS | etwa 30 Minuten |

### Docker Schritt für Schritt

Sie brauchen: einen Rechner mit Docker und Docker Compose für den Server; Node.js 18+ und [Bun](https://bun.sh) auf jedem Rechner,
dessen Agents Sie verbinden möchten. Um es von anderen Rechnern oder vom Handy aus zu nutzen, brauchen Sie außerdem eine HTTPS-Adresse (Schritt 3).

**1. Herunterladen und ein Passwort setzen** (auf dem Server-Rechner)

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
cp .env.example .env && chmod 600 .env
```

Für einen ersten Versuch zählen nur zwei Zeilen in `.env`:

```dotenv
# the address you open; your https://… address after step 3
PUBLIC_URL=http://localhost:8787
# 12+ characters; to change it: edit, then docker compose up -d
ADMIN_PASSWORD='a long password you keep'
```

**2. Starten und prüfen**

```sh
docker compose up -d --build
docker compose ps
curl -s http://localhost:8787/api/health
```

Nach einigen Sekunden zeigt `docker compose ps` **healthy**, und der Health-Check antwortet mit `{"ok":true,…}`. Öffnen Sie
<http://localhost:8787> und melden Sie sich an. Falls es nicht startet, listet `docker compose logs siiswell` jede Einstellung
auf, die korrigiert werden muss. Auf einem entfernten Server ohne Browser öffnen Sie zuerst einen Tunnel von Ihrem Laptop aus:
`ssh -L 8787:127.0.0.1:8787 you@your-server`, und öffnen dann <http://localhost:8787> auf dem Laptop.

**3. Eine HTTPS-Adresse vergeben** (nötig für andere Rechner und das Handy)

Der Container lauscht nur auf `127.0.0.1:8787`. Stellen Sie einen Reverse Proxy mit HTTPS davor, zum Beispiel
[Caddy](https://caddyserver.com/), das sich das Zertifikat selbst besorgt:

```text
# /etc/caddy/Caddyfile  (point the DNS name at this machine first)
dash.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Dann in `.env`:

```dotenv
PUBLIC_URL=https://dash.example.com
# the proxy reaches the container from this address
TRUSTED_PROXY_CIDRS=172.28.0.1/32
```

und `docker compose up -d`. Keine Domain? Ein privater HTTPS-Name aus einem VPN wie Tailscale funktioniert ebenfalls. Weitere Optionen:
[docs/deploy.md](docs/deploy.md#deploy-with-docker) (Englisch).

**4. Pushes aufs Handy** (optional)

```sh
docker compose exec siiswell bun scripts/vapid.ts mailto:you@example.com
```

Fügen Sie die drei ausgegebenen `VAPID_…=`-Zeilen in `.env` ein, dann `docker compose up -d`. Auf einem iPhone öffnen Sie das Dashboard in
Safari, wählen Teilen → **Zum Home-Bildschirm**, öffnen es von dort und tippen dann auf **Benachrichtigungen aktivieren**.

**5. Tokens erstellen** (auf dem Server; jedes Token wird nur einmal ausgegeben, lassen Sie das Fenster also für Schritt 6 offen)

```sh
docker compose exec siiswell bun scripts/new-token.ts laptop-1-claude client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1-codex client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1 host --apply
```

Ein Client-Token pro Agent-App, die Sie nutzen (hier Claude Code und Codex), ein Host-Token pro Rechner. Der Name des Host-Tokens
(`laptop-1`) ist die Rechnerbezeichnung, die Sie in Schritt 6 eingeben.

**6. Einen Rechner verbinden** (auf jedem Laptop oder Desktop)

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```

Es fragt nach der Dashboard-URL (`https://dash.example.com`), einer Rechnerbezeichnung (`laptop-1`), welche Apps verbunden werden sollen, und
nach einem Token pro App (die Eingabe ist verdeckt). Es installiert den Befehl `siiswell` in `~/.local/bin`, fügt Ihren Agents die Melderegel
hinzu und kann die Hooks und den stündlichen Usage-Collector einrichten. Am Ende sollten Sie `doctor claude-code: ok` sehen.

Probieren Sie es aus (öffnen Sie zuerst ein neues Terminal, falls `siiswell` nicht gefunden wird). Die Aufgabe erscheint unter **In Arbeit**,
`siiswell tasks` listet sie auf, und die letzte Zeile schließt sie:

```sh
ID=$(siiswell report "Try the dashboard" --kind testing --eta-min 5 | tail -1)
siiswell tasks
siiswell update "$ID" --status DONE
```

Oder bitten Sie einen Agent, die Verbindungsprüfung auszuführen ([Prompt 3](#prompts-zum-kopieren-für-ihre-agents)).

### Im laufenden Betrieb

| Aufgabe | Befehl |
|---|---|
| Den Server aktualisieren | `git pull && docker compose up -d --build` (Datenbankänderungen werden automatisch angewendet) |
| Den Client eines Rechners aktualisieren | `siiswell update` (ohne Task-ID installiert es die Version, die Ihr Dashboard veröffentlicht) |
| Stoppen / starten | `docker compose down` / `docker compose up -d` (Ihre Daten bleiben erhalten) |
| Sichern | `docker compose stop`, `/data/siiswell.sqlite` aus dem Volume `siiswell-data` kopieren (`docker volume ls` zeigt den vollständigen Namen), `docker compose start`. Bewahren Sie Backups so vertraulich auf wie `.env`: Sie enthalten den Hash des Passworts |

⚠️ `docker compose down -v` löscht das Volume und damit alle Ihre Daten.

<details>
<summary><b>Cloudflare (Worker + D1)</b></summary>

```sh
bun install
bunx wrangler d1 create siiswell
```

Tragen Sie die ausgegebene `database_id` in `wrangler.toml` ein, dann:

```sh
bunx wrangler d1 migrations apply siiswell --remote
bun run deploy
bun scripts/new-token.ts laptop-1-claude client
```

Der letzte Befehl gibt einen Token und eine `wrangler d1 execute`-Zeile aus: Führen Sie diese Zeile aus, um den Token zu registrieren.

Schützen Sie die Seite mit Cloudflare Access: Bis das eingerichtet ist, zeigt das Dashboard niemandem Daten. Die vollständige Checkliste,
mit jedem nach außen gerichteten Schritt markiert, finden Sie in [docs/deploy.md](docs/deploy.md). Verbinden Sie dann Ihre Rechner wie in Schritt 6.
</details>

## Prompts zum Kopieren für Ihre Agents

Die Agents übernehmen das Melden, also muss man es ihnen sagen. Diese Prompts können Sie gefahrlos in jeden Agent einfügen: Keiner davon fragt
nach einem Token oder enthält eines. **Fügen Sie niemals ein Token in einen Chat ein**: Tokens gehören in die Konfigurationsdatei oder die Connector-Einstellungen.

Agents verstehen die folgenden englischen Prompts; Sie können sie aber auch in Ihrer eigenen Sprache formulieren.

<details open>
<summary><b>1. Die Melderegel</b> (in die globalen Anweisungen jedes Agents eintragen; <code>setup-client.sh</code> erledigt das für Sie)</summary>

```text
For any task that will take longer than about 10 minutes, you may use the `siiswell` MCP tools: call
`report_task` (status `IN_PROGRESS`, with `eta_min`) when you start; call `update_task` with status
`BLOCKED` when you are blocked and need me, and with `DONE` when you finish, reusing the `task_id` you
were given. Always call `update_task` with `DONE` before your final reply. Give each task a short plain
description of the action as its title (under 60 characters) and a `kind` (one of coding, debugging,
testing, review, research, docs, deploy, ops, other). Never put prompt text, conversation content, file
contents, customer data, secrets, credentials, tokens or links to private documents in any title or summary.
Before you stop to ask me something, call `operator_status`: while I am away, continue on your own with
the safest reasonable choice instead of waiting.
```
</details>

<details>
<summary><b>2. „siiswell auf diesem Rechner aktualisieren“</b></summary>

```text
Update the siiswell client on this machine: run `siiswell update --yes`, then `siiswell doctor`.
Tell me the installed version and any line of the doctor output that is not [ok] or [--].
Do not print, read or change any token or config file.
```
</details>

<details>
<summary><b>3. „Prüfen, ob siiswell funktioniert“</b></summary>

```text
Check the siiswell connection: call the siiswell `report_task` tool with title "Connection check",
kind "testing", status IN_PROGRESS and eta_min 1, then call `update_task` with status DONE for the
task_id you got. Tell me whether both calls succeeded.
```
</details>

<details>
<summary><b>4. Einen neuen Rechner einrichten</b> (das führen Sie selbst aus: Es fragt Tokens mit verdeckter Eingabe ab; benötigt Node.js 18+ und Bun)</summary>

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```
</details>

### Cloud-Agents (Manus, Grok, Dots, ChatGPT)

Agents, die in der Cloud eines Anbieters laufen, können keinen lokalen `siiswell`-Prozess starten, aber die meisten können einen **Remote-MCP-Server
über HTTPS** aufrufen – und genau das ist `https://<your-dashboard>/mcp`.

| Agent | Was er von siiswell braucht | Status |
|---|---|---|
| **Manus** | eigener MCP-Server: URL + `Authorization: Bearer <token>` (Settings → Integrations → Custom MCP) | sollte funktionieren; von uns noch nicht getestet |
| **Grok** | Grok Build CLI: `siiswell mcp` oder die Remote-URL ([CLIENTS.md](CLIENTS.md#6-grok)); Grok API: Remote-MCP-Tool mit Bearer-Header | CLI dokumentiert; API noch nicht getestet |
| **OpenAI Dots** | ein über HTTPS erreichbarer Remote-MCP-Server | MCP-Unterstützung vom Anbieter noch nicht dokumentiert; ausprobieren, sobald sie es ist |
| **ChatGPT Custom Connectors** | ein Remote-MCP-Server; Plan- und Auth-Optionen hängen vom Anbieter ab | funktioniert nur, wo sich ein Bearer-Token / API-Key setzen lässt; reine OAuth-Setups werden noch nicht unterstützt |

1. Erstellen Sie für jeden Cloud-Agent ein eigenes Client-Token (`new-token.ts <name> client`), damit es einzeln widerrufen werden kann.
2. Tragen Sie in den Connector-Einstellungen des Agents die URL und den Header `Authorization: Bearer <token>` ein.
3. Fügen Sie die Melderegel (Prompt 1) zu den benutzerdefinierten Anweisungen des Agents hinzu.

Gut zu wissen: Das Dashboard muss aus dem Internet über HTTPS erreichbar sein (hinter Cloudflare Access ist `/mcp` für
Token-Anfragen bereits ausgenommen). Ein Cloud-Agent führt den lokalen Client nicht aus, daher werden seine Titel nur vom **Server**
begrenzt und bereinigt (`ACCEPT_TASK_TEXT`); Hooks für Claude Code und der Usage-Collector greifen dort nicht.

## Datenschutz: Welche Daten Ihren Rechner verlassen

siiswell zeichnet auf, **dass** Sie und Ihre Agents etwas getan haben, niemals **was**.

| An Ihren Server gesendet | Nie gesendet, nie gespeichert |
|---|---|
| Aufgabenstatus, ETA und ein fester `kind` (coding, docs, …) | Prompts, Antworten, Unterhaltungen |
| Ein kurzer Aufgabentitel, bereinigt und auf 60 Zeichen gekürzt (Standard `brief`; `minimal` oder `none` senden weniger) | Code, Diffs, Dateiinhalte, Tool-Ausgaben |
| Token-Zahlen pro Stunde, Modell und App | Tool-Argumente, Befehlstext |
| Zeitpunkt und Art Ihrer eigenen Interaktionen (ein Prompt, eine erteilte Berechtigung) | Arbeitsverzeichnisse und lokale Pfade |
| Projektbezeichnungen: ein gesalzener Hash, sofern Sie keinen anzuzeigenden Namen angeben | Echte Projektnamen (außer mit Opt-in) |

- Text wird von Geheimnissen (Tokens, Keys, Passwörter, URLs) bereinigt, **auf dem Client und erneut auf dem Server**, und der Server
  setzt seine eigene Obergrenze durch (`ACCEPT_TASK_TEXT`, `ACCEPT_HOST_TEXT`), sodass ein Client nicht mehr senden kann, als Sie erlauben.
- Jeder Rechner und jede App hat ein eigenes Token; ein verlorenes wird einzeln widerrufen.
- `siiswell permissions suggest` ist der einzige Befehl, der lokale Transkripte liest. Er sendet nichts und gibt nur
  Allowlist-Schlüssel aus.
- Selbst gehostet: Die Daten bleiben in Ihrem Cloudflare-Konto oder Ihrem Container, standardmäßig mit 30 Tagen Aufbewahrung.

Details: [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) und [SECURITY.md](SECURITY.md).

## Null KI

siiswell ruft nie ein KI-Modell auf und verbraucht nie Ihren Plan oder Ihre Tokens. Dashboard, CLI, Hooks, MCP-Server und
Collector lesen nur lokale Zähler und senden kleine Berichte. Jede Regel ist ein fester Schwellenwert, den Sie im Code nachlesen können,
sodass sich jeder Alert und jede Zahl auf der Seite erklären lässt.

## FAQ

<details>
<summary><b>Brauchen meine Agents eine besondere Unterstützung?</b></summary>

Nein. Jeder Agent, der MCP-Tools nutzen kann, kann Aufgaben melden: Fügen Sie den Server und die kurze Anweisungsregel hinzu
([CLIENTS.md](CLIENTS.md#the-instruction-rule-put-this-in-each-agents-global-instructions)). Ohne MCP verwenden Sie die
`siiswell`-CLI oder einen einfachen HTTP-Aufruf.
</details>

<details>
<summary><b>Funktioniert es mit Cloud-Agents wie Manus, Grok, Dots oder ChatGPT?</b></summary>

Für das Melden von Aufgaben ja, sofern der Agent einen Remote-MCP-Server mit Bearer-Token- oder API-Key-Header hinzufügen kann: siehe
[Cloud-Agents](#cloud-agents-manus-grok-dots-chatgpt). Token-Nutzung und die Signale der Karte „Sie“ stammen aus lokalen Logs und Hooks
und decken daher die Agents ab, die Sie auf Ihren eigenen Rechnern betreiben.
</details>

<details>
<summary><b>Bremst es meine Agents aus oder kostet es Tokens?</b></summary>

Kaum. Ein Tool-Aufruf umfasst einige hundert Bytes und erfolgt nur bei Aufgaben, die länger als etwa 10 Minuten dauern. Hooks kehren sofort zurück und
erledigen ihre Netzwerkarbeit im Hintergrund. Das Dashboard selbst verbraucht keine KI-Tokens.
</details>

<details>
<summary><b>Was passiert, wenn ein Agent das Melden vergisst oder abstürzt?</b></summary>

Jeder Client zeigt das Alter seines „letzten Berichts“. Eine Aufgabe ohne Update seit 24 Stunden wird als veraltet geschlossen und in
`siiswell tasks` aufgeführt. Hooks für Claude Code melden „wartet auf Sie“ und das Sitzungsende, ohne auf den Agent angewiesen zu sein.
</details>

<details>
<summary><b>Wie genau sind die Kosten?</b></summary>

Es ist der **API-äquivalente** Preis: Token-Zahlen aus lokalen Logs, multipliziert mit einer Preistabelle pro Modell
(`src/shared/model-prices.json`, pro Rechner überschreibbar). Bei einem Abo-Plan zeigt es, was dieselbe Arbeit über die API
kosten würde, nicht, was Sie bezahlen.
</details>

<details>
<summary><b>Ich betreibe einen Agent-Orchestrator. Werden seine Agents als „ich“ gezählt?</b></summary>

Nein, wenn Sie seine Projekte markieren. Legen Sie eine `.siiswell-agents`-Datei in das Projektstammverzeichnis (seine Agents arbeiten in
`<project>/worktrees/...`) oder starten Sie die Agents mit `SIISWELL_AGENT=1`. Die Hooks zeichnen dort dann nichts auf, und die schreibenden
MCP-Tools werden lokal beantwortet, sodass nur Ihre eigenen Sitzungen zählen und die Host-Integration des Orchestrators die
Aufgaben meldet. Siehe [Agent workspaces](docs/INSTALL-CLIENTS.md#agent-workspaces-run-by-an-orchestrator).
</details>

<details>
<summary><b>Ist die Karte „Sie“ ein Gesundheits-Tool?</b></summary>

Nein. Sie zählt Zeitstempel und Ereignisse mit festen Schwellenwerten und sagt das auch auf der Seite. Sie soll einen langen Tag
sichtbar machen, nicht ihn bewerten. Jeder Hinweis lässt sich abschalten.
</details>

<details>
<summary><b>Ist siiswell für Teams geeignet?</b></summary>

Heute ist siiswell für eine Person gebaut: eine Installation, ein Eigentümer (Single-Tenant; Client-Tokens identifizieren Apps, sie sind
keine Mandantengrenze, siehe [SECURITY.md](SECURITY.md)). Team-Funktionen — gemeinsame Ansichten von Agents und LLM-Kosten, wobei die
Wohlbefindensdaten jeder Person privat bleiben — stehen auf der Roadmap.
</details>

<details>
<summary><b>Was bedeutet „SI is well, I am well“?</b></summary>

SI steht für Superintelligenz: die KI-Agents, die für Sie arbeiten. „SI is well“ bedeutet, dass Ihre Agents reibungslos laufen; „I
am well“ bedeutet, dass Sie nicht überlastet sind. siiswell behält beides im Blick.
</details>

<details>
<summary><b>Was kostet der Betrieb?</b></summary>

Auf Cloudflare bleibt eine persönliche Installation deutlich innerhalb der Limits des D1 Free Tier
([Schätzung](docs/reference.md#d1-quota-estimate-5-projects)). Mit Docker ist es ein kleiner Container und eine SQLite-Datei.
</details>

<details>
<summary><b>Wie aktualisiere ich?</b></summary>

Docker: `git pull && docker compose up -d --build` (Datenbankänderungen werden beim Start angewendet). Cloudflare: pullen, neue
Migrationen anwenden, deployen ([docs/upgrade.md](docs/upgrade.md)). Clients: `siiswell update` installiert die CLI-Version, die Ihr
Dashboard veröffentlicht; das Dashboard zeigt unter jedem Client, der nicht aktuell ist, einen kleinen Hinweis.
</details>

## Dokumentation

| Thema | Wo |
|---|---|
| Deployment: lokale Entwicklung, Cloudflare-Checkliste, Docker | [docs/deploy.md](docs/deploy.md) |
| Eine bestehende Installation aktualisieren | [docs/upgrade.md](docs/upgrade.md) |
| CLI, Hooks und Usage-Collector installieren | [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) |
| MCP-Einrichtung pro App, alle Verbindungswege | [CLIENTS.md](CLIENTS.md) |
| Wire-Protokoll und Endpunkte | [docs/api.md](docs/api.md), [docs/openapi.yaml](docs/openapi.yaml) |
| OpenTelemetry-Ingest | [docs/otel.md](docs/otel.md) |
| Was die Seite zeigt, Regeln, Takt, Limits, Kontingent | [docs/reference.md](docs/reference.md) |
| Sicherheitsmodell und Meldung von Schwachstellen | [SECURITY.md](SECURITY.md) |

## Entwicklung

```sh
bun install
bun run typecheck
NODE_ENV=test bun test
bun run dev
```

`bun run dev` startet einen lokalen Worker auf <http://localhost:8787>; `bun scripts/demo-seed.ts --help` erklärt die Demodaten
für die Screenshots.

Siehe [CONTRIBUTING.md](CONTRIBUTING.md). Sicherheitsprobleme: [SECURITY.md](SECURITY.md). Änderungen: [CHANGELOG.md](CHANGELOG.md).

## Lizenz

| Teil | Lizenz | Warum |
|---|---|---|
| Der Server und die Seite (alles, was unten nicht aufgeführt ist) | [AGPL-3.0-only](LICENSE) | Verbesserungen an einem gehosteten siiswell bleiben offen |
| Der Client: `cli/`, `bridge/` und `src/shared/` (der in die CLI gebündelte Code) | [Apache-2.0](LICENSE-APACHE) | Auf jedem Rechner installierbar, auch auf Firmen-Laptops, ohne Lizenzfragen |

Eine kommerzielle Lizenz für den AGPL-Teil ist auf Anfrage erhältlich: siehe [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)
([license@siiswell.com](mailto:license@siiswell.com)). Alles andere: [hello@siiswell.com](mailto:hello@siiswell.com). Beiträge sind unter dem [Contributor License Agreement](CLA.md) willkommen (siehe [CONTRIBUTING.md](CONTRIBUTING.md)).
Jede Client-Quelldatei trägt eine Zeile `SPDX-License-Identifier: Apache-2.0`. Copyright und Lizenzübersicht: [NOTICE](NOTICE).

<div align="center"><sub>© 2026 <a href="https://siiswell.com">siiswell.com</a> · <a href="https://github.com/jcaol/siiswell">GitHub</a> · <a href="mailto:hello@siiswell.com">Kontakt</a></sub></div>
