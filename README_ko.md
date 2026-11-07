# Agent Swarm Director (`agent-swarm-director` / ASD v2.4.1)

[English](./README.md) | **한국어** | [🖥️ ASD-Nexus (공식 GUI)](https://github.com/yjsjs0987/ASD-Nexus) | [🏛️ 아키텍처 및 파일·함수 레퍼런스](./PROJECT_STATUS.md) | [🔌 외부 SDK 및 DB 레퍼런스](./EXTERNAL_SDK_REFERENCE.md) | [📋 패치 노트](./PATCH_NOTES_ko.md) | [📋 Patch Notes (EN)](./PATCH_NOTES.md)

> **외부 의존성 0개(Zero-Dependency)로 Claude Code, OpenCode, Codex CLI, Antigravity, Cursor CLI 5개 AI 코딩 하네스를 통합 제어하는 범용 멀티 에이전트 오케스트레이션 하네스 및 SDK**

**Agent Swarm Director (ASD v2.4.1)**는 5대 AI 코딩 하네스 전체에서 동작하는 범용 멀티 에이전트 컨트롤 플레인입니다. 외부 npm 런타임 패키지를 단 하나도 사용하지 않고(`dependencies: {}`), 순수 Node.js(`>=22.13.0`) 네이티브 TypeScript 실행과 내장 `node:sqlite`(WAL 모드)만으로 동작하며, 외부 GUI([**ASD-Nexus**](https://github.com/yjsjs0987/ASD-Nexus)) 연동을 위한 완전한 Node.js SDK를 제공합니다.

> [!TIP]
> ### 🖥️ 공식 GUI 프로젝트 안내 — **[ASD-Nexus](https://github.com/yjsjs0987/ASD-Nexus)**
> 5대 하네스의 로컬 CLI 세션을 한눈에 탐색하고, 대화 기록 4분류(Thinking / Tool Use / Tool Result / 응답) 열람, 실시간 스트리밍 대화, 클릭 한 번으로 일반 CLI ↔ ASD 세션 승격·하강까지 제어할 수 있는 공식 전용 GUI 애플리케이션입니다.  
> 👉 **[공식 GUI 저장소 바로가기: `https://github.com/yjsjs0987/ASD-Nexus`](https://github.com/yjsjs0987/ASD-Nexus)**

---

> [!IMPORTANT]
> ## 🚨 [구버전(v2.3.2 이하) 사용자 필수 안내] DB 자동 마이그레이션 툴 배포
>
> **ASD v2.3.3 / v2.4.0**부터 기존 프로젝트 해시별 분산 DB(`~/.asd/state/<12자리해시>/core.db`) 구조가 **단일 공유 SQLite DB(`~/.asd/state/core.db`)** 구조로 통합되었습니다.
>
> **v2.3.2 이하 구버전**을 사용 중이셨던 분들은 아래 구글 드라이브에서 **DB 자동 마이그레이션 툴(`asd-db-migrate.mjs`)**을 다운로드하여 실행하시면, 기존 세션·태스크·토론·드라이버 기록이 백업과 함께 최신 통합 DB로 안전하게 자동 이관됩니다.
>
> ### 👉 **[📥 ASD DB 자동 마이그레이션 툴 다운로드 (Google Drive)](https://drive.google.com/drive/u/0/folders/1knUQzIY8HDzIKYkxrhsCxgorQDn_B3nU)**
>
> ```bash
> # 기본 실행 (기존 공유 DB 자동 백업 후 레거시 DB 전체 자동 통합, 재실행 시 중복 자동 스킵)
> node asd-db-migrate.mjs
>
> # 선택 옵션: 이관 성공 후 기존 해시 폴더를 *.migrated 로 이름 변경 정리
> node asd-db-migrate.mjs --prune
> ```

---

## 핵심 기능

- **외부 런타임 의존성 0개 (`dependencies: {}`)**
  - 무거운 서드파티 패키지나 빌드 과정 없이 Node.js `>=22.13.0`의 네이티브 TypeScript 실행(`--no-warnings`)과 표준 라이브러리(`node:sqlite` 등)만으로 즉시 구동됩니다.
- **5대 AI 하네스 통합 컨트롤 플레인**
  - **Claude Code** (`claude`, `@cc`)
  - **OpenCode** (`opencode`, `@oc`)
  - **Codex CLI** (`codex`, `@cx`)
  - **Antigravity** (`agy`, `@ag`)
  - **Cursor CLI** (`agent` / `cursor-agent`, `@cr`)
- **단일 공유 SQLite SSOT (`~/.asd/state/core.db`)**
  - 모든 프로젝트의 세션(`sessions`), 태스크(`tasks`), 적대적 토론(`debates`), 멀티 드라이버 소유권(`session_drivers`)을 단 하나의 WAL 모드 SQLite DB(`~/.asd/state/core.db`)에서 `project_root` 스코프로 통합 관리합니다.
- **CLI ↔ ASD 세션 양방향 관리 및 실시간 스트리밍 SDK (v2.4.0)**
  - **프로젝트별 5대 하네스 CLI 세션 통합 탐색 (`discoverProjectCliSessions`)**: 현재 프로젝트 경로에서 실행된 모든 하네스의 로컬 CLI 세션을 자동 탐색하고 ASD 세션 승격 여부를 결합해 반환합니다.
  - **대화 기록 4분류 정밀 파싱 (`readHarnessTranscript`)**: 각 하네스의 로컬 DB/파일에서 실제 대화 기록을 읽어 **Thinking**, **Tool Use**, **Tool Result**, **User/Assistant 응답**으로 정밀 분리합니다 (Antigravity `transcript_full.jsonl` 자동 폴백 및 OpenCode `opencode.db` `part` 테이블 파싱 포함).
  - **실시간 스트리밍 턴 실행 (`runDriverTurn`)**: 유저 메시지를 실제 하네스로 전달해 실행하면서 실시간 Thinking 과정, Tool Use 과정, Tool Result, 응답 과정을 `onEvent` 콜백으로 스트리밍합니다.
  - **세션 승격 및 하강 (`promoteCliSessionToAsd` / `demoteAsdSession` / `asd resume`)**: 일반 CLI 세션을 ASD 세션으로 즉시 승격하거나, ASD 세션을 다시 원래 하네스의 네이티브 CLI 세션으로 하강시킬 수 있습니다.
- **빈자리만 채우는 지능형 MCP 및 스킬 동기화 (`asd sync`)**
  - 프로젝트 폴더를 오염시키지 않고 글로벌 사용자 홈 디렉토리(`~/.claude`, `~/.config/opencode`, `~/.codex`, `~/.gemini`, `~/.cursor`)에만 핵심 스킬(`/asd`, `/asd-plan`, `/asd-run`, `/asd-debate`, `/asd-debug`, `/handoff` / `/asd-handoff`), 5개 핵심 에이전트 페르소나(`planner`, `architect`, `worker`, `scout`, `critic`), 보안 훅(`PreToolUse`, `Stop`, Codex `notify`, Cursor `hooks.json`), MCP 서버를 자동 설치합니다.
  - **중복 방지(Gap-Filling) 주입**: 각 하네스가 기본 내장한 기능이나 사용자가 이미 등록해 둔 MCP는 건너뛰고, 해당 하네스에 없는 도구만 자동으로 채워 넣습니다.
- **이중 트랙(Dual-Track) 실행 (`LIGHT` 현재 하네스 모드 vs `HEAVY` 다중 하네스 모드)**
  - **LIGHT 트랙 (현재 하네스 전용)**: 소규모 작업은 현재 메인 AI가 직접 인플레이스(In-place)로 처리하고, 다중 작업은 현재 하네스 내부의 자체 서브에이전트로 처리(`claim_only`)하며 외부 하네스 CLI를 띄우지 않습니다. 완료 시 자동 체크포인트 커밋을 생성하고 실패 시 해당 태스크 범위만 즉시 롤백합니다.
  - **HEAVY 트랙 (다중 하네스 병렬)**: 독립된 Git 워크트리(`.asd/wt/<turn>-<taskId>`)를 생성하고 여러 외부 하네스를 동시에 스폰하여 병렬 실행한 뒤 프로세스 간 뮤텍스 잠금(`.asd/merge.lock`) 하에 안전하게 `--no-ff` 병합을 수행합니다.
- **블라인드 교차 모델 적대적 토론 (`asd debate`)**
  - 서로 다른 모델 패밀리(`claude`, `gpt`, `gemini`, `glm`)를 병렬 호출하여 1라운드 블라인드 비평을 수행하고, 2라운드 심판(`arbiter`) 판결을 통해 도출된 필수 제약 사항을 작업 인수 조건(`acceptance`)에 자동 주입합니다.
- **1ms Fail-Closed 보안 가드 & 서브에이전트 실드(Subagent Shield)**
  - 대소문자 우회(`.GIT/config`, `.Asd/meta.json`, `.ENV`)까지 차단하는 정규화 경로 검증으로 허용된 파일(`allowedFiles`) 외부 수정을 원천 차단합니다.

---

## 요구 사항

- **Node.js**: `>=22.13.0`
- **Git**: `>=2.30.0`

---

## 빠른 시작 (Quick Start)

### A. 전역 `PATH` 자동 등록 시 (기본값)
```bash
# 1. 최초 1회 설치: 5개 하네스 글로벌 설정 동기화 및 전역 PATH에 'asd' 명령어 자동 등록
node --no-warnings src/cli/index.ts sync

# 2. 이후부터는 어느 프로젝트 폴더에서든 'asd' 명령어를 바로 실행할 수 있습니다!
asd doctor
asd status
asd plan get
asd dispatch --turn 1
asd verify --task T1.1 --files "src/index.ts" --summary "기능 구현 완료"
asd debate --topic "아키텍처 설계" --proposal "SQLite WAL 모드 도입"
asd resume
asd logs
asd logs T1.1
asd ui

# 3. 임시 홈 격리 기반 전체 테스트 스위트 실행
node scripts/run-tests.mjs
```

### B. 전역 `PATH` 미등록 시 (`--no-path` 사용 시)
```bash
# 1. 전역 PATH에 'asd'를 등록하지 않고 5개 하네스 글로벌 설정만 동기화
node --no-warnings src/cli/index.ts sync --no-path

# 2. Node.js로 CLI 엔트리포인트를 직접 지정하여 실행
node --no-warnings src/cli/index.ts doctor
node --no-warnings src/cli/index.ts status
node --no-warnings src/cli/index.ts plan get
node --no-warnings src/cli/index.ts dispatch --turn 1
node --no-warnings src/cli/index.ts verify --task T1.1 --files "src/index.ts" --summary "기능 구현 완료"
node --no-warnings src/cli/index.ts debate --topic "아키텍처 설계" --proposal "SQLite WAL 모드 도입"
node --no-warnings src/cli/index.ts resume
node --no-warnings src/cli/index.ts logs
node --no-warnings src/cli/index.ts ui
```

---

## 에디터/채팅창 내 AI 스킬 명령어 (`/asd*`, `/handoff`)

`asd sync`를 실행하면 **Claude Code**, **OpenCode**, **Codex CLI**, **Antigravity**, **Cursor CLI** 채팅창에서 아래 슬래시(`/`) 스킬 명령어를 바로 호출하여 사용할 수 있습니다.

> **사전 1회 통합 브리핑 원칙**: 모든 `/asd*` 스킬은 실제 파일 수정이나 서브에이전트 실행 전에 **단 한 번만** 다음 내용을 묶어서 브리핑하고 확인을 받습니다:
> 1. **수행할 작업 요약 및 설명**: 변경할 대상 파일, 작업 순서, 예상 영향을 요약합니다.
> 2. **다중 하네스 사용 여부 선택 (`LIGHT` vs `HEAVY`)**:
>    - **`LIGHT` 모드 (현재 하네스만 사용)**: 소규모 작업은 메인 AI가 직접 처리하고, 병렬/위임 작업은 현재 하네스 내부의 자체 서브에이전트만 사용합니다(외부 하네스 동시 실행 안 함).
>    - **`HEAVY` 모드 (여러 하네스 동시 사용)**: 격리된 Git 워크트리(`.asd/wt/`)에서 여러 외부 하네스를 동시에 스폰해 병렬로 처리합니다.
> 3. **추가 확인 질문**: 모호한 요구사항이 있다면 여러 번 나누지 않고 이 브리핑에서 한 번에 질문합니다.

| 스킬 명령어 | 주요 역할 | 상세 작동 방식 및 사용 시점 |
| :--- | :--- | :--- |
| **`/asd <요청내용>`** | **전 과정 자율 수행 (계획 → 실행 → 검증)** | 코드베이스 탐색 후 **1회 사전 브리핑(할 일 요약 + `LIGHT`/`HEAVY` 선택 + 질문)**을 거쳐 `.asd/PLAN.md`를 생성하고, Turn(Wave) 단위로 구현(`asd dispatch`) 및 테스트/경계 검증(`asd verify`)을 끝까지 수행한 뒤 실시간 진행 보드와 `.asd/summary.md`를 출력합니다. |
| **`/asd-plan <요청내용>`** | **작업 계획 수립 전용 (코드 수정 안 함)** | 읽기 전용으로 코드를 분석하고 **1회 사전 브리핑**을 거친 뒤 `.asd/PLAN.md`와 SQLite 태스크 목록만 생성하고 멈춥니다. 생성된 `.asd/PLAN.md`를 직접 검토/수정한 뒤 `/asd-run`으로 실행할 때 사용합니다. |
| **`/asd-run`** | **생성된 `.asd/PLAN.md` 실행 및 재개** | 사용자가 `.asd/PLAN.md`에서 수정한 내용을 역동기화(`asd plan sync_from_md`)한 뒤, 실행할 작업 요약과 `LIGHT`/`HEAVY` 모드를 확인받고 미완료(`[ ]`) 또는 에스컬레이션(`[~]`)된 태스크들을 순서대로 실행합니다. |
| **`/asd-debug <증상/오류>`** | **재현 우선 체계적 디버깅** | 에러 로그와 코드를 분석해 **1회 사전 브리핑**을 제시한 뒤, 실패를 재현하는 테스트를 먼저 작성(**Rule Zero**)하고 최소 수정 적용 및 전체 회귀 테스트 통과 후 `asd verify`로 체크포인트 커밋을 생성합니다. |
| **`/asd-debate <주제/설계안>`** | **이기종 모델 블라인드 적대적 토론** | 논쟁이 되는 아키텍처/설계안을 요약하고 다중 하네스(`HEAVY`) 또는 현재 하네스(`LIGHT`)로 1라운드 블라인드 비평 및 2라운드 심판(`arbiter`) 판결을 수행하여 합의안과 필수 제약 사항을 도출합니다. |
| **`/handoff`** (또는 **`/asd-handoff`**) | **다중 하네스 세션 인수인계 문서 생성** | 현재까지의 사용자 요청, 완료된 작업, Git 및 테스트 상태, 활성 ASD 세션/`.asd/PLAN.md` 진행 현황(`asd status`), 핵심 의사결정과 제약 사항을 정리하여 루트 경로에 `handoff.md`로 저장합니다. |

---

## CLI 명령어

> **참고:** `--no-path` 옵션으로 설치한 경우 `asd <명령어>` 대신 `node --no-warnings src/cli/index.ts <명령어>` 형태로 실행합니다.

| 명령어 (`PATH` 설정 시) | 명령어 (`PATH` 미설정 시) | 설명 |
| :--- | :--- | :--- |
| `asd sync [--force] [--no-path]` | `node --no-warnings src/cli/index.ts sync [--force] [--no-path]` | 5대 하네스의 글로벌 설정에 스킬, 5개 핵심 에이전트, 보안 훅, 부족한 MCP 도구를 동기화하고 전역 `PATH`에 `asd` 명령어를 자동 등록합니다. |
| `asd plan [create\|get\|update\|sync_from_md]` | `node --no-warnings src/cli/index.ts plan [create\|get\|update\|sync_from_md]` | `.asd/PLAN.md`와 단일 공유 SQLite SSOT(`~/.asd/state/core.db`) 간의 계획 생성, 조회, 수정 및 양방향 동기화(`sync_from_md`)를 수행합니다. |
| `asd dispatch [--turn <n>] [--mode <m>]` | `node --no-warnings src/cli/index.ts dispatch [--turn <n>] [--mode <m>]` | 선행 작업(`depends_on`)의 완료 결과(`DoneClaim`)를 컨텍스트로 자동 주입하며, MCP 타임아웃 없이 웨이브 단위로 서브에이전트를 병렬 디스패치합니다. |
| `asd verify --task <id> [--files <csv>]` | `node --no-warnings src/cli/index.ts verify --task <id> [--files <csv>]` | 수정 파일 경계(`allowedFiles`) 검증, 시크릿 유출 차단, 테스트 명령 실행 후 LIGHT 체크포인트 커밋 또는 HEAVY 워크트리 병합을 수행합니다. |
| `asd debate --topic <t> --proposal <p>` | `node --no-warnings src/cli/index.ts debate --topic <t> --proposal <p>` | 이기종 모델 간 병렬 블라인드 비평과 심판 합의를 실시간 진행 로그 스트리밍과 함께 수행합니다. |
| `asd status [--json]` | `node --no-warnings src/cli/index.ts status [--json]` | 현재 프로젝트의 SQLite 세션 상태, 실시간 TODO 진행 보드, 미적용 자동 스태시(auto-stash) 경고를 출력합니다. |
| `asd resume [--session <id>] [--print]` | `node --no-warnings src/cli/index.ts resume [--session <id>] [--print]` | 활성 ASD 세션을 하강(`demoteAsdSession`)시키고 원래 하네스의 대화형 CLI를 즉시 재개합니다 (`--print`는 명령어만 출력, `--json`은 메타데이터 출력). |
| `asd logs [taskId] [--json]` | `node --no-warnings src/cli/index.ts logs [taskId] [--json]` | 가장 최근 서브에이전트 실행 로그를 자동 출력하거나, `T1.1`처럼 작업 번호를 지정해 해당 작업의 서브에이전트 로그를 조회합니다. |
| `asd ui [--port <num>]` | `node --no-warnings src/cli/index.ts ui [--port <num>]` | 한국어/영어를 지원하는 경량 로컬 웹 대시보드(`http://127.0.0.1:3847`)를 실행합니다 (`~/.asd/state/models-cache.json` 디스크 캐시로 즉시 기동). |
| — | — | **원칙:** `asd ui` 웹 대시보드는 기능 동결 — 새로운 UI 기능은 GUI 리포(asd-gui)에 구현합니다. Core는 CLI + 코어 관리 + 최소 SDK만 유지합니다 (CORE_GUI_BOUNDARY_AUDIT.md 참조). |
| `asd doctor [--json]` | `node --no-warnings src/cli/index.ts doctor [--json]` | Node 버전, SQLite WAL, Git 저장소, 5대 하네스 CLI 바이너리 경로 및 Headless 지원 여부, `PreToolUse` 보안 차단 여부를 100ms 이내에 점검합니다. |
| `asd clean [--pop] [--all]` | `node --no-warnings src/cli/index.ts clean [--pop] [--all]` | 잔여 `.asd/wt/*` 워크트리와 `asd/*` 브랜치를 정리하고, `--pop` 옵션 사용 시 자동 스태시된 변경사항을 복원합니다. |
| `asd uninstall` | `node --no-warnings src/cli/index.ts uninstall` | ASD가 주입한 글로벌 훅, TOML 펜스 블록, 스킬, 에이전트, `PATH` 심(shim), `_asdManaged` MCP 항목만 외과적으로 제거하고 사용자의 기존 설정을 100% 보존합니다. |

---

## 상세 아키텍처 및 외부 SDK 문서

- 🏛️ **[프로젝트 아키텍처 및 파일·함수 상세 레퍼런스 (`PROJECT_STATUS.md`)](./PROJECT_STATUS.md)** — 프로젝트 전체 디렉토리 구조, 2-Path 및 단일 DB 설계, 모든 소스 파일별·주요 함수별 상세 해설 및 `asd ui` 명세.
- 🔌 **[외부 SDK 및 단일 DB 전환 통합 레퍼런스 (`EXTERNAL_SDK_REFERENCE.md`)](./EXTERNAL_SDK_REFERENCE.md)** — `asd-gui` 등 외부 프로그램 연동을 위한 Node.js SDK, 단일 DB 전환 가이드, CLI/MCP/HTTP API 전체 명세.
- 🤖 **[AI 에이전트 작업 지침 프롬프트 (`AI_WORKFLOW_PROMPT.md`)](./AI_WORKFLOW_PROMPT.md)** — 다른 AI 에이전트에게 프로젝트 작업을 맡길 때 바로 복사해서 사용할 수 있는 핵심 규칙 및 절차 프롬프트.
- 📋 **[패치 노트 (한국어)](./PATCH_NOTES_ko.md)** | **[Patch Notes (English)](./PATCH_NOTES.md)** — 초기 구축부터 v2.4.0까지의 전체 버전별 패치 내역.

---

## 라이선스

[Functional Source License, Version 1.1, Apache 2.0 Future License (FSL-1.1-ALv2)](./LICENSE) © 2026 yjsjs0987
