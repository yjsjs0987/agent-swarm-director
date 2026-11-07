# Core–GUI 경계 감사 (CORE_GUI_BOUNDARY_AUDIT.md)

> 작성일: 2026-11-06 · 대상: `asd-multiagent` (Core) `src/` 전체 26개 TS 파일 실측 스캔
> 스캔 방법: 전체 파일 목록화 + `gui`/`createServer`/`<!DOCTYPE`/`WebSocket`/`runDriverTurn`/대시보드 서비스 5종 호출자 grep + 후보 파일 정밀 열람

---

## 0. 경계 원칙 (확정)

| Core(asd-multiagent)에 남는 것 | GUI 리포(asd-gui / 신규 앱)로 가는 것 |
|---|---|
| ① CLI (`asd` 명령 전반) | 모든 UI 렌더링 (HTML/CSS/React) |
| ② 코어 관리: 계획(PLAN), 대시보드(`asd ui` — 예외 허용), git worktree 분리/머지, 세션·드라이버 상태, 훅, MCP | HTTP/WS 서버 구동과 라우팅 (`asd ui` 제외) |
| ③ 최소 SDK/API: 스트리밍 턴, 트랜스크립트 읽기, 세션 탐색, 라우팅 로드 등 순수 데이터/실행 프리미티브 | 브라우저/화면 표현용 문자열·상태·이벤트 UI |

**판정 축**
1. 호출 주체가 CLI/훅/MCP/에이전트인가 → Core OK
2. 데이터/실행 프리미티브(DB 쿼리, 프로세스 스폰, 스트림 파싱, git 조작)인가 → Core OK (최소 SDK)
3. 서버 구동·엔드포인트 라우팅·화면 렌더링·UI 상태인가 → GUI 이관
4. 예외: `asd ui` 명령과 그 구현(`src/cli/dashboard.ts`의 서버+HTML)은 사용자가 명시적으로 허용

---

## 1. 요약 판정표

| # | 위치 | 항목 | 판정 | 권고 조치 |
|---|---|---|---|---|
| W1 | `src/cli/dashboard.ts:247/617/687/843/1461` | GUI가 import하는 **데이터 서비스 5종이 프레젠테이션 파일에 구현**됨 | ⚠️ 경계 위반 (레이어링) | `src/core/` 서비스 파일로 이관, dashboard.ts는 서버+HTML만 유지 |
| W2 | `src/index.ts:52-58` | 공개 SDK 표면에 dashboard 서버·서비스 혼재, GUI가 쓰지 않는 항목(`startDashboardServer`) 포함 | ⚠️ 표면 과다 | 최소 SDK 화이트리스트화 |
| W3 | `src/core/drivers.ts:423-424/482/588` | GUI 전용 동기 SDK의 주석·프롬프트 텍스트가 경계를 흐림 | 🔵 표기 문제 (동작 아님) | 주석 정리 + 프롬프트 내 GUI 문구 파라미터화 |
| W4 | (역방향) `asd-gui/src/server/core-api.ts:239` | `buildInteractiveResumeHarnessCommand`를 GUI가 자체 구현 — Core 어댑터의 `buildInteractiveResumeCommand`와 중복 | 🔵 역방향 위반 | GUI 구현 삭제, Core 구현 직접 사용 (실행 결과: 어댑터 버그 발견으로 상위 함수 re-export 채택 — §5) |

**결론: 명백한 "GUI 기능의 Core 침범"은 없음** (웹 서버·HTML은 `asd ui` 예외 1곳뿐). 위반은 ①GUI가 import하는 서비스가 dashboard.ts에 갇힌 레이어링 문제, ②SDK 표면 과다, ③표기 문제 수준.

---

## 2. 상세

### W1. GUI용 데이터 서비스 5종이 `dashboard.ts`(프레젠테이션)에 갇혀 있음

**증거** (`src/cli/dashboard.ts`):
- `discoverHarnessModels` (247행) — 5하네스 모델 탐색 + `~/.asd/state/models-cache.json` 캐시
- `saveSessionMemo` (617행) — 세션 메모 저장
- `saveProjectRoutingConfig` (687행) — 라우팅 설정 저장
- `runSubagentControlAction` (843행) — 서브에이전트 kill/retry/fallback/resume
- `collectDashboardSnapshot` (1461행) — 전체 상태 스냅샷

**문제**: 이 5종은 UI가 아닌 **순수 데이터/상태 서비스**인데, `asd ui`의 HTML+서버 파일(129KB) 안에 구현되어 있고 `src/index.ts:52-57`으로 재노출되어 asd-gui가 import한다 (asd-gui `core-api.ts:132/135/180-182` 확인). Core의 "최소 SDK"와 "asd ui 구현체"가 한 파일에 섞여 경계가 흐려짐 — GUI가 SDK를 쓰려면 129KB UI 파일을 거쳐야 함.

