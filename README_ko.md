# Agent Swarm Director (`agent-swarm-director` / ASD v2.3)

[English](./README.md) | **한국어** | [📋 패치 노트](./PATCH_NOTES_ko.md) | [📋 Patch Notes (EN)](./PATCH_NOTES.md)

> **외부 의존성 0개(Zero-Dependency)로 Claude Code, OpenCode, Codex CLI, Antigravity, Cursor CLI 5개 AI 코딩 하네스를 통합 제어하는 범용 멀티 에이전트 오케스트레이션 하네스**

**Agent Swarm Director (ASD v2.3)**는 기존 Antigravity 전용이었던 `agy-agent-swarm-director`를 5대 AI 코딩 하네스 전체에서 동작하도록 확장한 범용 멀티 에이전트 컨트롤 플레인입니다. 외부 npm 런타임 패키지를 단 하나도 사용하지 않고(`dependencies: {}`), 순수 Node.js(`>=22.13.0`) 네이티브 TypeScript 실행과 내장 `node:sqlite`(WAL 모드)만으로 동작합니다.

---

## 핵심 기능

- **외부 런타임 의존성 0개 (`dependencies: {}`)**
  - 무거운 서드파티 패키지나 빌드 과정 없이 Node.js `>=22.13.0`의 네이티브 TypeScript 실행(`--no-warnings`)과 표준 라이브러리(`node:sqlite` 등)만으로 즉시 구동됩니다.
- **5대 AI 하네스 통합 컨트롤 플레인**
  - **Claude Code** (`claude`)
  - **OpenCode** (`opencode`)
  - **Codex CLI** (`codex`)
  - **Antigravity** (`agy`)
  - **Cursor CLI** (`agent` / `cursor-agent`, `@cr`)
- **빈자리만 채우는 지능형 MCP 및 스킬 동기화 (`asd sync`)**
  - 프로젝트 폴더를 오염시키지 않고 글로벌 사용자 홈 디렉토리(`~/.claude`, `~/.config/opencode`, `~/.codex`, `~/.gemini`, `~/.cursor`)에만 핵심 스킬(`/asd`, `/asd-plan`, `/asd-run`, `/asd-debate`, `/asd-debug`, `/handoff` / `/asd-handoff`), 5개 핵심 에이전트 페르소나(`planner`, `architect`, `worker`, `scout`, `critic`), 보안 훅(`PreToolUse`, `Stop`), MCP 서버를 자동 설치합니다.
  - **중복 방지(Gap-Filling) 주입**: 각 하네스가 기본 내장한 기능(예: OpenCode의 내장 `lsp`, Claude Code·Codex·Antigravity의 내장 `websearch`)이나 사용자가 이미 등록해 둔 MCP는 건너뛰고, **해당 하네스에 없는 도구만 자동으로 채워 넣습니다.**
- **이중 트랙(Dual-Track) 실행 (`LIGHT` 현재 하네스 모드 vs `HEAVY` 다중 하네스 모드)**
  - **LIGHT 트랙 (현재 하네스 전용)**: 소규모 작업은 현재 메인 AI가 직접 인플레이스(In-place)로 처리하고, 다중 작업은 **현재 하네스 내부의 자체 서브에이전트**로 처리(`claim_only`)하며 외부 하네스 CLI를 띄우지 않습니다. 완료 시 자동 체크포인트 커밋을 생성하고 실패 시 즉시 롤백합니다.
  - **HEAVY 트랙 (다중 하네스 병렬)**: 독립된 Git 워크트리(`.asd/wt/<turn>-<taskId>`)를 생성하고 여러 외부 하네스(`claude-code`, `opencode`, `codex`)를 동시에 스폰하여 병렬 실행한 뒤 뮤텍스(Mutex) 잠금 하에 안전하게 `--no-ff` 병합을 수행합니다.
