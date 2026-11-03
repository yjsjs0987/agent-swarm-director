# Agent Swarm Director (ASD v2.4.0) — 아키텍처 및 전체 파일·함수 상세 레퍼런스

> **최종 갱신일**: 2026-11-03  
> **버전**: `2.4.0` (`agent-swarm-director`)  
> **대상 하네스 (5대 AI 코딩 CLI)**: Claude Code (`@cc`), OpenCode (`@oc`), Codex CLI (`@cx`), Antigravity (`@ag`), Cursor CLI (`@cr`)  
> **외부 런타임 의존성**: `0개` (`dependencies: {}` — 순수 Node.js `>=22.13.0` 내장 모듈만 사용)

[📖 README (한국어)](./README_ko.md) | [📖 README (EN)](./README.md) | [🔌 외부 SDK 및 DB 레퍼런스](./EXTERNAL_SDK_REFERENCE.md) | [🤖 AI 작업 지침 프롬프트](./AI_WORKFLOW_PROMPT.md) | [📋 패치 노트 (KR)](./PATCH_NOTES_ko.md) | [📋 Patch Notes (EN)](./PATCH_NOTES.md)

---

## 1. 프로젝트 개요 및 3대 아키텍처 불변성

**Agent Swarm Director (ASD v2.4.0)**는 서로 다른 5개의 AI 코딩 하네스(**Claude Code**, **OpenCode**, **Codex CLI**, **Antigravity**, **Cursor CLI**)를 단일 결정론적 컨트롤 플레인으로 통합 제어하는 **외부 의존성 0개(Zero-Dependency)** 멀티 에이전트 오케스트레이션 엔진이자 SDK입니다.

### 1.1 3대 아키텍처 불변성 (Core Invariants)
1. **Zero External Runtime Dependencies (`dependencies: {}`)**:
   - 서드파티 npm 런타임 패키지나 별도 트랜스파일/빌드 단계 없이, **Node.js `>=22.13.0`**의 네이티브 TypeScript 실행(`--no-warnings` / `--experimental-strip-types`)과 내장 `node:sqlite`(WAL 모드), `node:http`, `node:child_process`, `node:crypto`, `node:fs` 표준 모듈만으로 동작합니다.
2. **Strict Core Purity**:
   - `src/core/*` 모듈은 `src/adapters/*`를 직접 import하지 않으며, 어댑터 계층과의 순환 결합 없이 독립적으로 동작합니다.
3. **Erasable TypeScript Syntax Only**:
   - Node.js 네이티브 TypeScript 실행(`erasableSyntaxOnly: true`)을 준수하기 위해 `enum`, `namespace`, 생성자 파라미터 프로퍼티를 사용하지 않고 순수 타입 유니온(`type`)과 `as const` 배열만 사용합니다.

---

## 2. 디렉토리 및 전체 파일 구조

```text
asd-multiagent/
├── package.json                 # Zero runtime dependencies, version 2.4.0, bin: {"asd": "./src/cli/index.ts"}, exports 서브패스 정의
├── tsconfig.json                # erasableSyntaxOnly: true, strict: true
├── README.md / README_ko.md     # 영문/국문 사용자 매뉴얼 (스킬 및 CLI 가이드)
├── PROJECT_STATUS.md            # 전체 아키텍처 및 파일별·주요 함수별 상세 레퍼런스 (본 문서)
├── EXTERNAL_SDK_REFERENCE.md    # 외부 연동(asd-gui 등)을 위한 SDK API 및 단일 DB 전환 레퍼런스
├── PATCH_NOTES.md / _ko.md      # 영문/국문 버전별 패치 노트
├── presets/
│   ├── default-routing.jsonc    # 5대 전문 역할 및 카테고리/난이도별 기본 모델 라우팅 + 다중 폴백 체인
│   └── default-mcp.jsonc        # Gap-filling MCP 서버 카탈로그 (context7, grep_app, websearch)
├── scripts/
│   └── run-tests.mjs            # 임시 ASD_HOME_DIR 격리 기반 전체/개별 테스트 실행기
├── src/
│   ├── index.ts                 # 외부 라이브러리(asd-gui 등) 연동을 위한 통합 Public SDK 엔트리포인트
│   ├── core/                    # 코어 오케스트레이션 엔진 (어댑터 의존성 0)
│   │   ├── types.ts             # 전체 상수/타입(5대 하네스, 5대 역할, 3단계 난이도, 드라이버, 태스크, 토론 스키마)
│   │   ├── config.ts            # 2-Path 레이아웃(~/.asd 및 <project>/.asd), 단일 core.db 경로, 라우팅 설정 로더
│   │   ├── db.ts                # node:sqlite WAL 모드 4-테이블 SSOT 드라이버 (sessions, tasks, debates, session_drivers)
│   │   ├── session-tracker.ts   # 프로젝트 탐색, 5대 하네스 로컬 CLI 세션 발견/추적, CLI ↔ ASD 세션 승격(Promote)/하강(Demote)
│   │   ├── drivers.ts           # 멀티 드라이버 소유권(session_drivers), 0-Token 브리핑, 실시간 스트리밍 턴 실행기(runDriverTurn)
│   │   ├── transcripts.ts       # 5대 하네스 로컬 대화 기록 탐색 및 4분류(Thinking, Tool Use, Tool Result, 응답/유저) 파서
│   │   ├── router.ts            # 4단계 모델 라우팅, 미설치 하네스 필터링, 다양성 리뷰어 선택, 자동 폴백 체인
│   │   ├── spawner.ts           # 서브에이전트 프로세스 스폰, 시크릿 마스킹 로깅, 프로세스 트리 강제 종료, 아티팩트 마감
│   │   ├── workspace.ts         # Git 베이스라인 보호, LIGHT 체크포인트/롤백, HEAVY 워크트리 및 크로스 프로세스 뮤텍스 병합
│   │   ├── debate.ts            # 블라인드 교차 모델 적대적 토론 브로커 (Round 1 병렬 비평 + Round 2 심판)
│   │   ├── policy.ts            # 1ms PreToolUse 경로/명령 가드, ASD_DRIVER_ID 바인딩 및 Stop 훅 3회 무진전 서킷 브레이커
│   │   ├── render.ts            # .asd/PLAN.md 양방향 파서/렌더러, 전경 세션 제어, 실시간 progressBoard, summary.md 생성
│   │   ├── redact.ts            # API 키/JWT/PEM/비밀번호 자동 마스킹 ([REDACTED])
│   │   └── jsonc.ts             # 주석/후행 쉼표 안전 JSONC 파서 및 TOML 펜스 블록 매니저
│   ├── adapters/                # 5대 AI 하네스 어댑터 및 글로벌 인스톨러
│   │   ├── claude-code.ts       # Claude Code (@cc) 어댑터 (~/.claude, ~/.claude.json)
│   │   ├── opencode.ts          # OpenCode (@oc) 어댑터 (~/.config/opencode)
│   │   ├── codex.ts             # Codex CLI (@cx) 어댑터 (~/.codex/config.toml)
│   │   ├── antigravity.ts       # Antigravity (@ag) 어댑터 (~/.gemini)
│   │   ├── cursor.ts            # Cursor CLI (@cr) 어댑터 (~/.cursor)
│   │   └── installer.ts         # 글로벌 동기화(sync), 외과적 제거(uninstall), 100ms 헬스체크(doctor)
│   ├── mcp/                     # MCP 프로토콜 및 오케스트레이션 핸들러
│   │   ├── server.ts            # handlePlan, handleDispatch, handleVerify, handleDebate 코어 핸들러 및 Subagent Isolation Guard
│   │   └── stdio-rpc.ts         # 비동기 JSON-RPC 2.0 stdio 트랜스포트
│   ├── cli/                     # 통합 터미널 CLI 및 로컬 웹 대시보드
│   │   ├── index.ts             # 14개 CLI 서브커맨드 엔트리포인트 (plan, dispatch, verify, debate, resume, sync, ui 등)
│   │   └── dashboard.ts         # 한국어/영어 지원 Zero-Dependency 실시간 웹 대시보드 (http://127.0.0.1:3847)
│   └── skills/                  # 5대 하네스에 공통 배포되는 슬래시 스킬 템플릿 (asd, asd-plan, asd-run, asd-debug, asd-debate, handoff)
└── tests/                       # 26개 테스트 스위트, 총 321개 단위/통합 테스트
```

