# Agent Swarm Director (ASD v2.2) — 프로젝트 상태 및 아키텍처 상세 보고서

> **작성 기준일**: 2026-10-27
> **버전**: `2.2.0` (`agent-swarm-director`)
> **대상 하네스**: Claude Code (`@cc`), OpenCode (`@oc`), Codex CLI (`@cx`), Antigravity (`@ag`)

---

## 1. 프로젝트 개요 및 핵심 철학

**Agent Swarm Director (ASD v2.2)**는 서로 다른 4개의 AI 코딩 하네스(**Claude Code**, **OpenCode**, **Codex CLI**, **Antigravity**)를 단일 결정론적 컨트롤 플레인으로 통합 제어하는 **외부 의존성 0개(Zero-Dependency)** 멀티 에이전트 오케스트레이션 하네스입니다.

### 3대 아키텍처 불변성 (Core Invariants)
1. **Zero External Runtime Dependencies (`dependencies: {}`)**:
   - 서드파티 npm 런타임 패키지나 별도 트랜스파일/빌드 단계 없이, **Node.js `>=22.13.0`**의 네이티브 TypeScript 실행(`--no-warnings`)과 내장 `node:sqlite`(WAL 모드), `node:http`, `node:child_process`, `node:crypto` 표준 모듈만으로 동작합니다.
2. **Strict Core Purity**:
   - `src/core/*` 모듈은 `src/adapters/*`를 절대 import하지 않으며, 어댑터 계층과의 결합 없이 독립적으로 동작합니다.
3. **Erasable TypeScript Syntax Only**:
   - Node.js 네이티브 TypeScript 실행(`erasableSyntaxOnly: true`)을 준수하기 위해 `enum`, `namespace`, 생성자 파라미터 프로퍼티를 사용하지 않고 순수 타입 유니온(`type`)과 `as const` 배열만 사용합니다.

---

## 2. 디렉토리 및 모듈 구조

