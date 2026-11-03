# 패치 노트 (`agent-swarm-director` / ASD v2.4.0)

[English](./PATCH_NOTES.md) | **한국어** | [📖 README로 돌아가기](./README_ko.md) | [🏛️ 아키텍처 및 파일·함수 레퍼런스](./PROJECT_STATUS.md) | [🔌 외부 SDK 레퍼런스](./EXTERNAL_SDK_REFERENCE.md)

**Agent Swarm Director (ASD v2.4.0)**의 초기 아키텍처 구축부터 최신 기능 업데이트까지의 전체 패치 내역을 최신순으로 정리한 문서입니다.

---

## 1. 최신 주요 패치 (외부 GUI 연동 SDK, 오케스트레이션 & 성능 최적화 — v2.4.0)

### `v2.4.0` — 대화 기록 4분류 파서, 실시간 스트리밍(`onEvent`), CLI ↔ ASD 세션 승격/하강, 5대 하네스 세션 통합 탐색 및 로딩 속도 최적화
- **버전 `2.4.0` 상향 및 단일 DB 호환성 전환**:
  - 단일 공유 DB(`~/.asd/state/core.db`) 구조 및 확장된 세션/드라이버 스키마에 맞춰 코어, 스킬, 프리셋, 문서 전체 버전을 `2.4.0`으로 상향했습니다(`2.3.x` 이하의 해시별 DB 구조와 비호환).
- **5대 하네스 대화 기록 4분류 정밀 파싱 (`readHarnessTranscript` — `8b4980c`)**:
  - [`src/core/transcripts.ts`](./src/core/transcripts.ts)의 `TranscriptMessage`에 `category: "user" | "assistant" | "thinking" | "tool_use" | "tool_result" | "system"`, `thinking`, `toolUse`, `toolResult` 필드를 추가했습니다.
  - **Claude Code**(`thinking`, `tool_use`, `tool_result`, `text` 블록), **Codex CLI**(`agent_reasoning`, `function_call`, `custom_tool_call`, `function_call_output`), **OpenCode**(`opencode.db` SQLite `part` 테이블 및 JSON 스토리지), **Antigravity**(`USER_INPUT`, `PLANNER_RESPONSE`, `TOOL_RESPONSE` 분리 및 `truncated_fields` 존재 시 `transcript_full.jsonl` 자동 폴백) 전체에서 4분류 파싱을 지원합니다.
- **실시간 스트리밍 턴 실행 (`runDriverTurn` & `parseDriverStreamLine` — `ea92b73`)**:
  - [`src/core/drivers.ts`](./src/core/drivers.ts)의 `runDriverTurn`에 `onEvent?: (event: DriverStreamEvent) => void` 콜백과 `streamJson?: boolean`(기본값 `true`) 옵션을 추가했습니다.
  - Claude Code·Cursor(`--output-format stream-json --verbose`), Codex(`--json`), OpenCode(`--format json`) 실행 중 발생하는 실시간 Thinking 과정, Tool Use 과정, Tool Result, 응답 텍스트를 즉시 스트리밍합니다.
- **CLI ↔ ASD 세션 양방향 승격(`promoteCliSessionToAsd`), 하강(`unlinkHarnessSessionFromAsdSession`, `asd resume`) 및 세션 삭제(`deleteSession`)**:
  - 일반 CLI 세션을 ASD 세션으로 즉시 승격(멱등성 보장 및 활성 드라이버 자동 부착)하는 `promoteCliSessionToAsd()`를 추가했습니다.
  - ASD 세션에서 활성 드라이버를 해제하고 `cli-recent.json`의 `asdSessionId`를 `null`로 초기화해 일반 CLI 세션으로 복귀시키는 `unlinkHarnessSessionFromAsdSession()`, 대화형 복귀 명령을 생성하는 `buildSessionDemotion()` 및 `asd resume` CLI 명령어를 추가했습니다.
  - [`src/core/db.ts`](./src/core/db.ts)의 `SqliteDriver`에 네이티브 세션 ID 기반 조회 메서드 `findSessionByHarnessSessionId()`와 하위 테이블 연쇄 삭제 트랜잭션 메서드 `deleteSession()`을 추가했습니다.