---

## 3. 2-Path 상태 저장소 및 단일 공유 SQLite DB 아키텍처 (v2.4.0)

ASD v2.4.0은 프로젝트 폴더 오염을 막고 멀티 프로젝트·멀티 프로세스 동시성을 보장하기 위해 **글로벌 상태 디렉토리(`~/.asd`)**와 **프로젝트 로컬 뷰 디렉토리(`<project>/.asd`)**로 역할을 분리합니다.

### 3.1 글로벌 상태 디렉토리 (`~/.asd`)
- **`~/.asd/state/core.db` (단일 공유 SQLite SSOT)**:
  - 구버전(v2.3.2 이하)에서는 프로젝트마다 `~/.asd/state/<projectHash>/core.db`를 별도로 생성했으나, v2.3.3 / v2.4.0부터는 **단 하나의 `~/.asd/state/core.db`** 파일에 모든 프로젝트의 세션을 저장하며 `sessions.project_root` 컬럼으로 프로젝트를 스코프 구분합니다.
  - WAL(`journal_mode = WAL`), `busy_timeout = 5000`, `foreign_keys = ON`, `BEGIN IMMEDIATE` 트랜잭션으로 다중 프로세스 동시 접근 시에도 안전합니다.
  - 총 4개 테이블로 구성됩니다: `sessions`, `tasks`, `debates`, `session_drivers`.
- **`~/.asd/state/cli-recent.json`**:
  - 5대 하네스의 `SessionStart` / `PreToolUse` / `Stop` 훅 및 로컬 트랜스크립트 스캐너(`syncLocalHarnessTranscripts`)가 기록하는 최근 CLI 세션 레지스트리입니다 (첫 유저 프롬프트 `summary` 및 `transcriptPath` 보존).
- **`~/.asd/state/models-cache.json`**:
  - `discoverHarnessModels()`가 비동기 병렬 탐색한 5대 하네스 모델 목록을 10분(TTL) 동안 캐싱하는 디스크 캐시입니다.
- **`~/.asd/routing.jsonc`, `~/.asd/mcp.jsonc`**:
  - 전역 모델 라우팅 및 Gap-Filling MCP 카탈로그 설정 파일입니다.

### 3.2 프로젝트 로컬 뷰 디렉토리 (`<project>/.asd`)
`<project>/.asd/` 폴더는 `.git/info/exclude`에 자동 등록되어 Git 커밋 내역을 오염시키지 않습니다.
- `.asd/PLAN.md`: 인간과 AI가 함께 읽고 편집하는 마크다운 작업 계획서 (상단 `Session: <sessionId>` 헤더로 전경 세션 지정).
- `.asd/routing.jsonc`: 해당 프로젝트에만 우선 적용되는 로컬 모델 라우팅 오버라이드 설정(선택).
- `.asd/merge.lock`: `HEAVY` 워크트리 병합 시 프로세스 간 경합을 방지하는 파일 뮤텍스 잠금.
- `.asd/sessions/<sessionId>/main.json`: 세션 메타데이터, 메모(`memo`), 활성 드라이버 목록(`drivers`).
- `.asd/sessions/<sessionId>/subagents/<subSessionId>/`: 서브에이전트별 `meta.json`, `prompt.md`, `output.log`.
- `.asd/sessions/<sessionId>/summary.md` (및 `.asd/summary.md`): 모든 태스크 완료 시 생성되는 최종 요약 보고서.
- `.asd/wt/<turn>-<taskId>/`: `HEAVY` 트랙 실행 시 생성되는 태스크별 격리 Git 워크트리.

