<div align="center">

[English](README.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · **한국어** · [繁體中文](README.zh-Hant.md)

# siiswell

### SI is well, I am well.

<sub>SI가 잘 지내면, 나도 잘 지낸다.</sub>

**AI 에이전트가 무엇을 하고 있는지, 비용이 얼마인지, 그리고 당신은 어떻게 지내고 있는지를 보여 주는 차분한 한 페이지.**

<sub><b>SI</b> = super intelligence: 당신을 위해 일하는 AI 에이전트. 에이전트가 잘 지내고 당신도 잘 지내면, 모든 것이 잘 돌아갑니다.</sub>

오픈 소스 · self-hosted · 모든 MCP 클라이언트와 호환 · AI 호출 없음 · 기본값부터 개인정보 보호

[이유](#siiswell을-쓰는-이유) · [작동 방식](#작동-방식) · [다른 점](#siiswell이-다른-점) · [기능](#기능) · [클라이언트](#이미-쓰는-도구와-함께-작동합니다) · [빠른 시작](#빠른-시작) · [프롬프트](#에이전트용-복사-붙여넣기-프롬프트) · [개인정보](#개인정보-내-기기에서-무엇이-나가는가) · [FAQ](#faq) · [문서](#문서)

<img src="docs/img/overview.png" alt="siiswell dashboard: 상태, 요약 띠(내 응답 필요, 진행 중, 차단됨, 완료)와 You 카드" width="900">

</div>

---

**siiswell**은 Claude Code, Codex, Gemini CLI 같은 **AI 코딩 에이전트를 위한 dashboard**로, 무료이자 오픈 소스이며
self-hosted로 운영합니다. 어떤 에이전트 작업이 진행 중이거나 당신을 기다리고 있는지 보여 주고, **LLM token 사용량과 API
환산 비용**을 추적하며, 차분한 휴대폰 알림을 보내고, 규칙 기반의 **개발자 well-being** 신호로 그 한가운데 있는 사람을
돌봅니다. 이 모든 것을 AI 모델을 호출하거나 프롬프트와 코드를 읽지 않고 해냅니다. 지금은 한 사람을 위해 만들어졌으며, 팀
기능은 계획 중입니다.

## siiswell을 쓰는 이유

AI 코딩 에이전트는 이제 몇 분, 몇 시간씩 스스로 일하고, 종종 여러 개가 동시에 터미널, 데스크톱 앱,
서버, CI에서 돌아갑니다. 처리량에는 좋지만, 그 가운데 있는 사람에게는 부담이 됩니다.

| 일상의 불편 | siiswell이 하는 일 |
|---|---|
| **"아직 작업 중일까, 나를 기다리고 있을까?"** 40분째 권한을 요청하고 있는 에이전트 하나를 찾으려고 터미널 탭 다섯 개를 확인합니다. | 모든 에이전트가 긴 작업을 보고합니다(시작, 차단, 완료, ETA). **내 응답 필요** 목록과 휴대폰 push가 무언가 기다리는 순간 알려 줍니다. |
| **여기저기 흩어진 에이전트.** 노트북의 Claude Code, 서버의 Codex, 데스크톱 앱, 야간 스크립트. 한눈에 보이는 곳이 없습니다. | 모든 기기, 앱, 프로젝트를 `machine / project`로 묶은 하나의 dashboard. |
| **"이번 달 비용은 얼마였지?"** token 수는 로컬 로그에 묻혀 있고, 구독 플랜은 API 환산 가격을 보여 주지 않습니다. | usage collector가 로컬 로그에서 token **숫자**만 읽어, 일·시간·호스트·앱·프로젝트·모델별 token과 API 환산 비용을 보여 줍니다. |
| **알림 소음.** 중요한 프롬프트를 놓치거나, 저녁 내내 휴대폰이 울립니다. | push는 단계별로 나뉩니다: 급한 항목은 바로, 나머지는 요약으로. 조용한 시간, Focus 스위치, 캘린더 기반 Focus. |
| **긴 하루는 모르는 사이에 쌓입니다.** 에이전트는 지치지 않지만 사람은 지칩니다. | 규칙 기반의 부드러운 **You** 카드: 오늘이 실제로 얼마나 바빴는지, 휴식 권유, 저녁의 마무리 메시지. 점수도, 연속 기록도 없습니다. |
| **"내 코드를 또 다른 dashboard에 맡겨도 될까?"** | 프롬프트, 코드, 파일 내용을 보지 않습니다. AI 모델을 호출하지 않습니다. 직접 호스팅합니다. |

## 작동 방식

<p align="center"><img src="docs/img/how-it-works.svg" alt="siiswell 작동 방식: 에이전트, 스크립트, orchestrator, usage collector가 개인정보 경계를 넘어 self-hosted 서버로 보고하고, 서버는 매분 고정 규칙을 평가해 dashboard와 Web Push로 당신에게 전달합니다" width="760"></p>

1. **에이전트가 보고합니다.** 각 에이전트의 지침에 넣은 짧은 규칙이, 긴 작업을 시작할 때 `report_task`를,
   차단되거나 끝났을 때 `update_task`를 호출하도록 요청합니다. Claude Code와 Codex hooks는 "당신을 기다리는 중"도
   스스로 보고할 수 있습니다.
2. **내용이 아니라 숫자만 수집합니다.** usage collector는 로컬 로그를 모델별 시간당 token 합계로 바꿉니다. hooks는
   당신이 상호작용했다는 *사실*과 그 시각만 남깁니다.
3. **서버가 결정론적으로 판단합니다.** 고정 규칙(차단됨, 기한 초과, 대기 중인 권한 프롬프트, 호스트 오프라인, 플랜
   한도 임박)이 알림을 열고, push 정책이 휴대폰에 지금 보낼지, 나중에 보낼지, 보내지 않을지를 정합니다.
4. **한 번만 보면 됩니다.** 책상에서도 휴대폰에서도 한 페이지, 답은 맨 위에 있습니다.

## siiswell이 다른 점

| | |
|---|---|
| 🧘 **에이전트뿐 아니라 사람을 돌봅니다** | 대부분의 에이전트 도구는 token을 셉니다. siiswell은 사람도 살핍니다: 얼마나 오래 일했는지, 얼마나 빨리 응답하고 있는지, 저녁이 아직 당신의 시간인지. 부드럽게 권할 뿐, 점수를 매기지 않습니다. |
| 🔕 **더 적고, 더 알맞은 때의 알림** | 급한 항목은 바로 휴대폰에 도착하고, 나머지는 요약을 기다립니다. 조용한 시간, Focus, 캘린더가 나머지를 정하며, 당신이 자리를 비웠을 때는 에이전트에게 알려 기다리지 않고 계속 진행하게 합니다. |
| 🔒 **읽을 수 있는 개인정보 경계** | 기기 밖으로 나가는 것은 카운트, 시각, 짧게 정리된 제목뿐입니다. 텍스트는 두 번(클라이언트와 서버) 정리되고, 서버는 자체 상한을 적용합니다. 프롬프트, 코드, 파일 내용은 절대 넘어가지 않습니다. |
| 🧮 **AI 없음, 완전히 설명 가능** | 모델을 전혀 호출하지 않으므로 운영 비용이 들지 않고, 모든 알림은 코드에서 읽을 수 있는 임계값에서 나옵니다. |
| 🔌 **어떤 에이전트든, 어디서든** | 에이전트 지침에 작은 규칙 하나면 충분합니다. MCP, CLI, 일반 HTTP 또는 OpenTelemetry: 터미널, 데스크톱 앱, 서버, CI, 에이전트 orchestrator가 모두 한 페이지에 모입니다. |
| 🏠 **직접 호스팅** | Cloudflare Worker 하나 또는 Docker 컨테이너 하나, 설계부터 single-tenant. 데이터는 당신의 계정에 머뭅니다. |

## 기능

<table>
<tr><td width="50%" valign="top">

### 에이전트 작업
- **내 응답 필요** 받은편지함: 당신을 기다리는 차단된 작업과 권한 프롬프트, 오래된 순
- **진행 중**: ETA, 기한 초과 표시, 시작 시각이 있는 모든 열린 작업
- 최근 24시간의 **최근 결과**
- 기기, 앱, 프로젝트별로 묶음; 오래된 작업은 24시간 후 자동으로 닫힘
- 읽기 전용 `list_tasks`와 `operator_status`를 포함한 MCP 도구 다섯 개

</td><td width="50%" valign="top">

### 사용량과 비용
- 12개월 캘린더 heatmap과 하루 24시간 보기
- 호스트, 앱, 프로젝트, 모델별 token과 **API 환산 비용**
- Claude Code와 Codex 로그, 그리고 OpenTelemetry ingest
- 플랜 한도 예측: "이 속도라면 5시간 창은 16:40쯤 찹니다"
- 모델별 가격표, 직접 덮어쓰기 가능

</td></tr>
<tr><td valign="top">

### 차분한 알림
- 휴대폰과 데스크톱으로 Web Push(설치형 PWA)
- **Time-Sensitive** 항목은 바로, 나머지는 **Scheduled Summary**로
- 조용한 시간, 주말, **Focus 60분**, 캘린더 기반 Focus
- 관련 알림은 push 하나로 묶음; 반복 대신 단계적 리마인더
- 선택형 받은편지함 모드: 대기 중인 권한 프롬프트를 15분 또는 30분마다 한꺼번에

</td><td valign="top">

### 당신, 사람
- **Calm / Busy / Overloaded**, 항상 이유와 함께
- 투명한 신호 여덟 가지로 추정한 작업 부하 수준(0–100)
- **Highlights**: 한 주를 평이한 문장으로, 모든 지표에 평소 범위 표시
- 오늘의 타임라인, 7일·30일 추세, 주간 돌아보기; 관심 있는 카드를 고정
- 부드러운 권유(휴식, 속도, 조용한 시간), 각각 "오늘은 안 함"과 "다시 안 함" 선택 가능
- 마무리 인사와 아침 인사; 에이전트는 당신이 자리를 비웠음을 알게 됨

</td></tr>
<tr><td valign="top">

### 개인정보와 보안
- 프롬프트, 코드, 도구 인자, 파일 내용은 절대 없음
- 프로젝트 이름은 기본적으로 해시 처리; 텍스트는 클라이언트 **그리고** 서버에서 정리
- 기기와 앱마다 token 하나, 개별 폐기 가능
- 받아들이는 작업 텍스트 양에 대한 서버 측 상한

</td><td valign="top">

### 원하는 곳에서 실행
- **Cloudflare** Worker + D1, 또는 SQLite를 쓰는 **Docker**
- Cloudflare Access, 내장 로그인, 또는 직접 운영하는 auth proxy
- 스스로 업데이트하는 의존성 없는 CLI(Node ≥ 18)
- AGPL-3.0, 요청 시 상용 라이선스

</td></tr>
</table>

## 스크린샷

<p align="center"><img src="docs/img/highlights.png" alt="Highlights: 이번 주 사용량, 작업 부하, 저녁 시간, 활동 시간을 각각 평이한 문장 하나와 sparkline으로" width="880"><br/><b>Highlights</b> — 한 주를 평이한 문장 네 개로; 관심 있는 것을 고정하세요</p>

| | |
|---|---|
| <img src="docs/img/usage.png" alt="사용량: 캘린더 heatmap과 호스트, 앱, 프로젝트, 모델별 내역" width="440"><br/>**사용량과 비용** — 1년을 한눈에, 그다음 하루로 들어가 보기 | <img src="docs/img/wellbeing.png" alt="You 카드: 상태, 작업 부하 수준, 오늘의 타임라인" width="440"><br/>**You** — 하루가 어떻게 흘러가는지, 이유와 함께 |
| <img src="docs/img/tasks.png" alt="내 응답 필요와 진행 중" width="440"><br/>**작업** — 당신을 기다리는 것, 실행 중인 것 | <img src="docs/img/overview-dark.png" alt="다크 테마의 dashboard" width="440"><br/>**다크 테마** — 기기 설정을 따르거나 직접 선택 |
| <img src="docs/img/usage-month.png" alt="사용량 월간 보기: 합계, 일별 누적 막대, 상위 프로젝트와 모델" width="440"><br/>**월간 보기** — 합계, 상위 프로젝트와 모델, 요일 × 시간 | <img src="docs/img/phone.png" alt="휴대폰에서 본 dashboard" width="220"><br/>**휴대폰에서** — 앱으로 설치하고 push 받기 |

<sub>스크린샷은 <code>scripts/demo-seed.ts</code>의 데모 데이터를 사용합니다.</sub>

## 이미 쓰는 도구와 함께 작동합니다

MCP를 쓰는 것이라면 무엇이든 작업을 보고할 수 있습니다. 명령을 실행하거나 HTTP를 보낼 수 있는 것도 마찬가지입니다.

| 클라이언트 유형 | 예시 | 연결 방법 | dashboard에 표시되는 것 |
|---|---|---|---|
| **CLI 에이전트** | Claude Code, Codex, Gemini CLI, Antigravity (agy), opencode, grok, kilo | 설정 스크립트가 등록하는 `siiswell mcp`(stdio), 또는 bearer 헤더를 쓰는 원격 MCP | 작업; Claude Code / Codex hooks를 쓰면 "당신을 기다리는 중"과 당신의 속도도 |
| **데스크톱 앱과 IDE** | Claude Desktop, ChatGPT desktop app, Codex IDE extension | stdio MCP 서버(`siiswell mcp`) | 작업 |
| **모든 원격 MCP 클라이언트** | Streamable HTTP + 사용자 지정 헤더를 지원하는 모든 것 | `Authorization: Bearer <token>`과 함께 `POST /mcp` | 작업 |
| **클라우드 에이전트** | Manus, Grok (API remote MCP), OpenAI Dots, ChatGPT custom connectors | bearer token / API key 헤더와 함께 `https://<your-dashboard>/mcp`를 사용자 지정 MCP 서버로 추가([자세히](#클라우드-에이전트-manus-grok-dots-chatgpt)) | 작업 |
| **스크립트, cron, CI** | 빌드 작업, 긴 마이그레이션, 야간 작업 | `siiswell report` / `update` / `heartbeat` | 작업과 heartbeat |
| **Raw HTTP / API** | 모든 언어 | `/mcp`로 JSON-RPC; ingest endpoint는 [OpenAPI](docs/openapi.yaml)(영어) 참고 | 작업, 사용량, 호스트 상태 |
| **에이전트 orchestrator** | 직접 만든 agent runner, 자동화 서버 | 호스트 연동 endpoint `/api/ingest/{snapshot,events,heartbeat}`; `.siiswell-agents` 마커가 hooks를 그 작업 공간에서 제외 | 호스트, 프로젝트, 에이전트, 작업, 이벤트 |
| **Token 사용량** | Claude Code와 Codex 로그 | 일정에 따라 `siiswell usage push` | token과 API 환산 비용 |
| **OpenTelemetry** | Claude Code metrics | `/api/ingest/otlp`로 OTLP/HTTP JSON(선택 사항) | token과 비용 |

앱별 설정 예시와 지원 상태: [CLIENTS.md](CLIENTS.md)(영어). 단계별 설치: [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md).

## 빠른 시작

### 자주 보게 될 용어

| 용어 | 뜻 |
|---|---|
| **서버** | dashboard 자체: 보고를 저장하고 페이지를 보여 주는 Docker 컨테이너 하나(또는 Cloudflare Worker) |
| **클라이언트** | 에이전트가 실행되는 각 컴퓨터에 설치하는 작은 `siiswell` 프로그램 |
| **MCP** | AI 에이전트가 도구를 호출하는 표준 방식; siiswell은 에이전트에게 "내 작업 보고" 도구를 제공합니다 |
| **클라이언트 token** | 에이전트 앱 하나(예: 노트북의 Claude Code)가 작업을 보고할 수 있게 해 주는 키 |
| **호스트 token** | 컴퓨터 한 대의 usage collector가 token 수를 보낼 수 있게 해 주는 키; 이름은 그 컴퓨터의 레이블과 같아야 합니다 |
| **Hooks** | Claude Code / Codex가 이벤트(프롬프트, 권한 요청)마다 실행하는 작은 명령으로, "당신을 기다리는 중"에 쓰입니다 |

### 나에게 맞는 방식은?

| | **Docker** (대부분에게 권장) | **Cloudflare** (이미 Workers를 쓰는 분께) |
|---|---|---|
| 실행 위치 | Docker가 있는 모든 기기: 홈 서버, VPS, NAS | 당신의 Cloudflare 계정(보통 무료 플랜으로 충분) |
| 로그인 | 내장: `.env`의 관리자 비밀번호 하나 | Cloudflare Access(Google / GitHub / 이메일 로그인) |
| 휴대폰 push | 가능, HTTPS 주소가 생기면 | 가능 |
| 첫 작업까지 걸리는 시간 | 기기 한 대에서 약 10분; HTTPS까지 약 30분 | 약 30분 |

### Docker, 단계별로

필요한 것: 서버용으로 Docker와 Docker Compose가 있는 기기 하나, 그리고 연결하려는 에이전트가 있는 각 컴퓨터에
Node.js 18+와 [Bun](https://bun.sh). 다른 컴퓨터나 휴대폰에서 쓰려면 HTTPS 주소도 필요합니다(3단계).

**1. 받아서 비밀번호 설정하기** (서버 기기에서)

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
cp .env.example .env && chmod 600 .env
```

처음 써 볼 때는 `.env`에서 두 줄만 중요합니다:

```dotenv
# the address you open; your https://… address after step 3
PUBLIC_URL=http://localhost:8787
# 12+ characters; to change it: edit, then docker compose up -d
ADMIN_PASSWORD='a long password you keep'
```

**2. 시작하고 확인하기**

```sh
docker compose up -d --build
docker compose ps
curl -s http://localhost:8787/api/health
```

몇 초 뒤 `docker compose ps`에 **healthy**가 표시되고 health check가 `{"ok":true,…}`로 응답합니다.
<http://localhost:8787>을 열고 로그인하세요. 시작되지 않으면 `docker compose logs siiswell`이 고쳐야 할 설정을 모두
보여 줍니다. 브라우저가 없는 원격 서버라면 먼저 노트북에서 터널을 여세요:
`ssh -L 8787:127.0.0.1:8787 you@your-server`, 그다음 노트북에서 <http://localhost:8787>을 엽니다.

**3. HTTPS 주소 붙이기** (다른 컴퓨터와 휴대폰에 필요)

컨테이너는 `127.0.0.1:8787`에서만 수신합니다. 그 앞에 HTTPS reverse proxy를 두세요. 예를 들어
[Caddy](https://caddyserver.com/)는 인증서를 스스로 받아 옵니다:

```text
# /etc/caddy/Caddyfile  (point the DNS name at this machine first)
dash.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

그다음 `.env`에:

```dotenv
PUBLIC_URL=https://dash.example.com
# the proxy reaches the container from this address
TRUSTED_PROXY_CIDRS=172.28.0.1/32
```

그리고 `docker compose up -d`. 도메인이 없나요? Tailscale 같은 VPN의 비공개 HTTPS 이름도 됩니다. 다른 방법:
[docs/deploy.md](docs/deploy.md#deploy-with-docker)(영어).

**4. 휴대폰 push** (선택 사항)

```sh
docker compose exec siiswell bun scripts/vapid.ts mailto:you@example.com
```

출력되는 `VAPID_…=` 세 줄을 `.env`에 붙여 넣고 `docker compose up -d`. iPhone에서는 Safari로 dashboard를 열고
공유 → **홈 화면에 추가**를 고른 뒤, 거기서 열어 **알림 켜기**를 누르세요.

**5. token 만들기** (서버에서; 각 token은 한 번만 출력되므로 6단계를 위해 창을 열어 두세요)

```sh
docker compose exec siiswell bun scripts/new-token.ts laptop-1-claude client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1-codex client --apply
docker compose exec siiswell bun scripts/new-token.ts laptop-1 host --apply
```

사용하는 에이전트 앱마다 client token 하나(여기서는 Claude Code와 Codex), 컴퓨터마다 host token 하나를 만듭니다.
호스트 token의 이름(`laptop-1`)이 6단계에서 입력할 기기 레이블입니다.

**6. 컴퓨터 연결하기** (각 노트북이나 데스크톱에서)

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```

dashboard URL(`https://dash.example.com`), 기기 레이블(`laptop-1`), 연결할 앱, 그리고 앱마다 token 하나를
묻습니다(입력은 숨겨집니다). `~/.local/bin`에 `siiswell` 명령을 설치하고, 에이전트에 보고 규칙을 추가하며,
hooks와 시간별 usage collector도 추가할 수 있습니다. 마지막에 `doctor claude-code: ok`가 보이면 됩니다.

시험해 보세요(`siiswell`을 찾을 수 없다면 먼저 새 터미널을 여세요). 작업이 **진행 중**에 나타나고, `siiswell tasks`가
그것을 보여 주며, 마지막 줄이 작업을 닫습니다:

```sh
ID=$(siiswell report "Try the dashboard" --kind testing --eta-min 5 | tail -1)
siiswell tasks
siiswell update "$ID" --status DONE
```

또는 에이전트에게 연결 확인을 맡기세요([프롬프트 3](#에이전트용-복사-붙여넣기-프롬프트)).

### 계속 운영하기

| 할 일 | 명령 |
|---|---|
| 서버 업데이트 | `git pull && docker compose up -d --build` (데이터베이스 변경은 자동으로 적용됩니다) |
| 컴퓨터의 클라이언트 업데이트 | `siiswell update` (task id 없이 실행하면 dashboard가 게시하는 버전을 설치합니다) |
| 중지 / 시작 | `docker compose down` / `docker compose up -d` (데이터는 유지됩니다) |
| 백업 | `docker compose stop`, `siiswell-data` volume에서 `/data/siiswell.sqlite`를 복사(`docker volume ls`로 전체 이름 확인), `docker compose start`. 백업은 `.env`만큼 비공개로 보관하세요: 비밀번호 해시가 들어 있습니다 |

⚠️ `docker compose down -v`는 volume, 즉 모든 데이터를 삭제합니다.

<details>
<summary><b>Cloudflare (Worker + D1)</b></summary>

```sh
bun install
bunx wrangler d1 create siiswell
```

출력된 `database_id`를 `wrangler.toml`에 넣은 뒤:

```sh
bunx wrangler d1 migrations apply siiswell --remote
bun run deploy
bun scripts/new-token.ts laptop-1-claude client
```

마지막 명령은 token과 `wrangler d1 execute` 줄을 출력합니다. 그 줄을 실행하면 token이 등록됩니다.

Cloudflare Access로 페이지를 보호하세요. 설정이 끝나기 전까지 dashboard는 누구에게도 데이터를 보여 주지 않습니다. 외부와
닿는 모든 단계가 표시된 전체 체크리스트는 [docs/deploy.md](docs/deploy.md)에 있습니다. 그다음 6단계처럼 컴퓨터를 연결하세요.
</details>

## 에이전트용 복사-붙여넣기 프롬프트

보고는 에이전트가 하므로, 에이전트에게 알려 줘야 합니다. 이 프롬프트들은 어떤 에이전트에 붙여 넣어도 안전합니다: 어느 것도
token을 요구하거나 포함하지 않습니다. **token을 채팅에 붙여 넣지 마세요**: token은 설정 파일이나 connector 설정에 넣습니다.

에이전트는 아래의 영어 프롬프트를 그대로 이해합니다. 원하면 한국어로 바꿔 써도 됩니다.

<details open>
<summary><b>1. 보고 규칙</b> (각 에이전트의 전역 지침에 넣으세요; <code>setup-client.sh</code>가 대신 해 줍니다)</summary>

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
<summary><b>2. "이 기기의 siiswell 업데이트하기"</b></summary>

```text
Update the siiswell client on this machine: run `siiswell update --yes`, then `siiswell doctor`.
Tell me the installed version and any line of the doctor output that is not [ok] or [--].
Do not print, read or change any token or config file.
```
</details>

<details>
<summary><b>3. "siiswell이 작동하는지 확인하기"</b></summary>

```text
Check the siiswell connection: call the siiswell `report_task` tool with title "Connection check",
kind "testing", status IN_PROGRESS and eta_min 1, then call `update_task` with status DONE for the
task_id you got. Tell me whether both calls succeeded.
```
</details>

<details>
<summary><b>4. 새 기기 설정하기</b> (이것은 직접 실행하세요: token을 숨김 입력으로 묻습니다. Node.js 18+와 Bun이 필요합니다)</summary>

```sh
git clone https://github.com/jcaol/siiswell.git siiswell && cd siiswell
bun install && bun run build:cli
scripts/setup-client.sh
```
</details>

### 클라우드 에이전트 (Manus, Grok, Dots, ChatGPT)

벤더의 클라우드에서 실행되는 에이전트는 로컬 `siiswell` 프로세스를 시작할 수 없지만, 대부분 **HTTPS를 통한 원격 MCP
서버**를 호출할 수 있으며, `https://<your-dashboard>/mcp`가 바로 그것입니다.

| 에이전트 | siiswell에 필요한 것 | 상태 |
|---|---|---|
| **Manus** | 사용자 지정 MCP 서버: URL + `Authorization: Bearer <token>` (Settings → Integrations → Custom MCP) | 작동할 것으로 보이나 아직 저희가 테스트하지 않음 |
| **Grok** | Grok Build CLI: `siiswell mcp` 또는 원격 URL([CLIENTS.md](CLIENTS.md#6-grok)); Grok API: bearer 헤더를 쓰는 remote MCP tool | CLI는 문서화됨; API는 아직 테스트하지 않음 |
| **OpenAI Dots** | HTTPS로 접근 가능한 원격 MCP 서버 | 벤더가 아직 MCP 지원을 문서화하지 않음; 문서화되면 시도해 보세요 |
| **ChatGPT custom connectors** | 원격 MCP 서버; 플랜과 인증 옵션은 벤더에 따라 다름 | bearer token / API key를 설정할 수 있는 경우에만 작동; OAuth 전용 설정은 아직 지원하지 않음 |

1. 클라우드 에이전트마다 별도의 클라이언트 token을 만드세요(`new-token.ts <name> client`). 그래야 따로 폐기할 수 있습니다.
2. 에이전트의 connector 설정에 URL과 헤더 `Authorization: Bearer <token>`을 입력하세요.
3. 에이전트의 사용자 지정 지침에 보고 규칙(프롬프트 1)을 추가하세요.

알아 두면 좋은 점: dashboard는 인터넷에서 HTTPS로 접근할 수 있어야 합니다(Cloudflare Access 뒤에서는 token 요청에 대해
`/mcp`가 이미 우회 처리됩니다). 클라우드 에이전트는 로컬 클라이언트를 실행하지 않으므로, 제목은 **서버**에서만 제한되고
정리됩니다(`ACCEPT_TASK_TEXT`). Claude Code hooks와 usage collector는 여기에 적용되지 않습니다.

## 개인정보: 내 기기에서 무엇이 나가는가

siiswell은 당신과 에이전트가 무언가를 **했다는 사실**만 기록하고, **무엇을** 했는지는 기록하지 않습니다.

| 당신의 서버로 보내는 것 | 절대 보내지도, 저장하지도 않는 것 |
|---|---|
| 작업 상태, ETA, 고정된 `kind`(coding, docs, …) | 프롬프트, 응답, 대화 |
| 정리되고 60자로 잘린 짧은 작업 제목(기본값 `brief`; `minimal` 또는 `none`은 더 적게 보냄) | 코드, diff, 파일 내용, 도구 출력 |
| 시간·모델·앱별 token 수 | 도구 인자, 명령 텍스트 |
| 당신 자신의 상호작용 시각과 유형(프롬프트, 허용한 권한) | 작업 디렉터리와 로컬 경로 |
| 프로젝트 레이블: 표시할 이름을 지정하지 않으면 salted hash | 실제 프로젝트 이름(직접 허용하지 않는 한) |

- 텍스트에서 비밀 정보(token, key, 비밀번호, URL)를 **클라이언트에서, 그리고 서버에서 다시** 제거하며, 서버는 자체
  상한(`ACCEPT_TASK_TEXT`, `ACCEPT_HOST_TEXT`)을 적용하므로 클라이언트가 허용한 것보다 많이 보낼 수 없습니다.
- 기기와 앱마다 고유한 token이 있어, 잃어버린 token 하나만 폐기하면 됩니다.
- 로컬 대화 기록을 읽는 명령은 `siiswell permissions suggest` 하나뿐입니다. 아무것도 보내지 않고 allowlist 키만
  출력합니다.
- Self-hosted: 데이터는 당신의 Cloudflare 계정이나 컨테이너에 머물며, 기본 보존 기간은 30일입니다.

자세한 내용: [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md)와 [SECURITY.md](SECURITY.md).

## Zero AI

siiswell은 AI 모델을 호출하지 않으며, 당신의 플랜이나 token을 쓰지 않습니다. dashboard, CLI, hooks, MCP 서버,
collector는 로컬 카운터를 읽고 작은 보고를 보낼 뿐입니다. 모든 규칙은 코드에서 읽을 수 있는 고정 임계값이므로,
페이지의 모든 알림과 숫자를 설명할 수 있습니다.

## FAQ

<details>
<summary><b>에이전트에 특별한 지원이 필요한가요?</b></summary>

아니요. MCP 도구를 쓸 수 있는 에이전트라면 작업을 보고할 수 있습니다: 서버와 짧은 지침 규칙을 추가하세요
([CLIENTS.md](CLIENTS.md#the-instruction-rule-put-this-in-each-agents-global-instructions)). MCP가 없다면
`siiswell` CLI나 일반 HTTP 호출을 쓰세요.
</details>

<details>
<summary><b>Manus, Grok, Dots, ChatGPT 같은 클라우드 에이전트에서도 작동하나요?</b></summary>

작업 보고는, 에이전트가 bearer token 또는 API key 헤더로 원격 MCP 서버를 추가할 수 있다면 가능합니다:
[클라우드 에이전트](#클라우드-에이전트-manus-grok-dots-chatgpt)를 참고하세요. token 사용량과 "You" 신호는 로컬 로그와 hooks에서
오므로, 당신의 기기에서 실행하는 에이전트에만 해당합니다.
</details>

<details>
<summary><b>에이전트가 느려지거나 token이 드나요?</b></summary>

거의 없습니다. 도구 호출 하나는 몇백 바이트이며, 약 10분보다 긴 작업에서만 이루어집니다. hooks는 즉시 반환하고
네트워크 작업은 백그라운드에서 합니다. dashboard 자체는 AI token을 쓰지 않습니다.
</details>

<details>
<summary><b>에이전트가 보고를 잊거나 중단되면 어떻게 되나요?</b></summary>

각 클라이언트에는 "마지막 보고" 경과 시간이 표시됩니다. 24시간 동안 업데이트가 없는 작업은 오래된 작업으로 닫히고
`siiswell tasks`에 표시됩니다. Claude Code hooks는 에이전트에 의존하지 않고 "당신을 기다리는 중"과 세션 종료를 보고합니다.
</details>

<details>
<summary><b>비용은 얼마나 정확한가요?</b></summary>

**API 환산** 가격입니다: 로컬 로그의 token 수에 모델별 가격표(`src/shared/model-prices.json`, 기기별로 덮어쓰기 가능)를
곱한 값입니다. 구독 플랜에서는 실제로 지불하는 금액이 아니라, 같은 작업을 API로 했을 때의 비용을 보여 줍니다.
</details>

<details>
<summary><b>에이전트 orchestrator를 운영합니다. 그 에이전트들이 "나"로 집계되나요?</b></summary>

프로젝트를 표시해 두면 그렇지 않습니다. 프로젝트 루트에 `.siiswell-agents` 파일을 두거나(그 에이전트들은
`<project>/worktrees/...`에서 작업) `SIISWELL_AGENT=1`로 에이전트를 시작하세요. 그러면 hooks는 그곳에서 아무것도 기록하지 않고
MCP 쓰기 도구는 로컬에서 응답하므로, 당신 자신의 세션만 집계되고 작업은 orchestrator의 호스트 연동이 보고합니다.
[Agent workspaces](docs/INSTALL-CLIENTS.md#agent-workspaces-run-by-an-orchestrator)를 참고하세요.
</details>

<details>
<summary><b>"You" 카드는 건강 관리 도구인가요?</b></summary>

아니요. 고정 임계값으로 타임스탬프와 이벤트를 셀 뿐이며, 페이지에도 그렇게 적혀 있습니다. 긴 하루를 판단하려는 것이 아니라
보이게 하려는 것입니다. 모든 권유는 끌 수 있습니다.
</details>

<details>
<summary><b>siiswell은 팀용인가요?</b></summary>

지금의 siiswell은 한 사람을 위해 만들어졌습니다: 설치 하나에 소유자 한 명(single-tenant; 클라이언트 token은 앱을
식별할 뿐 tenant 경계가 아닙니다. [SECURITY.md](SECURITY.md) 참고). 팀 기능, 즉 에이전트와 LLM 비용을 함께 보는
화면(각자의 well-being 데이터는 본인만 볼 수 있게 유지)은 로드맵에 있습니다.
</details>

<details>
<summary><b>"SI is well, I am well"은 무슨 뜻인가요?</b></summary>

SI는 super intelligence, 즉 당신을 위해 일하는 AI 에이전트를 뜻합니다. "SI is well"은 에이전트가 순조롭게 돌아가고
있다는 뜻이고, "I am well"은 당신이 과부하 상태가 아니라는 뜻입니다. siiswell은 둘 다 지켜봅니다.
</details>

<details>
<summary><b>운영 비용은 얼마인가요?</b></summary>

Cloudflare에서 개인 설치는 D1 무료 플랜 한도 안에 충분히 들어갑니다
([추정치](docs/reference.md#d1-quota-estimate-5-projects)). Docker에서는 작은 컨테이너 하나와 SQLite 파일 하나입니다.
</details>

<details>
<summary><b>어떻게 업데이트하나요?</b></summary>

Docker: `git pull && docker compose up -d --build`(데이터베이스 변경은 시작할 때 적용됩니다). Cloudflare: pull, 새
마이그레이션 적용, 배포([docs/upgrade.md](docs/upgrade.md)). 클라이언트: `siiswell update`가 dashboard가
게시하는 CLI 버전을 설치합니다. dashboard는 뒤처진 클라이언트 아래에 작은 안내를 표시합니다.
</details>

## 문서

| 주제 | 위치 |
|---|---|
| 배포: 로컬 개발, Cloudflare 체크리스트, Docker | [docs/deploy.md](docs/deploy.md) |
| 기존 설치 업그레이드 | [docs/upgrade.md](docs/upgrade.md) |
| CLI, hooks, usage collector 설치 | [docs/INSTALL-CLIENTS.md](docs/INSTALL-CLIENTS.md) |
| 앱별 MCP 설정, 모든 연결 방법 | [CLIENTS.md](CLIENTS.md) |
| 통신 프로토콜과 endpoint | [docs/api.md](docs/api.md), [docs/openapi.yaml](docs/openapi.yaml) |
| OpenTelemetry ingest | [docs/otel.md](docs/otel.md) |
| 페이지에 표시되는 것, 규칙, 주기, 한도, quota | [docs/reference.md](docs/reference.md) |
| 보안 모델과 취약점 신고 | [SECURITY.md](SECURITY.md) |

## 개발

```sh
bun install
bun run typecheck
NODE_ENV=test bun test
bun run dev
```

`bun run dev`는 <http://localhost:8787>에서 로컬 Worker를 시작하고, `bun scripts/demo-seed.ts --help`는 스크린샷에
쓰인 데모 데이터를 설명합니다.

[CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요. 보안 문제: [SECURITY.md](SECURITY.md). 변경 내역: [CHANGELOG.md](CHANGELOG.md).

## 라이선스

| 부분 | 라이선스 | 이유 |
|---|---|---|
| 서버와 페이지(아래에 나열되지 않은 모든 것) | [AGPL-3.0-only](LICENSE) | 호스팅된 siiswell의 개선 사항이 공개로 유지됩니다 |
| 클라이언트: `cli/`, `bridge/`, `src/shared/`(CLI에 번들되는 코드) | [Apache-2.0](LICENSE-APACHE) | 회사 노트북을 포함해 어떤 기기에도 라이선스 걱정 없이 설치할 수 있습니다 |

AGPL 부분에 대한 상용 라이선스는 요청 시 제공됩니다: [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)를 참고하세요
([license@siiswell.com](mailto:license@siiswell.com)). 그 밖의 문의: [hello@siiswell.com](mailto:hello@siiswell.com). 기여는 [Contributor License Agreement](CLA.md)에 따라 환영합니다([CONTRIBUTING.md](CONTRIBUTING.md) 참고).
각 클라이언트 소스 파일에는 `SPDX-License-Identifier: Apache-2.0` 줄이 있습니다. 저작권 및 라이선스 요약: [NOTICE](NOTICE).

<div align="center"><sub>© 2026 <a href="https://siiswell.com">siiswell.com</a> · <a href="https://github.com/jcaol/siiswell">GitHub</a> · <a href="mailto:hello@siiswell.com">문의</a></sub></div>