- **프로젝트 경로 내 5대 하네스 CLI 세션 통합 탐색 (`discoverProjectCliSessions` — `c29200b`, `0e26088`)**:
  - 현재 프로젝트에서 실행된 5대 하네스의 로컬 CLI 세션을 모두 찾고 ASD 세션 승격 여부(`isPromotedToAsd`, `asdSessionId`, `asdPhase`)를 결합해 반환하는 `discoverProjectCliSessions()`를 추가했습니다.
  - `syncLocalHarnessTranscripts()`를 Antigravity뿐만 아니라 **Claude Code**(`~/.claude/projects`), **Codex**(`~/.codex/sessions`), **OpenCode**(`opencode.db`)까지 확장하고 파일 `mtimeMs` 기반 인메모리 캐시(`transcriptDiscoveryCache`)를 적용했으며, `recordCliRecentSession()`에서 이후 훅 호출 시에도 첫 프롬프트 `summary`와 `transcriptPath`가 덮어씌워지지 않도록 개선했습니다.
- **모델 탐색 디스크 캐시, 워크트리 상태 캐시 및 프로젝트 목록 로딩 최적화 (`fa59456`, `c29200b`)**:
  - [`src/cli/dashboard.ts`](./src/cli/dashboard.ts)의 `discoverHarnessModels()`를 비동기 병렬 실행(`Promise.all`) + `~/.asd/state/models-cache.json`(10분 TTL) 디스크 캐시 구조로 최적화하여 초기 로딩 지연을 해소했습니다.
  - `collectDashboardSnapshot()`에 3.5초 TTL 워크트리 상태 캐시(`worktreeStatusCache`) 및 `skipCliSpawn` 옵션을 추가하여 폴링 시 `git status --short` 반복 실행 병목을 제거했습니다.
  - `listKnownProjects()`에 15초 인메모리 FS stat 캐시, `skipDiskCheck`, `db` 재사용 옵션을 추가했습니다.
- **Codex `notify` 훅 및 Cursor 중첩 `hooks.json` 스키마 지원 (`aad8d91`, `8d68e01`)**:
  - `~/.codex/config.toml`에 Codex `notify` 훅을 자동 등록하고, `~/.cursor/hooks.json`을 Cursor 공식 중첩 스키마(`{"version": 1, "hooks": {...}}`)로 생성하도록 수정했습니다.

### `v2.3.3` (`fe668d3`) — 단일 공유 상태 DB (`~/.asd/state/core.db`) 전환 및 프로젝트 스코프 드라이버
- 프로젝트마다 생성되던 `~/.asd/state/<projectHash>/core.db` 구조를 단일 `~/.asd/state/core.db` 파일로 통합하고, `SqliteDriver(dbPath, projectRoot?)`를 통해 프로젝트별 자동 스코프 쿼리를 적용했습니다.
- `resolveHomeDir()` 단일 경로 결정점과 `scripts/run-tests.mjs`를 도입하여 테스트 실행 시 사용자 홈 디렉토리 오염을 원천 차단했습니다.

### `v2.3.2` — GUI 코어 연동: 멀티 드라이버 소유권(`session_drivers`), 0-Token 브리핑(`buildDriverBriefing`), 헤드리스 턴 실행(`runDriverTurn`), 5대 하네스 트랜스크립트 리더, 프로세스 간 병합 잠금 및 고아 태스크 복구
- `session_drivers` 테이블 및 드라이버 수명주기 API(`attachDriver`, `setDriverHarnessSessionId`, `detachDriver`, `getActiveDriver`, `listDrivers`, `buildDriverBriefing`, `runDriverTurn`)를 추가했습니다.
- 훅 자동 세션 하이재킹을 제거하고 `ASD_DRIVER_ID` 바인딩 및 `cli-recent.json` 10분 유효기간 제한(CR-04)을 적용했습니다.
- 5대 하네스 트랜스크립트 리더(`readHarnessTranscript`, `locateHarnessTranscript`), 서브에이전트 아티팩트 마감(`finalizeSubagentArtifacts`), 프로세스 간 병합 잠금(`.asd/merge.lock`), 고아 태스크 복구(`recoverOrphanedTasks`) 및 원자적 클레임(`tryClaimTask`), 상태별 서브에이전트 Resume(`follow_up_of`), `PLAN.md` 전경 세션 가드(`getForegroundSessionId`, `setForegroundSession`), 범위 지정 LIGHT 롤백(`rollbackLightChanges`)을 구현했습니다.