---

## 4. 파일별·주요 함수별 상세 기능 레퍼런스

### 4.1 공개 SDK 엔트리포인트 — [`src/index.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/index.ts)
외부 애플리케이션(`asd-gui` 등)이 `import { ... } from "agent-swarm-director"` 한 줄로 코어 전체 기능을 재사용할 수 있도록 모든 모듈을 re-export합니다.
- `src/core/*` 전체 모듈, `src/adapters/*` 5대 어댑터 및 인스톨러, `src/mcp/server.ts` 오케스트레이션 핸들러(`handlePlan`, `handleDispatch`, `handleVerify`, `handleDebate`), `src/cli/index.ts` 헬퍼(`getAdapter`, `getLatestSession`, `scanSubagentLogs`, `runAsdLogs`, `runAsdClean`), `src/cli/dashboard.ts` 대시보드 서비스(`collectDashboardSnapshot`, `discoverHarnessModels`, `getModelsDiskCachePath`, `saveSessionMemo`, `saveProjectRoutingConfig`, `runSubagentControlAction`, `startDashboardServer`)를 공개합니다.

---

### 4.2 코어 엔진 (`src/core/`)

#### ① [`src/core/types.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts)
전체 시스템의 상수 배열(`as const`)과 TypeScript 인터페이스를 정의하는 리프(Leaf) 모듈입니다.
- **주요 상수 및 유니온 타입**:
  - [`ASD_VERSION`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L11) (`"2.4.0"`): 패키지 및 설정 버전 상수.
  - [`HARNESS_IDS`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L17-L23) / `HarnessId`: `"claude-code" | "opencode" | "codex" | "antigravity" | "cursor"`.
  - [`AGENT_ROLES`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L31-L37) / `AgentRole`: 5대 핵심 역할 (`"planner" | "architect" | "worker" | "scout" | "critic"`).
  - [`TASK_CATEGORIES`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L42-L48) / `TaskCategory`: `"visual-ui" | "design" | "research" | "writing" | "general"`.
  - [`DIFFICULTY_TIERS`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L53-L57) / `DifficultyTier`: `"low" | "medium" | "high"`.
  - [`TASK_TRACKS`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L61) / `TaskTrack`: `"LIGHT" | "HEAVY"`.
  - [`TASK_STATUSES`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L65-L73) / `TaskStatus`: `"pending" | "running" | "verifying" | "awaiting_approval" | "done" | "escalated" | "failed" | "merge_conflict"`.
  - [`SESSION_PHASES`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L77) / `SessionPhase`: `"planning" | "running" | "paused" | "done"`.
  - [`DRIVER_SOURCES`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L85) / `DriverSource`: `"cli" | "gui" | "subagent"`.
- **주요 인터페이스**:
  - `SessionRecord`, `TaskRecord`, `DebateRecord`, `DriverRow`, `DoneClaim`, `CrossScopeFileRequest`, `RoutingConfig`, `McpCatalogConfig`, `HarnessAdapter`, `HookEvaluationInput`, `HookEvaluationResult`.

