<div align="center">

[English](README.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [한국어](README.ko.md) · **繁體中文**

# siiswell

### SI is well, I am well.

（SI 安好，我也安好。）

**一個平靜的頁面，看清你的 AI 代理正在做什麼、花了多少錢，以及你自己的狀態。**

<sub><b>SI</b> = 超級智慧（super intelligence）：為你工作的 AI 代理。它們安好、你也安好，一切就都安好。</sub>

開源 · 自行託管 · 支援任何 MCP 用戶端 · 零 AI 呼叫 · 預設保護隱私

[為什麼](#為什麼選擇-siiswell) · [運作方式](#運作方式) · [有何不同](#siiswell-有何不同) · [功能](#功能) · [用戶端](#支援你已在使用的工具) · [快速開始](#快速開始) · [提示詞](#給代理複製貼上的提示詞) · [隱私](#隱私哪些資料會離開你的電腦) · [常見問題](#常見問題) · [文件](#文件)

<img src="docs/img/overview.png" alt="siiswell dashboard：健康狀態、摘要列（需要你、進行中、受阻、已完成）以及「你」卡片" width="900">

</div>

---

**siiswell** 是一個免費、開源、自行託管的 **AI coding 代理 dashboard**，適用於 Claude Code、Codex 和 Gemini
CLI 等工具。它會顯示哪些代理任務正在執行或正在等你，追蹤 **LLM token 用量與等同 API 的成本**，送出
平靜的手機通知，並以基於規則的 **開發者身心健康（developer well-being）** 訊號照顧居中的那個人——
而且從不呼叫 AI 模型，也從不讀取你的提示詞和程式碼。目前為個人使用而設計；團隊功能已在規劃中。

## 為什麼選擇 siiswell

AI coding 代理如今能自行運作數分鐘甚至數小時，而且常常同時有好幾個，分布在終端機、桌面 app、
伺服器和 CI 上。這對產出很有幫助，對夾在中間的人卻很吃力。

| 日常的困擾 | siiswell 的做法 |
|---|---|
| **「它還在跑，還是在等我？」** 你得翻遍五個終端機分頁，才找到那個已經等你授權 40 分鐘的代理。 | 每個代理都會回報自己的長時間任務（開始、受阻、完成、ETA）。**需要你** 清單和手機 push 會在有事等你的那一刻通知你。 |
| **代理散落各處。** 筆電上的 Claude Code、伺服器上的 Codex、一個桌面 app、一支夜間 script，沒有統一的檢視畫面。 | 一個 dashboard 涵蓋所有機器、app 和專案，以 `machine / project` 分組。 |
| **「這個月花了多少？」** token 數量埋在本機 log 裡；訂閱方案則看不出等值的 API 價格。 | 用量收集器從本機 log 讀取 token **數字**，依日、小時、主機、app、專案和模型顯示 token 與 API 等值成本。 |
| **通知太吵。** 不是錯過重要的提示，就是手機整晚響個不停。 | push 分級：緊急項目立即送出，其餘彙整成摘要；另有勿擾時段、Focus 開關，以及依行事曆自動進入 Focus。 |
| **長時間工作不知不覺累積。** 代理不會累，人會。 | 溫和、以規則為基礎的 **你** 卡片：今天實際有多忙、提醒你休息一下、晚上送出收尾訊息。沒有分數，沒有連續紀錄。 |
| **「我能把程式碼交給另一個 dashboard 嗎？」** | 它從不讀取提示詞、程式碼或檔案內容，從不呼叫 AI 模型，而且由你自行託管。 |

## 運作方式

<p align="center"><img src="docs/img/how-it-works.svg" alt="siiswell 的運作方式：代理、script、orchestrator 和用量收集器跨過隱私界線，向你自行託管的伺服器回報；伺服器每分鐘依固定規則評估，再透過 dashboard 和 Web Push 通知你" width="760"></p>

1. **代理回報。** 在每個代理的指示中加入一條簡短規則，要求它在開始長時間工作時呼叫 `report_task`，
   在受阻或完成時呼叫 `update_task`。Claude Code 和 Codex 的 hooks 也能自行回報「正在等你」。
2. **只收集數字，不收集內容。** 用量收集器把本機 log 轉成每個模型每小時的 token 總數。
   hooks 只記錄你*有*互動以及互動的時間。
3. **伺服器以確定性方式判斷。** 固定規則（受阻、逾時、有授權提示在等待、主機離線、方案額度將滿）
   會開啟警示；push 策略決定哪些現在送到你的手機、哪些稍後再送、哪些不送。
4. **你只需看一眼。** 一個頁面，桌機或手機都能看，答案就在最上方。

## siiswell 有何不同

| | |
|---|---|
| 🧘 **照顧的是人，不只是代理** | 多數代理工具只計算 token。siiswell 也會留意人：你已經工作多久、回覆有多快、晚上是否還屬於你自己。它只溫和提醒，從不替你打分數。 |
| 🔕 **更少、時機更好的通知** | 緊急項目立即送到手機；其他一律等待摘要。其餘由勿擾時段、Focus 和你的行事曆決定；當你不在時，代理也會被告知，讓它們繼續工作而不是乾等。 |
| 🔒 **看得懂的隱私界線** | 只有計數、時間和經過清理的簡短標題會離開你的電腦。文字會清理兩次（用戶端和伺服器），伺服器也有自己的上限。提示詞、程式碼和檔案內容絕不越界。 |
| 🧮 **零 AI，完全可解釋** | 從不呼叫任何模型，因此執行不花錢，每一則警示都來自你能在程式碼中讀到的門檻值。 |
| 🔌 **任何代理，任何地方** | 在代理的指示中加一條簡短規則就夠了。MCP、CLI、純 HTTP 或 OpenTelemetry：終端機、桌面 app、伺服器、CI 和代理 orchestrator 全都集中在同一頁。 |
| 🏠 **由你自行託管** | 一個 Cloudflare Worker 或一個 Docker container，設計上即為 single-tenant。你的資料留在你自己的帳號中。 |

## 功能

<table>
<tr><td width="50%" valign="top">

### 代理任務
- **需要你** 收件匣：等你處理的受阻任務和授權提示，最舊的在前
- **進行中**：每個未完成任務的 ETA、逾時標記和開始時間
- 過去 24 小時的 **近期結果**
- 依機器、app 和專案分組；過時任務會在 24 小時後自動關閉
- 五個 MCP 工具，包括唯讀的 `list_tasks` 和 `operator_status`

</td><td width="50%" valign="top">

### 用量與成本
- 12 個月的日曆熱圖，以及任一天的 24 小時明細
- 依主機、app、專案和模型顯示 token 與 **API 等值成本**
- Claude Code 和 Codex log，另支援 OpenTelemetry 匯入
- 方案額度預測：「照這個速度，5 h 視窗約在 16:40 用滿」
- 各模型價格表，可自訂覆寫

</td></tr>
<tr><td valign="top">

### 平靜的通知
- Web Push 送到手機和桌機（可安裝的 PWA）
- **Time-Sensitive** 項目立即送出，其餘彙整成 **Scheduled Summary**
- 勿擾時段、週末、**Focus 60 分鐘**、依行事曆進入 Focus
- 相關警示合併成一則 push；以逐步提醒取代重複通知
- 可選的收件匣模式：待處理的授權提示每 15 或 30 分鐘一次集中送達

</td><td valign="top">

### 你，這個人
- **平靜 / 忙碌 / 過載**，一律附上原因
- 由八個透明訊號估算出的工作負荷等級（0–100）
- **重點摘要**：用簡單的句子描述這一週，每個指標都標出你平常的範圍
- 今天的時間軸、7 天與 30 天趨勢、每週回顧；可釘選你在意的卡片
- 溫和提醒（休息、節奏、勿擾時段），每一則都有「今天不要」和「永不」
- 收尾與早安訊息；代理會得知你不在

</td></tr>
<tr><td valign="top">

### 隱私與安全
- 永遠不收提示詞、程式碼、工具參數或檔案內容
- 專案名稱預設以 hash 處理；文字在用戶端 **和** 伺服器都會清理
- 每台機器、每個 app 各一個 token，可單獨撤銷
- 伺服器端限制可接受的任務文字長度

</td><td valign="top">

### 想在哪裡跑都行
- **Cloudflare** Worker + D1，或 **Docker** 搭配 SQLite
- Cloudflare Access、內建登入，或你自己的驗證 proxy
- 零相依的 CLI（Node ≥ 18），可自行更新
- AGPL-3.0，可應要求提供商業授權

</td></tr>
</table>

## 截圖

<p align="center"><img src="docs/img/highlights.png" alt="重點摘要：本週的用量、工作負荷、晚間與活躍時段，各附一句簡單說明和 sparkline" width="880"><br/><b>重點摘要</b> — 用四句簡單的話描述這一週；釘選你在意的項目</p>

| | |
|---|---|
| <img src="docs/img/usage.png" alt="用量：日曆熱圖，以及依主機、app、專案和模型的明細" width="440"><br/>**用量與成本** — 一眼看完一整年，再深入任一天 | <img src="docs/img/wellbeing.png" alt="「你」卡片：狀態、工作負荷等級和今天的時間軸" width="440"><br/>**你** — 今天過得如何，並附上原因 |
| <img src="docs/img/tasks.png" alt="需要你與進行中" width="440"><br/>**任務** — 什麼在等你、什麼正在執行 | <img src="docs/img/overview-dark.png" alt="深色主題的 dashboard" width="440"><br/>**深色主題** — 跟隨裝置設定，或自行選擇 |
| <img src="docs/img/usage-month.png" alt="用量月檢視：總計、每日堆疊長條圖、主要專案和模型" width="440"><br/>**月檢視** — 總計、主要專案和模型、星期 × 小時 | <img src="docs/img/phone.png" alt="手機上的 dashboard" width="220"><br/>**在手機上** — 安裝成 app 並接收 push |

<sub>截圖使用來自 <code>scripts/demo-seed.ts</code> 的示範資料。</sub>

## 支援你已在使用的工具

任何支援 MCP 的工具都能回報任務。任何能執行指令或發送 HTTP 的東西也可以。

| 用戶端類型 | 例子 | 連接方式 | dashboard 上顯示的內容 |
|---|---|---|---|
| **CLI 代理** | Claude Code, Codex, Gemini CLI, Antigravity (agy), opencode, grok, kilo | 由設定 script 註冊的 `siiswell mcp`（stdio），或使用 bearer header 的遠端 MCP | 任務；搭配 Claude Code / Codex hooks 時，另有「正在等你」和你自己的節奏 |
| **桌面 app 和 IDE** | Claude Desktop, ChatGPT desktop app, Codex IDE extension | stdio MCP server（`siiswell mcp`） | 任務 |
| **任何遠端 MCP 用戶端** | 任何支援 Streamable HTTP + 自訂 header 的工具 | `POST /mcp` 搭配 `Authorization: Bearer <token>` | 任務 |
| **雲端代理** | Manus, Grok (API remote MCP), OpenAI Dots, ChatGPT custom connectors | 將 `https://<your-dashboard>/mcp` 加為自訂 MCP server，並設定 bearer token / API key header（[詳情](#雲端代理-manus-grok-dots-chatgpt)） | 任務 |
| **Script、cron 和 CI** | build job、長時間 migration、夜間工作 | `siiswell report` / `update` / `heartbeat` | 任務和 heartbeat |
| **原生 HTTP / API** | 任何程式語言 | 對 `/mcp` 發送 JSON-RPC；匯入端點見 [OpenAPI](docs/openapi.yaml) | 任務、用量、主機狀態 |
| **代理 orchestrator** | 你自己的代理執行器、自動化伺服器 | 主機整合端點 `/api/ingest/{snapshot,events,heartbeat}`；`.siiswell-agents` 標記檔讓 hooks 不進入其 workspace | 主機、專案、代理、任務、事件 |
| **Token 用量** | Claude Code 和 Codex log | 排程執行 `siiswell usage push` | token 和 API 等值成本 |
| **OpenTelemetry** | Claude Code metrics | 以 OTLP/HTTP JSON 送到 `/api/ingest/otlp`（需自行啟用） | token 和成本 |

各 app 的設定片段與支援狀態：[CLIENTS.md](CLIENTS.md)（英文）。逐步安裝說明：[docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md)（英文）。

## 快速開始

### 你會看到的用語

| 用語 | 意思 |
|---|---|
| **伺服器（Server）** | dashboard 本身：一個 Docker container（或一個 Cloudflare Worker），負責儲存回報並顯示頁面 |
| **用戶端（Client）** | 安裝在每台執行代理的電腦上的小程式 `siiswell` |
| **MCP** | AI 代理呼叫工具的標準方式；siiswell 為代理提供一個「回報我的任務」的工具 |
| **Client token** | 讓某一個代理 app（例如你筆電上的 Claude Code）回報任務的金鑰 |
| **Host token** | 讓某一台電腦的用量收集器傳送 token 數量的金鑰；它的名稱必須與該電腦的標籤相同 |
| **Hooks** | Claude Code / Codex 在事件發生時（一則提示、一次授權請求）執行的小指令，用於「正在等你」 |

### 哪種方式適合我？

| | **Docker**（推薦大多數人使用） | **Cloudflare**（適合已在使用 Workers 的人） |
|---|---|---|
| 執行環境 | 任何有 Docker 的機器：家用伺服器、VPS、NAS | 你的 Cloudflare 帳號（免費方案通常就夠用） |
| 登入 | 內建：在 `.env` 設定一組管理員密碼 | Cloudflare Access（你的 Google / GitHub / e-mail 登入） |
| 手機 push | 可以，只要它有 HTTPS 網址 | 可以 |
| 到第一個任務所需時間 | 單台機器約 10 分鐘；加上 HTTPS 約 30 分鐘 | 約 30 分鐘 |

### Docker 逐步說明

你需要：一台有 Docker 和 Docker Compose 的機器作為伺服器；在每台要連接代理的電腦上安裝 Node.js 18+ 和
[Bun](https://bun.sh)。若要從其他電腦或手機使用，還需要一個 HTTPS 網址（第 3 步）。

**1. 取得程式並設定密碼**（在伺服器機器上）

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
cp .env.example .env && chmod 600 .env
```

初次試用時，`.env` 中只有兩行需要設定：

```dotenv
# the address you open; your https://… address after step 3
PUBLIC_URL=http://localhost:8787
# 12+ characters; to change it: edit, then docker compose up -d
ADMIN_PASSWORD='a long password you keep'
```

**2. 啟動並檢查**

```sh
docker compose up -d --build
docker compose ps
curl -s http://localhost:8787/api/health
```

幾秒後，`docker compose ps` 會顯示 **healthy**，health check 也會回應 `{"ok":true,…}`。
開啟 <http://localhost:8787> 並登入。若無法啟動，`docker compose logs siiswell` 會列出每一項需要修正的設定。
若是在沒有瀏覽器的遠端伺服器上，請先從你的筆電開一條 tunnel：
`ssh -L 8787:127.0.0.1:8787 you@your-server`，再在筆電上開啟 <http://localhost:8787>。

**3. 為它設定 HTTPS 網址**（其他電腦和手機需要）

container 只監聽 `127.0.0.1:8787`。請在前面放一個支援 HTTPS 的 reverse proxy，例如
[Caddy](https://caddyserver.com/)，它會自行取得憑證：

```text
# /etc/caddy/Caddyfile  (point the DNS name at this machine first)
dash.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

接著在 `.env` 中設定：

```dotenv
PUBLIC_URL=https://dash.example.com
# the proxy reaches the container from this address
TRUSTED_PROXY_CIDRS=172.28.0.1/32
```

然後執行 `docker compose up -d`。沒有網域？Tailscale 這類 VPN 提供的私有 HTTPS 名稱也可以。更多選項：
[docs/deploy.md](docs/deploy.md#deploy-with-docker)（英文）。

**4. 手機 push**（選用）

```sh
docker compose exec siiswell bun scripts/vapid.ts mailto:you@example.com
```

把它印出的三行 `VAPID_…=` 貼到 `.env`，再執行 `docker compose up -d`。在 iPhone 上，用 Safari 開啟 dashboard，
選擇「分享」→ **加入主畫面**，從主畫面開啟後，點選 **Enable notifications**。

**5. 建立 token**（在伺服器上；每個 token 只會顯示一次，請保留視窗以供第 6 步使用）

```sh
docker compose exec siiswell bun scripts/new-token.ts laptop-1-claude client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1-codex client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1 host --apply
```

每個你使用的代理 app 各一個 client token（這裡是 Claude Code 和 Codex），每台電腦一個 host token。
host token 的名稱（`laptop-1`）就是你在第 6 步要輸入的機器標籤。

**6. 連接電腦**（在每台筆電或桌機上）

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```

它會詢問 dashboard 網址（`https://dash.example.com`）、機器標籤（`laptop-1`）、要連接哪些 app，以及每個 app
各一個 token（輸入內容會隱藏）。它會把 `siiswell` 指令安裝到 `~/.local/bin`、為你的代理加入回報規則，
也可以加入 hooks 和每小時執行的用量收集器。最後你應該會看到 `doctor claude-code: ok`。

試試看（若找不到 `siiswell`，請先開一個新的終端機）。任務會出現在**進行中**，`siiswell tasks` 會列出它，
最後一行則會把它關閉：

```sh
ID=$(siiswell report "Try the dashboard" --kind testing --eta-min 5 | tail -1)
siiswell tasks
siiswell update "$ID" --status DONE
```

或者請代理執行連線檢查（[提示詞 3](#給代理複製貼上的提示詞)）。

### 日常維護

| 工作 | 指令 |
|---|---|
| 更新伺服器 | `git pull && docker compose up -d --build`（資料庫變更會自動套用） |
| 更新電腦上的用戶端 | `siiswell update`（不帶 task id 時，會安裝你的 dashboard 所發布的版本） |
| 停止 / 啟動 | `docker compose down` / `docker compose up -d`（資料會保留） |
| 備份 | `docker compose stop`，從 `siiswell-data` volume 複製出 `/data/siiswell.sqlite`（`docker volume ls` 會顯示完整名稱），再 `docker compose start`。請像保管 `.env` 一樣妥善保管備份：其中含有密碼的 hash |

⚠️ `docker compose down -v` 會刪除 volume，也就是你所有的資料。

<details>
<summary><b>Cloudflare（Worker + D1）</b></summary>

```sh
bun install
bunx wrangler d1 create siiswell
```

把印出的 `database_id` 填入 `wrangler.toml`，然後：

```sh
bunx wrangler d1 migrations apply siiswell --remote
bun run deploy
bun scripts/new-token.ts laptop-1-claude client
```

最後一個指令會印出一個 token 和一行 `wrangler d1 execute`：執行那一行即可登記這個 token。

請用 Cloudflare Access 保護這個頁面：在設定完成之前，dashboard 不會向任何人顯示資料。完整的檢查清單
（每個對外的步驟都有標示）在 [docs/deploy.md](docs/deploy.md)。接著依第 6 步連接你的電腦。
</details>

## 給代理複製貼上的提示詞

回報工作由代理負責，所以需要告訴它們。這些提示詞可以安心貼到任何代理中：沒有任何一則會索取或包含 token。
**絕對不要把 token 貼進對話**：token 應放在設定檔或 connector 設定中。

代理能理解以下的英文提示詞；你也可以改用自己的語言撰寫。

<details open>
<summary><b>1. 回報規則</b>（放進每個代理的全域指示；<code>setup-client.sh</code> 會替你完成）</summary>

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
<summary><b>2.「在這台機器上更新 siiswell」</b></summary>

```text
Update the siiswell client on this machine: run `siiswell update --yes`, then `siiswell doctor`.
Tell me the installed version and any line of the doctor output that is not [ok] or [--].
Do not print, read or change any token or config file.
```
</details>

<details>
<summary><b>3.「檢查 siiswell 是否正常運作」</b></summary>

```text
Check the siiswell connection: call the siiswell `report_task` tool with title "Connection check",
kind "testing", status IN_PROGRESS and eta_min 1, then call `update_task` with status DONE for the
task_id you got. Tell me whether both calls succeeded.
```
</details>

<details>
<summary><b>4. 設定新機器</b>（這一項由你自己執行：它會以隱藏輸入方式詢問 token；需要 Node.js 18+ 和 Bun）</summary>

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```
</details>

### 雲端代理 (Manus, Grok, Dots, ChatGPT)

在供應商雲端執行的代理無法啟動本機的 `siiswell` 程序，但大多數都能透過 **HTTPS 呼叫遠端 MCP
server**，而 `https://<your-dashboard>/mcp` 正是這樣的 server。

| 代理 | 需要 siiswell 提供什麼 | 狀態 |
|---|---|---|
| **Manus** | 自訂 MCP server：URL + `Authorization: Bearer <token>`（Settings → Integrations → Custom MCP） | 應該可用；我們尚未測試 |
| **Grok** | Grok Build CLI：`siiswell mcp` 或遠端 URL（[CLIENTS.md](CLIENTS.md#6-grok)）；Grok API：使用 bearer header 的 remote MCP tool | CLI 已有文件；API 尚未測試 |
| **OpenAI Dots** | 可透過 HTTPS 連線的遠端 MCP server | 供應商尚未公布 MCP 支援；公布後可再試 |
| **ChatGPT custom connectors** | 遠端 MCP server；方案與驗證選項依供應商而定 | 僅在可設定 bearer token / API key 時可用；目前尚不支援僅限 OAuth 的設定 |

1. 為每個雲端代理建立獨立的 client token（`new-token.ts <name> client`），以便單獨撤銷。
2. 在代理的 connector 設定中輸入 URL 和 header `Authorization: Bearer <token>`。
3. 將回報規則（提示詞 1）加入代理的自訂指示。

補充說明：dashboard 必須能從網際網路透過 HTTPS 連線（若放在 Cloudflare Access 後方，`/mcp` 的 token 請求
已設為略過驗證）。雲端代理不會執行本機用戶端，因此它的標題只由 **伺服器** 限制和清理（`ACCEPT_TASK_TEXT`）；
Claude Code hooks 和用量收集器在那裡不適用。

## 隱私：哪些資料會離開你的電腦

siiswell 只記錄你和你的代理**有**做了某件事，從不記錄做了**什麼**。

| 會傳送到你的伺服器 | 永不傳送、永不儲存 |
|---|---|
| 任務狀態、ETA 和固定的 `kind`（coding、docs、…） | 提示詞、回覆、對話 |
| 簡短的任務標題，經過清理並截短至 60 個字元（預設 `brief`；`minimal` 或 `none` 傳送更少） | 程式碼、diff、檔案內容、工具輸出 |
| 每小時、每個模型和每個 app 的 token 數量 | 工具參數、指令文字 |
| 你自己互動的時間和類型（一則提示、一次允許的授權） | 工作目錄和本機路徑 |
| 專案標籤：加 salt 的 hash，除非你指定要顯示的名稱 | 真實專案名稱（除非你選擇啟用） |

- 文字中的機密資訊（token、key、密碼、URL）會**在用戶端清理一次，再在伺服器清理一次**，而且伺服器
  有自己的上限（`ACCEPT_TASK_TEXT`、`ACCEPT_HOST_TEXT`），所以用戶端無法傳送超過你允許的內容。
- 每台機器和每個 app 都有自己的 token；遺失時可單獨撤銷。
- `siiswell permissions suggest` 是唯一會讀取本機對話紀錄的指令。它不傳送任何資料，只印出
  allowlist key。
- 自行託管：資料留在你的 Cloudflare 帳號或你的 container 中，預設保留 30 天。

詳情：[docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) 和 [SECURITY.md](SECURITY.md)（英文）。

## Zero AI

siiswell 從不呼叫 AI 模型，也從不消耗你的方案額度或 token。dashboard、CLI、hooks、MCP server 和
收集器只讀取本機計數器並傳送小型報告。每條規則都是你能在程式碼中讀到的固定門檻值，
所以頁面上的每則警示和每個數字都有據可查。

## 常見問題

<details>
<summary><b>我的代理需要特別支援嗎？</b></summary>

不需要。任何能使用 MCP 工具的代理都能回報任務：加入 server 和那條簡短的指示規則
（[CLIENTS.md](CLIENTS.md#the-instruction-rule-put-this-in-each-agents-global-instructions)）。沒有 MCP 的話，可使用
`siiswell` CLI 或一般的 HTTP 呼叫。
</details>

<details>
<summary><b>它能搭配 Manus、Grok、Dots 或 ChatGPT 這類雲端代理使用嗎？</b></summary>

就任務回報而言，只要代理能加入使用 bearer token 或 API key header 的遠端 MCP server 就可以：請見
[雲端代理](#雲端代理-manus-grok-dots-chatgpt)。token 用量和「你」的訊號來自本機 log 和 hooks，
因此只涵蓋你在自己機器上執行的代理。
</details>

<details>
<summary><b>它會拖慢我的代理或消耗 token 嗎？</b></summary>

幾乎不會。一次工具呼叫只有幾百 bytes，而且只用於超過約 10 分鐘的任務。hooks 會立即返回，
網路工作在背景進行。dashboard 本身不消耗任何 AI token。
</details>

<details>
<summary><b>如果代理忘了回報，或當掉了怎麼辦？</b></summary>

每個用戶端都會顯示「最後回報」距今多久。24 小時沒有更新的任務會被視為過時而關閉，並列在
`siiswell tasks` 中。Claude Code hooks 會回報「正在等你」和工作階段結束，不需依賴代理本身。
</details>

<details>
<summary><b>成本有多準確？</b></summary>

這是 **API 等值** 價格：本機 log 中的 token 數量乘以各模型的價格表
（`src/shared/model-prices.json`，可依機器覆寫）。若你使用訂閱方案，它顯示的是同樣的工作
在 API 上要花多少錢，而不是你實際支付的金額。
</details>

<details>
<summary><b>我在執行代理 orchestrator。它的代理會被算成「我」嗎？</b></summary>

只要你標記它的專案就不會。在專案根目錄放一個 `.siiswell-agents` 檔案（其代理在
`<project>/worktrees/...` 中工作），或以 `SIISWELL_AGENT=1` 啟動代理。這樣 hooks 在那裡就不會記錄任何東西，MCP
寫入工具也會在本機直接回應，因此只有你自己的工作階段會被計入，任務則由 orchestrator 的主機整合回報。
請見 [Agent workspaces](docs/INSTALL-CLIENTS.md#agent-workspaces-run-by-an-orchestrator)。
</details>

<details>
<summary><b>「你」卡片是健康工具嗎？</b></summary>

不是。它以固定門檻值計算時間戳記和事件，頁面上也會這樣說明。它的用意是讓漫長的一天變得看得見，
而不是評斷它。每一則提醒都可以關閉。
</details>

<details>
<summary><b>siiswell 適合團隊使用嗎？</b></summary>

目前 siiswell 是為個人設計的：一次安裝，一位擁有者（single-tenant；client token 用來識別 app，
而不是 tenant 的界線，請見 [SECURITY.md](SECURITY.md)）。團隊功能——共享的代理和 LLM 成本檢視，
同時每個人的身心健康資料只對本人可見——已列入 roadmap。
</details>

<details>
<summary><b>「SI is well, I am well」是什麼意思？</b></summary>

SI 是超級智慧（super intelligence）的縮寫：為你工作的 AI 代理。「SI is well」代表你的代理運作順暢；「I
am well」代表你沒有負荷過重。siiswell 兩者都會照看。
</details>

<details>
<summary><b>執行要花多少錢？</b></summary>

在 Cloudflare 上，個人安裝的用量遠低於 D1 免費方案的限制
（[估算](docs/reference.md#d1-quota-estimate-5-projects)）。使用 Docker 則只是一個小型 container 和一個 SQLite 檔案。
</details>

<details>
<summary><b>要如何更新？</b></summary>

Docker：`git pull && docker compose up -d --build`（資料庫變更會在啟動時套用）。Cloudflare：pull、套用新的
migration、部署（[docs/upgrade.md](docs/upgrade.md)）。用戶端：`siiswell update` 會安裝你的 dashboard 所發布的 CLI 版本；若有用戶端版本較舊，dashboard 會在其下方顯示一則小提示。
</details>

## 文件

| 主題 | 位置 |
|---|---|
| 部署：本機開發、Cloudflare 檢查清單、Docker | [docs/deploy.md](docs/deploy.md) |
| 升級既有的安裝 | [docs/upgrade.md](docs/upgrade.md) |
| 安裝 CLI、hooks 和用量收集器 | [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) |
| 各 app 的 MCP 設定，所有連接方式 | [CLIENTS.md](CLIENTS.md) |
| 通訊協定和端點 | [docs/api.md](docs/api.md), [docs/openapi.yaml](docs/openapi.yaml) |
| OpenTelemetry 匯入 | [docs/otel.md](docs/otel.md) |
| 頁面顯示內容、規則、頻率、限制、配額 | [docs/reference.md](docs/reference.md) |
| 安全模型與問題回報 | [SECURITY.md](SECURITY.md) |

## 開發

```sh
bun install
bun run typecheck
NODE_ENV=test bun test
bun run dev
```

`bun run dev` 會在 <http://localhost:8787> 啟動本機 Worker；`bun scripts/demo-seed.ts --help` 會說明截圖所用的
示範資料。

請見 [CONTRIBUTING.md](CONTRIBUTING.md)。安全問題：[SECURITY.md](SECURITY.md)。變更紀錄：[CHANGELOG.md](CHANGELOG.md)。

## 授權

| 部分 | 授權 | 原因 |
|---|---|---|
| 伺服器和頁面（以下未列出的所有內容） | [AGPL-3.0-only](LICENSE) | 讓託管版 siiswell 的改進保持開放 |
| 用戶端：`cli/`、`bridge/` 和 `src/shared/`（打包進 CLI 的程式碼） | [Apache-2.0](LICENSE-APACHE) | 可安裝在任何機器上，包括公司筆電，不必擔心授權問題 |

AGPL 部分可應要求提供商業授權：請見 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)
（[license@siiswell.com](mailto:license@siiswell.com)）。其他事項：[hello@siiswell.com](mailto:hello@siiswell.com)。歡迎依 [貢獻者授權協議](CLA.md) 提供貢獻（請見 [CONTRIBUTING.md](CONTRIBUTING.md)）。
每個用戶端原始碼檔案都帶有一行 `SPDX-License-Identifier: Apache-2.0`。著作權與授權摘要：[NOTICE](NOTICE)。

<div align="center"><sub>© 2026 <a href="https://siiswell.com">siiswell.com</a> · <a href="https://github.com/jcaol/siiswell">GitHub</a> · <a href="mailto:hello@siiswell.com">聯絡我們</a></sub></div>
