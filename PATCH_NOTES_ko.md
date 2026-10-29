# 패치 노트 (`agent-swarm-director` / ASD v2.2)

[English](./PATCH_NOTES.md) | **한국어** | [📖 README로 돌아가기](./README_ko.md)

**Agent Swarm Director (ASD v2.2)**의 초기 아키텍처 구축부터 최신 기능 업데이트까지의 전체 패치 내역을 최신순으로 정리한 문서입니다.

---

## 1. 최신 주요 패치 (오케스트레이션, 웹 대시보드 & 하네스 호환성)

### `523c3cb` — Cross-Scope(타 하네스 담당 파일) 수정 요청 자동 스케줄링 및 호출자 파일 묶음 기능
- **서브에이전트 위임 프롬프트 규약 주입 (`asd-report`)**:
  - 서브 하네스(A)가 작업 도중 자신의 허용 범위(`Allowed Target Files`) 밖에 있는 파일(B 하네스 담당 파일 등)을 수정해야 할 때, 직접 수정을 시도해 훅에 차단되는 대신 응답 마지막에 `asd-report` JSON 블록(`summary`, `key_decisions`, `risks`, `cross_scope_requests`)을 출력하도록 [`buildPromptForTask`](./src/mcp/server.ts)를 확장했습니다.
- **다음 Turn 후속 태스크 자동 생성 (서브 하네스당 최대 2개 제한)**:
  - 각 서브 하네스가 요청한 `cross_scope_requests` 중 **최대 2개까지** 자동으로 `현재 Turn + 1`에 후속 태스크(`T<next>.x`)로 생성합니다.
  - **요청자(A) 파일 일부 자동 묶음 (`caller_files`)**: 생성되는 후속 태스크의 `targetFiles`에 수정 대상 파일(`target_file`)뿐만 아니라 **A 하네스의 관련 파일(`caller_files` 지정분 또는 A가 실제로 Git에서 수정한 파일 최대 2개)**을 함께 묶어주어, 후속 하네스가 인터페이스 정의부와 호출부를 한 번에 맞춰 수정할 수 있게 했습니다.
  - **의존성(`dependsOn: [A, B]`) 및 역할 자동 승계**: 해당 파일을 기존 Turn에서 담당하던 하네스(B)를 자동 추적하여 `dependsOn`에 `[A태스크ID, B태스크ID]`를 모두 등록하고, B의 `role`과 `category`를 승계합니다.
- **초과 요청(3번째 이상) 메인 에이전트 전달**:
  - 서브 하네스당 2개를 초과한 요청(또는 연쇄 깊이 2단계 초과분)은 자동 생성하지 않고 `deferredCrossScopeRequests`로 분류하여 `asd_dispatch` / `asd_verify` 반환값과 `progressBoard` 하단의 **`⚠️ 메인 에이전트 판단 필요 (보류된 Cross-Scope 요청)`** 섹션으로 메인 디렉터 에이전트에게 전달합니다.

### `8439636` — 4대 하네스 실제 보유 모델 전체 로드 및 검색형 모델 선택기(Searchable Picker) 도입
- **하드코딩된 기본(더미) 모델 목록 전면 제거**:
  - [`discoverHarnessModels`](./src/cli/dashboard.ts)에서 임의의 기본 모델 배열을 모두 제거하고, 각 하네스에 실제로 존재하는 모델만 수집하도록 변경했습니다:
    - **Antigravity (`agy`)**: `agy models` CLI 출력을 직접 파싱하여 실제 지원 모델 전체 로드
    - **Claude Code (`claude`)**: 로컬 세션/설정 모델(`~/.claude/projects/**/*.jsonl`, `settings.json`) + `ANTHROPIC_BASE_URL` 설정 시 `/v1/models` API 실시간 조회
    - **Codex CLI (`codex`)**: `~/.codex/models_cache.json` 및 `config.toml`에서 전체 모델 로드
    - **OpenCode (`opencode`)**: `opencode models` 실행 버퍼 및 타임아웃을 확장하여 80개 이상의 전체 모델을 누락 없이 로드
- **검색형 모델 선택 팝오버 UI**:
  - 웹 대시보드(`asd ui`)의 **프로젝트 라우팅 편집기(`.asd/routing.jsonc`)**와 서브에이전트 카드의 **지정 모델 재실행(`custom`)**에서 일반 `<select>` 대신 클릭 시 작은 검색창과 모델 목록이 함께 뜨는 커스텀 팝오버(`filterModelPicker`)를 적용했습니다.

### `ca879a4` — Claude Code `settings.json` 공식 훅(Hook) 스키마 호환성 수정
- Claude Code의 최신 설정 검증 규격에 맞춰 [`src/adapters/claude-code.ts`](./src/adapters/claude-code.ts)와 [`src/adapters/installer.ts`](./src/adapters/installer.ts)가 `{ matcher: "", hooks: [{ type: "command", command: "..." }] }` 중첩 구조로 `PreToolUse` 및 `Stop` 훅을 생성하도록 수정했습니다.
- `asd sync` 및 `asd uninstall` 실행 시 구버전 플랫(`{ type: "command", command: "..." }`) 항목도 자동 감지하여 정리하고 사용자의 커스텀 훅은 보존합니다.

