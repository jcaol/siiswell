<div align="center">

[English](README.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · **Français** · [한국어](README.ko.md) · [繁體中文](README.zh-Hant.md)

# siiswell

### SI is well, I am well.

<sub>(La SI va bien, je vais bien.)</sub>

**Une seule page, sereine, pour voir ce que font vos agents IA, ce que cela coûte et comment vous allez.**

<sub><b>SI</b> = super-intelligence : les agents IA qui travaillent pour vous. Quand ils vont bien et que vous allez bien, tout va bien.</sub>

Open source · auto-hébergé · compatible avec tout client MCP · zéro appel à une IA · confidentialité par défaut

[Pourquoi](#pourquoi-siiswell) · [Fonctionnement](#comment-ça-marche) · [Ce qui change](#ce-qui-distingue-siiswell) · [Fonctionnalités](#fonctionnalités) · [Clients](#fonctionne-avec-les-outils-que-vous-utilisez-déjà) · [Démarrage rapide](#démarrage-rapide) · [Prompts](#prompts-à-copier-coller-pour-vos-agents) · [Confidentialité](#confidentialité--ce-qui-quitte-votre-machine) · [FAQ](#faq) · [Docs](#documentation)

<img src="docs/img/overview.png" alt="Le dashboard siiswell : état de santé, le bandeau de synthèse (vous attend, en cours, bloqué, terminé) et la carte Vous" width="900">

</div>

---

**siiswell** est un **dashboard pour agents de code IA** gratuit, open source et auto-hébergé, pour Claude Code, Codex ou Gemini
CLI par exemple. Il montre quelles tâches d'agents sont en cours ou vous attendent, suit l'**usage des tokens LLM et le coût équivalent API**, envoie
des notifications sereines sur votre téléphone et prend soin de la personne au milieu grâce à des signaux de **bien-être du développeur** fondés sur des règles,
sans jamais appeler de modèle d'IA ni lire vos prompts ou votre code. Conçu pour une personne aujourd'hui ; des fonctionnalités d'équipe sont prévues.

## Pourquoi siiswell

Les agents de code IA travaillent désormais seuls pendant des minutes, voire des heures, souvent à plusieurs en même temps, dans
des terminaux, des applications de bureau, sur des serveurs et en CI. C'est excellent pour le débit, et éprouvant pour la personne au milieu.

| Le problème au quotidien | Ce que siiswell y apporte |
|---|---|
| **« Est-ce qu'il travaille encore, ou est-ce qu'il m'attend ? »** Vous parcourez cinq onglets de terminal pour trouver l'agent qui demande une autorisation depuis 40 minutes. | Chaque agent signale ses tâches longues (démarrée, bloquée, terminée, ETA). La liste **Vous attend** et une notification push sur votre téléphone vous préviennent dès que quelque chose attend. |
| **Des agents partout.** Claude Code sur le portable, Codex sur un serveur, une application de bureau, un script nocturne. Aucune vue d'ensemble. | Un seul dashboard pour chaque machine, application et projet, regroupés en `machine / project`. |
| **« Combien a coûté ce mois-ci ? »** Les nombres de tokens sont enfouis dans des logs locaux ; les abonnements masquent le prix équivalent API. | Le collecteur d'usage lit les **nombres** de tokens dans les logs locaux et affiche les tokens et le coût équivalent API par jour, heure, hôte, application, projet et modèle. |
| **Le bruit des notifications.** Soit vous manquez la demande importante, soit votre téléphone vibre toute la soirée. | Les push sont hiérarchisés : l'urgent tout de suite, le reste dans un récapitulatif ; heures calmes, un interrupteur Focus et un Focus basé sur votre agenda. |
| **Les longues journées s'installent sans prévenir.** Les agents ne se fatiguent jamais ; les personnes, si. | Une carte **Vous** bienveillante, fondée sur des règles : à quel point la journée a réellement été chargée, une invitation à faire une pause, un message de fin de journée le soir. Pas de score, pas de série. |
| **« Puis-je confier mon code à un dashboard de plus ? »** | Il ne voit jamais les prompts, le code ni le contenu des fichiers. Il n'appelle jamais de modèle d'IA. Vous l'hébergez vous-même. |

## Comment ça marche

<p align="center"><img src="docs/img/how-it-works.svg" alt="Fonctionnement de siiswell : agents, scripts, orchestrateurs et collecteur d'usage envoient leurs rapports, à travers une frontière de confidentialité, à votre serveur auto-hébergé, qui évalue des règles fixes chaque minute et vous joint via le dashboard et Web Push" width="760"></p>

1. **Les agents rendent compte.** Une courte règle dans les instructions de chaque agent lui demande d'appeler `report_task` quand il commence
   quelque chose de long, et `update_task` quand il est bloqué ou a terminé. Les hooks de Claude Code et Codex peuvent aussi signaler « vous attend »
   d'eux-mêmes.
2. **On collecte des nombres, pas du contenu.** Le collecteur d'usage transforme les logs locaux en totaux horaires de tokens par modèle. Les
   hooks ne retiennent que *le fait* que vous avez interagi, et quand.
3. **Le serveur décide, de façon déterministe.** Des règles fixes (bloqué, en retard, une demande d'autorisation en attente, hôte hors ligne, limite
   du forfait proche) ouvrent des alertes ; la politique de push décide de ce qui arrive sur votre téléphone maintenant, plus tard, ou jamais.
4. **Vous regardez une seule fois.** Une seule page, sur votre bureau ou votre téléphone, avec la réponse en haut.

## Ce qui distingue siiswell

| | |
|---|---|
| 🧘 **Il prend soin de la personne, pas seulement des agents** | La plupart des outils pour agents comptent des tokens. siiswell remarque aussi l'humain : depuis combien de temps vous êtes dessus, à quelle vitesse vous répondez, si la soirée vous appartient encore. Il encourage en douceur et ne vous note jamais. |
| 🔕 **Moins de notifications, mieux placées** | L'urgent arrive aussitôt sur votre téléphone ; tout le reste attend un récapitulatif. Heures calmes, Focus et votre agenda décident du reste, et les agents savent quand vous êtes absent pour continuer au lieu d'attendre. |
| 🔒 **Une frontière de confidentialité lisible** | Seuls des compteurs, des horaires et de courts titres nettoyés quittent votre machine. Le texte est nettoyé deux fois (client et serveur) et le serveur applique son propre plafond. Prompts, code et contenu des fichiers ne passent jamais. |
| 🧮 **Zéro IA, entièrement explicable** | Aucun modèle n'est jamais appelé : il ne coûte rien à faire tourner et chaque alerte vient d'un seuil que vous pouvez lire dans le code. |
| 🔌 **N'importe quel agent, n'importe où** | Une petite règle dans les instructions d'un agent suffit. MCP, une CLI, du HTTP simple ou OpenTelemetry : terminaux, applications de bureau, serveurs, CI et orchestrateurs d'agents arrivent tous sur une seule page. |
| 🏠 **À héberger chez vous** | Un Cloudflare Worker ou un conteneur Docker, mono-tenant par conception. Vos données restent dans votre compte. |

## Fonctionnalités

<table>
<tr><td width="50%" valign="top">

### Tâches des agents
- Boîte **Vous attend** : tâches bloquées et demandes d'autorisation en attente, les plus anciennes d'abord
- **En cours** : chaque tâche ouverte avec ETA, indicateur de retard et heure de début
- **Résultats récents** des dernières 24 heures
- Regroupées par machine, application et projet ; les tâches inactives se ferment d'elles-mêmes après 24 h
- Cinq outils MCP, dont `list_tasks` et `operator_status` en lecture seule

</td><td width="50%" valign="top">

### Usage et coût
- Heatmap calendaire sur 12 mois et les 24 heures de n'importe quel jour
- Tokens et **coût équivalent API** par hôte, application, projet et modèle
- Logs de Claude Code et Codex, plus ingestion OpenTelemetry
- Prévision de limite du forfait : « À ce rythme, la fenêtre de 5 h sera pleine vers 16:40 »
- Table de prix par modèle, avec vos propres ajustements

</td></tr>
<tr><td valign="top">

### Notifications sereines
- Web Push sur téléphone et ordinateur (PWA installable)
- Éléments **Time-Sensitive** tout de suite, le reste dans un **Scheduled Summary**
- Heures calmes, week-ends, **Focus 60 min**, Focus depuis votre agenda
- Alertes liées regroupées en un seul push ; une relance progressive plutôt que des répétitions
- Mode boîte de réception optionnel : les demandes d'autorisation en attente arrivent ensemble toutes les 15 ou 30 minutes

</td><td valign="top">

### Vous, la personne
- **Calme / Occupé / Surchargé**, toujours avec les raisons
- Un niveau de charge estimé (0–100) à partir de huit signaux transparents
- **Highlights** : la semaine en phrases simples, avec votre plage habituelle affichée sur chaque indicateur
- Chronologie du jour, tendances sur 7 et 30 jours, bilan hebdomadaire ; épinglez les cartes qui comptent pour vous
- Encouragements discrets (pause, rythme, heures calmes), chacun avec « Pas aujourd'hui » et « Jamais »
- Messages de fin de journée et de bonjour ; les agents apprennent que vous êtes absent

</td></tr>
<tr><td valign="top">

### Confidentialité et sécurité
- Jamais de prompts, de code, d'arguments d'outils ni de contenu de fichiers
- Noms de projets hachés par défaut ; texte nettoyé sur le client **et** sur le serveur
- Un token par machine et par application, révocable individuellement
- Plafonds côté serveur sur la quantité de texte de tâche acceptée

</td><td valign="top">

### Tourne où vous voulez
- **Cloudflare** Worker + D1, ou **Docker** avec SQLite
- Cloudflare Access, connexion intégrée, ou votre propre proxy d'authentification
- CLI sans dépendance (Node ≥ 18) qui se met à jour toute seule
- AGPL-3.0, licence commerciale sur demande

</td></tr>
</table>

## Captures d'écran

<p align="center"><img src="docs/img/highlights.png" alt="Highlights : l'usage de la semaine, la charge, les soirées et les heures actives, chacun avec une phrase simple et une sparkline" width="880"><br/><b>Highlights</b> — la semaine en quatre phrases simples ; épinglez celles qui comptent pour vous</p>

| | |
|---|---|
| <img src="docs/img/usage.png" alt="Usage : heatmap calendaire et répartition par hôte, application, projet et modèle" width="440"><br/>**Usage et coût** — une année d'un coup d'œil, puis le détail d'une journée | <img src="docs/img/wellbeing.png" alt="La carte Vous : état, niveau de charge et chronologie du jour" width="440"><br/>**Vous** — comment se passe la journée, avec les raisons |
| <img src="docs/img/tasks.png" alt="Vous attend et En cours" width="440"><br/>**Tâches** — ce qui vous attend, ce qui tourne | <img src="docs/img/overview-dark.png" alt="Le dashboard en thème sombre" width="440"><br/>**Thème sombre** — suit votre appareil, ou choisissez-en un |
| <img src="docs/img/usage-month.png" alt="Vue mensuelle de l'usage : totaux, barres empilées par jour, principaux projets et modèles" width="440"><br/>**Vue mensuelle** — totaux, principaux projets et modèles, jour de semaine × heure | <img src="docs/img/phone.png" alt="Le dashboard sur un téléphone" width="220"><br/>**Sur le téléphone** — installez-le comme une application et recevez les push |

<sub>Les captures d'écran utilisent les données de démonstration de <code>scripts/demo-seed.ts</code>.</sub>

## Fonctionne avec les outils que vous utilisez déjà

Tout ce qui parle MCP peut signaler des tâches. Tout ce qui peut lancer une commande ou envoyer une requête HTTP aussi.

| Type de client | Exemples | Mode de connexion | Ce qui apparaît sur le dashboard |
|---|---|---|---|
| **Agents CLI** | Claude Code, Codex, Gemini CLI, Antigravity (agy), opencode, grok, kilo | `siiswell mcp` (stdio) enregistré par le script d'installation, ou MCP distant avec un en-tête bearer | Tâches ; avec les hooks Claude Code / Codex, aussi « vous attend » et votre propre rythme |
| **Applications de bureau et IDE** | Claude Desktop, application de bureau ChatGPT, extension IDE Codex | serveur MCP stdio (`siiswell mcp`) | Tâches |
| **Tout client MCP distant** | tout ce qui gère Streamable HTTP + en-têtes personnalisés | `POST /mcp` avec `Authorization: Bearer <token>` | Tâches |
| **Agents cloud** | Manus, Grok (MCP distant via l'API), OpenAI Dots, connecteurs personnalisés ChatGPT | ajoutez `https://<your-dashboard>/mcp` comme serveur MCP personnalisé avec un en-tête bearer token / clé API ([détails](#agents-cloud-manus-grok-dots-chatgpt)) | Tâches |
| **Scripts, cron et CI** | jobs de build, longues migrations, tâches nocturnes | `siiswell report` / `update` / `heartbeat` | Tâches et heartbeats |
| **HTTP brut / API** | n'importe quel langage | JSON-RPC vers `/mcp` ; endpoints d'ingestion dans [OpenAPI](docs/openapi.yaml) | Tâches, usage, état des hôtes |
| **Orchestrateurs d'agents** | votre propre lanceur d'agents, serveurs d'automatisation | endpoints d'intégration hôte `/api/ingest/{snapshot,events,heartbeat}` ; un marqueur `.siiswell-agents` tient les hooks à l'écart de ses espaces de travail | Hôtes, projets, agents, tâches, événements |
| **Usage des tokens** | logs de Claude Code et Codex | `siiswell usage push` à intervalle régulier | Tokens et coût équivalent API |
| **OpenTelemetry** | métriques de Claude Code | OTLP/HTTP JSON vers `/api/ingest/otlp` (sur option) | Tokens et coût |

Extraits et état par application : [CLIENTS.md](CLIENTS.md) (en anglais). Installation pas à pas : [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) (en anglais).

## Démarrage rapide

### Les mots que vous allez croiser

| Mot | Signification |
|---|---|
| **Serveur** | le dashboard lui-même : un conteneur Docker (ou un Cloudflare Worker) qui stocke les rapports et affiche la page |
| **Client** | le petit programme `siiswell` installé sur chaque ordinateur où tournent vos agents |
| **MCP** | la manière standard dont les agents IA appellent des outils ; siiswell leur fournit un outil « signaler ma tâche » |
| **Token client** | une clé qui permet à une application d'agent (par exemple Claude Code sur votre portable) de signaler des tâches |
| **Token hôte** | une clé qui permet au collecteur d'usage d'un ordinateur d'envoyer des nombres de tokens ; son nom doit être identique au libellé de cet ordinateur |
| **Hooks** | de petites commandes que Claude Code / Codex exécutent lors d'événements (un prompt, une demande d'autorisation), utilisées pour « vous attend » |

### Quelle méthode me convient ?

| | **Docker** (recommandé pour la plupart des gens) | **Cloudflare** (pour qui utilise déjà les Workers) |
|---|---|---|
| Tourne sur | toute machine avec Docker : un serveur domestique, un VPS, un NAS | votre compte Cloudflare (l'offre gratuite suffit généralement) |
| Connexion | intégrée : un mot de passe admin dans `.env` | Cloudflare Access (votre connexion Google / GitHub / e-mail) |
| Push sur téléphone | oui, une fois qu'il dispose d'une adresse HTTPS | oui |
| Délai jusqu'à la première tâche | environ 10 minutes sur une machine ; environ 30 avec HTTPS | environ 30 minutes |

### Docker, pas à pas

Il vous faut : une machine avec Docker et Docker Compose pour le serveur ; Node.js 18+ et [Bun](https://bun.sh) sur chaque ordinateur
dont vous voulez connecter les agents. Pour l'utiliser depuis d'autres ordinateurs ou votre téléphone, il vous faut aussi une adresse HTTPS (étape 3).

**1. Récupérez-le et définissez un mot de passe** (sur la machine serveur)

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
cp .env.example .env && chmod 600 .env
```

Pour un premier essai, seules deux lignes de `.env` comptent :

```dotenv
# the address you open; your https://… address after step 3
PUBLIC_URL=http://localhost:8787
# 12+ characters; to change it: edit, then docker compose up -d
ADMIN_PASSWORD='a long password you keep'
```

**2. Démarrez-le et vérifiez-le**

```sh
docker compose up -d --build
docker compose ps
curl -s http://localhost:8787/api/health
```

Au bout de quelques secondes, `docker compose ps` indique **healthy** et le contrôle de santé répond `{"ok":true,…}`. Ouvrez
<http://localhost:8787> et connectez-vous. S'il ne démarre pas, `docker compose logs siiswell` liste chaque réglage
à corriger. Sur un serveur distant sans navigateur, ouvrez d'abord un tunnel depuis votre portable :
`ssh -L 8787:127.0.0.1:8787 you@your-server`, puis ouvrez <http://localhost:8787> sur le portable.

**3. Donnez-lui une adresse HTTPS** (nécessaire pour les autres ordinateurs et le téléphone)

Le conteneur n'écoute que sur `127.0.0.1:8787`. Placez devant lui un reverse proxy avec HTTPS, par exemple
[Caddy](https://caddyserver.com/), qui obtient le certificat tout seul :

```text
# /etc/caddy/Caddyfile  (point the DNS name at this machine first)
dash.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Puis dans `.env` :

```dotenv
PUBLIC_URL=https://dash.example.com
# the proxy reaches the container from this address
TRUSTED_PROXY_CIDRS=172.28.0.1/32
```

et `docker compose up -d`. Pas de nom de domaine ? Un nom HTTPS privé fourni par un VPN comme Tailscale convient aussi. Plus d'options :
[docs/deploy.md](docs/deploy.md#deploy-with-docker) (en anglais).

**4. Push sur téléphone** (facultatif)

```sh
docker compose exec siiswell bun scripts/vapid.ts mailto:you@example.com
```

Collez les trois lignes `VAPID_…=` affichées dans `.env`, puis `docker compose up -d`. Sur un iPhone, ouvrez le dashboard dans
Safari, choisissez Partager → **Sur l'écran d'accueil**, ouvrez-le depuis là, puis touchez **Activer les notifications**.

**5. Créez les tokens** (sur le serveur ; chaque token n'est affiché qu'une fois, gardez donc la fenêtre ouverte pour l'étape 6)

```sh
docker compose exec siiswell bun scripts/new-token.ts laptop-1-claude client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1-codex client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1 host --apply
```

Un token client par application d'agent que vous utilisez (ici Claude Code et Codex), un token hôte par ordinateur. Le nom du token hôte
(`laptop-1`) est le libellé de machine que vous saisirez à l'étape 6.

**6. Connectez un ordinateur** (sur chaque portable ou poste de travail)

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```

Il demande l'URL du dashboard (`https://dash.example.com`), un libellé de machine (`laptop-1`), les applications à connecter, et
un token par application (la saisie est masquée). Il installe la commande `siiswell` dans `~/.local/bin`, ajoute la règle de rapport à
vos agents, et peut ajouter les hooks et le collecteur d'usage horaire. Vous devriez voir `doctor claude-code: ok` à la fin.

Essayez (ouvrez d'abord un nouveau terminal si `siiswell` est introuvable). La tâche apparaît sous **En cours**, `siiswell tasks`
la liste, et la dernière ligne la clôt :

```sh
ID=$(siiswell report "Try the dashboard" --kind testing --eta-min 5 | tail -1)
siiswell tasks
siiswell update "$ID" --status DONE
```

Ou demandez à un agent de lancer la vérification de connexion ([prompt 3](#prompts-à-copier-coller-pour-vos-agents)).

### Le faire tourner au quotidien

| Tâche | Commande |
|---|---|
| Mettre à jour le serveur | `git pull && docker compose up -d --build` (les changements de base de données s'appliquent d'eux-mêmes) |
| Mettre à jour le client d'un ordinateur | `siiswell update` (sans identifiant de tâche, il installe la version publiée par votre dashboard) |
| Arrêter / démarrer | `docker compose down` / `docker compose up -d` (vos données sont conservées) |
| Sauvegarder | `docker compose stop`, copiez `/data/siiswell.sqlite` hors du volume `siiswell-data` (`docker volume ls` affiche son nom complet), `docker compose start`. Gardez les sauvegardes aussi privées que `.env` : elles contiennent le hash du mot de passe |

⚠️ `docker compose down -v` supprime le volume, c'est-à-dire toutes vos données.

<details>
<summary><b>Cloudflare (Worker + D1)</b></summary>

```sh
bun install
bunx wrangler d1 create siiswell
```

Reportez le `database_id` affiché dans `wrangler.toml`, puis :

```sh
bunx wrangler d1 migrations apply siiswell --remote
bun run deploy
bun scripts/new-token.ts laptop-1-claude client
```

La dernière commande affiche un token et une ligne `wrangler d1 execute` : exécutez cette ligne pour enregistrer le token.

Protégez la page avec Cloudflare Access : tant que ce n'est pas configuré, le dashboard n'affiche aucune donnée à personne. La checklist complète,
avec chaque étape exposée vers l'extérieur signalée, se trouve dans [docs/deploy.md](docs/deploy.md). Connectez ensuite vos ordinateurs comme à l'étape 6.
</details>

## Prompts à copier-coller pour vos agents

Ce sont les agents qui font les rapports, il faut donc le leur dire. Ces prompts peuvent être collés sans risque dans n'importe quel agent : aucun ne demande
ni ne contient de token. **Ne collez jamais un token dans une conversation** : les tokens vont dans le fichier de configuration ou dans les réglages du connecteur.

Les agents comprennent les prompts en anglais ci-dessous ; vous pouvez aussi les rédiger dans votre propre langue.

<details open>
<summary><b>1. La règle de rapport</b> (à placer dans les instructions globales de chaque agent ; <code>setup-client.sh</code> le fait pour vous)</summary>

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
<summary><b>2. « Mets à jour siiswell sur cette machine »</b></summary>

```text
Update the siiswell client on this machine: run `siiswell update --yes`, then `siiswell doctor`.
Tell me the installed version and any line of the doctor output that is not [ok] or [--].
Do not print, read or change any token or config file.
```
</details>

<details>
<summary><b>3. « Vérifie que siiswell fonctionne »</b></summary>

```text
Check the siiswell connection: call the siiswell `report_task` tool with title "Connection check",
kind "testing", status IN_PROGRESS and eta_min 1, then call `update_task` with status DONE for the
task_id you got. Tell me whether both calls succeeded.
```
</details>

<details>
<summary><b>4. Configurer une nouvelle machine</b> (à lancer vous-même : il demande les tokens en saisie masquée ; nécessite Node.js 18+ et Bun)</summary>

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```
</details>

### Agents cloud (Manus, Grok, Dots, ChatGPT)

Les agents qui tournent dans le cloud d'un éditeur ne peuvent pas lancer de processus `siiswell` local, mais la plupart peuvent appeler un **serveur MCP
distant en HTTPS**, ce qu'est précisément `https://<your-dashboard>/mcp`.

| Agent | Ce dont il a besoin côté siiswell | État |
|---|---|---|
| **Manus** | serveur MCP personnalisé : URL + `Authorization: Bearer <token>` (Settings → Integrations → Custom MCP) | devrait fonctionner ; pas encore testé de notre côté |
| **Grok** | Grok Build CLI : `siiswell mcp` ou l'URL distante ([CLIENTS.md](CLIENTS.md#6-grok)) ; API Grok : outil MCP distant avec un en-tête bearer | CLI documentée ; API pas encore testée |
| **OpenAI Dots** | un serveur MCP distant accessible en HTTPS | prise en charge de MCP pas encore documentée par l'éditeur ; à essayer quand elle le sera |
| **Connecteurs personnalisés ChatGPT** | un serveur MCP distant ; les options d'offre et d'authentification dépendent de l'éditeur | fonctionne uniquement là où un bearer token / une clé API peut être défini ; les configurations uniquement OAuth ne sont pas encore prises en charge |

1. Créez un token client distinct pour chaque agent cloud (`new-token.ts <name> client`), afin de pouvoir le révoquer séparément.
2. Dans les réglages du connecteur de l'agent, saisissez l'URL et l'en-tête `Authorization: Bearer <token>`.
3. Ajoutez la règle de rapport (prompt 1) aux instructions personnalisées de l'agent.

Bon à savoir : le dashboard doit être accessible depuis internet en HTTPS (derrière Cloudflare Access, `/mcp` est
déjà exempté pour les requêtes avec token). Un agent cloud n'exécute pas le client local : ses titres sont donc limités et
nettoyés par le **serveur** uniquement (`ACCEPT_TASK_TEXT`) ; les hooks de Claude Code et le collecteur d'usage ne s'y appliquent pas.

## Confidentialité : ce qui quitte votre machine

siiswell enregistre **le fait** que vous et vos agents avez fait quelque chose, jamais **quoi**.

| Envoyé à votre serveur | Jamais envoyé, jamais stocké |
|---|---|
| État de la tâche, ETA et un `kind` fixe (coding, docs, …) | Prompts, réponses, conversations |
| Un court titre de tâche, nettoyé et tronqué à 60 caractères (par défaut `brief` ; `minimal` ou `none` envoient moins) | Code, diffs, contenu des fichiers, sortie des outils |
| Nombre de tokens par heure, modèle et application | Arguments d'outils, texte des commandes |
| Heure et type de vos propres interactions (un prompt, une autorisation accordée) | Répertoires de travail et chemins locaux |
| Libellés de projets : un hash salé, sauf si vous indiquez un nom à afficher | Vrais noms de projets (sauf si vous l'activez) |

- Le texte est débarrassé des secrets (tokens, clés, mots de passe, URL) **sur le client puis à nouveau sur le serveur**, et le serveur
  applique son propre plafond (`ACCEPT_TASK_TEXT`, `ACCEPT_HOST_TEXT`), de sorte qu'un client ne peut pas envoyer plus que ce que vous autorisez.
- Chaque machine et application a son propre token ; un token perdu est révoqué seul.
- `siiswell permissions suggest` est la seule commande qui lit les transcriptions locales. Elle n'envoie rien et n'affiche que
  des clés d'allowlist.
- Auto-hébergé : les données restent dans votre compte Cloudflare ou votre conteneur, avec une rétention de 30 jours par défaut.

Détails : [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) et [SECURITY.md](SECURITY.md) (en anglais).

## Zéro IA

siiswell n'appelle jamais de modèle d'IA et ne consomme jamais votre forfait ni vos tokens. Le dashboard, la CLI, les hooks, le serveur MCP et
le collecteur ne font que lire des compteurs locaux et envoyer de petits rapports. Chaque règle est un seuil fixe que vous pouvez lire dans le code :
chaque alerte et chaque nombre affiché sur la page peuvent donc être expliqués.

## FAQ

<details>
<summary><b>Mes agents ont-ils besoin d'une prise en charge particulière ?</b></summary>

Non. Tout agent capable d'utiliser des outils MCP peut signaler des tâches : ajoutez le serveur et la courte règle d'instruction
([CLIENTS.md](CLIENTS.md#the-instruction-rule-put-this-in-each-agents-global-instructions)). Sans MCP, utilisez la
CLI `siiswell` ou un simple appel HTTP.
</details>

<details>
<summary><b>Fonctionne-t-il avec des agents cloud comme Manus, Grok, Dots ou ChatGPT ?</b></summary>

Pour le rapport de tâches, oui, là où l'agent peut ajouter un serveur MCP distant avec un en-tête bearer token ou clé API : voir
[Agents cloud](#agents-cloud-manus-grok-dots-chatgpt). L'usage des tokens et les signaux « Vous » proviennent des logs locaux et des hooks :
ils couvrent donc les agents que vous faites tourner sur vos propres machines.
</details>

<details>
<summary><b>Est-ce que cela ralentit mes agents ou consomme des tokens ?</b></summary>

À peine. Un appel d'outil pèse quelques centaines d'octets et n'a lieu que pour les tâches de plus de 10 minutes environ. Les hooks rendent la main immédiatement et
font leur travail réseau en arrière-plan. Le dashboard lui-même ne consomme aucun token d'IA.
</details>

<details>
<summary><b>Et si un agent oublie de rendre compte, ou plante ?</b></summary>

Chaque client affiche l'ancienneté de son « dernier rapport ». Une tâche sans mise à jour depuis 24 heures est fermée comme inactive et listée dans
`siiswell tasks`. Les hooks de Claude Code signalent « vous attend » et la fin de session sans dépendre de l'agent.
</details>

<details>
<summary><b>Quelle est la précision du coût ?</b></summary>

Il s'agit du prix **équivalent API** : les nombres de tokens des logs locaux multipliés par une table de prix par modèle
(`src/shared/model-prices.json`, modifiable par machine). Avec un abonnement, il indique ce que le même travail
coûterait via l'API, pas ce que vous payez.
</details>

<details>
<summary><b>J'utilise un orchestrateur d'agents. Ses agents seront-ils comptés comme « moi » ?</b></summary>

Non, si vous marquez ses projets. Placez un fichier `.siiswell-agents` à la racine d'un projet (ses agents travaillent dans
`<project>/worktrees/...`) ou lancez les agents avec `SIISWELL_AGENT=1`. Les hooks n'enregistrent alors rien à cet endroit et les outils MCP
d'écriture reçoivent une réponse locale : seules vos propres sessions comptent, et l'intégration hôte de l'orchestrateur signale les
tâches. Voir [Agent workspaces](docs/INSTALL-CLIENTS.md#agent-workspaces-run-by-an-orchestrator) (en anglais).
</details>

<details>
<summary><b>La carte « Vous » est-elle un outil de santé ?</b></summary>

Non. Elle compte des horodatages et des événements avec des seuils fixes, et le dit sur la page. Elle est là pour rendre visible une longue journée,
pas pour la juger. Chaque encouragement peut être désactivé.
</details>

<details>
<summary><b>siiswell convient-il aux équipes ?</b></summary>

Aujourd'hui, siiswell est conçu pour une personne : une installation, un propriétaire (mono-tenant ; les tokens client identifient des applications,
ils ne constituent pas une frontière entre tenants, voir [SECURITY.md](SECURITY.md)). Des fonctionnalités d'équipe (des vues partagées des agents et des coûts LLM,
les données de bien-être de chacun restant privées) figurent sur la roadmap.
</details>

<details>
<summary><b>Que signifie « SI is well, I am well » ?</b></summary>

SI signifie super-intelligence : les agents IA qui travaillent pour vous. « SI is well » veut dire que vos agents tournent sans accroc ; « I
am well » veut dire que vous n'êtes pas surchargé. siiswell veille sur les deux.
</details>

<details>
<summary><b>Combien coûte son fonctionnement ?</b></summary>

Sur Cloudflare, une installation personnelle reste largement dans les limites de l'offre gratuite de D1
([estimation](docs/reference.md#d1-quota-estimate-5-projects)). Avec Docker, c'est un petit conteneur et un fichier SQLite.
</details>

<details>
<summary><b>Comment faire la mise à jour ?</b></summary>

Docker : `git pull && docker compose up -d --build` (les changements de base de données s'appliquent au démarrage). Cloudflare : pull,
appliquer les nouvelles migrations, déployer ([docs/upgrade.md](docs/upgrade.md)). Clients : `siiswell update` installe la version de la CLI
publiée par votre dashboard ; le dashboard affiche une petite note sous tout client en retard.
</details>

## Documentation

| Sujet | Où |
|---|---|
| Déploiement : développement local, checklist Cloudflare, Docker | [docs/deploy.md](docs/deploy.md) |
| Mettre à jour une installation existante | [docs/upgrade.md](docs/upgrade.md) |
| Installer la CLI, les hooks et le collecteur d'usage | [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) |
| Configuration MCP par application, toutes les façons de se connecter | [CLIENTS.md](CLIENTS.md) |
| Protocole et endpoints | [docs/api.md](docs/api.md), [docs/openapi.yaml](docs/openapi.yaml) |
| Ingestion OpenTelemetry | [docs/otel.md](docs/otel.md) |
| Ce que montre la page, règles, cadence, limites, quotas | [docs/reference.md](docs/reference.md) |
| Modèle de sécurité et signalement | [SECURITY.md](SECURITY.md) |

## Développement

```sh
bun install
bun run typecheck
NODE_ENV=test bun test
bun run dev
```

`bun run dev` lance un Worker local sur <http://localhost:8787> ; `bun scripts/demo-seed.ts --help` explique les données de démonstration
utilisées pour les captures d'écran.

Voir [CONTRIBUTING.md](CONTRIBUTING.md). Problèmes de sécurité : [SECURITY.md](SECURITY.md). Changements : [CHANGELOG.md](CHANGELOG.md).

## Licence

| Partie | Licence | Pourquoi |
|---|---|---|
| Le serveur et la page (tout ce qui n'est pas listé ci-dessous) | [AGPL-3.0-only](LICENSE) | Les améliorations d'un siiswell hébergé restent ouvertes |
| Le client : `cli/`, `bridge/` et `src/shared/` (le code intégré à la CLI) | [Apache-2.0](LICENSE-APACHE) | Installez-le sur n'importe quelle machine, y compris des portables d'entreprise, sans question de licence |

Une licence commerciale pour la partie AGPL est disponible sur demande : voir [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)
([license@siiswell.com](mailto:license@siiswell.com)). Pour tout le reste : [hello@siiswell.com](mailto:hello@siiswell.com). Les contributions sont les bienvenues dans le cadre du [Contributor License Agreement](CLA.md) (voir [CONTRIBUTING.md](CONTRIBUTING.md)).
Chaque fichier source du client porte une ligne `SPDX-License-Identifier: Apache-2.0`. Résumé du copyright et des licences : [NOTICE](NOTICE).

<div align="center"><sub>© 2026 <a href="https://siiswell.com">siiswell.com</a> · <a href="https://github.com/jcaol/siiswell">GitHub</a> · <a href="mailto:hello@siiswell.com">Contact</a></sub></div>