- **블라인드 교차 모델 적대적 토론 (`asd debate`)**
  - 서로 다른 모델 패밀리(`claude`, `gpt`, `gemini`, `glm`)를 병렬 호출하여 1라운드 블라인드 비평을 수행하고, 2라운드 심판(`arbiter`) 판결을 통해 도출된 필수 제약 사항을 작업 인수 조건(`acceptance`)에 자동 주입합니다. (MCP 60초 타임아웃 제한이 없는 CLI 직접 실행 방식)
- **1ms Fail-Closed 보안 가드 & 서브에이전트 실드(Subagent Shield)**
  - 대소문자 우회(`.GIT/config`, `.Asd/meta.json`, `.ENV`)까지 차단하는 정규화 경로 검증으로 허용된 파일(`allowedFiles`) 외부 수정을 원천 차단합니다.
  - 서브에이전트가 오케스트레이션 도구를 재귀 호출하거나 무한 루프에 빠지는 것을 방지합니다.

---

## 요구 사항

- **Node.js**: `>=22.13.0`
- **Git**: `>=2.30.0`

---

## 빠른 시작 (Quick Start)

### A. 전역 `PATH` 자동 등록 시 (기본값)
```bash
# 1. 최초 1회 설치: 4개 하네스 글로벌 설정 동기화 및 전역 PATH에 'asd' 명령어 자동 등록
node --no-warnings src/cli/index.ts sync

# 2. 이후부터는 어느 프로젝트 폴더에서든 'asd' 명령어를 바로 실행할 수 있습니다!
asd doctor
asd status
asd plan get
asd dispatch --turn 1
asd verify --task T1.1 --files "src/index.ts" --summary "기능 구현 완료"
asd debate --topic "아키텍처 설계" --proposal "SQLite WAL 모드 도입"
asd logs
asd logs T1.1
asd ui

# 3. 전체 자동화 테스트 스위트 실행
npm test
```

### B. 전역 `PATH` 미등록 시 (`--no-path` 사용 시)
```bash
# 1. 전역 PATH에 'asd'를 등록하지 않고 4개 하네스 글로벌 설정만 동기화
node --no-warnings src/cli/index.ts sync --no-path

# 2. Node.js로 CLI 엔트리포인트를 직접 지정하여 실행
node --no-warnings src/cli/index.ts doctor
node --no-warnings src/cli/index.ts status
node --no-warnings src/cli/index.ts plan get
node --no-warnings src/cli/index.ts dispatch --turn 1
node --no-warnings src/cli/index.ts verify --task T1.1 --files "src/index.ts" --summary "기능 구현 완료"
node --no-warnings src/cli/index.ts debate --topic "아키텍처 설계" --proposal "SQLite WAL 모드 도입"
node --no-warnings src/cli/index.ts logs
node --no-warnings src/cli/index.ts logs T1.1
node --no-warnings src/cli/index.ts ui
```

---

## 에디터/채팅창 내 AI 스킬 명령어 (`/asd*`, `/handoff`)

`asd sync`를 실행하면 **Claude Code**, **OpenCode**, **Codex CLI**, **Antigravity** 채팅창에서 아래 슬래시(`/`) 스킬 명령어를 바로 호출하여 사용할 수 있습니다.

> **사전 1회 통합 브리핑 원칙**: 모든 `/asd*` 스킬은 실제 파일 수정이나 서브에이전트 실행 전에 **단 한 번만** 다음 내용을 묶어서 브리핑하고 확인을 받습니다:
> 1. **수행할 작업 요약 및 설명**: 변경할 대상 파일, 작업 순서, 예상 영향을 요약합니다.
> 2. **다중 하네스 사용 여부 선택 (`LIGHT` vs `HEAVY`)**:
>    - **`LIGHT` 모드 (현재 하네스만 사용)**: 소규모 작업은 메인 AI가 직접 처리하고, 병렬/위임 작업은 현재 하네스 내부의 자체 서브에이전트만 사용합니다(외부 하네스 동시 실행 안 함).
>    - **`HEAVY` 모드 (여러 하네스 동시 사용)**: 격리된 Git 워크트리(`.asd/wt/`)에서 Claude Code, OpenCode, Codex 등 여러 외부 하네스를 동시에 스폰해 병렬로 처리합니다.
> 3. **추가 확인 질문**: 모호한 요구사항이 있다면 여러 번 나누지 않고 이 브리핑에서 한 번에 질문합니다.

