<div align="center">

[English](README.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · **Español** · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [한국어](README.ko.md) · [繁體中文](README.zh-Hant.md)

# siiswell

### SI is well, I am well.

<sub>La SI está bien, yo estoy bien.</sub>

**Una página tranquila para ver qué hacen tus agentes de IA, cuánto cuesta y cómo estás tú.**

<sub><b>SI</b> = superinteligencia: los agentes de IA que trabajan para ti. Cuando ellos están bien y tú estás bien, todo está bien.</sub>

Código abierto · self-hosted · funciona con cualquier cliente MCP · cero llamadas a IA · privacidad por defecto

[Por qué](#por-qué-siiswell) · [Cómo funciona](#cómo-funciona) · [Qué lo hace diferente](#qué-hace-diferente-a-siiswell) · [Funciones](#funciones) · [Clientes](#funciona-con-las-herramientas-que-ya-usas) · [Inicio rápido](#inicio-rápido) · [Prompts](#prompts-para-copiar-y-pegar-en-tus-agentes) · [Privacidad](#privacidad-qué-sale-de-tu-máquina) · [FAQ](#preguntas-frecuentes) · [Documentación](#documentación)

<img src="docs/img/overview.png" alt="El dashboard de siiswell: estado, la franja de resumen (te necesita, trabajando, bloqueado, hecho) y la tarjeta Tú" width="900">

</div>

---

**siiswell** es un **dashboard para agentes de IA de programación** gratuito, de código abierto y self-hosted, para herramientas como Claude Code, Codex y Gemini
CLI. Muestra qué tareas de los agentes están en marcha o esperándote, registra el **uso de tokens de LLM y el coste equivalente en API**, envía
notificaciones tranquilas al móvil y cuida de la persona que está en medio con señales de **bienestar del desarrollador** basadas en reglas,
sin llamar nunca a un modelo de IA ni leer tus prompts ni tu código. Hoy está pensado para una persona; hay funciones para equipos en el roadmap.

## Por qué siiswell

Los agentes de IA para programar ya trabajan solos durante minutos u horas, a menudo varios a la vez, en terminales, apps de escritorio,
servidores y CI. Eso es estupendo para el rendimiento y duro para la persona que está en medio.

| El problema de cada día | Qué hace siiswell al respecto |
|---|---|
| **"¿Sigue trabajando o me está esperando?"** Revisas cinco pestañas de terminal para encontrar el agente que lleva 40 minutos pidiendo permiso. | Cada agente informa de sus tareas largas (iniciada, bloqueada, hecha, ETA). La lista **Te necesita** y un push a tu móvil te avisan en cuanto algo espera. |
| **Agentes en muchos sitios.** Claude Code en el portátil, Codex en un servidor, una app de escritorio, un script nocturno. Ninguna vista única. | Un solo dashboard para cada máquina, app y proyecto, agrupado como `machine / project`. |
| **"¿Cuánto costó este mes?"** Los recuentos de tokens están enterrados en logs locales; los planes de suscripción ocultan el precio equivalente en API. | El colector de uso lee los **números** de tokens de los logs locales y muestra tokens y coste equivalente en API por día, hora, host, app, proyecto y modelo. |
| **Ruido de notificaciones.** O te pierdes el prompt importante, o el móvil vibra toda la tarde. | Los push van por niveles: lo urgente ahora, el resto en un resumen; horas de silencio, un interruptor de Focus y Focus según tu calendario. |
| **Los días largos se te echan encima.** Los agentes nunca se cansan; las personas sí. | Una tarjeta **Tú** amable y basada en reglas: lo ocupado que fue realmente el día, un recordatorio para descansar, un mensaje para desconectar por la tarde. Sin puntuaciones ni rachas. |
| **"¿Puedo confiar mi código a otro dashboard?"** | Nunca ve prompts, código ni contenido de archivos. Nunca llama a un modelo de IA. Lo alojas tú mismo. |

## Cómo funciona

<p align="center"><img src="docs/img/how-it-works.svg" alt="Cómo funciona siiswell: agentes, scripts, orquestadores y el colector de uso informan cruzando una línea de privacidad a tu servidor self-hosted, que evalúa reglas fijas cada minuto y te llega a través del dashboard y Web Push" width="760"></p>

1. **Los agentes informan.** Una regla breve en las instrucciones de cada agente le pide llamar a `report_task` cuando empieza algo
   largo, y a `update_task` cuando está bloqueado o ha terminado. Los hooks de Claude Code y Codex también pueden informar de "esperándote"
   por sí solos.
2. **Se recogen números, no contenido.** El colector de uso convierte los logs locales en totales de tokens por hora y modelo. Los
   hooks solo guardan *que* interactuaste y cuándo.
3. **El servidor decide, de forma determinista.** Reglas fijas (bloqueado, retrasado, un prompt de permiso esperando, host sin conexión, límite
   del plan cerca) abren alertas; la política de push decide qué llega a tu móvil ahora, más tarde o nunca.
4. **Miras una vez.** Una página, en tu escritorio o en tu móvil, con la respuesta arriba.

## Qué hace diferente a siiswell

| | |
|---|---|
| 🧘 **Cuida a la persona, no solo a los agentes** | La mayoría de las herramientas para agentes cuentan tokens. siiswell también se fija en el humano: cuánto tiempo llevas, lo rápido que respondes, si la tarde sigue siendo tuya. Sugiere con suavidad y nunca te puntúa. |
| 🔕 **Menos notificaciones y en mejor momento** | Lo urgente llega a tu móvil al instante; todo lo demás espera a un resumen. Las horas de silencio, Focus y tu calendario deciden el resto, y los agentes saben cuándo no estás para que sigan adelante en lugar de esperar. |
| 🔒 **Una línea de privacidad que puedes leer** | Solo salen de tu máquina recuentos, horas y títulos cortos depurados. El texto se depura dos veces (cliente y servidor) y el servidor aplica su propio límite. Prompts, código y contenido de archivos nunca cruzan. |
| 🧮 **Cero IA, totalmente explicable** | Nunca se llama a ningún modelo, así que no cuesta nada ejecutarlo y cada alerta procede de un umbral que puedes leer en el código. |
| 🔌 **Cualquier agente, en cualquier lugar** | Basta una pequeña regla en las instrucciones del agente. MCP, una CLI, HTTP simple u OpenTelemetry: terminales, apps de escritorio, servidores, CI y orquestadores de agentes acaban en una sola página. |
| 🏠 **Lo alojas tú** | Un Cloudflare Worker o un contenedor Docker, single-tenant por diseño. Tus datos se quedan en tu cuenta. |

## Funciones

<table>
<tr><td width="50%" valign="top">

### Tareas de agentes
- Bandeja **Te necesita**: tareas bloqueadas y prompts de permiso que te esperan, las más antiguas primero
- **Trabajando ahora**: cada tarea abierta con ETA, marca de retraso y hora de inicio
- **Resultados recientes** de las últimas 24 horas
- Agrupadas por máquina, app y proyecto; las tareas abandonadas se cierran solas tras 24 h
- Cinco herramientas MCP, incluidas `list_tasks` y `operator_status` de solo lectura

</td><td width="50%" valign="top">

### Uso y coste
- Mapa de calor de calendario de 12 meses y las 24 horas de cualquier día
- Tokens y **coste equivalente en API** por host, app, proyecto y modelo
- Logs de Claude Code y Codex, además de ingesta OpenTelemetry
- Previsión del límite del plan: "A este ritmo la ventana de 5 h se llena hacia las 16:40"
- Tabla de precios por modelo con tus propios ajustes

</td></tr>
<tr><td valign="top">

### Notificaciones tranquilas
- Web Push al móvil y al escritorio (PWA instalable)
- Elementos **Time-Sensitive** ahora, todo lo demás en un **Scheduled Summary**
- Horas de silencio, fines de semana, **Focus 60 min**, Focus desde tu calendario
- Alertas relacionadas agrupadas en un solo push; una escalera de recordatorios en lugar de repeticiones
- Modo bandeja opcional: los prompts de permiso pendientes llegan juntos cada 15 o 30 minutos

</td><td valign="top">

### Tú, la persona
- **Tranquilo / Ocupado / Sobrecargado**, siempre con los motivos
- Un nivel de carga estimado (0–100) a partir de ocho señales transparentes
- **Highlights**: la semana en frases sencillas, con tu rango habitual en cada indicador
- La línea de tiempo de hoy, tendencias de 7 y 30 días, reflexión semanal; fija las tarjetas que te importan
- Sugerencias amables (descanso, ritmo, horas de silencio), cada una con "Hoy no" y "Nunca"
- Mensajes para desconectar y de buenos días; los agentes saben cuándo no estás

</td></tr>
<tr><td valign="top">

### Privacidad y seguridad
- Sin prompts, código, argumentos de herramientas ni contenido de archivos, nunca
- Nombres de proyecto con hash por defecto; texto depurado en el cliente **y** en el servidor
- Un token por máquina y app, revocable por separado
- Límites en el servidor sobre cuánto texto de tarea se acepta

</td><td valign="top">

### Funciona donde quieras
- **Cloudflare** Worker + D1, o **Docker** con SQLite
- Cloudflare Access, login integrado o tu propio proxy de autenticación
- CLI sin dependencias (Node ≥ 18) que se actualiza sola
- AGPL-3.0, licencia comercial bajo petición

</td></tr>
</table>

## Capturas de pantalla

<p align="center"><img src="docs/img/highlights.png" alt="Highlights: el uso de esta semana, carga de trabajo, tardes y horas activas, cada uno con una frase sencilla y un sparkline" width="880"><br/><b>Highlights</b> — la semana en cuatro frases sencillas; fija las que te importan</p>

| | |
|---|---|
| <img src="docs/img/usage.png" alt="Uso: mapa de calor de calendario y desglose por host, app, proyecto y modelo" width="440"><br/>**Uso y coste** — un año de un vistazo, luego entra en un día | <img src="docs/img/wellbeing.png" alt="La tarjeta Tú: estado, nivel de carga y la línea de tiempo de hoy" width="440"><br/>**Tú** — cómo va el día, con los motivos |
| <img src="docs/img/tasks.png" alt="Te necesita y Trabajando ahora" width="440"><br/>**Tareas** — lo que te espera, lo que está en marcha | <img src="docs/img/overview-dark.png" alt="El dashboard en tema oscuro" width="440"><br/>**Tema oscuro** — sigue a tu dispositivo, o elige uno |
| <img src="docs/img/usage-month.png" alt="Vista mensual de uso: totales, barras diarias apiladas, proyectos y modelos principales" width="440"><br/>**Vista mensual** — totales, proyectos y modelos principales, día de la semana × hora | <img src="docs/img/phone.png" alt="El dashboard en un móvil" width="220"><br/>**En el móvil** — instálalo como app y recibe push |

<sub>Las capturas usan datos de demostración de <code>scripts/demo-seed.ts</code>.</sub>

## Funciona con las herramientas que ya usas

Todo lo que hable MCP puede informar de tareas. Todo lo que pueda ejecutar un comando o enviar HTTP, también.

| Tipo de cliente | Ejemplos | Cómo se conecta | Qué aparece en el dashboard |
|---|---|---|---|
| **Agentes CLI** | Claude Code, Codex, Gemini CLI, Antigravity (agy), opencode, grok, kilo | `siiswell mcp` (stdio) registrado por el script de configuración, o MCP remoto con una cabecera bearer | Tareas; con los hooks de Claude Code / Codex también "esperándote" y tu propio ritmo |
| **Apps de escritorio e IDE** | Claude Desktop, app de escritorio de ChatGPT, extensión de Codex para IDE | servidor MCP stdio (`siiswell mcp`) | Tareas |
| **Cualquier cliente MCP remoto** | cualquiera con Streamable HTTP + cabeceras personalizadas | `POST /mcp` con `Authorization: Bearer <token>` | Tareas |
| **Agentes en la nube** | Manus, Grok (MCP remoto vía API), OpenAI Dots, conectores personalizados de ChatGPT | añade `https://<your-dashboard>/mcp` como servidor MCP personalizado con una cabecera bearer token / API key ([detalles](#agentes-en-la-nube-manus-grok-dots-chatgpt)) | Tareas |
| **Scripts, cron y CI** | trabajos de build, migraciones largas, tareas nocturnas | `siiswell report` / `update` / `heartbeat` | Tareas y heartbeats |
| **HTTP / API directa** | cualquier lenguaje | JSON-RPC a `/mcp`; endpoints de ingesta en [OpenAPI](docs/openapi.yaml) | Tareas, uso, estado del host |
| **Orquestadores de agentes** | tu propio ejecutor de agentes, servidores de automatización | endpoints de integración de host `/api/ingest/{snapshot,events,heartbeat}`; un marcador `.siiswell-agents` mantiene los hooks fuera de sus espacios de trabajo | Hosts, proyectos, agentes, tareas, eventos |
| **Uso de tokens** | logs de Claude Code y Codex | `siiswell usage push` de forma programada | Tokens y coste equivalente en API |
| **OpenTelemetry** | métricas de Claude Code | OTLP/HTTP JSON a `/api/ingest/otlp` (opcional) | Tokens y coste |

Fragmentos y estado por app: [CLIENTS.md](CLIENTS.md) (en inglés). Instalación paso a paso: [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) (en inglés).

## Inicio rápido

### Palabras que vas a ver

| Palabra | Significado |
|---|---|
| **Servidor** | el propio dashboard: un contenedor Docker (o un Cloudflare Worker) que guarda los informes y muestra la página |
| **Cliente** | el pequeño programa `siiswell` en cada ordenador donde se ejecutan tus agentes |
| **MCP** | la forma estándar en que los agentes de IA llaman a herramientas; siiswell da a los agentes una herramienta para "informar de mi tarea" |
| **Token de cliente** | una clave que permite a una app de agente (por ejemplo, Claude Code en tu portátil) informar de tareas |
| **Token de host** | una clave que permite al colector de uso de un ordenador enviar recuentos de tokens; su nombre debe coincidir con la etiqueta de ese ordenador |
| **Hooks** | pequeños comandos que Claude Code / Codex ejecutan ante eventos (un prompt, una solicitud de permiso), usados para "esperándote" |

### ¿Qué opción es para mí?

| | **Docker** (recomendado para la mayoría) | **Cloudflare** (para quien ya usa Workers) |
|---|---|---|
| Se ejecuta en | cualquier máquina con Docker: un servidor doméstico, un VPS, un NAS | tu cuenta de Cloudflare (el plan gratuito suele bastar) |
| Inicio de sesión | integrado: una contraseña de administrador en `.env` | Cloudflare Access (tu login de Google / GitHub / e-mail) |
| Push al móvil | sí, en cuanto tenga una dirección HTTPS | sí |
| Tiempo hasta la primera tarea | unos 10 minutos en una máquina; unos 30 con HTTPS | unos 30 minutos |

### Docker, paso a paso

Necesitas: una máquina con Docker y Docker Compose para el servidor; Node.js 18+ y [Bun](https://bun.sh) en cada ordenador
cuyos agentes quieras conectar. Para usarlo desde otros ordenadores o desde el móvil también necesitas una dirección HTTPS (paso 3).

**1. Descárgalo y define una contraseña** (en la máquina del servidor)

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
cp .env.example .env && chmod 600 .env
```

Para una primera prueba, solo importan dos líneas de `.env`:

```dotenv
# the address you open; your https://… address after step 3
PUBLIC_URL=http://localhost:8787
# 12+ characters; to change it: edit, then docker compose up -d
ADMIN_PASSWORD='a long password you keep'
```

**2. Arráncalo y compruébalo**

```sh
docker compose up -d --build
docker compose ps
curl -s http://localhost:8787/api/health
```

Tras unos segundos, `docker compose ps` muestra **healthy** y la comprobación de estado responde `{"ok":true,…}`. Abre
<http://localhost:8787> e inicia sesión. Si no arranca, `docker compose logs siiswell` enumera cada ajuste
que hay que corregir. En un servidor remoto sin navegador, abre primero un túnel desde tu portátil:
`ssh -L 8787:127.0.0.1:8787 you@your-server`, y luego abre <http://localhost:8787> en el portátil.

**3. Dale una dirección HTTPS** (necesaria para otros ordenadores y para el móvil)

El contenedor solo escucha en `127.0.0.1:8787`. Pon delante un reverse proxy con HTTPS, por ejemplo
[Caddy](https://caddyserver.com/), que obtiene el certificado por sí solo:

```text
# /etc/caddy/Caddyfile  (point the DNS name at this machine first)
dash.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Después, en `.env`:

```dotenv
PUBLIC_URL=https://dash.example.com
# the proxy reaches the container from this address
TRUSTED_PROXY_CIDRS=172.28.0.1/32
```

y `docker compose up -d`. ¿No tienes dominio? También sirve un nombre HTTPS privado de una VPN como Tailscale. Más opciones:
[docs/deploy.md](docs/deploy.md#deploy-with-docker) (en inglés).

**4. Push al móvil** (opcional)

```sh
docker compose exec siiswell bun scripts/vapid.ts mailto:you@example.com
```

Pega en `.env` las tres líneas `VAPID_…=` que imprime y luego ejecuta `docker compose up -d`. En un iPhone, abre el dashboard en
Safari, elige Compartir → **Añadir a pantalla de inicio**, ábrelo desde ahí y pulsa **Enable notifications**.

**5. Crea los tokens** (en el servidor; cada token se imprime una sola vez, así que deja la ventana abierta para el paso 6)

```sh
docker compose exec siiswell bun scripts/new-token.ts laptop-1-claude client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1-codex client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1 host --apply
```

Un token de cliente por cada app de agente que uses (aquí Claude Code y Codex) y un token de host por ordenador. El nombre del token de host
(`laptop-1`) es la etiqueta de máquina que escribirás en el paso 6.

**6. Conecta un ordenador** (en cada portátil o equipo de sobremesa)

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```

Te pide la URL del dashboard (`https://dash.example.com`), una etiqueta de máquina (`laptop-1`), qué apps conectar y
un token por app (la entrada queda oculta). Instala el comando `siiswell` en `~/.local/bin`, añade la regla de informe a
tus agentes y puede añadir los hooks y el colector de uso por horas. Al final deberías ver `doctor claude-code: ok`.

Pruébalo (abre antes un terminal nuevo si no se encuentra `siiswell`). La tarea aparece en **Trabajando ahora**, `siiswell tasks`
la muestra y la última línea la cierra:

```sh
ID=$(siiswell report "Try the dashboard" --kind testing --eta-min 5 | tail -1)
siiswell tasks
siiswell update "$ID" --status DONE
```

O pide a un agente que ejecute la comprobación de conexión ([prompt 3](#prompts-para-copiar-y-pegar-en-tus-agentes)).

### Mantenerlo en marcha

| Tarea | Comando |
|---|---|
| Actualizar el servidor | `git pull && docker compose up -d --build` (los cambios de base de datos se aplican solos) |
| Actualizar el cliente de un ordenador | `siiswell update` (sin task id instala la versión que publica tu dashboard) |
| Detener / iniciar | `docker compose down` / `docker compose up -d` (tus datos se conservan) |
| Copia de seguridad | `docker compose stop`, copia `/data/siiswell.sqlite` fuera del volumen `siiswell-data` (`docker volume ls` muestra su nombre completo), `docker compose start`. Guarda las copias con la misma privacidad que `.env`: contienen el hash de la contraseña |

⚠️ `docker compose down -v` elimina el volumen, que contiene todos tus datos.

<details>
<summary><b>Cloudflare (Worker + D1)</b></summary>

```sh
bun install
bunx wrangler d1 create siiswell
```

Pon el `database_id` que aparece en `wrangler.toml` y después:

```sh
bunx wrangler d1 migrations apply siiswell --remote
bun run deploy
bun scripts/new-token.ts laptop-1-claude client
```

El último comando muestra un token y una línea `wrangler d1 execute`: ejecuta esa línea para registrar el token.

Protege la página con Cloudflare Access: hasta que esté configurado, el dashboard no muestra datos a nadie. La lista de comprobación completa,
con cada paso que afecta al exterior marcado, está en [docs/deploy.md](docs/deploy.md). Luego conecta tus ordenadores como en el paso 6.
</details>

## Prompts para copiar y pegar en tus agentes

Los agentes son quienes informan, así que hay que decírselo. Estos prompts se pueden pegar con seguridad en cualquier agente: ninguno pide
ni contiene un token. **Nunca pegues un token en un chat**: los tokens van en el archivo de configuración o en los ajustes del conector.

Los agentes entienden los prompts en inglés; también puedes escribirlos en tu propio idioma.

<details open>
<summary><b>1. La regla de informe</b> (ponla en las instrucciones globales de cada agente; <code>setup-client.sh</code> lo hace por ti)</summary>

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
<summary><b>2. "Actualiza siiswell en esta máquina"</b></summary>

```text
Update the siiswell client on this machine: run `siiswell update --yes`, then `siiswell doctor`.
Tell me the installed version and any line of the doctor output that is not [ok] or [--].
Do not print, read or change any token or config file.
```
</details>

<details>
<summary><b>3. "Comprueba que siiswell funciona"</b></summary>

```text
Check the siiswell connection: call the siiswell `report_task` tool with title "Connection check",
kind "testing", status IN_PROGRESS and eta_min 1, then call `update_task` with status DONE for the
task_id you got. Tell me whether both calls succeeded.
```
</details>

<details>
<summary><b>4. Configurar una máquina nueva</b> (este lo ejecutas tú: pide los tokens con entrada oculta; necesita Node.js 18+ y Bun)</summary>

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```
</details>

### Agentes en la nube (Manus, Grok, Dots, ChatGPT)

Los agentes que se ejecutan en la nube de un proveedor no pueden iniciar un proceso local de `siiswell`, pero la mayoría pueden llamar a un **servidor
MCP remoto por HTTPS**, que es lo que es `https://<your-dashboard>/mcp`.

| Agente | Qué necesita de siiswell | Estado |
|---|---|---|
| **Manus** | servidor MCP personalizado: URL + `Authorization: Bearer <token>` (Settings → Integrations → Custom MCP) | debería funcionar; aún no lo hemos probado |
| **Grok** | Grok Build CLI: `siiswell mcp` o la URL remota ([CLIENTS.md](CLIENTS.md#6-grok)); Grok API: herramienta MCP remota con una cabecera bearer | CLI documentada; API aún sin probar |
| **OpenAI Dots** | un servidor MCP remoto accesible por HTTPS | el proveedor aún no ha documentado el soporte de MCP; pruébalo cuando lo haga |
| **Conectores personalizados de ChatGPT** | un servidor MCP remoto; las opciones de plan y autenticación dependen del proveedor | funciona solo donde se puede definir un bearer token / API key; las configuraciones solo con OAuth aún no son compatibles |

1. Crea un token de cliente separado para cada agente en la nube (`new-token.ts <name> client`), para poder revocarlo por separado.
2. En los ajustes del conector del agente, introduce la URL y la cabecera `Authorization: Bearer <token>`.
3. Añade la regla de informe (prompt 1) a las instrucciones personalizadas del agente.

Conviene saber: el dashboard debe ser accesible desde internet por HTTPS (detrás de Cloudflare Access, `/mcp` ya
queda exento para las peticiones con token). Un agente en la nube no ejecuta el cliente local, así que sus títulos los limita y
depura solo el **servidor** (`ACCEPT_TASK_TEXT`); los hooks de Claude Code y el colector de uso no se aplican ahí.

## Privacidad: qué sale de tu máquina

siiswell registra **que** tú y tus agentes hicisteis algo, nunca **qué**.

| Se envía a tu servidor | Nunca se envía ni se guarda |
|---|---|
| Estado de la tarea, ETA y un `kind` fijo (coding, docs, …) | Prompts, respuestas, conversaciones |
| Un título corto de la tarea, depurado y recortado a 60 caracteres (por defecto `brief`; `minimal` o `none` envían menos) | Código, diffs, contenido de archivos, salida de herramientas |
| Recuentos de tokens por hora, modelo y app | Argumentos de herramientas, texto de comandos |
| Hora y tipo de tus propias interacciones (un prompt, un permiso concedido) | Directorios de trabajo y rutas locales |
| Etiquetas de proyecto: un hash con sal salvo que indiques un nombre para mostrar | Nombres reales de proyectos (salvo que lo actives) |

- El texto se depura de secretos (tokens, claves, contraseñas, URL) **en el cliente y de nuevo en el servidor**, y el servidor
  aplica su propio límite (`ACCEPT_TASK_TEXT`, `ACCEPT_HOST_TEXT`), así que un cliente no puede enviar más de lo que permites.
- Cada máquina y app tiene su propio token; uno perdido se revoca por separado.
- `siiswell permissions suggest` es el único comando que lee transcripciones locales. No envía nada y solo imprime
  claves de la allowlist.
- Self-hosted: los datos se quedan en tu cuenta de Cloudflare o en tu contenedor, con una retención de 30 días por defecto.

Detalles: [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) y [SECURITY.md](SECURITY.md) (en inglés).

## Cero IA

siiswell nunca llama a un modelo de IA y nunca gasta tu plan ni tus tokens. El dashboard, la CLI, los hooks, el servidor MCP y el
colector solo leen contadores locales y envían pequeños informes. Cada regla es un umbral fijo que puedes leer en el código,
así que cada alerta y cada número de la página se puede explicar.

## Preguntas frecuentes

<details>
<summary><b>¿Mis agentes necesitan algún soporte especial?</b></summary>

No. Cualquier agente que pueda usar herramientas MCP puede informar de tareas: añade el servidor y la breve regla de instrucciones
([CLIENTS.md](CLIENTS.md#the-instruction-rule-put-this-in-each-agents-global-instructions)). Sin MCP, usa la
CLI `siiswell` o una simple llamada HTTP.
</details>

<details>
<summary><b>¿Funciona con agentes en la nube como Manus, Grok, Dots o ChatGPT?</b></summary>

Para informar de tareas, sí, siempre que el agente pueda añadir un servidor MCP remoto con una cabecera de bearer token o API key: consulta
[Agentes en la nube](#agentes-en-la-nube-manus-grok-dots-chatgpt). El uso de tokens y las señales de "Tú" proceden de logs locales y hooks,
así que cubren los agentes que ejecutas en tus propias máquinas.
</details>

<details>
<summary><b>¿Ralentiza mis agentes o cuesta tokens?</b></summary>

Apenas. Una llamada a herramienta ocupa unos cientos de bytes y solo se hace para tareas de más de unos 10 minutos. Los hooks responden al instante y
hacen su trabajo de red en segundo plano. El dashboard en sí no gasta tokens de IA.
</details>

<details>
<summary><b>¿Y si un agente se olvida de informar o se cuelga?</b></summary>

Cada cliente muestra la antigüedad de su "último informe". Una tarea sin actualización durante 24 horas se cierra como abandonada y aparece en
`siiswell tasks`. Los hooks de Claude Code informan de "esperándote" y del fin de sesión sin depender del agente.
</details>

<details>
<summary><b>¿Qué precisión tiene el coste?</b></summary>

Es el precio **equivalente en API**: recuentos de tokens de los logs locales multiplicados por una tabla de precios por modelo
(`src/shared/model-prices.json`, ajustable por máquina). Con un plan de suscripción muestra lo que costaría el mismo trabajo
en la API, no lo que pagas.
</details>

<details>
<summary><b>Uso un orquestador de agentes. ¿Sus agentes contarán como "yo"?</b></summary>

No, si marcas sus proyectos. Pon un archivo `.siiswell-agents` en la raíz del proyecto (sus agentes trabajan en
`<project>/worktrees/...`) o inicia los agentes con `SIISWELL_AGENT=1`. Así los hooks no registran nada ahí y las herramientas MCP
de escritura se responden localmente, de modo que solo cuentan tus propias sesiones y la integración de host del orquestador informa de las
tareas. Consulta [Agent workspaces](docs/INSTALL-CLIENTS.md#agent-workspaces-run-by-an-orchestrator).
</details>

<details>
<summary><b>¿Es la tarjeta "Tú" una herramienta de salud?</b></summary>

No. Cuenta marcas de tiempo y eventos con umbrales fijos, y así lo indica en la página. Está ahí para hacer visible un día largo,
no para juzgarlo. Cada sugerencia se puede desactivar.
</details>

<details>
<summary><b>¿Es siiswell para equipos?</b></summary>

Hoy siiswell está pensado para una persona: una instalación, un propietario (single-tenant; los tokens de cliente identifican apps,
no son una frontera entre tenants, consulta [SECURITY.md](SECURITY.md)). Las funciones para equipos (vistas compartidas de agentes y costes de LLM,
con los datos de bienestar de cada persona privados para ella) están en el roadmap.
</details>

<details>
<summary><b>¿Qué significa "La SI está bien, yo estoy bien"?</b></summary>

SI significa superinteligencia: los agentes de IA que trabajan para ti. "La SI está bien" significa que tus agentes funcionan sin problemas; "yo
estoy bien" significa que no estás sobrecargado. siiswell vigila ambas cosas.
</details>

<details>
<summary><b>¿Cuánto cuesta ejecutarlo?</b></summary>

En Cloudflare, una instalación personal se queda holgadamente dentro de los límites del plan gratuito de D1
([estimación](docs/reference.md#d1-quota-estimate-5-projects)). Con Docker, es un contenedor pequeño y un archivo SQLite.
</details>

<details>
<summary><b>¿Cómo actualizo?</b></summary>

Docker: `git pull && docker compose up -d --build` (los cambios de base de datos se aplican al arrancar). Cloudflare: haz pull, aplica
las nuevas migraciones y despliega ([docs/upgrade.md](docs/upgrade.md)). Clientes: `siiswell update` instala la versión de la CLI que
publica tu dashboard; el dashboard muestra una pequeña nota bajo cualquier cliente que esté desactualizado.
</details>

## Documentación

| Tema | Dónde |
|---|---|
| Despliegue: desarrollo local, lista de comprobación de Cloudflare, Docker | [docs/deploy.md](docs/deploy.md) |
| Actualizar una instalación existente | [docs/upgrade.md](docs/upgrade.md) |
| Instalar la CLI, los hooks y el colector de uso | [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) |
| Configuración MCP por app, todas las formas de conectarse | [CLIENTS.md](CLIENTS.md) |
| Protocolo y endpoints | [docs/api.md](docs/api.md), [docs/openapi.yaml](docs/openapi.yaml) |
| Ingesta OpenTelemetry | [docs/otel.md](docs/otel.md) |
| Qué muestra la página, reglas, frecuencia, límites, cuota | [docs/reference.md](docs/reference.md) |
| Modelo de seguridad y notificación de problemas | [SECURITY.md](SECURITY.md) |

## Desarrollo

```sh
bun install
bun run typecheck
NODE_ENV=test bun test
bun run dev
```

`bun run dev` arranca un Worker local en <http://localhost:8787>; `bun scripts/demo-seed.ts --help` explica los datos de demostración
usados para las capturas de pantalla.

Consulta [CONTRIBUTING.md](CONTRIBUTING.md). Problemas de seguridad: [SECURITY.md](SECURITY.md). Cambios: [CHANGELOG.md](CHANGELOG.md).

## Licencia

| Parte | Licencia | Por qué |
|---|---|---|
| El servidor y la página (todo lo que no aparece abajo) | [AGPL-3.0-only](LICENSE) | Las mejoras a un siiswell alojado siguen siendo abiertas |
| El cliente: `cli/`, `bridge/` y `src/shared/` (el código incluido en la CLI) | [Apache-2.0](LICENSE-APACHE) | Instálalo en cualquier máquina, incluidos portátiles de empresa, sin dudas de licencia |

Hay una licencia comercial para la parte AGPL disponible bajo petición: consulta [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)
([license@siiswell.com](mailto:license@siiswell.com)). Para todo lo demás: [hello@siiswell.com](mailto:hello@siiswell.com). Las contribuciones son bienvenidas bajo el [Contributor License Agreement](CLA.md) (consulta [CONTRIBUTING.md](CONTRIBUTING.md)).
Cada archivo fuente del cliente lleva una línea `SPDX-License-Identifier: Apache-2.0`. Resumen de copyright y licencia: [NOTICE](NOTICE).

<div align="center"><sub>© 2026 <a href="https://siiswell.com">siiswell.com</a> · <a href="https://github.com/jcaol/siiswell">GitHub</a> · <a href="mailto:hello@siiswell.com">Contacto</a></sub></div>
