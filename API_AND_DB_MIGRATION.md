# ASD v2.3.3 — 외부 API 레퍼런스 & 단일 DB 전환 인계 문서

> 대상: asd-gui 부서 인계용. ASD 코어(asd-multiagent) v2.3.2 → **단일 상태 DB** 전환 변경분과
> 외부에서 호출 가능한 모든 API를 정리했다.
>
> 작성: 2026-11-03 (ASD 코어 리포지토리 기준, 테스트 304/304 통과 후 스냅샷)

---

## 1. 단일 DB 전환 — 무엇이 바뀌었나

### 1.1 배경

기존에는 프로젝트마다 `~/.asd/state/<projectHash>/core.db` 를 만들었다.
테스트가 임시 프로젝트를 실제 홈에 등록하는 오염이 누적되어 **해시 디렉터리 4,415개 / 271MB**,
그중 실세션은 12개뿐이었다. 전환 후:

| | 이전 | 이후 |
|---|---|---|
| DB 위치 | `~/.asd/state/<hash>/core.db` × N개 | `~/.asd/state/core.db` **1개** |
| 프로젝트 구분 | 디렉터리 | `sessions.project_root` 컬럼 |
| 디스크 | 271MB / 4,415 디렉터리 | **809KB / 파일 3개** (`core.db`, `last-sync.json`, `update-check.json`) |
| 프로젝트 발견(GUI 목록) | 디렉터리 순회 + DB N회 오픈 | `listSessions()` 1회 → `project_root` 그룹핑 |

### 1.2 코드 변경 지점 (5파일)

| 파일 | 변경 |
|---|---|
| `src/core/config.ts` | `dbPath` → `state/core.db` 단일화. `resolveHomeDir()` 추가: `명시 인자 > ASD_HOME_DIR env > os.homedir()` 단일 결정점 |
| `src/core/db.ts` | `SqliteDriver(dbPath, projectRoot?)` — 두 번째 인자로 스코프. `getLatestSession`/`listSessions`/`getAllTasks`/`getAllDebates`가 스코프 시 `project_root`로 WHERE. `openProjectDb()`는 항상 스코프 적용 |
| `src/core/session-tracker.ts` | `listKnownProjects()` — 디렉터리 순회 폐지, 단일 DB 쿼리 그룹핑으로 재작성 |
| `src/core/policy.ts` | 훅이 자체 여는 드라이버도 스코프 적용 |
| `src/cli/dashboard.ts` | 레거시 `<project>/.asd/core.db` 폴백 드라이버 3곳도 스코프 적용 |

### 1.3 asd-gui가 알아야 할 것 (핵심)

1. **`openProjectDb(root, home)` 호출만 쓰면 무변경 대응 가능** — 반환된 드라이버는 이미
   그 프로젝트로 스코프돼 있어 `listSessions()`, `getAllTasks()`, `getAllDebates()`,
   `getLatestSession()`이 자동으로 해당 프로젝트 것만 돌려준다.
   (asd-gui `src/server/context.ts`의 `getDb()` 캐시도 그대로 동작)
2. **`projectHash`는 여전히 반환되지만 디렉터리와 대응하지 않는다.** GUI 프로젝트 목록의
   React `key={p.projectHash}` 용도로는 안전(안정적 해시). 단, `state/<hash>/core.db`
   경로를 조립해 쓰는 코드가 있다면 `KnownProjectSummary.dbPath`를 쓰도록 교체.
3. **직접 `new SqliteDriver(path)` 를 쓰는 코드 주의** — 두 번째 인자를 주지 않으면
   *무스코프*(모든 프로젝트의 세션이 섞여 보임). GUI처럼 한 DB를 여러 프로젝트가 공유하는
   환경에서는 반드시 `openProjectDb`를 쓰거나 스코프 인자를 전달할 것.
4. **마이그레이션 완료됨.** 기존 12세션(asd-gui 5, multiagent 3, OMO 3, Elysium 1) 모두
   새 단일 DB로 이식했고 구 `<hash>` 디렉터리 4,415개는 삭제했다. GUI 쪽 추가 이관 작업 불필요.

### 1.4 테스트/개발자 환경 규칙

- **`ASD_HOME_DIR` 환경변수가 모든 경로 결정에 적용된다.** 테스트/샌드박스에서 이 값을
  임시 디렉터리로 주면 실제 홈이 절대 오염되지 않는다 (이전에는 호출부마다 폴백이 달랐음).