### `v2.3.0` — 5번째 하네스(`Cursor CLI` / `@cr`) 통합, 6대 스킬 전면 개편, 테스트 파일 수정 허용 규약 및 `asd ui` 개선
- **5번째 AI 코딩 하네스 `Cursor CLI` (`@cr`) 공식 지원**:
  - [`src/adapters/cursor.ts`](./src/adapters/cursor.ts)를 추가하여 헤드리스 CLI 실행, `PreToolUse` / `Stop` 보안 훅, `~/.cursor/` 글로벌 설정 동기화를 지원합니다.
- **6대 스킬(`src/skills/*/SKILL.md`) 전면 차별화 및 최신화**:
  - `/asd`, `/asd-plan`, `/asd-run`, `/asd-debate`, `/asd-debug`, `/handoff` (`/asd-handoff`) 스킬에 5대 핵심 역할과 Cross-Scope `autoCreatedTasks`(최대 2개) / `deferredCrossScopeRequests` 프로토콜을 반영했습니다.
- **테스트 파일 수정 기본 허용 & `claim_only` 모드 서브에이전트 로그 자동 생성**:
  - 태스크의 `allowedFiles`가 지정된 경우에도 `tests/**`, `**/*.test.ts`, `**/*.spec.ts` 수정을 기본 허용하고, `claim_only` 디스패치 시에도 서브에이전트 로그 폴더를 생성합니다.

### `523c3cb` — Cross-Scope(타 하네스 담당 파일) 수정 요청 자동 스케줄링 및 호출자 파일 묶음 기능
- 서브 하네스가 허용 범위 밖 파일 수정이 필요할 때 `asd-report` JSON 블록의 `cross_scope_requests`로 보고하면, 서브 하네스당 최대 2개까지 자동으로 `Turn + 1`에 후속 태스크를 생성하고 요청자 파일(`caller_files`)을 함께 묶어줍니다.

### `8439636` — 하네스 실제 보유 모델 전체 로드 및 검색형 모델 선택기(Searchable Picker) 도입
- `discoverHarnessModels`에서 하드코딩된 더미 모델 목록을 제거하고 실제 하네스 모델만 수집하도록 개선했으며, 웹 대시보드(`asd ui`)에 실시간 검색형 모델 피커를 적용했습니다.

### `ca879a4` — Claude Code `settings.json` 공식 훅(Hook) 스키마 호환성 수정
- Claude Code의 최신 설정 규격에 맞춰 `{ matcher: "", hooks: [{ type: "command", command: "..." }] }` 중첩 구조로 훅을 생성하도록 수정했습니다.

### `0b39793` — 하네스별 모델 탐색 모달(2x2), 드롭다운 선택기 및 단독 토론 세션 격리
- `asd ui` 헤더에 하네스별 사용 가능 모델 확인 모달을 추가하고, 단독 실행된 `asd debate`를 `<타임스탬프>-debate` 전용 세션으로 격리했습니다.

### `48d09a7` — 프로젝트별 라우팅 편집기(`.asd/routing.jsonc`) 및 4종 서브에이전트 런타임 제어
- `asd ui`에 프로젝트 전용 라우팅 편집기와 서브에이전트 실시간 제어(`kill`, `retry`, `fallback`, `custom`) 기능을 추가했습니다.

### `bec4abb` — 웹 대시보드 세션별 그룹화, `.asd` 메모 영구 저장 및 서브에이전트 로그/프롬프트 조회
- `asd ui`에서 세션별 태스크/토론/로그 그룹화 및 세션 메모 영구 저장(`sessions.memo` + `main.json`) 기능을 추가했습니다.

