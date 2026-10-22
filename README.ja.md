<div align="center">

[English](README.md) · **日本語** · [Deutsch](README.de.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [한국어](README.ko.md) · [繁體中文](README.zh-Hant.md)

# siiswell

### SI is well, I am well.

<sub>（SI が元気なら、私も元気。）</sub>

**AI エージェントが何をしているか、いくらかかっているか、そしてあなた自身の調子を、落ち着いた 1 ページで。**

<sub><b>SI</b> = スーパーインテリジェンス: あなたのために働く AI エージェントたち。エージェントが元気で、あなたも元気なら、すべて順調です。</sub>

オープンソース · セルフホスト · あらゆる MCP クライアントに対応 · AI 呼び出しゼロ · 標準でプライバシー重視

[理由](#siiswell-を選ぶ理由) · [仕組み](#仕組み) · [違い](#siiswell-の違い) · [機能](#機能) · [クライアント](#いつものツールと連携) · [クイックスタート](#クイックスタート) · [プロンプト](#エージェント向けのコピペ用プロンプト) · [プライバシー](#プライバシー-マシンから送られるもの) · [FAQ](#faq) · [ドキュメント](#ドキュメント)

<img src="docs/img/overview.png" alt="siiswell の dashboard: ヘルス、サマリー帯（対応待ち、作業中、ブロック中、完了）と You カード" width="900">

</div>

---

**siiswell** は、Claude Code、Codex、Gemini CLI などの **AI コーディングエージェント向け dashboard** です。無料・オープンソースで、
セルフホストで動きます。どのエージェントタスクが実行中か、あなたを待っているかを表示し、**LLM の token 使用量と API 換算コスト**
を記録し、落ち着いたスマートフォン通知を送り、ルールベースの **開発者のウェルビーイング** シグナルで真ん中にいる人を気にかけます。
AI モデルを呼び出すことも、プロンプトやコードを読むこともありません。現在は 1 人向けに作られており、チーム機能は計画中です。

## siiswell を選ぶ理由

AI コーディングエージェントは、今では数分から数時間、自律的に動き続けます。しかも複数が同時に、ターミナル、デスクトップアプリ、
サーバー、CI にまたがって。スループットには最高ですが、その真ん中にいる人には負担がかかります。

| よくある困りごと | siiswell がすること |
|---|---|
| **「まだ動いている？それとも私を待っている？」** 5 つのターミナルタブを確認して、40 分間ずっと許可を求めていた 1 つのエージェントを探す。 | すべてのエージェントが長いタスクを報告します（開始、ブロック、完了、ETA）。**対応待ち（Needs you）** リストとスマートフォンへの push が、何かが待ち始めた瞬間に知らせます。 |
| **エージェントがあちこちに。** ノート PC の Claude Code、サーバーの Codex、デスクトップアプリ、夜間スクリプト。全体を見渡す場所がない。 | すべてのマシン、アプリ、プロジェクトを 1 つの dashboard に、`machine / project` 単位でまとめて表示します。 |
| **「今月はいくらかかった？」** token 数はローカルログに埋もれ、サブスクリプションプランでは API 換算の価格が見えない。 | usage collector がローカルログから token の **数値** を読み取り、日・時間・ホスト・アプリ・プロジェクト・モデル別に token と API 換算コストを表示します。 |
| **通知のノイズ。** 大事なプロンプトを見逃すか、夜じゅうスマートフォンが鳴り続けるか。 | push は段階的です。緊急のものはすぐに、それ以外はダイジェストで。静音時間、Focus スイッチ、カレンダー連動の Focus もあります。 |
| **長い一日は気づかないうちに積み重なる。** エージェントは疲れませんが、人は疲れます。 | やさしいルールベースの **You** カード: 今日が実際どれだけ忙しかったか、休憩のひと声、夜にはクールダウンのメッセージ。スコアも連続記録もありません。 |
| **「自分のコードを別の dashboard に任せて大丈夫？」** | プロンプト、コード、ファイルの内容は一切見ません。AI モデルも呼び出しません。ホストするのはあなた自身です。 |

## 仕組み

<p align="center"><img src="docs/img/how-it-works.svg" alt="siiswell の仕組み: エージェント、スクリプト、オーケストレーター、usage collector がプライバシーラインを越えてセルフホストのサーバーに報告し、サーバーは毎分固定ルールを評価して dashboard と Web Push であなたに届けます" width="760"></p>

1. **エージェントが報告する。** 各エージェントの指示に短いルールを加え、長い作業を始めるときに `report_task` を、
   ブロックされたときや完了したときに `update_task` を呼ぶよう伝えます。Claude Code と Codex の hooks は
   「あなたを待っています」を自動で報告することもできます。
2. **集めるのは内容ではなく数値。** usage collector はローカルログをモデルごとの 1 時間単位の token 合計に変換します。
   hooks が残すのは、あなたが操作した *という事実* とその時刻だけです。
3. **サーバーが決定的に判断する。** 固定ルール（ブロック、期限超過、許可プロンプトの待機、ホストのオフライン、プラン上限が近い）
   がアラートを開き、push ポリシーがスマートフォンへ今届けるか、後で届けるか、届けないかを決めます。
4. **見るのは一度だけ。** デスクでもスマートフォンでも 1 ページ、答えは一番上にあります。

## siiswell の違い

| | |
|---|---|
| 🧘 **エージェントだけでなく、人を気にかける** | 多くのエージェントツールは token を数えるだけです。siiswell は人にも目を向けます。どれだけ長く作業しているか、どれだけ速く応答しているか、夜がまだあなたのものか。やさしく声をかけ、決してスコアを付けません。 |
| 🔕 **通知は少なく、タイミングよく** | 緊急のものはすぐスマートフォンに届き、それ以外はまとめて届くまで待ちます。残りは静音時間、Focus、カレンダーが決めます。あなたが不在のときはエージェントにも伝わるので、待たずに作業を続けます。 |
| 🔒 **読んで確かめられるプライバシーライン** | マシンから出るのは件数、時刻、短く整えたタイトルだけです。テキストは 2 回（クライアントとサーバー）スクラブされ、サーバーは独自の上限を適用します。プロンプト、コード、ファイルの内容は決して越えません。 |
| 🧮 **AI ゼロ、すべて説明可能** | モデルを一切呼ばないので運用コストはかからず、すべてのアラートはコードで読める閾値から生まれます。 |
| 🔌 **どのエージェントでも、どこでも** | エージェントの指示に小さなルールを 1 つ加えるだけで十分です。MCP、CLI、素の HTTP、OpenTelemetry: ターミナル、デスクトップアプリ、サーバー、CI、エージェントオーケストレーターがすべて 1 ページに集まります。 |
| 🏠 **自分でホストできる** | Cloudflare Worker 1 つ、または Docker コンテナ 1 つ。設計上シングルテナントです。データはあなたのアカウントに留まります。 |

## 機能

<table>
<tr><td width="50%" valign="top">

### エージェントのタスク
- **対応待ち（Needs you）** 受信箱: あなたを待っているブロック中のタスクと許可プロンプトを古い順に
- **作業中（Working now）**: 開いているすべてのタスクを ETA、期限超過マーク、開始時刻とともに
- 直近 24 時間の **最近の結果**
- マシン、アプリ、プロジェクトごとにグループ化。更新のないタスクは 24 時間後に自動でクローズ
- 読み取り専用の `list_tasks` と `operator_status` を含む 5 つの MCP ツール

</td><td width="50%" valign="top">

### 使用量とコスト
- 12 か月のカレンダーヒートマップと、任意の日の 24 時間
- ホスト、アプリ、プロジェクト、モデル別の token と **API 換算コスト**
- Claude Code と Codex のログ、さらに OpenTelemetry の取り込み
- プラン上限の予測: 「このペースだと 5 時間枠は 16:40 ごろに埋まります」
- モデルごとの価格表を、自分の設定で上書き可能

</td></tr>
<tr><td valign="top">

### 落ち着いた通知
- スマートフォンとデスクトップへの Web Push（インストール可能な PWA）
- **Time-Sensitive** の項目はすぐに、それ以外は **Scheduled Summary** で
- 静音時間、週末、**Focus 60 分**、カレンダーからの Focus
- 関連するアラートは 1 つの push にまとめ、繰り返しではなく段階的なリマインダーで
- 任意の受信箱モード: 保留中の許可プロンプトを 15 分または 30 分ごとにまとめて受け取る

</td><td valign="top">

### あなた自身のこと
- **Calm / Busy / Overloaded**、いつも理由とともに
- 8 つの透明なシグナルから推定する作業負荷レベル（0–100）
- **Highlights**: 1 週間をわかりやすい文章で。どの指標にも普段の範囲を表示
- 今日のタイムライン、7 日・30 日の傾向、週ごとのふりかえり。気になるカードはピン留め
- やさしい声かけ（休憩、ペース、静音時間）。それぞれに「今日はいい」と「今後表示しない」
- クールダウンとおはようのメッセージ。あなたの不在はエージェントにも伝わります

</td></tr>
<tr><td valign="top">

### プライバシーとセキュリティ
- プロンプト、コード、ツール引数、ファイルの内容は一切扱いません
- プロジェクト名は標準でハッシュ化。テキストはクライアント **と** サーバーの両方でスクラブ
- マシンとアプリごとに token が 1 つ、個別に失効可能
- 受け付けるタスクテキストの量にサーバー側で上限

</td><td valign="top">

### 好きな場所で動く
- **Cloudflare** Worker + D1、または SQLite を使う **Docker**
- Cloudflare Access、組み込みのログイン、または自前の認証プロキシ
- 依存関係ゼロの CLI（Node ≥ 18）、自己アップデート対応
- AGPL-3.0、商用ライセンスはご相談に応じて

</td></tr>
</table>

## スクリーンショット

<p align="center"><img src="docs/img/highlights.png" alt="Highlights: 今週の使用量、作業負荷、夜間、活動時間を、それぞれ短い 1 文とスパークラインで" width="880"><br/><b>Highlights</b> — 1 週間を 4 つのわかりやすい文で。気になるものはピン留め</p>

| | |
|---|---|
| <img src="docs/img/usage.png" alt="Usage: カレンダーヒートマップと、ホスト・アプリ・プロジェクト・モデル別の内訳" width="440"><br/>**使用量とコスト** — 1 年をひと目で、そこから 1 日を掘り下げる | <img src="docs/img/wellbeing.png" alt="You カード: 状態、作業負荷レベル、今日のタイムライン" width="440"><br/>**You** — 今日の調子を、理由とともに |
| <img src="docs/img/tasks.png" alt="対応待ちと作業中" width="440"><br/>**タスク** — あなたを待っているもの、動いているもの | <img src="docs/img/overview-dark.png" alt="ダークテーマの dashboard" width="440"><br/>**ダークテーマ** — デバイスの設定に従うか、自分で選ぶ |
| <img src="docs/img/usage-month.png" alt="使用量の月表示: 合計、日ごとの積み上げ棒、上位のプロジェクトとモデル" width="440"><br/>**月表示** — 合計、上位のプロジェクトとモデル、曜日 × 時間 | <img src="docs/img/phone.png" alt="スマートフォンで表示した dashboard" width="220"><br/>**スマートフォンで** — アプリとしてインストールして push を受け取る |

<sub>スクリーンショットは <code>scripts/demo-seed.ts</code> のデモデータを使用しています。</sub>

## いつものツールと連携

MCP を話せるものなら何でもタスクを報告できます。コマンドを実行できるもの、HTTP を送れるものも同様です。

| クライアントの種類 | 例 | 接続方法 | dashboard に表示されるもの |
|---|---|---|---|
| **CLI エージェント** | Claude Code, Codex, Gemini CLI, Antigravity (agy), opencode, grok, kilo | セットアップスクリプトが登録する `siiswell mcp`（stdio）、または bearer ヘッダー付きのリモート MCP | タスク。Claude Code / Codex の hooks があれば「あなたを待っています」とあなた自身のペースも |
| **デスクトップアプリと IDE** | Claude Desktop, ChatGPT デスクトップアプリ, Codex IDE 拡張 | stdio MCP サーバー（`siiswell mcp`） | タスク |
| **任意のリモート MCP クライアント** | Streamable HTTP + カスタムヘッダーに対応するもの | `Authorization: Bearer <token>` 付きの `POST /mcp` | タスク |
| **クラウドエージェント** | Manus, Grok（API のリモート MCP）, OpenAI Dots, ChatGPT のカスタムコネクタ | `https://<your-dashboard>/mcp` を bearer token / API キーのヘッダー付きカスタム MCP サーバーとして追加（[詳細](#クラウドエージェント-manus-grok-dots-chatgpt)） | タスク |
| **スクリプト、cron、CI** | ビルドジョブ、長いマイグレーション、夜間タスク | `siiswell report` / `update` / `heartbeat` | タスクと heartbeat |
| **素の HTTP / API** | 任意の言語 | `/mcp` への JSON-RPC。取り込みエンドポイントは [OpenAPI](docs/openapi.yaml)（英語） | タスク、使用量、ホストの状態 |
| **エージェントオーケストレーター** | 自作のエージェントランナー、自動化サーバー | ホスト連携エンドポイント `/api/ingest/{snapshot,events,heartbeat}`。`.siiswell-agents` マーカーでそのワークスペースから hooks を除外 | ホスト、プロジェクト、エージェント、タスク、イベント |
| **token 使用量** | Claude Code と Codex のログ | 定期実行する `siiswell usage push` | token と API 換算コスト |
| **OpenTelemetry** | Claude Code のメトリクス | `/api/ingest/otlp` への OTLP/HTTP JSON（オプトイン） | token とコスト |

アプリごとの設定例と対応状況: [CLIENTS.md](CLIENTS.md)（英語）。手順を追ったインストール: [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md)（英語）。

## クイックスタート

### 目にする用語

| 用語 | 意味 |
|---|---|
| **サーバー** | dashboard 本体です。報告を保存してページを表示する Docker コンテナ 1 つ（または Cloudflare Worker） |
| **クライアント** | エージェントが動く各コンピューター上の小さな `siiswell` プログラム |
| **MCP** | AI エージェントがツールを呼び出すための標準的な方法です。siiswell はエージェントに「タスクを報告する」ツールを提供します |
| **クライアント token** | 1 つのエージェントアプリ（たとえばノート PC の Claude Code）がタスクを報告するためのキー |
| **ホスト token** | 1 台のコンピューターの usage collector が token 数を送るためのキー。名前はそのコンピューターのラベルと同じにする必要があります |
| **Hooks** | Claude Code / Codex がイベント（プロンプト、許可リクエスト）のたびに実行する小さなコマンド。「あなたを待っています」に使われます |

### どちらの方法が合っているか

| | **Docker**（多くの人におすすめ） | **Cloudflare**（すでに Workers を使っている人向け） |
|---|---|---|
| 動作環境 | Docker が動く任意のマシン: 自宅サーバー、VPS、NAS | あなたの Cloudflare アカウント（たいてい無料枠で十分） |
| サインイン | 組み込み: `.env` の管理者パスワード 1 つ | Cloudflare Access（Google / GitHub / メールでのログイン） |
| スマートフォンへの push | 対応（HTTPS アドレスを用意した後） | 対応 |
| 最初のタスクまでの時間 | 1 台のマシンで約 10 分。HTTPS を含めて約 30 分 | 約 30 分 |

### Docker の手順

必要なもの: サーバー用に Docker と Docker Compose が入ったマシン。接続したいエージェントが動く各コンピューターに Node.js 18+ と
[Bun](https://bun.sh)。ほかのコンピューターやスマートフォンから使うには、HTTPS アドレスも必要です（ステップ 3）。

**1. 取得してパスワードを設定する**（サーバーのマシンで）

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
cp .env.example .env && chmod 600 .env
```

まず試すだけなら、`.env` で重要なのは 2 行だけです:

```dotenv
# the address you open; your https://… address after step 3
PUBLIC_URL=http://localhost:8787
# 12+ characters; to change it: edit, then docker compose up -d
ADMIN_PASSWORD='a long password you keep'
```

**2. 起動して確認する**

```sh
docker compose up -d --build
docker compose ps
curl -s http://localhost:8787/api/health
```

数秒後に `docker compose ps` が **healthy** と表示し、ヘルスチェックは `{"ok":true,…}` を返します。
<http://localhost:8787> を開いてサインインします。起動しない場合は、`docker compose logs siiswell` に修正が必要な設定がすべて
表示されます。ブラウザのないリモートサーバーでは、先にノート PC からトンネルを開きます:
`ssh -L 8787:127.0.0.1:8787 you@your-server`。その後、ノート PC で <http://localhost:8787> を開きます。

**3. HTTPS アドレスを用意する**（ほかのコンピューターやスマートフォンから使うために必要）

コンテナは `127.0.0.1:8787` でのみ待ち受けます。その前に HTTPS 対応のリバースプロキシを置いてください。たとえば
証明書を自動で取得する [Caddy](https://caddyserver.com/) です:

```text
# /etc/caddy/Caddyfile  (point the DNS name at this machine first)
dash.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

次に `.env` で:

```dotenv
PUBLIC_URL=https://dash.example.com
# the proxy reaches the container from this address
TRUSTED_PROXY_CIDRS=172.28.0.1/32
```

設定して `docker compose up -d` を実行します。ドメインがない場合は、Tailscale などの VPN が提供するプライベートな HTTPS 名でも使えます。ほかの方法:
[docs/deploy.md](docs/deploy.md#deploy-with-docker)（英語）。

**4. スマートフォンへの push**（任意）

```sh
docker compose exec siiswell bun scripts/vapid.ts mailto:you@example.com
```

表示された 3 行の `VAPID_…=` を `.env` に貼り付け、`docker compose up -d` を実行します。iPhone では Safari で dashboard を開き、
共有 → **ホーム画面に追加** を選び、そこから開いて **Enable notifications** をタップします。

**5. token を作成する**（サーバーで。各 token は一度しか表示されないので、ステップ 6 までウィンドウを開いたままにしてください）

```sh
docker compose exec siiswell bun scripts/new-token.ts laptop-1-claude client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1-codex client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1 host --apply
```

使うエージェントアプリごとにクライアント token を 1 つ（ここでは Claude Code と Codex）、コンピューターごとにホスト token を 1 つ作ります。
ホスト token の名前（`laptop-1`）が、ステップ 6 で入力するマシンラベルになります。

**6. コンピューターを接続する**（各ノート PC やデスクトップで）

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```

dashboard の URL（`https://dash.example.com`）、マシンラベル（`laptop-1`）、接続するアプリ、アプリごとの token（入力は非表示）を
尋ねられます。`siiswell` コマンドを `~/.local/bin` にインストールし、エージェントに報告ルールを追加し、hooks と 1 時間ごとの
usage collector も追加できます。最後に `doctor claude-code: ok` と表示されれば完了です。

試してみましょう（`siiswell` が見つからない場合は、先に新しいターミナルを開いてください）。タスクが **作業中** に表示され、
`siiswell tasks` に一覧表示され、最後の行でそのタスクを閉じます:

```sh
ID=$(siiswell report "Try the dashboard" --kind testing --eta-min 5 | tail -1)
siiswell tasks
siiswell update "$ID" --status DONE
```

または、エージェントに接続確認を頼んでも構いません（[プロンプト 3](#エージェント向けのコピペ用プロンプト)）。

### 運用を続ける

| 作業 | コマンド |
|---|---|
| サーバーを更新する | `git pull && docker compose up -d --build`（データベースの変更は自動で適用されます） |
| コンピューターのクライアントを更新する | `siiswell update`（task id なしで実行すると、dashboard が公開しているバージョンをインストールします） |
| 停止 / 起動 | `docker compose down` / `docker compose up -d`（データは残ります） |
| バックアップ | `docker compose stop` を実行し、`siiswell-data` ボリューム（`docker volume ls` で正式名を確認できます）から `/data/siiswell.sqlite` をコピーして、`docker compose start`。バックアップは `.env` と同じように非公開で保管してください。パスワードのハッシュが含まれます |

⚠️ `docker compose down -v` はボリュームを削除します。つまり、すべてのデータが消えます。

<details>
<summary><b>Cloudflare（Worker + D1）</b></summary>

```sh
bun install
bunx wrangler d1 create siiswell
```

表示された `database_id` を `wrangler.toml` に入れてから、次を実行します:

```sh
bunx wrangler d1 migrations apply siiswell --remote
bun run deploy
bun scripts/new-token.ts laptop-1-claude client
```

最後のコマンドは token と `wrangler d1 execute` の行を表示します。その行を実行すると token が登録されます。

ページは Cloudflare Access で保護してください。設定が済むまで、dashboard は誰にもデータを表示しません。外部に公開される
手順をすべて明記した完全なチェックリストは [docs/deploy.md](docs/deploy.md) にあります。その後、ステップ 6 と同じようにコンピューターを接続します。
</details>

## エージェント向けのコピペ用プロンプト

報告するのはエージェントなので、伝えておく必要があります。これらのプロンプトはどのエージェントに貼り付けても安全です。どれも
token を求めず、含んでもいません。**token をチャットに貼り付けないでください**。token は設定ファイルかコネクタの設定に入れます。

エージェントは英語のプロンプトをそのまま理解します。必要であれば、ご自身の言語で書いても構いません。

<details open>
<summary><b>1. 報告ルール</b>（各エージェントのグローバル指示に入れます。<code>setup-client.sh</code> が自動で行います）</summary>

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
<summary><b>2. 「このマシンの siiswell を更新して」</b></summary>

```text
Update the siiswell client on this machine: run `siiswell update --yes`, then `siiswell doctor`.
Tell me the installed version and any line of the doctor output that is not [ok] or [--].
Do not print, read or change any token or config file.
```
</details>

<details>
<summary><b>3. 「siiswell が動いているか確認して」</b></summary>

```text
Check the siiswell connection: call the siiswell `report_task` tool with title "Connection check",
kind "testing", status IN_PROGRESS and eta_min 1, then call `update_task` with status DONE for the
task_id you got. Tell me whether both calls succeeded.
```
</details>

<details>
<summary><b>4. 新しいマシンをセットアップする</b>（これはご自身で実行してください。token を非表示入力で尋ねます。Node.js 18 以上と Bun が必要です）</summary>

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```
</details>

### クラウドエージェント (Manus, Grok, Dots, ChatGPT)

ベンダーのクラウドで動くエージェントはローカルの `siiswell` プロセスを起動できませんが、多くは **HTTPS 経由のリモート MCP
サーバー** を呼び出せます。`https://<your-dashboard>/mcp` がまさにそれです。

| エージェント | siiswell 側で必要なもの | 状況 |
|---|---|---|
| **Manus** | カスタム MCP サーバー: URL + `Authorization: Bearer <token>`（Settings → Integrations → Custom MCP） | 動作するはずですが、まだ私たちは検証していません |
| **Grok** | Grok Build CLI: `siiswell mcp` またはリモート URL（[CLIENTS.md](CLIENTS.md#6-grok)）。Grok API: bearer ヘッダー付きのリモート MCP ツール | CLI は手順あり。API は未検証 |
| **OpenAI Dots** | HTTPS で到達できるリモート MCP サーバー | ベンダーによる MCP 対応はまだ公開されていません。公開されたら試してください |
| **ChatGPT のカスタムコネクタ** | リモート MCP サーバー。プランと認証の選択肢はベンダー次第 | bearer token / API キーを設定できる場合のみ動作。OAuth のみの構成にはまだ対応していません |

1. クラウドエージェントごとに別のクライアント token を作成します（`new-token.ts <name> client`）。そうすれば個別に失効できます。
2. エージェントのコネクタ設定で、URL とヘッダー `Authorization: Bearer <token>` を入力します。
3. 報告ルール（プロンプト 1）をエージェントのカスタム指示に追加します。

補足: dashboard はインターネットから HTTPS で到達できる必要があります（Cloudflare Access の背後では、token 付きのリクエストに対して `/mcp` は
すでにバイパスされています）。クラウドエージェントはローカルクライアントを実行しないため、タイトルの制限とスクラブは **サーバー**
側のみで行われます（`ACCEPT_TASK_TEXT`）。Claude Code の hooks と usage collector はそこでは適用されません。

## プライバシー: マシンから送られるもの

siiswell が記録するのは、あなたとエージェントが何かを **した** という事実だけで、**何を** したかは決して記録しません。

| サーバーに送られるもの | 決して送られず、保存もされないもの |
|---|---|
| タスクの状態、ETA、固定の `kind`（coding、docs など） | プロンプト、返答、会話 |
| スクラブされ 60 文字に切り詰められた短いタスクタイトル（標準は `brief`。`minimal` または `none` ならさらに少なく） | コード、差分、ファイルの内容、ツールの出力 |
| 1 時間ごと、モデルごと、アプリごとの token 数 | ツール引数、コマンドのテキスト |
| あなた自身の操作の時刻と種類（プロンプト、許可した操作） | 作業ディレクトリとローカルパス |
| プロジェクトラベル: 表示する名前を指定しない限りソルト付きハッシュ | 実際のプロジェクト名（オプトインしない限り） |

- テキストは **クライアントとサーバーの両方で** シークレット（token、キー、パスワード、URL）がスクラブされ、サーバーは独自の上限
  （`ACCEPT_TASK_TEXT`、`ACCEPT_HOST_TEXT`）を適用するため、クライアントは許可した以上の量を送れません。
- マシンとアプリごとに専用の token があり、紛失したものだけを個別に失効できます。
- ローカルのトランスクリプトを読むコマンドは `siiswell permissions suggest` だけです。何も送信せず、表示するのは
  allowlist のキーのみです。
- セルフホスト: データはあなたの Cloudflare アカウントまたはコンテナに留まり、標準の保持期間は 30 日です。

詳細: [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) と [SECURITY.md](SECURITY.md)（英語）。

## Zero AI

siiswell は AI モデルを決して呼び出さず、あなたのプランや token を消費しません。dashboard、CLI、hooks、MCP サーバー、
collector は、ローカルのカウンターを読んで小さな報告を送るだけです。すべてのルールはコードで読める固定の閾値なので、
ページ上のすべてのアラートとすべての数値を説明できます。

## FAQ

<details>
<summary><b>エージェント側に特別な対応は必要ですか？</b></summary>

いいえ。MCP ツールを使えるエージェントなら、どれでもタスクを報告できます。サーバーと短い指示ルールを追加してください
（[CLIENTS.md](CLIENTS.md#the-instruction-rule-put-this-in-each-agents-global-instructions)）。MCP がない場合は、
`siiswell` CLI か素の HTTP 呼び出しを使います。
</details>

<details>
<summary><b>Manus、Grok、Dots、ChatGPT のようなクラウドエージェントでも使えますか？</b></summary>

タスクの報告については、エージェントが bearer token または API キーのヘッダー付きでリモート MCP サーバーを追加できる場合は使えます。
[クラウドエージェント](#クラウドエージェント-manus-grok-dots-chatgpt) を参照してください。token 使用量と「You」のシグナルはローカルのログと hooks から
得られるため、対象はあなた自身のマシンで動かすエージェントです。
</details>

<details>
<summary><b>エージェントが遅くなったり、token を消費したりしませんか？</b></summary>

ほとんどありません。ツール呼び出しは数百バイトで、約 10 分より長いタスクに対してのみ行われます。hooks はすぐに戻り、
ネットワーク処理はバックグラウンドで行います。dashboard 自体は AI の token を消費しません。
</details>

<details>
<summary><b>エージェントが報告を忘れたり、クラッシュしたりしたら？</b></summary>

各クライアントには「最後の報告」からの経過時間が表示されます。24 時間更新のないタスクは stale としてクローズされ、
`siiswell tasks` に一覧表示されます。Claude Code の hooks は、エージェントに頼らずに「あなたを待っています」とセッション終了を報告します。
</details>

<details>
<summary><b>コストはどのくらい正確ですか？</b></summary>

これは **API 換算** の価格です。ローカルログの token 数に、モデルごとの価格表
（`src/shared/model-prices.json`、マシンごとに上書き可能）を掛けたものです。サブスクリプションプランでは、同じ作業を API で行った場合の
コストを示しており、実際の支払額ではありません。
</details>

<details>
<summary><b>エージェントオーケストレーターを使っています。そのエージェントが「自分」として数えられますか？</b></summary>

プロジェクトに印を付ければ、数えられません。プロジェクトのルートに `.siiswell-agents` ファイルを置く（そのエージェントは
`<project>/worktrees/...` で作業します）か、`SIISWELL_AGENT=1` を付けてエージェントを起動してください。すると hooks はそこで何も記録せず、MCP の
書き込みツールはローカルで応答するため、数えられるのはあなた自身のセッションだけになり、タスクはオーケストレーターのホスト連携が報告します。
[Agent workspaces](docs/INSTALL-CLIENTS.md#agent-workspaces-run-by-an-orchestrator)（英語）を参照してください。
</details>

<details>
<summary><b>「You」カードは健康管理ツールですか？</b></summary>

いいえ。固定の閾値でタイムスタンプとイベントを数えているだけで、ページにもそう明記しています。長い一日を見えるようにするためのもので、
評価するためのものではありません。すべての声かけはオフにできます。
</details>

<details>
<summary><b>siiswell はチーム向けですか？</b></summary>

現在の siiswell は 1 人向けに作られています。1 つのインストールにオーナーは 1 人です（シングルテナント。クライアント token はアプリを
識別するもので、テナントの境界ではありません。[SECURITY.md](SECURITY.md) を参照してください）。チーム機能（エージェントと LLM コストの共有ビュー。
各メンバーのウェルビーイングのデータは本人だけのものとして保たれます）はロードマップにあります。
</details>

<details>
<summary><b>「SI is well, I am well」とはどういう意味ですか？</b></summary>

SI はスーパーインテリジェンス、つまりあなたのために働く AI エージェントたちのことです。「SI is well」はエージェントが順調に動いていること、
「I am well」はあなたが無理をしすぎていないことを意味します。siiswell はその両方を見守ります。
</details>

<details>
<summary><b>運用にはいくらかかりますか？</b></summary>

Cloudflare では、個人用のインストールは D1 の無料枠の上限に十分収まります
（[見積もり](docs/reference.md#d1-quota-estimate-5-projects)、英語）。Docker なら、小さなコンテナ 1 つと SQLite ファイル 1 つです。
</details>

<details>
<summary><b>どうやって更新しますか？</b></summary>

Docker: `git pull && docker compose up -d --build`（データベースの変更は起動時に適用されます）。Cloudflare: pull し、新しいマイグレーションを
適用してデプロイします（[docs/upgrade.md](docs/upgrade.md)、英語）。クライアント: `siiswell update` が dashboard の公開している CLI バージョンを
インストールします。遅れているクライアントには、dashboard がその下に小さな注記を表示します。
</details>

## ドキュメント

| トピック | 場所 |
|---|---|
| デプロイ: ローカル開発、Cloudflare チェックリスト、Docker | [docs/deploy.md](docs/deploy.md) |
| 既存インストールのアップグレード | [docs/upgrade.md](docs/upgrade.md) |
| CLI、hooks、usage collector のインストール | [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) |
| アプリごとの MCP 設定、すべての接続方法 | [CLIENTS.md](CLIENTS.md) |
| ワイヤープロトコルとエンドポイント | [docs/api.md](docs/api.md), [docs/openapi.yaml](docs/openapi.yaml) |
| OpenTelemetry の取り込み | [docs/otel.md](docs/otel.md) |
| ページの表示内容、ルール、頻度、制限、クォータ | [docs/reference.md](docs/reference.md) |
| セキュリティモデルと報告 | [SECURITY.md](SECURITY.md) |

## 開発

```sh
bun install
bun run typecheck
NODE_ENV=test bun test
bun run dev
```

`bun run dev` は <http://localhost:8787> でローカル Worker を起動します。`bun scripts/demo-seed.ts --help` では、スクリーンショットに使う
デモデータについて説明しています。

[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。セキュリティの問題: [SECURITY.md](SECURITY.md)。変更履歴: [CHANGELOG.md](CHANGELOG.md)。

## ライセンス

| 部分 | ライセンス | 理由 |
|---|---|---|
| サーバーとページ（下記以外のすべて） | [AGPL-3.0-only](LICENSE) | ホストされた siiswell への改善がオープンなまま保たれるように |
| クライアント: `cli/`、`bridge/`、`src/shared/`（CLI に同梱されるコード） | [Apache-2.0](LICENSE-APACHE) | 会社のノート PC を含め、どのマシンにもライセンスの心配なくインストールできるように |

AGPL 部分の商用ライセンスはご相談に応じて提供します: [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) を参照してください
（[license@siiswell.com](mailto:license@siiswell.com)）。その他のお問い合わせ: [hello@siiswell.com](mailto:hello@siiswell.com)。コントリビューションは [Contributor License Agreement](CLA.md) のもとで歓迎します（[CONTRIBUTING.md](CONTRIBUTING.md) を参照）。
各クライアントのソースファイルには `SPDX-License-Identifier: Apache-2.0` の行があります。著作権とライセンスの概要: [NOTICE](NOTICE)。

<div align="center"><sub>© 2026 <a href="https://siiswell.com">siiswell.com</a> · <a href="https://github.com/jcaol/siiswell">GitHub</a> · <a href="mailto:hello@siiswell.com">お問い合わせ</a></sub></div>