**권고**: 5종을 `src/core/`로 이관 (예: `core/models.ts`, `core/session-services.ts`, `core/subagent-control.ts`). `cli/dashboard.ts`는 `startDashboardServer` + HTML만 남김. 이관 후 `src/index.ts`는 core 경유로 재노출.

### W2. `src/index.ts` 공개 SDK 표면 과다

**증거**: `src/index.ts:52-58`이 `collectDashboardSnapshot, discoverHarnessModels, getModelsDiskCachePath, saveSessionMemo, saveProjectRoutingConfig, runSubagentControlAction, startDashboardServer`를 `./cli/dashboard.ts` 경유로 export.

**문제**: `startDashboardServer`는 GUI가 절대 쓰지 않음(asd-gui는 자체 서버 보유) — asd ui 전용 구현이 공개 SDK에 노출. 또한 dashboard 서비스가 cli 레이어 경유로 노출되어 "SDK = core에서 온다"는 원칙이 깨짐.

**권고**: 공개 표면을 화이트리스트로 재정의 — ①코어 관리(plan/dispatch/verify/worktree/세션), ②최소 SDK(runDriverTurn, readHarnessTranscript, discoverProjectCliSessions, 모델·메모·라우팅·서브에이전트 서비스), `startDashboardServer`는 `./cli/dashboard.ts` 서브패스로만 노출(또는 비노출).

### W3. `drivers.ts`의 GUI 전용 SDK 표기 문제

**증거**:
- 482행: `// CR-03: GUI Headless Driver Turn Runner (runDriverTurn)` — GUI 변경요청서(CR) 번호가 코어 소스에 박제됨
- 588행: parseDriverStreamLine 주석 "for real-time GUI rendering"
- 423-424행: 드라이버 브리핑 프롬프트에 "병합 충돌 태스크는 사용자가 GUI에서 해결" 문구 하드코딩

**판정**: 동작 자체는 정당 — `runDriverTurn`/`parseDriverStreamLine`/`buildDriverBriefing`은 신규 앱 계획의 **필수 최소 SDK**이고, 드라이버 CRUD(attach/detach)는 MCP가 사용(`mcp/server.ts:862`, CR-04)하므로 코어 관리 기능. 다만 주석·프롬프트가 "GUI 전용"처럼 읽혀 경계를 흐림.

**권고**: 주석을 "SDK: 헤드리스 스트리밍 턴 실행" 등 주체 중립 표기로 정리, 프롬프트 내 GUI 문구는 옵션 파라미터화.

### W4. (역방향) GUI가 코어 어댑터 로직을 재구현

**증거**: `asd-gui/src/server/core-api.ts:239` `buildInteractiveResumeHarnessCommand` — agy `--resume`→`--conversation` 정규화를 GUI가 자체 구현. Core 어댑터의 `buildInteractiveResumeCommand`(`adapters/antigravity.ts:90`)와 중복.

**권고**: GUI 구현 삭제 → Core 어댑터 사용. 양방향 경계 원칙: "코어 로직 필요 시 GUI에서 구현하지 말고 Core에 요청(GUI_ARCHITECTURE.md ADR-01-3도 동일 원칙)".

---

## 3. 유지 확정 목록 (검토했으나 위반 아님)

| 위치 | 항목 | 유지 근거 |
|---|---|---|
| `src/mcp/server.ts` (78KB) + `mcp/stdio-rpc.ts` | asd_plan/dispatch/verify/debate + 드라이버 부착 | CLI·에이전트(하네스)용 코어 관리 |
| `src/core/workspace.ts:1421-1942` | `getWorktreeDiff` / `approvePendingTask` / `rejectPendingTask` ("GUI Gate") | git worktree diff/머지/롤백 = **사용자 정의 코어 관리 기능**. 단 Core 내부 호출자 0개(grep 확인) — GUI 전용 호출 SDK임을 문서화할 것 |
| `src/core/drivers.ts` | 드라이버 CRUD(`attachDriver` 등), `runDriverTurn`, `parseDriverStreamLine`, `buildDriverBriefing` | CRUD는 MCP 사용 / 스트리밍 턴·파서는 신규 앱의 최소 SDK (W3 표기 정리만) |
| `src/core/transcripts.ts` (CR-10) | 5하네스 트랜스크립트 리더 | 세션 자동 로드용 최소 SDK. 갭: cursor는 `unsupported` (13행) — 별도 과제 |
| `src/cli/dashboard.ts` 서버+HTML | `asd ui` | **사용자 예외 허용**. 단 이후 기능 확장 금지 원칙 명문화 권장 (새 기능은 GUI 리포로) |
| `src/core/{db,render,router,session-tracker,spawner,policy,debate,redact,jsonc,config}.ts`, `src/adapters/*`, `src/cli/index.ts` | 전부 CLI/코어 관리/SDK | GUI 흔적 grep 결과 0 (주석 1건 제외 전부 코어 관리 문언) |
| `.asd/sessions/` 산출물 구조 | `drivers/<id>/runs/`, `subagents/<id>/` | GUI 턴 로그(`gui-turns`)는 GUI가 직접 기록·판독 (asd-gui `routes/transcripts.ts`) — Core 무관 ✅ |