| 스킬 명령어 | 주요 역할 | 상세 작동 방식 및 사용 시점 |
| :--- | :--- | :--- |
| **`/asd <요청내용>`** | **전 과정 자율 수행 (계획 → 실행 → 검증)** | 코드베이스 탐색 후 **1회 사전 브리핑(할 일 요약 + `LIGHT`/`HEAVY` 선택 + 질문)**을 거쳐 `.asd/PLAN.md`를 생성하고, Turn(Wave) 단위로 구현(`asd dispatch`) 및 테스트/경계 검증(`asd verify`)을 끝까지 수행한 뒤 실시간 진행 보드와 `.asd/summary.md`를 출력합니다. |
| **`/asd-plan <요청내용>`** | **작업 계획 수립 전용 (코드 수정 안 함)** | 읽기 전용으로 코드를 분석하고 **1회 사전 브리핑(`LIGHT` vs `HEAVY` 선택 및 요구사항 확인)**을 거친 뒤 `.asd/PLAN.md`와 SQLite 태스크 목록만 생성하고 멈춥니다. 생성된 `.asd/PLAN.md`를 직접 검토/수정한 뒤 `/asd-run`으로 실행할 때 사용합니다. |
| **`/asd-run`** | **생성된 `.asd/PLAN.md` 실행 및 재개** | 사용자가 `.asd/PLAN.md`에서 수정한 내용을 역동기화(`asd plan sync_from_md`)한 뒤, 실행할 작업 요약과 `LIGHT`/`HEAVY` 모드를 확인받고 미완료(`[ ]`) 또는 에스컬레이션(`[~]`)된 태스크들을 순서대로 실행합니다. |
| **`/asd-debug <증상/오류>`** | **재현 우선 체계적 디버깅** | 에러 로그와 코드를 분석해 **1회 사전 브리핑(원인 가설 + 수정 계획 + `LIGHT`/`HEAVY` 선택)**을 제시한 뒤, 실패를 재현하는 테스트를 먼저 작성(**Rule Zero**)하고 최소 수정 적용 및 전체 회귀 테스트 통과 후 `asd verify`로 체크포인트 커밋을 생성합니다. |
| **`/asd-debate <주제/설계안>`** | **이기종 모델 블라인드 적대적 토론** | 논쟁이 되는 아키텍처/설계안을 요약하고 **여러 하네스(`HEAVY` — Claude, GPT, GLM 등 교차 블라인드 비평)**를 쓸지 **현재 하네스(`LIGHT` — `--harness <현재하네스>`)**만 쓸지 확인한 뒤, 1라운드 블라인드 비평 및 2라운드 심판(`arbiter`) 판결을 통해 합의안과 필수 제약 사항을 도출합니다. |
| **`/handoff`** (또는 **`/asd-handoff`**) | **다중 하네스 세션 인수인계 문서 생성** | 현재까지의 사용자 요청, 완료된 작업, Git 및 테스트 상태, 활성 ASD 세션/`.asd/PLAN.md` 진행 현황(`asd status`), 핵심 의사결정과 제약 사항을 정리하여 루트 경로에 `handoff.md`로 저장합니다. 새 세션이나 다른 하네스(Claude Code ↔ OpenCode ↔ Codex ↔ Antigravity)로 전환해 이어서 작업할 때 사용합니다. |

### `LIGHT` 모드 vs `HEAVY` 모드 비교