```text
asd-multiagent/
├── package.json                 # Zero runtime dependencies, Node >=22.13.0, bin: {"asd": "./src/cli/index.ts"}
├── tsconfig.json                # erasableSyntaxOnly: true, strict: true
├── README.md / README_ko.md     # 영문/국문 사용자 매뉴얼 (스킬 및 CLI 가이드)
├── handoff.md                   # 다중 하네스 세션 인수인계(Handoff) 컨텍스트 문서
├── PROJECT_STATUS.md            # 현재 프로젝트 상태 및 아키텍처 상세 보고서 (본 문서)
├── presets/
│   ├── default-routing.jsonc    # 10대 전문 역할 및 카테고리/난이도별 기본 모델 라우팅 + 다중 폴백 체인
│   └── default-mcp.jsonc        # Gap-filling MCP 서버 카탈로그 (lsp, context7, grep_app, websearch)
├── src/
│   ├── core/                    # 코어 오케스트레이션 엔진 (어댑터 의존성 0)
│   │   ├── types.ts             # 전체 인터페이스, 역할(10개), 카테고리, 난이도, 입출력 스키마 정의
│   │   ├── config.ts            # 2-Path 레이아웃 해석 (~/.asd 및 <project>/.asd), 대소문자 정규화 경로 해시
│   │   ├── db.ts                # node:sqlite WAL 모드 3-테이블 SSOT 드라이버 (sessions, tasks, debates)
│   │   ├── router.ts            # 4단계 모델 라우팅, 미설치 하네스 감지, 다양성 리뷰어 선택, 자동 폴백 체인
│   │   ├── spawner.ts           # 서브에이전트 프로세스 스폰, 시크릿 마스킹 로깅, 프로세스 트리 강제 종료
│   │   ├── workspace.ts         # Git 베이스라인 보호, LIGHT 체크포인트/롤백, HEAVY 워크트리 및 뮤텍스 병합
│   │   ├── debate.ts            # 블라인드 교차 모델 적대적 토론 브로커 (Round 1 병렬 비평 + Round 2 심판)
│   │   ├── policy.ts            # 1ms PreToolUse 경로/명령 가드 및 Stop 훅 3회 무진전 서킷 브레이커
│   │   ├── render.ts            # .asd/PLAN.md 양방향 파서/렌더러, 실시간 progressBoard, summary.md 생성
│   │   ├── lsp.ts               # TS/JS/Python/Go/Rust 심볼 추출, 정의/참조 탐색, 정적 진단 엔진
│   │   ├── redact.ts            # API 키/JWT/PEM/비밀번호 자동 마스킹 ([REDACTED])
│   │   └── jsonc.ts             # 주석/후행 쉼표 안전 JSONC 파서 및 TOML 펜스 블록 매니저
│   ├── adapters/                # 4대 AI 하네스 어댑터 및 글로벌 인스톨러
│   │   ├── claude-code.ts       # Claude Code (@cc) 어댑터 (~/.claude, ~/.claude.json)
│   │   ├── opencode.ts          # OpenCode (@oc) 어댑터 (~/.config/opencode)
│   │   ├── codex.ts             # Codex CLI (@cx) 어댑터 (~/.codex/config.toml)
│   │   ├── antigravity.ts       # Antigravity (@ag) 어댑터 (~/.gemini)
│   │   └── installer.ts         # 글로벌 동기화(sync), 외과적 제거(uninstall), 100ms 헬스체크(doctor)
│   ├── mcp/                     # MCP 프로토콜 및 인프로세스 오케스트레이션 핸들러
│   │   ├── server.ts            # plan, dispatch, verify, debate 코어 핸들러 및 Subagent Isolation Guard
│   │   ├── lsp-server.ts        # 내장 LSP 기능이 없는 하네스에 주입되는 독립형 LSP MCP 서버
│   │   └── stdio-rpc.ts         # 비동기 JSON-RPC 2.0 stdio 트랜스포트 (start 시점에만 console.log 리다이렉트)
│   ├── cli/                     # 통합 터미널 CLI 및 로컬 웹 대시보드
│   │   ├── index.ts             # 11개 CLI 명령어 엔트리포인트
│   │   └── dashboard.ts         # 한국어/영어 지원 Zero-Dependency 실시간 웹 대시보드 (http://127.0.0.1:3847)
│   └── skills/                  # 4대 하네스에 공통 배포되는 슬래시 스킬 템플릿
│       ├── asd/SKILL.md         # /asd (전 과정 자율 수행)
│       ├── asd-plan/SKILL.md    # /asd-plan (계획 수립 전용)
│       ├── asd-run/SKILL.md     # /asd-run (PLAN.md 역동기화 및 실행/재개)
│       ├── asd-debug/SKILL.md   # /asd-debug (재현 우선 디버깅)
│       ├── asd-debate/SKILL.md  # /asd-debate (이기종 모델 블라인드 적대적 토론)
│       ├── asd-handoff/SKILL.md # /asd-handoff (다중 하네스 세션 인수인계 문서 생성)
│       └── handoff/SKILL.md     # /handoff (다중 하네스 세션 인수인계 문서 생성 별칭)
└── tests/                       # 14개 테스트 파일, 총 231개 단위/통합 테스트 (100% 통과)
```

---

## 3. 2-Path 상태 저장소 및 `.asd/sessions` 기록 조건

ASD v2.2는 프로젝트 폴더 오염을 막고 멀티 프로세스 동시성을 보장하기 위해 **글로벌 상태 디렉토리(`~/.asd`)**와 **프로젝트 로컬 뷰 디렉토리(`<project>/.asd`)**로 역할을 분리합니다.

### 3.1 글로벌 상태 디렉토리 (`~/.asd`)
- `~/.asd/state/<projectHash>/core.db`: SQLite WAL 모드 단일 진실 공급원(SSOT). `sessions`, `tasks`, `debates` 3개 테이블로 구성됩니다.
- `~/.asd/routing.jsonc`, `~/.asd/mcp.jsonc`: 전역 모델 라우팅 및 MCP 카탈로그 설정.
- `~/.asd/state/last-sync.json`: 마지막 `asd sync` 해시 기록(동일 해시 시 불필요한 파일 쓰기 스킵).

### 3.2 프로젝트 로컬 뷰 디렉토리 (`<project>/.asd`) 및 `.asd/sessions` 기록 조건
`<project>/.asd/` 폴더는 `.git/info/exclude`에 자동으로 등록되어 Git 커밋 내역을 오염시키지 않습니다.