#### ② [`src/core/config.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts)
홈 디렉토리 및 프로젝트 경로 해석, 설정 파일(`routing.jsonc`, `mcp.jsonc`) 로드, 원격 버전 체크를 담당합니다.
- [`resolveHomeDir(explicitHomeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L102-L108): `explicitHomeDir > process.env.ASD_HOME_DIR > os.homedir()` 우선순위로 홈 경로를 결정합니다 (테스트 시 홈 오염 원천 차단).
- [`computeProjectHash(projectRoot)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L114-L125): `fs.realpathSync.native` 및 Windows 소문자 정규화 후 SHA-256 앞 16자리를 반환합니다.
- [`resolveAsdPaths(projectRoot, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L131-L162): 글로벌 `~/.asd` 경로(`dbPath: ~/.asd/state/core.db`, `globalRoutingPath`, `globalMcpPath`, `lastSyncPath`)와 로컬 `<project>/.asd` 경로(`planMdPath`, `sessionsDir`, `worktreesDir`, `localRoutingPath`)를 일괄 반환합니다.
- [`ensureProjectInitialized(projectRoot, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L204-L242): `~/.asd/state` 및 `<project>/.asd/{sessions,wt}` 폴더를 생성하고 `.git/info/exclude`에 `.asd/`를 등록합니다.
- [`loadRoutingConfig(projectRoot, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L276-L315): 기본 프리셋(`presets/default-routing.jsonc`) 위에 글로벌(`~/.asd/routing.jsonc`) 및 프로젝트 로컬(`<project>/.asd/routing.jsonc`) 설정을 딥 머지하여 반환합니다.
- [`loadMcpCatalog(homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L321-L347): `~/.asd/mcp.jsonc` 또는 기본 MCP 카탈로그를 로드합니다.
- [`checkForRemoteUpdate(options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L403-L485): GitHub의 최신 `package.json` 버전을 24시간 캐시 기반으로 조회하여 업데이트 안내를 제공합니다.

#### ③ [`src/core/db.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts)
Node.js 내장 `node:sqlite` (`DatabaseSync`)를 사용하여 `~/.asd/state/core.db`의 4개 테이블(`sessions`, `tasks`, `debates`, `session_drivers`)을 관리하는 SSOT 드라이버입니다.
- [`generateAsdSessionId(now?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L56-L78) / [`isValidAsdSessionId(id)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L45-L49): 충돌 없는 세션 ID(`asd-YYYYMMDD-HHMMSS-xxxx`) 생성 및 경로 안전성 검증.
- **[`SqliteDriver`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L288-L1025) 클래스**:
  - `constructor(dbPath, projectRoot?)`: DB 연결을 열고 WAL 모드·외래키·스키마 마이그레이션을 자동 적용하며, `projectRoot`가 주어지면 조회 쿼리를 해당 프로젝트로 자동 스코프합니다.
  - `withImmediateTx(fn)`: `BEGIN IMMEDIATE` 트랜잭션 래퍼 (중첩 호출 시 외부 트랜잭션에 합류).
  - **세션 관리**: `createOrGetSession()`, `getSession()`, `findSessionByHarnessSessionId()`(네이티브 하네스 세션 ID로 `sessions` 및 `session_drivers`를 통합 조회), `deleteSession()`(`session_drivers`, `tasks`, `debates`, `sessions` 연쇄 삭제 트랜잭션), `getLatestSession()`, `listSessions()`, `listProjectRoots()`, `updateSessionPhase()`, `updateSessionHarnessInfo()`, `updateSessionMemo()`, `incrementNoProgress()`, `resetNoProgress()`, `setStashedWorkSha()`.
  - **태스크 관리**: `upsertTasks()`, `getTask()`, `getTasksBySession()`, `getTasksByTurn()`, `getAllTasks()`, `tryClaimTask()`(원자적 `pending/escalated → running` 전이), `claimWaveTasks()`, `updateTaskStatus()`, `recordTaskVerified()`, `recordTaskAttemptFailure()`.
  - **토론 관리**: `createDebate()`, `getDebate()`, `getDebatesBySession()`, `getAllDebates()`, `updateDebateBundles()`.
  - **드라이버 관리 (`session_drivers`)**: `insertDriverRow()`, `getDriverById()`, `getActiveDriver()`, `listDriverRows()`, `updateDriverHarnessSessionId()`, `touchDriverSeen()`, `closeActiveDriversForSession()`, `closeDriverById()`.
- [`openProjectDb(projectRoot, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L1030-L1040): 프로젝트를 초기화하고 해당 `projectRoot`로 스코프된 `SqliteDriver` 인스턴스를 반환합니다.

#### ④ [`src/core/session-tracker.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts)
5대 하네스의 CLI 세션 ID 추출, 로컬 트랜스크립트 스캔, CLI ↔ ASD 세션 양방향 승격/하강, 멀티 프로젝트 목록 탐색을 담당합니다.
- [`extractHookSessionInfo(rawPayload)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L229-L360): 각 하네스 훅이 전달한 JSON 페이로드에서 `harnessSessionId`, `transcriptPath`, `cwd`, `model`, `promptSummary`를 정규화 추출합니다.
- [`buildResumeHarnessCommand(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L85-L150) & [`buildInteractiveResumeHarnessCommand(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L157-L220): 하네스별 헤드리스 재개 명령 및 대화형 TUI 재개 명령(`claude --resume <id>`, `codex resume <id>`, `opencode -s <id>`, `cursor-agent --resume <id>`, `agy chat --resume <id>`)을 생성합니다.
- [`syncLocalHarnessTranscripts(projectRoot, options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1200-L1308): Antigravity(`brain/`), Claude Code(`~/.claude/projects`), Codex(`~/.codex/sessions`), OpenCode(`opencode.db`)의 로컬 저장소를 직접 스캔하여 훅이 누락된 CLI 세션도 `cli-recent.json`에 자동 복구합니다 (`transcriptDiscoveryCache`를 통해 파일 `mtimeMs`가 변경되지 않은 `.jsonl` 파일은 재파싱 없이 즉시 캐시 반환).
- [`recordCliRecentSession(entry, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1331-L1410) & [`readCliRecentSessions(filter?, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1310-L1329): `~/.asd/state/cli-recent.json`에 최근 CLI 세션을 기록(기존 첫 프롬프트 `summary`와 `transcriptPath` 보존) 및 조회합니다.
- [`linkHarnessSessionToAsdSession(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1415-L1450): ASD 세션에 네이티브 하네스 세션 ID를 연결합니다(후보가 없으면 `syncLocalHarnessTranscripts` 자동 실행).
- [`promoteCliSessionToAsd(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1619-L1740): 일반 CLI 세션을 ASD 세션(`sessions` 테이블)으로 즉시 승격(멱등성 보장)하고 선택적으로 드라이버(`session_drivers`)를 연결합니다.
- [`unlinkHarnessSessionFromAsdSession(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1670-L1785): `promoteCliSessionToAsd()`의 역연산으로, 활성 드라이버를 분리(또는 `deleteAsdSession: true` 시 세션 삭제)하고 `cli-recent.json`의 `asdSessionId`를 `null`로 초기화하여 일반 CLI 세션 상태로 복귀시킵니다.
- [`demoteAsdSession(projectRoot, sessionId, options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1455-L1545) & [`buildSessionDemotion(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L248-L350): ASD 세션을 일시정지(`paused`)하고 드라이버를 분리한 뒤, 원래 하네스 CLI로 돌아갈 수 있는 대화형 Resume 명령어를 반환하고 `cli-recent.json`을 갱신합니다.
- [`discoverProjectCliSessions(projectPath, options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1774-L1895): 특정 프로젝트 경로에서 실행된 5대 하네스의 모든 CLI 세션을 탐색하고, 각 세션이 ASD 세션으로 승격되어 있는지(`isPromotedToAsd`, `asdSessionId`, `asdPhase`) 결합하여 최신순으로 반환합니다.
- [`listKnownProjects(options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1901-L1980): 단일 공유 DB(`core.db`)에서 프로젝트별 세션/태스크/토론 통계를 고속 집계합니다 (15초 FS stat 캐시, `skipDiskCheck`, `db` 재사용 지원).

#### ⑤ [`src/core/drivers.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts)
하나의 ASD 세션을 여러 하네스나 GUI/CLI가 번갈아 운전할 때의 소유권(`session_drivers`), 핸드오프 브리핑, 실시간 스트리밍 턴 실행을 담당합니다.
- [`attachDriver(db, options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L98-L195) / [`detachDriver(db, options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L220-L265): 세션에 새 드라이버(`cli` | `gui` | `subagent`)를 부착(기존 활성 드라이버는 자동으로 `handover` 종료)하거나 분리합니다.
- [`buildDriverBriefing(db, sessionId, maxChars?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L315-L445): 하네스나 모델이 교체될 때 이전 작업 맥락(완료된 태스크의 `DoneClaim`, 진행 중 태스크, 토론 제약사항, 드라이버 교체 이력)을 0-Token으로 요약 주입하는 브리핑 텍스트를 생성합니다.
- [`parseDriverStreamLine(harness, rawLine)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L583-L920): Claude Code/Cursor(`stream-json`), Codex(`--json`), OpenCode(`--format json`)가 출력하는 실시간 JSON 스트림 라인을 파싱하여 구조화된 `DriverStreamEvent` 배열(`thinking`, `tool_use`, `tool_result`, `assistant`, `system`, `error`)로 변환합니다.
- [`runDriverTurn(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L926-L1196): 유저 메시지를 받아 해당 하네스 CLI를 실행하고, 실행 도중 발생하는 Thinking·Tool Use·Tool Result·응답 이벤트를 `onEvent` 콜백으로 실시간 스트리밍하며, 완료 후 새로 발급된 `harnessSessionId`를 DB에 자동 저장합니다.

#### ⑥ [`src/core/transcripts.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts)
5대 하네스의 로컬 디스크/DB에서 실제 대화 기록을 찾아 **4분류(Thinking, Tool Use, Tool Result, User/Assistant 메시지)**로 정밀 분리합니다.
- [`locateHarnessTranscript(query)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts#L140-L260): 하네스 종류, 프로젝트 경로, `harnessSessionId`를 바탕으로 로컬 트랜스크립트 파일(`.jsonl`, `.json`) 또는 SQLite DB(`opencode.db`) 위치를 찾습니다.
- [`readHarnessTranscript(query)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts#L995-L1084):
  - **Claude Code**: `~/.claude/projects/<encoded>/*.jsonl` 내 `thinking`, `tool_use`, `tool_result`, `text` 콘텐츠 블록을 개별 `TranscriptMessage`로 분리합니다.
  - **Codex CLI**: `~/.codex/sessions/**/<id>.jsonl`의 `event_msg`(`agent_reasoning`, `user_message`, `agent_message`) 및 `response_item`(`reasoning`, `function_call`, `custom_tool_call`, `function_call_output`)을 4분류로 파싱합니다.
  - **OpenCode**: `~/.local/share/opencode/opencode.db`의 `message` 및 `part` 테이블(`reasoning`, `tool`, `step-start`, `text`)과 JSON 스토리지를 모두 파싱합니다.
  - **Antigravity**: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`의 `USER_INPUT`, `PLANNER_RESPONSE`(`thinking` 및 `tool_calls` 분리), `TOOL_RESPONSE`를 파싱하며, `truncated_fields`가 감지되면 자동으로 같은 폴더의 `transcript_full.jsonl` 해당 라인을 읽어 잘림 없는 원문을 복원합니다.
  - **Cursor**: 평문 로컬 트랜스크립트를 제공하지 않으므로 `{ unsupported: true, messages: [] }`를 안전하게 반환합니다.

#### ⑦ [`src/core/router.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts)
태스크의 역할·카테고리·난이도에 따라 최적의 하네스와 모델을 배정하고 장애 시 폴백 체인을 구동합니다.
- [`resolveRoute(req, config)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts#L295-L420): 4단계 우선순위(① 명시적 핀 고정 → ② 5대 에이전트 역할 매칭 → ③ 도메인 카테고리 매칭 → ④ 난이도 매칭)로 라우팅을 결정합니다. 단일 하네스 고정(`pinnedHarness`) 시 `fallbacks`에서 해당 하네스의 지정 모델을 자동 탐색합니다.
- [`resolveFallback(currentDecision, attemptIndex)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts#L425-L465) & [`runWithFallbacks(initialDecision, runner)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts#L495-L580): 쿼터 초과(`429`, `quota exceeded`), 네트워크 오류, 비정상 종료 시 설정된 `fallbacks` 체인을 순서대로 자동 순회합니다.
- [`escalateTaskRoute(req, config, attempt)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts#L470-L492): 검증이 2회 이상 실패한 태스크를 상위 `architect` 역할 및 `high` 난이도 모델로 자동 에스컬레이션합니다.
- [`selectDiverseReviewer(primaryHarness, primaryModel, config, exclude?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts#L585-L650): 적대적 토론 시 메인 모델과 다른 모델 패밀리(`claude` vs `gpt` vs `gemini` vs `glm`)를 우선 선택하여 확증 편향을 방지합니다.

#### ⑧ [`src/core/spawner.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/spawner.ts)
외부 하네스 CLI 서브프로세스를 백그라운드로 스폰하고, 타임아웃·시크릿 마스킹·강제 종료·아티팩트 기록을 관리합니다.
- [`resolveSpawnCommand(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/spawner.ts#L104-L175): 5대 하네스별 비대화형 실행 인자 및 이전 서브세션 이어받기(`resumeSessionId`) 명령을 조립합니다.
- [`spawnSubagent(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/spawner.ts#L310-L520): `.asd/sessions/<sessionId>/subagents/<subSessionId>/` 아래에 `meta.json`, `prompt.md`, 시크릿이 마스킹된 실시간 `output.log`를 기록하며 유휴 타임아웃(`idleTimeoutMs`) 및 전체 타임아웃(`wallClockTimeoutMs`)을 감시합니다.
- [`killProcessTree(pid)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/spawner.ts#L60-L95): Windows(`taskkill /PID <pid> /T /F`) 및 POSIX(`process.kill(-pid, "SIGKILL")`)에서 자식 프로세스 트리를 완전히 종료합니다.
- [`finalizeSubagentArtifacts(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/spawner.ts#L530-L600): `claim_only` 모드 및 `asd verify` 완료 시 서브에이전트 `meta.json`과 `output.log`를 최종 상태로 마감합니다.

#### ⑨ [`src/core/workspace.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts)
Git 작업 트리 보호, `LIGHT` 체크포인트 커밋/롤백, `HEAVY` 워크트리 생성/병합, 고아 태스크 복구를 담당합니다.
- [`prepareBaseline(projectRoot, db, sessionId)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L375-L430): 세션 시작 시 미커밋 변경사항이 있으면 `git stash push -u`로 안전하게 보관하고 `stashed_work_sha`를 DB에 기록합니다.
- [`verifyAndCommitLightTask(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L505-L625): `LIGHT` 트랙에서 수정된 파일이 `targetFiles` 범위 내인지와 시크릿 유출 여부를 검사하고, 검증 명령(`verifyCmd`) 통과 시 `asd(<taskId>): <title>` 체크포인트 커밋을 생성합니다. 실패 시 [`rollbackLightChanges()`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L450-L500)로 해당 태스크 범위만 즉시 롤백합니다.
- [`createTaskWorktree(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L220-L310) & [`verifyAndMergeHeavyTask(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L630-L790): `HEAVY` 트랙에서 `.asd/wt/<turn>-<taskId>` 독립 워크트리를 생성하고 루트 `node_modules`를 Junction으로 연결한 뒤, 검증 통과 시 Junction을 해제하고 프로세스 간 파일 잠금(`.asd/merge.lock`, `withMergeLock`) 하에 `--no-ff` 병합합니다.
- [`recoverOrphanedTasks(db, projectRoot, sessionId)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L850-L940): 비정상 종료된 프로세스의 `running` 태스크를 감지하여 `pending` 또는 `escalated` 상태로 자동 복구합니다.

#### ⑩ [`src/core/debate.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/debate.ts)
이기종 모델 간 블라인드 교차 비평(Round 1)과 심판 합의 판결(Round 2)을 수행합니다.
- [`runDebateBroker(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/debate.ts#L310-L520): 코드 슬라이스(`--files path:start-end`) 및 `git diff HEAD`를 프롬프트에 직접 주입(0-Token 조회)하여 2명의 이기종 모델 리뷰어를 병렬 실행한 뒤, 익명화된 비평(`Reviewer A`, `Reviewer B`)을 심판(`arbiter`)에게 전달해 최종 판결(`APPROVE` | `MINOR_AMEND` | `REJECT`, `hard_constraints`, `decisions`, `risks`)을 도출합니다.
- [`formatDebateAcceptance(existingAcceptance, verdict)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/debate.ts#L530-L565): 도출된 `hard_constraints`를 태스크의 `acceptance` 필드에 자동 주입합니다.

#### ⑪ [`src/core/policy.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/policy.ts)
5대 하네스의 `PreToolUse` 및 `Stop` 훅에서 호출되는 1ms 보안 가드 및 서킷 브레이커입니다.
- [`evaluatePreToolUse(input)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/policy.ts#L580-L760):
  - 보호 경로(`.git/`, `.asd/`, `.env*`, `*.pem`, `*.key`, `id_rsa*`) 수정 및 파괴적 셸 명령(`git reset --hard`, `git push --force`, `rm -rf /` 등)을 대소문자·심볼릭 링크 정규화 기반으로 즉시 차단합니다.
  - 서브에이전트(`ASD_SESSION_ROLE=subagent`)일 경우 배정된 `allowedFiles` 밖의 파일 수정을 차단합니다.
- [`evaluateStopHook(input)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/policy.ts#L770-L890):
  - 서브에이전트는 즉시 종료를 허용(Subagent Shield)합니다.
  - 메인 디렉터 세션에서 미완료(`pending`/`running`/`escalated`) 태스크가 남아 있으면 종료를 보류하고 진행 안내를 반환하며, 진전 없는 정지 시도가 3회 연속(`no_progress_count >= 3`) 발생하면 서킷 브레이커를 작동시켜 세션을 `paused`로 전환하고 종료를 허용합니다.

#### ⑫ [`src/core/render.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts), [`src/core/redact.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/redact.ts), [`src/core/jsonc.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/jsonc.ts)
- **`render.ts`**:
  - [`renderPlanMd(sessionId, tasks)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L110-L185) / [`parsePlanMd(markdown)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L220-L480) / [`syncPlanFromMd(projectRoot, db, sessionId?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L485-L560): `.asd/PLAN.md`와 SQLite `tasks` 테이블 간의 양방향 렌더링·파싱·역동기화를 처리합니다.
  - [`getForegroundSessionId(projectRoot)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L65-L105) / [`setForegroundSession(projectRoot, db, sessionId)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L565-L600): `.asd/PLAN.md` 상단 `Session:` 헤더를 통해 현재 프로젝트의 전경(Foreground) 세션을 관리합니다.
  - [`renderProgressBoard(tasks, options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L605-L710) & [`renderSessionSummaryMd(session, tasks, debates)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L715-L790): 실시간 마크다운 진행 현황 보드와 최종 `summary.md`를 생성합니다.
- **`redact.ts`**:
  - [`redactSecrets(text)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/redact.ts#L55-L85) / [`containsSecrets(text)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/redact.ts#L90-L115): Anthropic/OpenAI/GitHub/Google/AWS API 키, Bearer 토큰, PEM 개인키, 비밀번호 패턴을 감지하여 `[REDACTED]`로 치환하거나 커밋 전 유출을 차단합니다.
- **`jsonc.ts`**:
  - [`parseJsonc(text)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/jsonc.ts#L95-L105) / [`stripJsoncComments(text)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/jsonc.ts#L15-L90): 문자열 리터럴 내부의 `//`나 `/*`를 훼손하지 않고 주석과 후행 쉼표를 제거하여 파싱합니다.
  - [`upsertTomlFencedBlock(existingToml, blockContent)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/jsonc.ts#L115-L160) / [`removeTomlFencedBlock(existingToml)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/jsonc.ts#L165-L190): Codex `~/.codex/config.toml` 내 `# >>> ASD MANAGED START >>>` 펜스 블록만 외과적으로 삽입·제거합니다.

---

### 4.3 5대 하네스 어댑터 및 인스톨러 (`src/adapters/`)

- **[`claude-code.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/claude-code.ts), [`opencode.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/opencode.ts), [`codex.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/codex.ts), [`antigravity.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/antigravity.ts), [`cursor.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/cursor.ts)**:
  - 모든 어댑터는 공통 `HarnessAdapter` 인터페이스를 구현합니다:
    - `detectCli()`: 바이너리 경로(`claude`, `opencode`, `codex`, `agy`, `cursor-agent`/`agent`) 및 버전, Headless 지원 여부를 탐지합니다.
    - `buildHeadlessCommand(options)`: 비대화형 서브에이전트 실행을 위한 CLI 인자 배열과 환경변수를 생성합니다.
    - `getCapabilities()`: 내장 도구(`nativeLsp`, `nativeWebSearch`, `supportsHooks` 등) 지원 여부를 반환하여 Gap-Filling MCP 주입 시 중복을 방지합니다.
- **[`src/adapters/installer.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/installer.ts)**:
  - [`syncGlobalHarnesses(options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/installer.ts#L1310-L1520): 5대 하네스의 글로벌 설정 디렉토리(`~/.claude`, `~/.config/opencode`, `~/.codex`, `~/.gemini`, `~/.cursor`)에 7개 스킬, 5대 에이전트 페르소나, 보안 훅(`PreToolUse`, `Stop`, Codex `notify`, Cursor 중첩 `hooks.json`), 부족한 MCP 서버, 전역 `PATH`의 `asd` 실행 심(shim)을 멱등(Idempotent)하게 동기화합니다.
  - [`uninstallGlobalHarnesses(options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/installer.ts#L1525-L1690): ASD가 설치한 훅, 펜스 블록, `_asdManaged` MCP 항목, 에이전트, 스킬만 외과적으로 제거하고 사용자의 기존 설정은 100% 보존합니다.
  - [`runDoctor(options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/installer.ts#L1695-L1830): 100ms 이내에 Node 버전, SQLite WAL, Git 저장소, 5대 하네스 바이너리 상태, `PreToolUse` 가드 정상 작동 여부를 진단합니다.

---

### 4.4 MCP 서버 및 오케스트레이션 핸들러 (`src/mcp/`)

- **[`src/mcp/server.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/server.ts)**:
  - CLI(`asd plan`, `asd dispatch`, `asd verify`, `asd debate`)와 MCP 서버(`AsdMcpServer`) 양쪽에서 공통으로 호출하는 코어 오케스트레이션 핸들러입니다.
  - [`handlePlan(ctx, args)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/server.ts#L590-L820): `create`, `get`, `update`, `sync_from_md` 액션을 처리하며, SQLite `tasks`와 `.asd/PLAN.md`, `.asd/sessions/<id>/main.json`을 동기화하고 메인 하네스 세션을 자동 연결합니다.
  - [`handleDispatch(ctx, args)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/server.ts#L825-L1250):
    - 고아 태스크 복구(`recoverOrphanedTasks`) → 선행 태스크(`depends_on`) 완료 확인 → 원자적 클레임(`tryClaimTask`)을 수행합니다.
    - `claim_only`(`LIGHT` 모드 기본값)일 때는 태스크별 위임 프롬프트와 허용 파일(`tests/**` 자동 포함)을 반환하고 서브에이전트 로그 폴더를 생성합니다.
    - `parallel_spawn`(`HEAVY` 모드)일 때는 태스크별 Git 워크트리를 만들고 외부 하네스 CLI들을 병렬 스폰한 뒤 검증·병합·에스컬레이션(최대 3회) 및 Cross-Scope 후속 태스크 자동 생성(서브에이전트당 최대 2개)까지 일괄 수행합니다.
  - [`handleVerify(ctx, args)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/server.ts#L1255-L1520): 태스크의 파일 경계·시크릿·테스트 명령을 검증하여 통과 시 체크포인트 커밋(`LIGHT`) 또는 워크트리 병합(`HEAVY`)을 수행하고, 모든 태스크가 `done`이면 `.asd/summary.md`를 생성합니다.
  - [`handleDebate(ctx, args)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/server.ts#L1525-L1660): `runDebateBroker`를 실행하여 이기종 모델 블라인드 토론 결과를 DB에 저장하고 대상 태스크의 `acceptance`에 제약사항을 주입합니다.
- **[`src/mcp/stdio-rpc.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/stdio-rpc.ts)**:
  - `StdioRpcServer`: 줄바꿈 구분 JSON-RPC 2.0 stdio 서버 구현체입니다.

---

### 4.5 CLI 및 로컬 웹 대시보드 (`src/cli/`)

#### ① [`src/cli/index.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/index.ts)
터미널에서 실행되는 `asd` 명령어의 엔트리포인트입니다.
- 지원 서브커맨드: `sync`, `update`, `status`, `resume`, `plan`, `dispatch`, `verify`, `debate`, `logs`, `ui`, `doctor`, `clean`, `uninstall`, `hook`, `mcp`.
- [`runHookCli(hookType, flags)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/index.ts#L530-L710): 5대 하네스의 `session-start`, `pre-invocation`, `pre-tool-use`, `stop` 훅 호출을 받아 `cli-recent.json`을 갱신하고 정책 평가 결과를 하네스별 규격 JSON으로 반환합니다.
- [`runAsdResume(projectRoot, flags)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/index.ts#L715-L790): 활성 ASD 세션을 하강(`demoteAsdSession`)시키고 원래 하네스의 대화형 CLI를 즉시 실행(또는 `--print`/`--json` 출력)합니다.

#### ② [`src/cli/dashboard.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts) (`asd ui` 상세 명세)
외부 프런트엔드 빌드 도구 없이 `node:http`와 단일 인라인 HTML/CSS/JS로 동작하는 실시간 로컬 웹 대시보드(`http://127.0.0.1:3847`) 및 상태 서비스 모듈입니다.
- **주요 백엔드 함수 및 HTTP 엔드포인트**:
  - [`collectDashboardSnapshot(options?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L1285-L1500) (`GET /api/state`): 현재 프로젝트의 세션, 태스크, 토론, 활성 드라이버, 서브에이전트 로그, 라우팅 설정, 하네스 설치 상태를 통합 스냅샷으로 반환합니다 (`worktreeStatusCache` 3.5초 TTL 캐시로 `git status --short` 반복 호출 병목 방지 및 `skipCliSpawn` 옵션 지원).
  - [`discoverHarnessModels(forceRefresh?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L225-L470) (`GET /api/models`, `POST /api/models/refresh`): 5대 하네스의 사용 가능 모델을 비동기 병렬(`Promise.all`)로 탐색하고 `~/.asd/state/models-cache.json`(10분 TTL)에 캐싱합니다.
  - [`saveSessionMemo(projectRoot, sessionId, memo)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L500-L555) (`POST /api/session-memo`): SQLite `sessions.memo`와 `.asd/sessions/<id>/main.json`에 메모를 동시 저장합니다.
  - [`saveProjectRoutingConfig(projectRoot, action, routingConfig?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L560-L610) (`POST /api/routing`): 프로젝트 전용 `.asd/routing.jsonc`를 저장하거나 글로벌 기본값으로 초기화합니다.
  - [`runSubagentControlAction(projectRoot, req)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L615-L685) (`POST /api/subagent-action`): 실행 중인 서브에이전트에 대해 `kill`(강제 종료), `retry`(동일 모델 재실행), `fallback`(다음 폴백 모델로 재실행), `custom`(지정 하네스·모델로 재실행)을 수행합니다.
  - [`startDashboardServer(options)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L2400-L2530): 로컬 HTTP 서버를 기동합니다.

---

## 5. 아키텍처 참고 및 운영 시 주의 사항 (Known Architectural Notes)

1. **Cursor CLI 로컬 트랜스크립트 제약**:
   - Cursor CLI(`agent` / `cursor-agent`)는 타 하네스와 달리 디스크에 평문 JSONL 대화 기록 파일을 노출하지 않습니다. 따라서 `readHarnessTranscript`는 Cursor에 대해 `{ unsupported: true, messages: [] }`를 반환하며, 대신 `~/.cursor/hooks.json` 기반의 세션 ID 추적(`cli-recent.json`), 실시간 스트리밍 실행(`runDriverTurn` `--output-format stream-json`), 세션 승격/하강(`promoteCliSessionToAsd` / `demoteAsdSession`)을 통해 제어합니다.
2. **단일 프로젝트 내 다중 디렉터 동시 실행 주의**:
   - SQLite DB는 WAL + `BEGIN IMMEDIATE`와 `session_drivers` 테이블로 동시 접근에 안전하며 `HEAVY` 병합도 `.asd/merge.lock`으로 보호되지만, 하나의 워킹 트리에서 두 개의 `LIGHT` 트랙 디렉터가 동시에 파일을 직접 수정하면 Git 워킹 트리 경합이 발생할 수 있으므로 병렬 작업 시에는 `HEAVY` 트랙(워크트리 격리) 사용을 권장합니다.
3. **Node.js 네이티브 TypeScript 실행 시 JSDoc 주석 주의**:
   - 하네스 `PreToolUse` 훅이 `node --no-warnings src/cli/index.ts hook pre-tool-use`를 직접 실행하므로, `src/` 내부 파일의 `/** ... */` 블록 주석 안에 경로 글로브 `/*` 또는 `*/`(예: `projects/*/*.jsonl`)를 적으면 주석이 조기 종료되어 구문 에러가 발생할 수 있습니다. 주석 내 경로 예시에는 `projects/<dir>/*.jsonl` 형태를 사용합니다.