| 구분 | `LIGHT` 모드 (현재 하네스 전용) | `HEAVY` 모드 (다중 하네스 동시 사용) |
| :--- | :--- | :--- |
| **실행 주체** | 소규모 작업은 **현재 메인 AI가 직접 처리**, 위임 작업은 **현재 하네스 내 다중 서브에이전트** 사용 (`claim_only`) | `routing.jsonc`에 따라 **여러 외부 하네스 CLI(`claude`, `opencode`, `codex`)를 동시에 백그라운드 스폰** (`parallel_spawn`) |
| **워크스페이스** | 현재 브랜치에서 직접 수정 후 태스크별 자동 체크포인트 커밋 (실패 시 즉시 롤백) | 태스크별 독립 Git Worktree(`.asd/wt/<turn>-<taskId>`) 격리 실행 후 자동 검증 및 병합 |
| **추천 상황** | 일반적인 기능 추가/수정, 단일 하네스만 쓰고 싶을 때(타 하네스 쿼터 소모 방지) | 프론트엔드+백엔드 대규모 동시 구현, 역할별 특화 하네스 조합이 필요할 때 |

---

## CLI 명령어

> **참고:** `--no-path` 옵션으로 설치한 경우 `asd <명령어>` 대신 `node --no-warnings src/cli/index.ts <명령어>` 형태로 실행합니다.

| 명령어 (`PATH` 설정 시) | 명령어 (`PATH` 미설정 시) | 설명 |
| :--- | :--- | :--- |
| `asd sync [--force] [--no-path]` | `node --no-warnings src/cli/index.ts sync [--force] [--no-path]` | 4개 하네스의 글로벌 설정에 스킬, 10개 에이전트, 보안 훅, 부족한 MCP 도구를 동기화하고 전역 `PATH`에 `asd` 명령어를 자동 등록합니다 (`--no-path` 지정 시 `PATH` 등록 생략). |
| `asd plan [create\|get\|update\|sync_from_md]` | `node --no-warnings src/cli/index.ts plan [create\|get\|update\|sync_from_md]` | `.asd/PLAN.md`와 3-테이블 SQLite SSOT(`sessions`, `tasks`, `debates`) 간의 계획 생성, 조회, 수정 및 양방향 동기화(`sync_from_md`)를 수행합니다. |
| `asd dispatch [--turn <n>] [--mode <m>]` | `node --no-warnings src/cli/index.ts dispatch [--turn <n>] [--mode <m>]` | 선행 작업(`depends_on`)의 완료 결과(`DoneClaim`)를 컨텍스트로 자동 주입하며, MCP 타임아웃 없이 웨이브 단위로 서브에이전트를 병렬 디스패치합니다. |
| `asd verify --task <id> [--files <csv>]` | `node --no-warnings src/cli/index.ts verify --task <id> [--files <csv>]` | 수정 파일 경계(`allowedFiles`) 검증, 시크릿 유출 차단, 테스트 명령 실행 후 LIGHT 체크포인트 커밋 또는 HEAVY 워크트리 병합을 수행합니다. |
| `asd debate --topic <t> --proposal <p>` | `node --no-warnings src/cli/index.ts debate --topic <t> --proposal <p>` | 이기종 모델 간 병렬 블라인드 비평과 심판 합의를 실시간 진행 로그 스트리밍과 함께 수행합니다. |
| `asd status [--json]` | `node --no-warnings src/cli/index.ts status [--json]` | 현재 프로젝트의 SQLite 세션 상태, 실시간 TODO 진행 보드, 미적용 자동 스태시(auto-stash) 경고를 출력합니다. |
| `asd logs [taskId] [--json]` | `node --no-warnings src/cli/index.ts logs [taskId] [--json]` | 인자 없이 실행하면 가장 최근 서브에이전트 실행 로그를 자동 출력하며, `T1.1`(또는 `t1.1`)처럼 작업 번호를 지정하면 해당 작업의 서브에이전트 로그를 조회합니다. |
| `asd ui [--port <num>]` | `node --no-warnings src/cli/index.ts ui [--port <num>]` | 한국어/영어를 지원하는 외부 패키지 0개의 경량 로컬 웹 대시보드(`http://127.0.0.1:3847`)를 실행하여 실시간 진행률, 서브에이전트 로그/프롬프트 조회, 토론 판결문을 브라우저에서 제공합니다. |
| `asd doctor [--json]` | `node --no-warnings src/cli/index.ts doctor [--json]` | Node 버전, SQLite WAL, Git 저장소, 4대 하네스 CLI 바이너리 경로 및 Headless 지원 여부, `PreToolUse` 보안 차단 여부를 100ms 이내에 점검합니다. |
| `asd clean [--pop] [--all]` | `node --no-warnings src/cli/index.ts clean [--pop] [--all]` | 잔여 `.asd/wt/*` 워크트리와 `asd/*` 브랜치를 정리하고, `--pop` 옵션 사용 시 자동 스태시된 변경사항을 복원합니다. |
| `asd uninstall` | `node --no-warnings src/cli/index.ts uninstall` | ASD가 주입한 글로벌 훅, TOML 펜스 블록, 스킬, 에이전트, `PATH` 심(shim), `_asdManaged` MCP 항목만 외과적으로 제거하고 사용자의 기존 설정을 100% 보존합니다. |