| 경로 | 생성 및 기록되는 정확한 조건 |
| :--- | :--- |
| **`.asd/sessions/` (빈 폴더)** | `ensureProjectInitialized()`가 호출될 때 디렉토리 구조만 미리 생성됩니다 (`openProjectDb`, `prepareBaseline`, `createTaskWorktree` 호출 시). **단, `asd status`, `asd doctor`, `asd ui`, `asd logs`, `asd clean`만 실행했을 때는 하위 세션 폴더가 기록되지 않습니다.** |
| **`.asd/sessions/<sessionId>/main.json`** | **`asd plan` (`create`, `get`, `update`, `sync_from_md`)이 실행될 때** (`src/mcp/server.ts`의 `handlePlan()`) 생성 및 갱신됩니다. 메인 세션 ID, 메인 하네스 종류, 현재 페이즈(`planning`/`running`/`done`), PID, 시작 시각이 기록됩니다. |
| **`.asd/sessions/<sessionId>/subagents/<subSessionId>/`** (`meta.json`, `prompt.md`, `output.log`) | **`spawnSubagent()`가 실제로 외부/백그라운드 서브에이전트 CLI를 스폰할 때** (`src/core/spawner.ts`) 생성됩니다:<br>1. **`HEAVY` 모드 병렬 실행 (`asd dispatch --mode parallel_spawn`)**: 태스크별로 `sub-<turn>-<taskId>-<role>-<harness>` 폴더가 생성되며 프롬프트(`prompt.md`), 시크릿 마스킹된 실시간 출력(`output.log`), 상태 메타데이터(`meta.json`)가 기록됩니다.<br>2. **적대적 토론 (`asd debate` / `/asd-debate`)**: 1라운드 리뷰어(`...-deb-<debateId>-r1-1`, `r1-2`)와 2라운드 심판(`...-r2-arbiter`) 실행 시 각각 기록됩니다.<br>3. **폴백 재시도 발생 시**: 쿼터 초과/네트워크 장애 등으로 폴백 모델이 호출되면 `-fb1`, `-fb2`, `-default` 접미사가 붙은 서브세션 폴더가 추가로 기록됩니다.<br>*(반면 `LIGHT` 모드의 `claim_only` 실행은 외부 CLI를 띄우지 않고 현재 하네스 내부에서 처리하므로 `subagents/` 하위 폴더를 생성하지 않습니다.)* |
| **`.asd/sessions/<sessionId>/summary.md`** (및 `.asd/summary.md`) | 세션 내 모든 태스크의 상태가 `done`(`[x]`)이 되는 순간 (`asd verify` 통과 또는 `asd dispatch` 완료 시점) 자동 생성됩니다. |

---

## 4. 핵심 서브시스템 작동 방식

### 4.1 CLI 직접 오케스트레이션 (MCP 60초 타임아웃 완전 해결)
- 기존 MCP 프로토콜(`stdio` RPC)을 통해 무거운 서브에이전트 스폰이나 다중 모델 토론을 호출하면 호스트 클라이언트의 **60초 요청 타임아웃(`MCP error -32001: Request timed out`)**에 걸리는 한계가 있었습니다.
- 현재 버전에서는 `asd-core` MCP 등록을 제거하고, 모든 오케스트레이션 명령(`asd plan`, `asd dispatch`, `asd verify`, `asd debate`)을 **터미널 CLI로 직접 실행**하도록 일원화하여 시간 제한 없이 안정적으로 동작합니다.

### 4.2 `LIGHT` 모드 vs `HEAVY` 모드 이중 트랙
- **사전 1회 통합 브리핑 원칙**: 모든 `/asd*` 스킬(`/asd`, `/asd-plan`, `/asd-run`, `/asd-debug`, `/asd-debate`)은 코드 수정이나 서브에이전트 호출 전에 **단 한 번만** ① 할 일 요약, ② `LIGHT`(현재 하네스 전용) vs `HEAVY`(다중 하네스 병렬) 선택 질문, ③ 요구사항 확인 질문을 묶어서 브리핑합니다.
- **`LIGHT` 모드 (현재 하네스 전용)**:
  - `asd dispatch` 시 기본값으로 `claim_only` 모드로 동작하며 현재 세션의 하네스(`session.main_harness`)로 라우팅을 고정합니다.
  - 소규모 작업은 메인 AI가 직접 파일을 수정하고, 위임 작업은 현재 하네스 내부의 네이티브 서브에이전트를 사용한 뒤 `asd verify`로 체크포인트 커밋(`asd(<taskId>): <title>`)을 생성합니다.