- `npm test` 대신 **`node scripts/run-tests.mjs`** 를 권장한다 — 임시 홈을 자동 만들고
  `ASD_HOME_DIR`로 격리 후 종료 시 제거한다. (기존 테스트 대부분은 `--home`/`homeDir`를
  명시하지 않으면 이 env 폴백 하나로 격리된다.)
- 마이그레이션 스크립트는 `scripts/migrate-single-db.ts` 에 남아 있다 (신규 머신 이관용,
  idempotent: 이미 이식된 세션은 스킵).

---

## 2. 외부 호출 가능 API 전체

### 2.1 CLI (`asd <command>`) — `src/cli/index.ts`

공통 플래그: `--json`(기계판독 stdout), `--project-root <dir>`, `--home <dir>`,
`--session <id>`, `--harness <claude-code|opencode|codex|antigravity|cursor>`.

| 명령 | 설명 | 주요 플래그 |
|---|---|---|
| `asd plan [create\|get\|update\|sync_from_md]` | PLAN.md/SQLite 태스크 생성·조회·수동편집 동기화 | `--tasks <json>`, `--title`, `--payload <json\|->`, `--file <path>` |
| `asd dispatch` | 웨이브(Turn) 태스크 병렬 실행/클레임. 의존성 검증, HEAVY 워크트리, 에스컬레이션(≤3회) | `--turn <n>`, `--mode parallel_spawn\|claim_only`, `--task T1.1,T1.2` |
| `asd verify --task <id>` | 경계 검증 → 커밋/병합. 전체 완료 시 summary.md 생성 | `--summary`, `--files`, `--cmd`, `--payload` |
| `asd debate --topic <t> --proposal <p>` | 크로스모델 블라인드 토론 → Insight Verdict → acceptance 주입 | `--proposal-file`, `--diff`, `--files path:start-end` |
| `asd sync` | 5 하네스 글로벌 설정 동기화 + PATH 셈 등록 | `--force`, `--no-path` |
| `asd update` | GitHub 최신 릴리스 pull + sync | — |
| `asd status` | 최신(전경) 세션 진행 보드 | `--json` |
| `asd logs [taskId]` | 서브에이전트 프롬프트/출력 로그 | `--json` |
| `asd ui` | 로컬 웹 대시보드 (기본 3847) | `--port`, `--json` |
| `asd doctor` | 환경/도구/정책 진단 | `--json` |
| `asd clean` | 임시 워크트리 정리, auto-stash 복원 | `--pop`, `--all` |
| `asd uninstall` | 하네스 설정 원복 | `--home` |
| `asd hook <session-start\|pre-invocation\|pre-tool-use\|stop>` | 하네스 훅 평가기 (stdin JSON → `{decision}` stdout) | — |
| `asd mcp` | MCP 서버 stdio 시작 | — |

### 2.2 MCP 서버 (`asd mcp`) — `src/mcp/server.ts`

stdio JSON-RPC (`initialize`, `ping`, `tools/list`, `tools/call`).

| 도구 | 필수 입력 | 비고 |
|---|---|---|
| `asd_plan` | `action` | create/get/update/sync_from_md. 응답에 progressBoard 포함 |
| `asd_dispatch` | `sessionId` | `mode`, `turn`, `taskIds`, `harness` 옵션 |
| `asd_verify` | `sessionId`, `taskId`, `doneClaim{summary, changed_files, key_decisions, risks}` | `cross_scope_requests`로 스코프 밖 변경 요청 가능(≤2 자동 스케줄) |
| `asd_debate` | `sessionId`, `topic`, `proposal` | `files`, `includeDiff`, `harness` 옵션 |

**서브에이전트 격리 가드**: `ASD_SESSION_ROLE=subagent` 환경에서는 plan/dispatch/debate가
거부되고 `asd_verify`만 허용된다.

라이브러리 사용 시: `new AsdMcpServer({projectRoot, homeDir?, db?, autoSync?})` 후
`handlePlan/handleDispatch/handleVerify/handleDebate` 직접 호출 가능.

### 2.3 HTTP 대시보드 API (`asd ui`, 기본 `127.0.0.1:3847`) — `src/cli/dashboard.ts`

| 엔드포인트 | 메서드 | 기능 |
|---|---|---|
| `/api/state` | GET | 전체 스냅샷 (세션/태스크/토론/드라이버/서브에이전트 로그/모델 카탈로그) |
| `/api/models` | GET | 하네스별 사용 가능 모델 (캐시) |
| `/api/models/refresh` | POST | 모델 탐색 강제 재실행 |
| `/api/session-memo` | POST | `{sessionId, memo}` |
| `/api/routing` | POST | `{action: save\|reset, routingConfig}` |
| `/api/subagent-action` | POST | `{subSessionId, action: kill\|retry\|fallback\|custom, harness?, model?, waitForCompletion?}` |