---

## 4. 정리 작업 체크리스트

1. [x] **(P1)** W1: dashboard.ts 데이터 서비스 5종 → `src/core/` 이관 — **완료 (2026-11-06)**. 신규 파일: `core/models.ts`(모델 탐색+캐시), `core/session-services.ts`(메모+스냅샷), `core/subagent-control.ts`(서브에이전트 제어), `core/subagent-logs.ts`(scanSubagentLogs — cli/index.ts가 re-export). `saveProjectRoutingConfig`는 `core/router.ts`로. dashboard.ts는 서버+HTML만 잔존(-1,605줄).
2. [x] **(P1)** W2: `src/index.ts` 표면 정리 — **완료**. 5종 서비스+`getModelsDiskCachePath`를 core 경유 export(심볼명 불변 — asd-gui 호환), `startDashboardServer`는 루트 export 제거(패키지 서브패스 `./cli/dashboard.ts`로만 접근).
3. [x] **(P2)** W3: drivers.ts 정리 — **완료**. CR-03 주석·"GUI rendering" 문언 중립화, 브리핑 프롬프트 EN/KO GUI 문구 제거. 파일 내 "GUI" 문자열 0건 확인.
4. [x] **(P2)** W4: asd-gui 중복 제거 — **완료 (경로 조정)**. 계획은 어댑터 사용이었으나 실행 중 어댑터 버그 발견(§5) → GUI 래퍼(30줄 no-op 정규화) 삭제 후 Core 상위 함수 `buildInteractiveResumeHarnessCommand`를 core-api.ts에서 직접 re-export. 4개 호출부 무변경.
5. [x] **(P3)** W5: README/README_ko에 "asd ui 기능 동결 — 신규 UI 기능은 asd-gui로" 원칙 추가 — **완료**.
6. [ ] **(P3)** cursor 트랜스크립트 리더 구현 (현재 `unsupported`) — 미착수, 별도 과제.

---

## 5. 실행 결과 (2026-11-06)

**테스트**: Core `node scripts/run-tests.mjs` **355/356 통과**, asd-gui `npm test` **14/14 통과**.

**유일한 실패 1건은 변경과 무관한 기존 문제**: `tests/installer-sync.test.ts:650` "Runtime Isolation: ... Staged CLI entrypoint must exist in isolated runtimeDir" — `git stash`로 HEAD 기준선에서 동일 재현을 확인했다. (참고: stash 대조 과정에서 기존의 `asd-auto-stash` 항목이 발견되어 그대로 보존함.)

**검증 증거**:
- `src/core/**` → `src/cli/**` import: 0건 (grep)
- `src/cli/dashboard.ts` 내 5종 서비스 정의: 0건 (grep), 서버 코드는 core에서 import
- `src/core/drivers.ts` 내 "GUI" 문언: 0건 (grep)
- W1 과정에서 tests 3종(artifact-lifecycle, dashboard, subagent-resume)의 import 경로를 새 core 위치로 갱신

**신규 발견 → 즉시 수정**: 어댑터 `buildInteractiveResumeCommand`(claude-code/opencode/codex/cursor)가 **빈 세션ID에서도 `--resume ""` 같은 무효 플래그를 무조건 생성**하는 버그(antigravity만 정상) → 4개 어댑터에 조건부 가드 적용(`harnessSessionId ? [...] : []`). 유효 sid 동작은 불변. 이 버그가 W4의 어댑터 직접 사용 경로를 막았고, 그래서 W4는 Core 상위 함수 re-export 방식으로 완료했다.

**진행 중 발생한 일시 문제(기록용)**: W1 실행 중 asd-gui 테스트가 Core `router.ts` 파싱 오류로 실패한 적이 있는데, 이는 asd-gui의 `node_modules/agent-swarm-director`가 Core 소스에 라이브 연결되어 있어 리팩터링 중간 쓰기 상태를 읽은 레이스였음. 최종 상태에서는 재현되지 않음.