### `0b39793` — 하네스별 모델 탐색 모달(2x2), 드롭다운 선택기 및 단독 토론 세션 격리
- 웹 대시보드(`asd ui`) 헤더에 4대 하네스의 실제 사용 가능 모델을 `2x2` 그리드로 한눈에 확인하고 클릭해 복사할 수 있는 모달(`GET /api/models`)을 추가했습니다.
- `--task` 지정 없이 단독으로 실행한 `asd debate`는 `<타임스탬프>-debate` 전용 세션으로 격리하여 기존 코딩 작업 세션을 오염시키지 않도록 개선했습니다.

### `48d09a7` — 프로젝트별 라우팅 편집기(`.asd/routing.jsonc`) 및 4종 서브에이전트 런타임 제어
- 웹 대시보드에서 현재 프로젝트 전용 에이전트·카테고리 라우팅(`.asd/routing.jsonc`)을 GUI로 즉시 편집·저장(`GET/POST /api/routing`)할 수 있는 모달을 추가했습니다.
- 각 서브에이전트 실행 카드에 4가지 실시간 런타임 제어 버튼(`POST /api/subagent/control`)을 추가했습니다:
  1. **강제 종료 (`kill`)**: 실행 중인 서브에이전트 프로세스 트리 즉시 종료 및 워크트리 정리
  2. **재시도 (`retry`)**: 동일 하네스/모델로 해당 태스크 재실행
  3. **폴백 실행 (`fallback`)**: `routing.jsonc`의 다음 폴백 하네스/모델로 전환하여 재실행
  4. **지정 모델 실행 (`custom`)**: 사용자가 선택한 하네스와 모델로 즉시 재실행

### `bec4abb` — 웹 대시보드 세션별 그룹화, `.asd` 메모 영구 저장 및 서브에이전트 로그/프롬프트 조회
- 웹 대시보드(`asd ui`)에서 세션을 드롭다운으로 전환하며 세션별 태스크, 서브에이전트, 토론 이력을 그룹화하여 볼 수 있도록 개편했습니다.
- 세션마다 메모를 작성해 SQLite(`sessions.memo`)와 `.asd/sessions/<sessionId>/main.json`에 영구 저장(`POST /api/session/memo`)하는 기능을 추가했습니다.
- 각 서브에이전트가 받은 실제 프롬프트(`prompt.md`), 실행 출력(`output.log`), 완료 보고(`DoneClaim`)를 브라우저 모달에서 바로 열람(`GET /api/subagent-log`)할 수 있습니다.

### `ebb4927` — 5대 핵심 에이전트 + 3단계 난이도 통합 및 토론 시 Zero-Token 코드 슬라이스 주입
- 에이전트 역할을 **5개 핵심 역할(`planner`, `architect`, `worker`, `scout`, `critic`)**과 **3단계 난이도(`low`, `medium`, `high`)**로 단순화·표준화했습니다.
- `asd debate` 실행 시 `--files "파일경로:시작줄-끝줄"` 및 `--include-diff` 옵션을 통해 실제 소스 코드 슬라이스와 `git diff HEAD`를 프롬프트에 직접 삽입하여, 토론 에이전트들이 파일 읽기 도구를 호출하느라 토큰과 시간을 낭비하지 않도록 개선했습니다.

---

## 2. 보안 감사 수정, CLI 직접 실행 전환 및 안정화 패치

| 커밋 해시 | 주요 패치 내용 |
| :--- | :--- |
| `f9b2f4a` | **P0/P1 보안 및 품질 감사 수정**: 가짜 정규식 LSP 폴백 제거, 시크릿 마스킹 및 경로 경계 검증 강화, 동기화 예외 처리 보강 |
| `6375b6b` | **Non-TTY 무한 대기 및 NDJSON 파싱 수정**: 비대화형 파이프 실행 시 stdin 대기 버그 해결, OpenCode 등 NDJSON 스트림 내부의 토론 판결문 파싱, `LIGHT` 트랙 내부 서브에이전트 강제 적용 |
| `be4ded9` | **다중 하네스 `/handoff` 스킬 추가**: Claude Code, OpenCode, Codex CLI, Antigravity 간 작업 세션을 이어받을 수 있는 `handoff.md` 생성 스킬(`/handoff`, `/asd-handoff`) 추가 |
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
| `2bca203` | 내장 `lsp` 코드 인텔리전스 MCP 서버(`src/mcp/lsp-server.ts`) 및 하네스별 부족 기능만 채우는 Gap-Filling MCP 동기화 |
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