바인딩 127.0.0.1 로컬 전용. `startDashboardServer({port, host, projectRoot, homeDir})`로
라이브러리 임베드도 가능.

### 2.4 Node 라이브러리 import

```ts
import "agent-swarm-director";                       // 전체 코어 (src/index.ts)
import "agent-swarm-director/core/db";               // 개별 모듈
import "agent-swarm-director/mcp/server";
import "agent-swarm-director/adapters/claude-code";
import "agent-swarm-director/cli/dashboard";
```

모듈별 대표 공개 함수:

| 모듈 | 대표 API |
|---|---|
| `core/db` | `openProjectDb(root, home?)`, `SqliteDriver(dbPath, projectRoot?)` — sessions/tasks/debates/driver CRUD, `tryClaimTask`, `claimWaveTasks`, `recordTaskVerified`, `recordTaskAttemptFailure`, `upsertTasks`, `listProjectRoots()` |
| `core/config` | `resolveAsdPaths(root, home?)` → `{projectHash, dbPath, planMdPath, sessionsDir, wt, routing...}`, `resolveHomeDir(explicit?)`, `loadRoutingConfig`, `checkForRemoteUpdate`, `computeProjectHash` |
| `core/session-tracker` | `listKnownProjects({homeDir?, extraProjectRoots?})` — **GUI 프로젝트 목록의 단일 소스**, `linkHarnessSessionToAsdSession`, `buildResumeHarnessCommand`, `buildInteractiveResumeHarnessCommand`, `extractHookSessionInfo`, `syncLocalHarnessTranscripts`, `readCliRecentSessions`, `recordCliRecentSession` |
| `core/drivers` | `attachDriver`, `detachDriver`, `getActiveDriver`, `listDrivers`, `buildDriverBriefing`, `runDriverTurn`, `syncSessionDriversToMainJson` |
| `core/spawner` | `spawnSubagent`, `executeHarnessProcess`, `killProcessTree`, `resolveSpawnCommand`, `finalizeSubagentArtifacts` |
| `core/router` | `resolveRoute`, `runWithFallbacks`, `escalateTaskRoute`, `resolveFallback`, `detectAvailableCliHarnesses`, `selectDiverseReviewer` |
| `core/workspace` | `createTaskWorktree`, `verifyAndCommitLightTask`, `verifyAndMergeHeavyTask`, `approvePendingTask`, `rejectPendingTask`, `recoverOrphanedTasks`, `getChangedFiles`, `checkChangedFilesAndSecrets`, `withMergeLock`, `runGit` |
| `core/render` | `renderPlanMd`, `parsePlanMd`, `syncPlanFromMd`, `setForegroundSession`, `getForegroundSessionId`, `renderProgressBoard`, `renderSessionSummaryMd`, `atomicWriteFileSync` |
| `core/debate` | `runDebateBroker`, `synthesizeInsightVerdict`, `buildRound1Prompt`, `buildRound2Prompt`, `formatDebateAcceptance` |
| `core/policy` | `evaluatePreToolUse`, `evaluateStopHook`, `isPathAllowed`, `checkProtectedPath`, `verifyChangedFilesBoundary` (훅 엔진) |
| `core/transcripts` | `locateHarnessTranscript`, `readHarnessTranscript` |
| `cli/dashboard` | `startDashboardServer`, `collectDashboardSnapshot`, `discoverHarnessModels`, `saveSessionMemo`, `saveProjectRoutingConfig`, `runSubagentControlAction` |
| `cli/index` | `getAdapter`, `getLatestSession(db)`, `scanSubagentLogs`, `runAsdLogs`, `runAsdClean` |

### 2.5 훅 프로토콜 & 환경변수

- **훅 stdin 예** (`pre-tool-use`): `{tool_name, tool_input, projectRoot?, sessionId?}` →
  stdout `{decision: "allow"|"block"|"ask", reason?}`. 세션 미발견은 fail-open(allow).
- **환경변수**: `ASD_HOME_DIR`(홈 격리 — 단일 결정점 `resolveHomeDir`), `ASD_SESSION_ROLE`
  (`subagent` 가드), `ASD_UPDATE_CHECK_URL`(업데이트 체크 URL 오버라이드).

### 2.6 DB 스키마 (변경 없음 — 4 테이블)