### `ebb4927` — 5대 핵심 에이전트 + 3단계 난이도 통합 및 토론 시 Zero-Token 코드 슬라이스 주입
- 에이전트 역할을 **5개 핵심 역할(`planner`, `architect`, `worker`, `scout`, `critic`)**과 **3단계 난이도(`low`, `medium`, `high`)**로 표준화하고, `asd debate` 시 `--files` 및 `--include-diff`로 코드 슬라이스를 프롬프트에 직접 삽입하도록 개선했습니다.

---

## 2. 보안 감사 수정, CLI 직접 실행 전환 및 안정화 패치

| 커밋 해시 | 주요 패치 내용 |
| :--- | :--- |
| `f9b2f4a` | **P0/P1 보안 및 품질 감사 수정**: 가짜 정규식 LSP 폴백 제거, 시크릿 마스킹 및 경로 경계 검증 강화, 동기화 예외 처리 보강 |
| `6375b6b` | **Non-TTY 무한 대기 및 NDJSON 파싱 수정**: 비대화형 파이프 실행 시 stdin 대기 버그 해결, OpenCode 등 NDJSON 스트림 내부의 토론 판결문 파싱, `LIGHT` 트랙 내부 서브에이전트 강제 적용 |
| `be4ded9` | **다중 하네스 `/handoff` 스킬 추가**: 하네스 간 작업 세션을 이어받을 수 있는 `handoff.md` 생성 스킬(`/handoff`, `/asd-handoff`) 추가 |
| `afb2ac2` | **쿼터/네트워크 오류 시 자동 폴백(Fallback) 연쇄 이동**: `asd dispatch` 및 `asd debate` 도중 Rate Limit, 쿼터 소진, 네트워크/CLI 오류 발생 시 `routing.jsonc`의 `fallbacks` 체인을 순서대로 자동 순회 |
| `625ec4f` | **`LIGHT` 트랙 기본값 및 사전 1회 통합 브리핑 의무화**: `LIGHT` 트랙을 현재 하네스 기본 모드로 설정하고, 모든 `/asd*` 스킬 실행 전 1회 통합 브리핑(`LIGHT` vs `HEAVY` 선택 포함) 규칙 도입 |
| `73faca5` | **CLI 실행 문서 보강**: 전역 `PATH` 등록 시(`asd ...`)와 미등록 시(`node --no-warnings src/cli/index.ts ...`) 명령어 안내 추가 |
| `fde3a2a` | **CLI 직접 실행 아키텍처 전환**: 60초 MCP 타임아웃(`-32001`) 방지를 위해 장시간 오케스트레이션 도구를 CLI 직접 호출 방식으로 일원화 |
| `d3a9cd5` | **CLI 오케스트레이션 명령어 추가**: `asd plan`, `asd dispatch`, `asd verify`, `asd debate` CLI 서브커맨드 구현 |
| `f31a13c` | **미설치 하네스 자동 필터링 및 모델 정규화**: 설치되지 않은 하네스 CLI 자동 제외, 폴백 시 기본 모델 재시도, Antigravity 모델 티어 정규화 |
| `022e109` | **웹 대시보드 다국어(한국어/영어) 지원**: 시스템 로케일 자동 감지 및 헤더 한/영 전환 버튼 추가 |
| `d278c40` | **외과적 언인스톨러 보강**: `asd uninstall` 시 `_asdManaged` 항목만 제거하고 사용자가 추가한 MCP 설정은 100% 보존 |
| `ddea901` / `928c89d` | **Antigravity MCP 설정 동기화**: 클린 설치 환경에서도 `~/.gemini/config/mcp_config.json` 자동 생성 및 동기화 |
| `3753c45` | **전역 `PATH` 자동 등록**: `asd sync` 시 전역 `PATH`에 `asd` 실행 심(shim) 자동 설치 (`--no-path` 옵션 제공) |
| `5af81b9` | **Zero-Dependency 웹 대시보드(`asd ui`) 추가**: 외부 패키지 없이 동작하는 로컬 실시간 대시보드(`src/cli/dashboard.ts`) 구현 |
| `c349129` | **`asd logs` 명령어 및 Windows `.cmd` 지원**: 최근/태스크별 서브에이전트 로그 조회(`asd logs [taskId]`), Windows `.cmd` 심 해석, `thinkingEffort` 지원 |
| `1d181ff` | **코어 리팩토링**: 글로브 매처 단순화 및 하네스 명령/MCP 동기화 헬퍼 중복 제거 |
| `01388f9` / `383ac67` | **문서화 및 라이선스 적용**: 패키지명을 `agent-swarm-director`로 확정하고 `README.md`, `README_ko.md`, `FSL-1.1-ALv2` 라이선스 추가 |