- **`HEAVY` 모드 (다중 하네스 병렬)**:
  - 태스크마다 독립된 Git 워크트리(`.asd/wt/<turn>-<taskId>`)와 브랜치(`asd/wt-<turn>-<taskId>`)를 생성하고 루트 `node_modules`를 Directory Junction으로 연결합니다.
  - 여러 외부 하네스 CLI(`claude`, `opencode`, `codex`)를 동시에 스폰하여 병렬 작업 후, 테스트 통과 시 Junction을 안전하게 해제하고 비동기 뮤텍스(`withMergeLock`) 하에 메인 브랜치로 `--no-ff` 병합합니다.

### 4.3 4단계 모델 라우팅 및 순차 폴백(Sequential Fallback) 체인
1. **4단계 라우팅 우선순위 (`resolveRoute`)**:
   - **Tier 1**: 명시적 하네스/모델 핀 고정 (`--harness`, `--model`)
   - **Tier 2**: 전문 에이전트 역할 매칭 (`director`, `planner`, `analyst`, `critic`, `arbiter`, `architect`, `scout`, `verifier`)
   - **Tier 3**: 도메인 카테고리 매칭 (`visual-ui`, `design`, `research`, `writing`)
   - **Tier 4**: 작업 난이도 매칭 (`trivial`, `low`, `medium`, `high`, `critical`)
2. **단일 하네스 고정 시 모델 자동 매핑**:
   - 현재 하네스만 사용(`LIGHT` 또는 `--harness <id>`)할 때, 1순위 모델이 다른 하네스이더라도 `routing.jsonc`의 `fallbacks` 배열에서 **현재 하네스에 해당하는 지정 모델**을 자동으로 찾아 호출합니다.
3. **자동 폴백 조건 (`isFallbackTriggerOutput` & `resolveFallback`)**:
   - 서브에이전트나 토론 리뷰어 실행 중 **비정상 종료(exitCode !== 0)**, **타임아웃**, **사용량/쿼터 제한(`429`, `rate limit`, `quota exceeded`, `credit balance`, `overloaded`)**, **네트워크 오류(`ECONNRESET`, `ETIMEDOUT`, `fetch failed`)**, **모델명 오류(`model not found`)**가 감지되면 `fallbacks` 배열에 등록된 다음 모델(동일 하네스의 다른 모델 및 타 하네스 모델 모두 지원)로 즉시 자동 전환하여 재시도합니다.

### 4.4 보안 가드 및 실패 복구
- **1ms Fail-Closed `PreToolUse` 가드 (`src/core/policy.ts`)**:
  - 대소문자 변조(`.GIT/config`, `.Asd/`, `.ENV`) 및 심볼릭 링크 우회를 차단하고, 보호 파일(`.env*`, `*.pem`, `*.key`, `id_rsa*`) 및 허용된 파일 경계(`allowedFiles`) 밖의 수정을 즉시 거부합니다.
- **3단계 자동 에스컬레이션 및 서킷 브레이커**:
  - 검증 실패 시 1차 롤백 후 재시도 → 2차 재시도 → 3차 상위 아키텍트(`architect` / `critical`) 모델로 에스컬레이션하며, 진전 없는 정지 시도가 3회 누적(`no_progress_count >= 3`)되면 서킷 브레이커가 작동해 무한 루프를 차단합니다.

---

## 5. 테스트 및 동기화 검증 현황

- **자동화 테스트 스위트 (`npm test`)**:
  - 총 **14개 테스트 스위트 / 231개 테스트 케이스 100% 통과 (실패 0건)**.
- **4대 하네스 글로벌 동기화 (`asd sync`)**:
  - Claude Code, OpenCode, Codex CLI, Antigravity의 글로벌 설정에 7개 스킬 엔트리(`/asd`, `/asd-plan`, `/asd-run`, `/asd-debug`, `/asd-debate`, `/asd-handoff`, `/handoff`), 10개 에이전트 페르소나, 보안 훅, Gap-Filling MCP(`lsp`, `context7`, `grep_app`, `websearch`), 전역 `asd` CLI 심(shim)이 정상 배포되어 있습니다.