---

## 내장 코드 인텔리전스 및 Gap-Filling MCP 서버

시간이 오래 걸리는 오케스트레이션 작업(`plan`, `dispatch`, `verify`, `debate`)은 MCP의 60초 타임아웃(`-32001`)을 원천 배제하기 위해 모두 **`asd` CLI를 통해 직접 실행**됩니다. 단발성 조회용 MCP 서버들은 각 하네스에 내장되어 있지 않은 기능만 골라서 자동 등록됩니다:

### 1. `lsp` (`src/mcp/lsp-server.ts`)
자체 CLI LSP가 없는 하네스에 자동으로 채워지는 내장 코드 인텔리전스 서버입니다 (자체 LSP가 내장된 OpenCode에서는 자동 생략):
- `lsp_diagnostics`: 정적 타입 및 문법 오류 진단 (`tsc`, `node --check`, 병합 충돌 마커 감지)
- `lsp_symbols`: 파일/디렉토리 내 심볼 선언 추출 (`function`, `class`, `interface`, `type`, `variable`, `struct`)
- `lsp_definition`: 심볼 정의부 위치(`file`, `line`, `column`) 정밀 탐색
- `lsp_references`: 프로젝트 전체에서 특정 심볼의 참조 위치(`file`, `line`, `column`, `isDefinition`) 탐색

### 2. 지식 검색용 Gap-Filling MCP (`presets/default-mcp.jsonc`)
- `context7` (`https://mcp.context7.com/mcp`): 외부 라이브러리 및 프레임워크의 최신 공식 문서/코드 예제 조회
- `grep_app` (`https://mcp.grep.app/mcp`): GitHub 공개 오픈소스 저장소 대상 초고속 정규식/코드 검색
- `websearch` (`https://mcp.exa.ai/mcp`): Exa 기반 실시간 웹 검색 (Claude Code, Codex, Antigravity처럼 자체 웹 검색이 내장된 하네스에서는 중복 등록 생략)

---

## 패치 노트 (Patch Notes)

- 📋 **[패치 노트 (한국어)](./PATCH_NOTES_ko.md)** — ASD v2.2 초기 구축부터 최신 기능(Cross-Scope 자동 후속 태스크, 실제 모델 전체 탐색 및 검색창, 런타임 제어 등)까지의 전체 패치 내역
- 📋 **[Patch Notes (English)](./PATCH_NOTES.md)** — Full chronological patch history in English

---

## 라이선스

[Functional Source License, Version 1.1, Apache 2.0 Future License (FSL-1.1-ALv2)](./LICENSE) © 2026 yjsjs0987