`sessions`(PK session_id, **project_root** — 단일 DB의 프로젝트 구분 키), `tasks`
(PK session_id+task_id, FK CASCADE), `debates`(PK debate_id, FK CASCADE),
`session_drivers`(PK driver_id, FK CASCADE, 활성 드라이버 partial unique index).
DDL 원본: `src/core/db.ts:201`.

---

## 3. GUI 측 체크리스트 (권장)

1. `context.getDb()` 가 `openProjectDb`만 쓰는지 재확인 — 현재 구조상 그렇다면 코드 변경 0.
2. `state-watcher.ts`의 `path.dirname(paths.dbPath)` 감시는 이제 `~/.asd/state` 공용 디렉터리가
   된다. 다른 프로젝트의 DB 쓰기도 이벤트가 걸리므로, 디바운스 뒤의 digest 비교
   (`computeProjectDigest`)가 스코프 드라이버로 프로젝트별 필터링하는지 확인 (1.3-1 참고).
3. 프로젝트 목록의 `projectHash`를 파일 경로로 쓰지 않기 (1.3-2).
4. 테스트에 `ASD_HOME_DIR` 격리 또는 `node scripts/run-tests.mjs` 사용.

---

## 4. 향후 로드맵 (기록용 — 아직 착수 안 함)

GUI 신기능 요구사항(GUI부 원문 5개 항목)을 코어부/GUI부 작업으로 구분한 것.

### 4.1 코어(asd-multiagent) 할 일

| # | 작업 | 상태 | 비고 |
|---|---|---|---|
| C1 | **ASD 세션 → CLI 세션 하강** (세션 하강 기능) | **코어부에 구현 요청됨** | `buildInteractiveResumeHarnessCommand`(이미 존재)에 "ASD 세션의 활성 드라이버 → 하네스 세션 ID 추출 → 인터랙티브 resume 명령/가이드 생성"을 붙이는 형태 |
| C2 | `TranscriptMessage`에 Thinking / Tool Use / 응답 / 유저 메시지 4분류 구조 추가 + 5 하네스 파서 일반화 | 계획 | OpenCode용으로 GUI가 이미 자체 구현한 reasoning/tool 파트 분해(`asd-gui src/server/routes/transcripts.ts`)를 코어로 승격하는 게 정석 |
| C3 | "프로젝트 경로에서 실행된 CLI 세션 나열" 디스커버리 | 계획(후순위) | **1차로 cli-recent.json 읽기로 충분**(`readCliRecentSessions` 이미 존재). 빈틈 2개: (a) ASD 훅 미설치 하네스의 세션은 기록 안 됨 — `~/.claude/projects/<인코딩경로>/` 등 직접 스캔으로 보완, (b) 훅 페이로드에 세션ID가 없는 하네스(Cursor)는 기록 불가 |
| C4 | `discoverHarnessModels` CLI 스폰 비용 캐싱 | 검토 | GUI 로딩 지연의 코어 측 후보. 측정 후 착수 |

### 4.2 GUI(asd-gui) 할 일 — 코어 변경 불필요

| # | 작업 | 기반 |
|---|---|---|
| G1 | 대화 기록 4분류(Thinking/Tool/응답/유저) 렌더링 | C2 완료 후 코어 API 소비 |
| G2 | 대화창 메시지 → 하네스 실행 + 실시간 Thinking/Tool 스트리밍 | PTY(`pty_spawn`/`pty_input`) + WS 청크(`driver_output_chunk`) 이미 존재. `runDriverTurn`은 완료형이라 인터랙티브 resume 경로 사용 |
| G3 | 창 목록/배열/버튼 최적화 | 순수 GUI |
| G4 | 일반 CLI 세션 → ASD 세션 **승격** | 코어 준비 완료: `linkHarnessSessionToAsdSession` + `attachDriver` + `createOrGetSession` |
| G5 | ASD 세션 → CLI 세션 **하강** UI | C1 완료 후 코어 API 소비 |
| G6 | 창 늦게 뜸 등 로딩/버그 최적화 | 대부분 GUI. 코어 측은 C4 + 이미 완료된 `listKnownProjects()` 단일화(디렉터리 4,415개 순회 → 쿼리 1회)로 상당 부분 해소 |

### 4.3 완료된 것 (참고)

- 단일 상태 DB 전환 + 12세션 마이그레이션 + 구 해시 디렉터리 4,415개 정리 (본 문서 1장)
- `listKnownProjects()` 디렉터리 순회 폐지 → 프로젝트 목록 로딩 개선 (G6의 코어 측 주요 원인 제거)
- 테스트 홈 격리 체계(`ASD_HOME_DIR` 단일 결정점 + `scripts/run-tests.mjs`)
