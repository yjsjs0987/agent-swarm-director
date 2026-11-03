# ASD v2.4.0 외부 SDK 및 단일 DB 전환 통합 레퍼런스 (`EXTERNAL_SDK_REFERENCE.md`)

> **버전**: `2.4.0` (단일 공유 SQLite DB 및 v2.4.0 신규 SDK 통합본 — `2.3.x` 이하와 DB 비호환)  
> **대상**: `asd-gui` 등 외부 애플리케이션 및 라이브러리 연동 개발자  
> **런타임 의존성**: `0개` (`dependencies: {}`, 순수 Node.js `>=22.13.0` 내장 모듈만 사용)  
> **메인 엔트리포인트**: [`src/index.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/index.ts) (`import { ... } from "agent-swarm-director"`)

[📖 README (한국어)](./README_ko.md) | [📖 README (EN)](./README.md) | [🏛️ 프로젝트 아키텍처 및 파일·함수 상세](./PROJECT_STATUS.md) | [📋 패치 노트 (KR)](./PATCH_NOTES_ko.md)

---

## 1. 단일 상태 DB 전환 및 v2.4.0 핵심 변경 사항

### 1.1 단일 공유 SQLite DB 전환 (`~/.asd/state/core.db`)
기존(v2.3.2 이하)에는 프로젝트마다 `~/.asd/state/<projectHash>/core.db`를 개별 생성했으나, 테스트 임시 프로젝트 누적 등으로 디렉토리가 수천 개로 늘어나는 문제를 해결하기 위해 **단일 공유 DB(`~/.asd/state/core.db`)** 구조로 전환했습니다.

| 구분 | 이전 (v2.3.2 이하) | 현재 (v2.4.0) |
| :--- | :--- | :--- |
| **DB 파일 위치** | `~/.asd/state/<projectHash>/core.db` × N개 | **`~/.asd/state/core.db` 단 1개** |
| **프로젝트 구분 방식** | 해시 디렉토리 분리 | `sessions.project_root` 컬럼 스코프 (`SqliteDriver(dbPath, projectRoot?)`) |
| **프로젝트 목록 탐색** | 수천 개 디렉토리 순회 + DB N회 오픈 | `listKnownProjects()` 단일 쿼리 1회 + 15초 FS 캐시 (`skipDiskCheck` 지원) |
| **테스트 홈 격리** | 호출부마다 상이 | `ASD_HOME_DIR` 환경변수 단일 결정점 ([`resolveHomeDir`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L102-L108)) |

#### 외부 GUI(`asd-gui`) 연동 시 필수 확인 사항
1. **[`openProjectDb(projectRoot, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L1030-L1040) 사용 권장**: 반환된 [`SqliteDriver`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L288-L1025) 인스턴스는 이미 해당 `projectRoot`로 스코프되어 있어 `listSessions()`, `getAllTasks()`, `getAllDebates()`, `getLatestSession()` 호출 시 자동으로 해당 프로젝트 데이터만 반환합니다.
2. **`new SqliteDriver(dbPath)` 직접 호출 주의**: 두 번째 인자(`projectRoot`)를 생략하면 전체 프로젝트의 세션이 함께 조회됩니다. 특정 프로젝트만 조회할 때는 반드시 `new SqliteDriver(dbPath, projectRoot)` 또는 `openProjectDb(projectRoot)`를 사용하세요.
3. **`projectHash` 용도**: `resolveAsdPaths()`와 `KnownProjectSummary`의 `projectHash`는 UI 리스트의 고유 키(`key={p.projectHash}`)로 계속 사용할 수 있으나, 실제 DB 경로는 항상 `paths.dbPath`(`~/.asd/state/core.db`)를 참조해야 합니다.

### 1.2 v2.4.0 신규 및 고도화 SDK 요약
1. **프로젝트별 5대 하네스 CLI 세션 통합 탐색 ([`discoverProjectCliSessions`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1774-L1895))**:
   - Claude Code, OpenCode, Codex, Antigravity, Cursor에서 현재 프로젝트 경로로 실행된 모든 CLI 세션을 찾고, ASD 세션 승격 여부(`isPromotedToAsd`, `asdSessionId`, `asdPhase`)까지 결합해 반환합니다.
2. **대화 기록 4분류 정밀 파싱 ([`readHarnessTranscript`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts#L995-L1084))**:
   - 각 하네스의 로컬 DB/파일에서 대화 기록을 읽어 **① Thinking(`thinking`), ② Tool Use(`tool_use`), ③ Tool Result(`tool_result`), ④ 사용자에게 답하는 메시지(`assistant`) 및 사용자 메시지(`user`)**로 정밀 분리합니다.
3. **실시간 스트리밍 턴 실행 ([`runDriverTurn`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L926-L1196) & [`parseDriverStreamLine`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L583-L920))**:
   - 유저 메시지를 실제 하네스로 전달해 실행하면서, 실행 도중 발생하는 실시간 Thinking 과정, Tool Use 과정, Tool Result, 응답 텍스트를 `onEvent` 콜백으로 즉시 스트리밍합니다.
4. **일반 CLI 세션 ↔ ASD 세션 양방향 승격 및 하강**:
   - **승격(Promote)**: [`promoteCliSessionToAsd`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1619-L1740)로 일반 CLI 세션을 ASD 세션으로 즉시 승격(멱등성 보장 + 드라이버 자동 연결)합니다.
   - **하강(Demote)**: [`demoteAsdSession`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1455-L1545)(또는 CLI `asd resume`)로 ASD 세션을 일시정지하고 원래 하네스의 네이티브 CLI 세션으로 즉시 복귀합니다.
5. **초기 로딩 및 모델 탐색 속도 최적화**:
   - [`discoverHarnessModels`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L225-L470): 비동기 병렬 실행(`Promise.all`) + `~/.asd/state/models-cache.json`(10분 TTL) 디스크 캐시 적용.
   - [`listKnownProjects`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1901-L1980): 15초 인메모리 FS 캐시, `skipDiskCheck`, `db` 인스턴스 재사용 옵션 추가.

---

## 2. v2.4.0 핵심 신규/개선 SDK 상세 사용법

### 2.1 프로젝트 내 5대 하네스 CLI 세션 통합 탐색 (`discoverProjectCliSessions`)

특정 프로젝트 경로에서 실행된 5대 하네스의 로컬 CLI 세션을 모두 스캔(`syncLocalHarnessTranscripts` 포함)하고 `core.db`의 ASD 세션과 매칭하여 최신순으로 반환합니다.

```ts
import {
  discoverProjectCliSessions,
  type DiscoveredCliSession,
  type DiscoverProjectCliSessionsOptions,
} from "agent-swarm-director";

const sessions: DiscoveredCliSession[] = discoverProjectCliSessions("/path/to/project", {
  limit: 100,
  syncLocalTranscripts: true, // 기본값 true: Claude/Codex/OpenCode/Antigravity 로컬 스토리지 스캔 포함
});
```

#### `DiscoveredCliSession` 반환 구조
| 필드 | 타입 | 설명 |
| :--- | :--- | :--- |
| `harness` | `HarnessId` | `"claude-code" \| "opencode" \| "codex" \| "antigravity" \| "cursor"` |
| `harnessSessionId` | `string` | 하네스 네이티브 세션 ID (UUID 등) |
| `projectRoot` | `string` | 정규화된 프로젝트 루트 경로 |
| `updatedAt` | `number` | 마지막 활동 시각 (Unix epoch ms) |
| `model` | `string \| undefined` | 감지된 모델 ID |
| `summary` | `string \| undefined` | 세션의 첫 사용자 프롬프트 또는 요약 제목 |
| `transcriptPath` | `string \| undefined` | 로컬 트랜스크립트 파일(`.jsonl`) 또는 `opencode.db` 경로 |
| `asdSessionId` | `string \| null` | 승격된 ASD `session_id` (미승격 일반 CLI 세션이면 `null`) |
| `asdPhase` | `SessionPhase \| null` | `"planning" \| "running" \| "paused" \| "done" \| null` |
| `isPromotedToAsd` | `boolean` | ASD 세션으로 승격되어 `core.db`에 등록되어 있으면 `true` |

---

### 2.2 대화 기록 4분류 파서 (`readHarnessTranscript`)

각 하네스의 로컬 트랜스크립트에서 대화 기록을 읽어 **Thinking**, **Tool Use**, **Tool Result**, **User / Assistant 메시지**로 분류합니다.
- **Claude Code**: `~/.claude/projects/<encoded>/*.jsonl`의 `thinking`, `tool_use`, `tool_result`, `text` 블록 분리.
- **Codex CLI**: `~/.codex/sessions/**/<id>.jsonl`의 `agent_reasoning`, `function_call`, `custom_tool_call`, `function_call_output`, `user_message`, `agent_message` 분리.
- **OpenCode**: `~/.local/share/opencode/opencode.db`의 `part` 테이블(`reasoning`, `tool`, `text`) 및 JSON 스토리지 분리.
- **Antigravity**: `transcript.jsonl`의 `USER_INPUT`, `PLANNER_RESPONSE`(`thinking`, `tool_calls`), `TOOL_RESPONSE` 분리 및 `truncated_fields` 발생 시 `transcript_full.jsonl` 해당 라인 자동 복원.

```ts
import {
  readHarnessTranscript,
  type TranscriptReadResult,
  type TranscriptMessage,
  type TranscriptMessageCategory,
} from "agent-swarm-director";

const transcript: TranscriptReadResult = readHarnessTranscript({
  harness: "claude-code", // "claude-code" | "opencode" | "codex" | "antigravity" | "cursor"
  projectRoot: "/path/to/project",
  harnessSessionId: "eb7de063-fd75-4fa7-8312-9efcf3fd77e5",
  transcriptPath: undefined, // 선택: 알고 있는 경우 직접 전달하면 디스크 탐색 생략
  maxMessages: 300,
});
```

#### `TranscriptMessage` 인터페이스 (v2.4.0)
```ts
export type TranscriptMessageCategory =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "system";

export interface TranscriptMessage {
  role: "user" | "assistant" | "system" | "tool";
  category?: TranscriptMessageCategory;
  text: string;
  thinking?: string; // category === "thinking" 일 때 추론 원문
  toolName?: string;
  toolUse?: {
    name: string;
    id?: string;
    input?: string;  // 도구 호출 인자 JSON 문자열
  };
  toolResult?: {
    name?: string;
    toolUseId?: string;
    output: string;  // 도구 실행 결과 텍스트
    isError?: boolean;
  };
  timestamp?: string;
}
```

---

### 2.3 실시간 스트리밍 대화 실행 (`runDriverTurn`, `parseDriverStreamLine`)

유저가 대화창을 통해 보낸 메시지를 실제 하네스로 전달해 실행하고, 실행 중 발생하는 **Thinking 과정**, **Tool Use 과정**, **Tool Result**, **응답 텍스트**를 `onEvent` 콜백으로 실시간 수신합니다.

```ts
import {
  runDriverTurn,
  parseDriverStreamLine,
  type DriverStreamEvent,
  type RunDriverTurnResult,
} from "agent-swarm-director";

const result: RunDriverTurnResult = await runDriverTurn({
  projectRoot: "/path/to/project",
  sessionId: "asd-20261103-182153-i9ti",
  harness: "claude-code",
  model: "claude-sonnet-4-6",
  prompt: "현재 프로젝트의 세션 트래커 구조를 분석해줘.",
  source: "gui",
  streamJson: true, // 기본값 true: Claude/Cursor(--output-format stream-json --verbose), Codex(--json), OpenCode(--format json) 자동 활성화
  onEvent: (event: DriverStreamEvent) => {
    switch (event.category) {
      case "thinking":
        console.log("[실시간 Thinking]", event.thinking);
        break;
      case "tool_use":
        console.log("[실시간 Tool Use]", event.toolUse?.name, event.toolUse?.input);
        break;
      case "tool_result":
        console.log("[실시간 Tool Result]", event.toolResult?.output);
        break;
      case "assistant":
        console.log("[실시간 Assistant 응답]", event.text);
        break;
    }
  },
});
```

---

### 2.4 ASD 세션 관리: 승격 (`promoteCliSessionToAsd`) 및 하강 (`demoteAsdSession`)

#### ① 일반 CLI 세션을 ASD 세션으로 승격 (Promote)
```ts
import {
  promoteCliSessionToAsd,
  type PromoteCliSessionResult,
} from "agent-swarm-director";

const promoted: PromoteCliSessionResult = promoteCliSessionToAsd({
  projectRoot: "/path/to/project",
  harness: "claude-code",
  harnessSessionId: "eb7de063-fd75-4fa7-8312-9efcf3fd77e5",
  model: "claude-sonnet-4-6",
  memo: "GUI에서 승격된 세션",
  phase: "running",         // 기본값 "running"
  attachActiveDriver: true, // true 시 session_drivers 테이블에 즉시 활성 드라이버 등록
  driverSource: "gui",
});
// promoted.session        -> 생성 또는 기존 매칭된 SessionRecord
// promoted.created        -> 신규 생성 여부 (이미 승격된 세션이면 false)
// promoted.driver         -> 부착된 DriverRow | null
```

#### ② ASD 세션을 다시 하네스의 네이티브 CLI 세션으로 하강 (Demote)
```ts
import {
  demoteAsdSession,
  type DemoteAsdSessionResult,
} from "agent-swarm-director";

const demoted: DemoteAsdSessionResult = demoteAsdSession(
  "/path/to/project",
  "asd-20261103-182153-i9ti",
  { pauseSession: true },
);
// demoted.ok               -> true
// demoted.harness          -> "claude-code"
// demoted.harnessSessionId -> "eb7de063-fd75-4fa7-8312-9efcf3fd77e5"
// demoted.commandString    -> 'claude --resume "eb7de063-fd75-4fa7-8312-9efcf3fd77e5"'
// demoted.command          -> "claude"
// demoted.args             -> ["--resume", "eb7de063-fd75-4fa7-8312-9efcf3fd77e5"]
```

---

### 2.5 고속 프로젝트 로딩 및 모델 캐시 API (`listKnownProjects`, `discoverHarnessModels`)

```ts
import {
  listKnownProjects,
  discoverHarnessModels,
  getModelsDiskCachePath,
} from "agent-swarm-director";

// 1. 프로젝트 목록 고속 조회 (15초 FS stat 캐시 적용; skipDiskCheck: true 시 디스크 I/O 없이 DB만 즉시 조회)
const projects = listKnownProjects({
  skipDiskCheck: false,
  forceRefresh: false,
});

// 2. 비동기 병렬 모델 조회 (~/.asd/state/models-cache.json 10분 디스크 캐시 사용)
const models = await discoverHarnessModels(false); // 강제 새로고침 시 true
const cachePath = getModelsDiskCachePath();
```

---

## 3. 전체 외부 호출 가능 인터페이스 카탈로그

### 3.1 Node.js 라이브러리 서브패스 Export (`package.json` `exports`)

```ts
import * as asd from "agent-swarm-director";               // 전체 코어 통합 엔트리 (src/index.ts)
import * as db from "agent-swarm-director/core/db";        // 개별 서브모듈 직접 import 가능
import * as mcp from "agent-swarm-director/mcp/server";
import * as dashboard from "agent-swarm-director/cli/dashboard";
```

| 모듈 경로 | 대표 공개 함수 및 클래스 |
| :--- | :--- |
| **`core/types`** | `ASD_VERSION` (`"2.4.0"`), `HARNESS_IDS`, `AGENT_ROLES`, `TASK_CATEGORIES`, `DIFFICULTY_TIERS`, `TASK_TRACKS`, `TASK_STATUSES`, `SESSION_PHASES`, `DRIVER_SOURCES` 및 전체 타입 |
| **`core/config`** | `resolveAsdPaths(root, home?)`, `resolveHomeDir(explicit?)`, `ensureProjectInitialized`, `loadRoutingConfig`, `loadMcpCatalog`, `checkForRemoteUpdate`, `computeProjectHash` |
| **`core/db`** | `openProjectDb(root, home?)`, `SqliteDriver(dbPath, projectRoot?)`, `generateAsdSessionId`, `isValidAsdSessionId` — `sessions` / `tasks` / `debates` / `session_drivers` 전체 CRUD |
| **`core/session-tracker`** | `discoverProjectCliSessions` *(v2.4.0)*, `promoteCliSessionToAsd` *(v2.4.0)*, `demoteAsdSession`, `buildSessionDemotion`, `listKnownProjects` *(v2.4.0 캐시 최적화)*, `syncLocalHarnessTranscripts` *(v2.4.0 4하네스 확장)*, `linkHarnessSessionToAsdSession`, `readCliRecentSessions`, `recordCliRecentSession`, `buildResumeHarnessCommand`, `buildInteractiveResumeHarnessCommand`, `extractHookSessionInfo` |
| **`core/drivers`** | `runDriverTurn` *(v2.4.0 `onEvent` 스트리밍)*, `parseDriverStreamLine` *(v2.4.0)*, `attachDriver`, `detachDriver`, `getActiveDriver`, `listDrivers`, `buildDriverBriefing`, `syncSessionDriversToMainJson` |
| **`core/transcripts`** | `readHarnessTranscript` *(v2.4.0 4분류 고도화)*, `locateHarnessTranscript` |
| **`core/spawner`** | `spawnSubagent`, `executeHarnessProcess`, `killProcessTree`, `resolveSpawnCommand`, `finalizeSubagentArtifacts` |
| **`core/router`** | `resolveRoute`, `runWithFallbacks`, `escalateTaskRoute`, `resolveFallback`, `detectAvailableCliHarnesses`, `selectDiverseReviewer` |
| **`core/workspace`** | `prepareBaseline`, `createTaskWorktree`, `verifyAndCommitLightTask`, `verifyAndMergeHeavyTask`, `rollbackLightChanges`, `recoverOrphanedTasks`, `getChangedFiles`, `checkChangedFilesAndSecrets`, `withMergeLock`, `runGit` |
| **`core/render`** | `renderPlanMd`, `parsePlanMd`, `syncPlanFromMd`, `setForegroundSession`, `getForegroundSessionId`, `renderProgressBoard`, `renderSessionSummaryMd`, `atomicWriteFileSync` |
| **`core/debate`** | `runDebateBroker`, `synthesizeInsightVerdict`, `buildRound1Prompt`, `buildRound2Prompt`, `formatDebateAcceptance` |
| **`core/policy`** | `evaluatePreToolUse`, `evaluateStopHook`, `isPathAllowed`, `checkProtectedPath`, `verifyChangedFilesBoundary` |
| **`core/redact` & `jsonc`** | `redactSecrets`, `containsSecrets`, `parseJsonc`, `stripJsoncComments`, `upsertTomlFencedBlock`, `removeTomlFencedBlock` |
| **`adapters/*`** | `ClaudeCodeAdapter`, `OpenCodeAdapter`, `CodexAdapter`, `AntigravityAdapter`, `CursorAdapter`, `syncGlobalHarnesses`, `uninstallGlobalHarnesses`, `runDoctor` |
| **`mcp/server`** | `AsdMcpServer`, `ASD_MCP_TOOLS`, `handlePlan`, `handleDispatch`, `handleVerify`, `handleDebate` |
| **`cli/dashboard`** | `startDashboardServer`, `collectDashboardSnapshot`, `discoverHarnessModels` *(v2.4.0 디스크 캐시)*, `getModelsDiskCachePath` *(v2.4.0)*, `saveSessionMemo`, `saveProjectRoutingConfig`, `runSubagentControlAction` |
| **`cli/index`** | `getAdapter`, `getLatestSession`, `scanSubagentLogs`, `runAsdLogs`, `runAsdClean` |

---

### 3.2 CLI 서브커맨드 (`asd <command>`)

공통 플래그: `--json`, `--project-root <dir>`, `--home <dir>`, `--session <id>`, `--harness <id>`.

| 명령어 | 설명 | 주요 플래그 |
| :--- | :--- | :--- |
| `asd plan [create\|get\|update\|sync_from_md]` | `.asd/PLAN.md` 및 SQLite 태스크 생성·조회·역동기화 | `--tasks <json>`, `--payload <json\|->`, `--file <path>` |
| `asd dispatch` | Turn(Wave) 태스크 병렬 실행 또는 클레임 | `--turn <n>`, `--mode parallel_spawn\|claim_only`, `--task T1.1` |
| `asd verify --task <id>` | 파일 경계·시크릿·테스트 검증 후 커밋(`LIGHT`) 또는 워크트리 병합(`HEAVY`) | `--summary`, `--files`, `--cmd`, `--payload` |
| `asd debate --topic <t> --proposal <p>` | 교차 모델 블라인드 적대적 토론 및 `acceptance` 제약 자동 주입 | `--proposal-file`, `--diff`, `--files path:start-end` |
| `asd resume` | 활성 ASD 세션을 하강(`demote`)하고 원래 하네스의 대화형 CLI로 즉시 복귀 | `--session <id>`, `--print`, `--json` |
| `asd status` | 현재 프로젝트의 전경 세션 진행 현황 보드 출력 | `--json` |
| `asd logs [taskId]` | 최근 또는 특정 태스크의 서브에이전트 프롬프트·출력 로그 조회 | `--json` |
| `asd ui` | 로컬 실시간 웹 대시보드 서버 실행 (기본 포트 `3847`) | `--port <num>`, `--no-open` |
| `asd sync` | 5대 하네스 글로벌 스킬·에이전트·훅·MCP 동기화 및 전역 `PATH` 등록 | `--force`, `--no-path` |
| `asd update` | GitHub 최신 버전 pull 및 `asd sync` 자동 실행 | — |
| `asd doctor` | 100ms 이내 환경·하네스·보안 훅 헬스체크 | `--json` |
| `asd clean` | 잔여 `.asd/wt/*` 워크트리 정리 및 auto-stash 복원 | `--pop`, `--all` |
| `asd uninstall` | ASD가 설치한 글로벌 설정만 외과적으로 원복 | `--home <dir>` |
| `asd hook <type>` | 하네스 훅 평가기 (`session-start`, `pre-invocation`, `pre-tool-use`, `stop`) | stdin JSON → stdout JSON |

---

### 3.3 로컬 웹 대시보드 HTTP API (`asd ui`, 기본 `http://127.0.0.1:3847`)

| 엔드포인트 | 메서드 | 설명 |
| :--- | :--- | :--- |
| `/api/state` | `GET` | `collectDashboardSnapshot()` 전체 상태 스냅샷 반환 |
| `/api/models` | `GET` | 5대 하네스별 사용 가능 모델 목록 조회 (`models-cache.json` 활용) |
| `/api/models/refresh` | `POST` | 모델 목록 강제 재탐색 (`discoverHarnessModels(true)`) |
| `/api/session-memo` | `POST` | 세션 한 줄 메모 저장 (`{ sessionId, memo }`) |
| `/api/routing` | `POST` | 프로젝트 로컬 라우팅(`.asd/routing.jsonc`) 저장 또는 초기화 (`{ action: "save" \| "reset", routingConfig }`) |
| `/api/subagent-action` | `POST` | 서브에이전트 실시간 제어 (`{ sessionId, subSessionId, action: "kill" \| "retry" \| "fallback" \| "custom", harness?, model? }`) |