---

## 3. ASD v2.2 초기 코어 아키텍처 구축

| 커밋 해시 | 주요 패치 내용 |
| :--- | :--- |
| `2bca203` | 내장 `lsp` 코드 인텔리전스 MCP 서버 및 하네스별 부족 기능만 채우는 Gap-Filling MCP 동기화 |
| `d3e4679` | 초기 5대 CLI 명령어(`sync`, `status`, `clean`, `doctor`, `uninstall`), 훅 러너 및 E2E 테스트 구현 |
| `b6f32fe` | 4대 코어 도구(`asd_plan`, `asd_dispatch`, `asd_verify`, `asd_debate`), 서브에이전트 격리 가드 및 실시간 `progressBoard` 구현 |
| `53000fa` | Zero-Polling 블라인드 교차 모델 적대적 토론 브로커 및 인수 조건(`acceptance`) 자동 주입기(`src/core/debate.ts`) 구현 |
| `e3492a9` | 글로벌 전용 멱등(Idempotent) 인스톨러, 외과적 언인스톨러 및 `<100ms` `asd doctor` 진단기(`src/adapters/installer.ts`) 구현 |
| `2ca663e` | `LIGHT` 트랙 체크포인트 커밋/롤백 및 `HEAVY` 트랙 Git Worktree 격리·뮤텍스 병합(`src/core/workspace.ts`) 구현 |
| `57908c8` | 대소문자 정규화 경로 보안 가드, `1ms` `meta.json` `PreToolUse` 경계 검사 및 서브에이전트 실드(`src/core/policy.ts`) 구현 |
| `772f948` | 다중 하네스 모델 라우터, `@ag` 폴백 및 모델 패밀리 다양성 보장(`src/core/router.ts`) 구현 |
| `71ddbec` | `.asd/PLAN.md` 인라인 렌더러/파서, 역동기화(`syncPlanFromMd`), `progressBoard` 및 세션 요약 생성기(`src/core/render.ts`) 구현 |
| `02df2e0` | 4대 하네스 어댑터(`claude-code`, `opencode`, `codex`, `antigravity`) 구현 |
| `a1fb198` | `node:sqlite` WAL 모드 및 `BEGIN IMMEDIATE` 트랜잭션 기반 3-테이블(`sessions`, `tasks`, `debates`) SSOT 드라이버(`src/core/db.ts`) 구현 |
| `9ba1140` | `meta.json` 기록, 유휴/전체 타임아웃 및 프로세스 트리 종료를 지원하는 서브에이전트 스포너(`src/core/spawner.ts`) 구현 |
| `b7cd956` | 기본 라우팅(`presets/default-routing.jsonc`), MCP 카탈로그(`presets/default-mcp.jsonc`) 및 어댑터 도구 매니페스트 정의 |
| `f60db2c` | 2-경로 설정 탐색, 대소문자 정규화 프로젝트 해시 및 로컬 라우팅 우선순위(`src/core/config.ts`) 구현 |
| `24504a6` | 실시간 진행률 스트리밍을 지원하는 비동기 `StdioRpcServer` JSON-RPC 트랜스포트(`src/mcp/stdio-rpc.ts`) 구현 |
| `873894e` | 외부 의존성 0개의 JSONC 파서, TOML 펜스 매니저 및 시크릿 마스킹(`src/core/`) 구현 |
| `8eaf651` / `69d7423` | Node.js `>=22.13.0` 네이티브 TypeScript 실행을 위한 코어 타입(`src/core/types.ts`), `package.json`, `tsconfig.json` 초기 구성 |
