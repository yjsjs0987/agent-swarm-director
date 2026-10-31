# ASD Web Dashboard (`asd ui`) 상세 기능 명세 및 재구현 가이드

이 문서는 [`src/cli/dashboard.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts)에 구현되어 있는 `asd ui` 웹 대시보드의 **전체 아키텍처, 백엔드 API, 데이터 소스, 화면 영역별 상세 기능, 그리고 기존 구현의 구조적 버그 및 재구현 시 개선 요구사항**을 정리한 명세서입니다.

추후 Claude 등의 모델에게 이 문서를 컨텍스트로 제공하여 [`src/cli/dashboard.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts)를 재설계 및 재구현할 수 있도록 작성되었습니다.

---

## 1. 시스템 개요 및 아키텍처

- **진입점**: CLI 명령어 `asd ui [--port <number>] [--no-open]` ([`src/cli/index.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/index.ts))
- **구현 파일**: [`src/cli/dashboard.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts)
- **서버 방식**: Node.js 내장 `node:http` 모듈을 사용하는 로컬 HTTP 서버 (기본 주소: `http://127.0.0.1:3847`)
- **프론트엔드 구성**: 외부 프런트엔드 빌드 파이프라인 없이 `renderDashboardHtml()`이 단일 HTML 문서(인라인 CSS + Vanilla JS)를 반환하는 구조
- **주요 외부 의존성 (코드베이스 내부 모듈)**:
  - [`src/core/db.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts): `openStateDb(projectRoot)`를 통해 `.asd/state.db` (SQLite) 조회 및 업데이트
  - [`src/core/router.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/router.ts): `loadRoutingConfig(projectRoot)`, `resolveRoute(...)`를 통해 글로벌/프로젝트 라우팅 설정 로드 및 Fallback 계산
  - [`src/adapters/registry.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/registry.ts): `getAdapter(harness)`를 통해 서브에이전트 재실행 시 CLI 명령어(`buildHeadlessCommand`) 생성
  - [`src/cli/doctor.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/doctor.ts): `runAsdDoctor(projectRoot)`를 통해 각 하네스 설치 및 가용 상태 확인
  - [`src/core/types.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts): `ASD_VERSION`, `HarnessId`, `AgentRole`, `TaskCategory` 등 코어 타입

---

## 2. 데이터 소스 구조 (SQLite & 파일 시스템)

### 2.1 SQLite 데이터베이스 (`.asd/state.db`)
1. **`sessions` 테이블**:
   - `session_id` (PK), `project_root`, `current_phase`, `status`, `active_harness`, `memo`, `created_at`, `updated_at`
2. **`tasks` 테이블**:
   - `session_id`, `task_id` (복합 PK, 예: `T1.1`), `turn`, `track` (`LIGHT` | `HEAVY`), `role` (`planner` | `architect` | `worker` | `scout` | `critic`), `category`, `difficulty` (`low` | `medium` | `high`)
   - `title`, `context_hint`, `target_files` (JSON 배열 문자열), `verification_cmd`
   - `assigned_harness`, `assigned_model`, `status` (`pending` | `running` | `done` | `failed` | `blocked`)
   - `worktree_path`, `branch_name`, `commit_sha`, `started_at`, `completed_at`, `error_message`
3. **`debates` 테이블**:
   - `debate_id` (PK, 예: `D-mvqw...`), `session_id`, `topic`, `mode`, `rounds`, `reviewers_json`, `proposals_json`, `critiques_json`, `synthesized_json`, `verdict` (`APPROVE` | `MINOR_AMEND` | `REJECT`), `status` (`running` | `completed` | `failed`), `created_at`, `completed_at`

### 2.2 파일 시스템 (`.asd/`)
1. **세션 메타데이터**: `.asd/sessions/<sessionId>/main.json`
   - `memo`: 세션 메모 문자열
   - `debateMemos`: `{ [debateId: string]: string }` (단독 실행된 적대적 토론별 메모)
2. **서브에이전트 실행 로그 디렉토리**: `.asd/sessions/<sessionId>/subagents/<subSessionId>/`
   - `meta.json`:
     ```json
     {
       "subSessionId": "sub-1-T1.2-architect-opencode-...",
       "parentSessionId": "cursor-and-skills-v22",
       "taskId": "T1.2",
       "debateId": null,
       "role": "architect",
       "harness": "opencode",
       "model": "opencode/glm-5.1",
       "status": "running | completed | failed | cli_error | timeout",
       "pid": 12345,
       "worktreePath": "C:\\...\\.asd\\wt\\1-T1.2",
       "branchName": "asd/cursor-and-skills-v22/1/T1.2",
       "startedAt": "2026-10-30T...",
       "completedAt": "2026-10-30T...",
       "exitCode": 0,
       "durationMs": 45200,
       "error": null
     }
     ```
   - `prompt.md`: 서브에이전트에게 전달된 전체 프롬프트 텍스트
   - `output.log`: 서브에이전트 실행 표준 출력(stdout/stderr) 또는 실행 요약 로그
3. **프로젝트 로컬 라우팅 오버라이드**: `.asd/routing.jsonc`
   - 존재할 경우 글로벌 `~/.config/asd/routing.jsonc`보다 우선 적용됨
4. **Heavy 모드 Git 워크트리**: `.asd/wt/<turn>-<taskId>/`

---

## 3. 백엔드 HTTP API 엔드포인트 명세

[`startDashboardServer()`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L2369-L2465)가 제공하는 엔드포인트 목록입니다.

### 3.1 `GET /` (또는 `GET /index.html`)
- **역할**: 대시보드 웹 UI HTML 반환 (`Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`)

### 3.2 `GET /api/state`
- **역할**: `collectDashboardSnapshot(projectRoot)`를 호출하여 대시보드 전체 상태 스냅샷 반환
- **응답 JSON 구조 (`DashboardSnapshot`)**:
  - `version`: ASD 버전 문자열 (`ASD_VERSION`)
  - `projectRoot`: 프로젝트 절대 경로
  - `systemLocale`: OS 로케일 문자열
  - `timestamp`: ISO 시각 문자열
  - `session`: 가장 최근 활성 세션 요약 객체 (`null` 가능)
  - `sessions`: 전체 세션 배열 (`id`, `createdAt`, `updatedAt`, `status`, `phase`, `memo`)
  - `tasks`: 기본 활성 세션의 태스크 배열
  - `allTasks`: 모든 세션의 전체 태스크 배열
  - `debates`: 기본 활성 세션의 토론 배열 (`synthesized` 파싱 포함)
  - `allDebates`: 모든 세션의 전체 토론 배열
  - `subagentLogs`: 모든 세션의 `.asd/sessions/*/subagents/*` 로그 배열 (최대 60개, `outputTail` 최근 8,000자, `promptPreview` 앞 4,000자 포함)
  - `routingConfig`: 현재 유효한 `RoutingConfig` 객체 (`agents`, `categories`)
  - `hasLocalRouting`: `.asd/routing.jsonc` 파일 존재 여부 (`boolean`)
  - `localRoutingPath`: `.asd/routing.jsonc` 절대 경로
  - `availableModels`: 하네스별 사용 가능한 모델 ID 배열 (`Record<HarnessId, string[]>`)
  - `harnesses`: `runAsdDoctor()` 결과 (`harness`, `installed`, `version`, `binaryPath`, `notes`)

### 3.3 `GET /api/models` 및 `POST /api/models/refresh`
- **역할**: 각 하네스 CLI 및 로컬 설정 파일에서 사용 가능한 모델 목록을 탐지하여 반환 (`GET`은 60초 메모리 캐시 사용, `POST /api/models/refresh`는 강제 재탐지)
- **하네스별 모델 탐지 방식 (`discoverHarnessModels`)**:
  - `antigravity`: `agy models` (또는 `--list-models`) 실행 파싱 + 기본 모델 목록(`flash`, `pro`, `flash_lite`, `claude-sonnet-4-6`, `claude-opus-4-6`, `gpt-5.4` 등) 병합
  - `opencode`: `opencode models` 실행 출력 라인 파싱 + `~/.config/opencode/opencode.json(c)`의 `provider` 설정 파싱
  - `codex`: `~/.codex/models_cache.json`의 `models[].slug` 파싱 + `~/.codex/config.toml`의 `model` 파싱
  - `claude-code`: `~/.claude/settings.json` (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_BASE_URL`의 `/v1/models` 조회) + `~/.claude/litellm_config.yaml` (`model_list[].model_name`) + 기본 별칭(`default`, `sonnet`, `opus`, `haiku`)
  - `cursor` *(v2.3 추가 대상)*: `~/.cursor/cli-config.json`의 `model.modelId` 파싱 + 기본 모델 목록(`auto`, `composer-2`, `claude-sonnet-4.6`, `claude-opus-4.6`, `gpt-5.4`)

### 3.4 `POST /api/session-memo`
- **요청 Body**: `{ "sessionId": string, "memo": string }`
- **역할**: SQLite `sessions.memo` 컬럼과 `.asd/sessions/<sessionId>/main.json`의 `memo` 필드를 동시에 업데이트 (가상 토론 세션 ID `<sessionId>::<debateId>`인 경우 `main.json`의 `debateMemos[debateId]`에 저장)

### 3.5 `POST /api/routing`
- **요청 Body**:
  - 저장 시: `{ "action": "save", "routingConfig": RoutingConfig }` -> `.asd/routing.jsonc`에 포맷팅하여 저장
  - 초기화 시: `{ "action": "reset" }` -> `.asd/routing.jsonc` 삭제 후 글로벌 설정 반환

### 3.6 `POST /api/subagent-action`
- **요청 Body**:
  ```json
  {
    "sessionId": "cursor-and-skills-v22",
    "subSessionId": "sub-1-T1.2-...",
    "action": "kill | retry | fallback | custom",
    "harness": "opencode",
    "model": "opencode/glm-5.1"
  }
  ```
- **역할 (`runSubagentControlAction`)**:
  1. **`kill`**: `meta.json`의 `pid`가 살아있으면 프로세스 트리 강제 종료(`taskkill /PID <pid> /T /F` 또는 `kill -9`), `meta.json` 상태를 `"failed"`, 에러 메시지를 `"Killed by user from dashboard"`로 기록하고 `output.log`에 중단 로그 추가.
  2. **`retry`**: 기존 프로세스가 실행 중이면 종료 후, 기존과 동일한 `harness`, `model`, `prompt.md`, `worktreePath`를 사용하여 새 서브세션 디렉토리(`<baseSubId>-retry-<id>`)를 만들고 백그라운드(`detached: true`)로 재실행.
  3. **`fallback`**: `loadRoutingConfig()`에서 해당 `role`/`difficulty`/`category`의 `fallbacks` 리스트를 조회하여 현재 `harness:model`의 다음 순번 Fallback으로 새 서브세션(`<baseSubId>-fb-<id>`)을 백그라운드 스폰.
  4. **`custom`**: 사용자가 요청 Body로 지정한 `harness`와 `model`로 새 서브세션(`<baseSubId>-custom-<id>`)을 백그라운드 스폰.
  - **공통 후처리**: 재실행(`retry`/`fallback`/`custom`) 시 대상 `taskId`가 있으면 SQLite `tasks` 테이블의 `status`를 `'running'`으로, `assigned_harness`/`assigned_model`을 새 값으로 업데이트.

---

## 4. 기존 프론트엔드 화면 구성 및 상세 기능

### 4.1 상단 헤더 바 (`.header`)
- **좌측**: 대시보드 타이틀 (`ASD 멀티 에이전트 컨트롤 플레인 (v2.3.1)`) + 현재 프로젝트 루트 경로 표시
- **우측 컨트롤 그룹**:
  - `최근 갱신: <시각>`: 마지막 폴링 성공 시각 표시
  - `라우팅 편집` 버튼: 클릭 시 프로젝트 라우팅 편집기 패널(`#routingEditorCard`) 토글
  - `모델 확인` 버튼: 클릭 시 하네스별 사용 가능 모델 모달(`#modelsModalBackdrop`) 오픈
  - `한국어 | EN` 언어 토글 스위치: `localStorage.getItem('asd_ui_lang')`에 저장하며 UI 다국어 사전(`I18N`) 즉시 반영

### 4.2 하네스별 모델 확인 모달 (`#modelsModalBackdrop`)
- 각 하네스(`antigravity`, `claude-code`, `codex`, `opencode`, `cursor`) 박스를 그리드로 배치하고, 탐지된 모델 개수 배지와 모델 ID 리스트를 표시
- 우측 상단 `🔄 모델 목록 새로고침` 버튼 클릭 시 `POST /api/models/refresh` 호출 후 모달 및 라우팅 피커 갱신

### 4.3 프로젝트 라우팅 편집기 (`#routingEditorCard`)
- 상단 상태 표시줄: 현재 `.asd/routing.jsonc` 오버라이드가 적용 중인지 글로벌 기본값 사용 중인지 배지로 표시 + `글로벌 기본값으로 초기화` / `프로젝트에 라우팅 저장` 버튼
- **좌측 테이블 (`5대 코어 에이전트`)**: `planner`, `architect`, `worker`, `scout`, `critic`
- **우측 테이블 (`3단계 난이도 및 도메인 카테고리`)**: `low`, `medium`, `high`, `frontend`, `backend`, `security`, `research`, `debugging`, `quick`, `deep`, `visual`
- **행별 편집 필드**:
  - `Primary Harness` (`<select>`)
  - `Primary Model` (클릭/타이핑 시 해당 하네스의 `availableModels`를 보여주는 커스텀 검색 팝오버 `.model-picker-wrap`)
  - `Effort` (`<input>`, 예: `low`, `medium`, `high`, `max`)
  - `Fallbacks` (`<input>`, `harness:model` 콤마 구분 문자열)

### 4.4 메인 3단 그리드 레이아웃 (`.grid`: 좌측 `270px` / 중앙 `1fr` / 우측 `460px`)

#### (1) 좌측 컬럼: 세션 목록 (`#sessionList`)
- 세션 카드 리스트 표시 (`id`, 생성 일시, 메모 요약, `메모` 편집 버튼)
- 메모가 비어 있으면 해당 세션의 첫 번째 태스크 제목(`firstTask.title`)이나 첫 번째 토론 주제(`firstDebate.topic`)를 자동으로 요약 텍스트로 표시
- `메모` 버튼 클릭 시 메모 수정 및 `/api/session-memo` 저장

#### (2) 중앙 컬럼: KPI 요약 + 적대적 토론 + 태스크 실행 현황
- **KPI 카드 3개 (`#kpiGrid`)**:
  1. `선택된 세션`: 선택된 세션 ID, 메모, 현재 단계(`phase`)
  2. `세션 작업 진행률`: `완료 / 전체 (%)` 수치 및 프로그레스 바
  3. `하네스 가용 상태`: 각 하네스의 설치 여부 초록/회색 배지
- **세션 내 적대적 토론 (`#debateList`)**:
  - 선택된 세션의 `debates` 목록 렌더링
  - 상태(`running`/`completed`), 최종 판정(`APPROVE`/`MINOR_AMEND`/`REJECT`), 합성 결과(`decisions`, `hardConstraints`, `risks`) 표시
  - 토론 카드 클릭 시 `selectDebate(debateId)` 실행 -> 우측 인스펙터를 해당 토론의 서브에이전트 로그로 필터링
- **세션 내 작업(TASK) 실행 현황 (`#taskList`)**:
  - 선택된 세션의 `tasks` 목록 렌더링
  - 상태 배지(`pending`/`running`/`done`/`failed`/`blocked`), `task_id`, `[Turn N | track | role]`, 할당된 `harness/model`, 소요 시간, 커밋 SHA 앞 7자리, 태스크 제목 표시
  - 태스크 카드 클릭 시 `selectTask(taskId)` 실행 -> 우측 인스펙터를 해당 태스크의 서브에이전트 로그로 필터링

#### (3) 우측 컬럼: 서브에이전트 제어 & 실행 로그 뷰어 (`#inspector`)
- **서브에이전트 선택 알약(Pill) 리스트 (`.pill-scroll`)**:
  - 선택된 태스크(또는 토론)에 매칭되는 서브에이전트 실행 로그들을 알약 탭으로 나열 (`role [subSessionId] @harness`)
  - 태스크/토론 필터가 걸려 있을 때는 맨 앞에 `전체 세션 로그 보기` 버튼 표시
- **서브에이전트 메타 정보 헤더**:
  - `taskId — harness (model) | Role: role`
  - `서브세션: subSessionId | 상태: status | PID: pid`
- **실시간 제어 박스 (`.control-box`)**:
  - `■ 강제 종료 (Kill)` 버튼
  - `↻ 동일 모델 재실행` 버튼
  - `⏭ Fallback으로 실행` 버튼
  - 하네스 `<select>` + 모델 검색 피커 + `🎯 선택한 모델로 실행` 버튼
- **로그 및 프롬프트 뷰어**:
  - `실행 출력 로그 (OUTPUT.LOG)` (`<pre>`)
  - `전달된 프롬프트 (PROMPT.MD)` (`<pre>`)

---

## 5. 기존 구현의 구조적 문제점 및 버그 (재구현 시 필수 해결 과제)

새로 구현할 때 반드시 해결해야 하는 현재 [`src/cli/dashboard.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts)의 핵심 문제점들입니다.

### 문제 1: 태스크를 클릭해도 다른 태스크의 로그가 계속 보이는 버그
- **원인 A (프론트엔드 폴백 버그)**:
  - 기존 코드(`dashboard.ts` 약 2299행)에서 태스크 클릭 시 로그를 필터링할 때:
    ```javascript
    const effectiveLogs = filteredLogs.length > 0 ? filteredLogs : sessionLogs;
    ```
    처럼 작성되어 있어, 선택한 태스크(예: `T1.1`)에 매칭되는 서브에이전트 로그가 0개일 때 빈 상태 안내를 띄우지 않고 **세션 전체 로그(`sessionLogs`, 예: `T1.2`의 로그)로 몰래 폴백**해 버립니다.
  - 결과적으로 사용자는 좌측/중앙에서 `T1.1`을 클릭해 파란색 테두리가 쳐졌는데도 우측 인스펙터에는 여전히 `T1.2`만 표시되어 클릭이 먹통인 것처럼 느끼게 됩니다.
- **원인 B (`claim_only` 모드 서브에이전트 로그 미생성)**:
  - 호스트 에이전트(예: Antigravity, Claude Code)가 `claim_only` 모드로 태스크를 직접 수행할 때([`src/mcp/server.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/mcp/server.ts)의 `handleDispatch`), SQLite `tasks` 상태만 `running`으로 바꾸고 `.asd/sessions/<sessionId>/subagents/<subSessionId>/{meta.json,prompt.md,output.log}`를 생성하지 않았습니다.
- **해결 방안**:
  1. `selectedTaskId` 또는 `selectedDebateId`가 선택되었는데 `filteredLogs.length === 0`이면 절대 `sessionLogs`로 폴백하지 말고, **"선택한 작업(T1.1)에 기록된 서브에이전트 실행 로그가 없습니다."**라는 명확한 안내 화면(및 해당 태스크의 SQLite 메타데이터: 워크트리 경로, 브랜치명, 커밋 해시, 타겟 파일 목록, 검증 명령어 등)을 표시할 것.
  2. `claim_only` 디스패치 및 `asd verify` 시에도 `.asd/sessions/<sessionId>/subagents/` 아래에 로그 디렉토리를 기록할 것.

### 문제 2: 2초마다 `innerHTML` 전체 교체로 인한 스크롤 초기화, 드래그 해제, 입력 증발
- **원인**:
  - `setInterval(poll, 2000)`이 돌 때마다 `renderAll()`이 호출되어 `#sessionList`, `#kpiGrid`, `#debateList`, `#taskList`, `#inspector`의 `innerHTML`을 통째로 덮어씁니다.
- **부작용**:
  1. 우측 `OUTPUT.LOG`나 `PROMPT.MD`의 `<pre>` 박스에서 스크롤을 내려 로그를 읽고 있으면 **2초마다 스크롤이 맨 위로 강제 초기화**됩니다.
  2. 로그 내 에러 메시지를 마우스로 드래그하여 복사하려 해도 2초 안에 풀려버립니다.
  3. 우측 `.control-box`에서 `선택한 모델로 실행`을 위해 하네스 드롭다운이나 모델 검색창을 조작하는 도중 리렌더링이 일어나면 포커스나 팝오버가 깨집니다.
  4. 좌측 세션 메모 수정 시 브라우저의 구식 `window.prompt()` 블로킹 다이얼로그에 의존하고 있습니다.
- **해결 방안**:
  - 데이터 변경 감지(Diffing) 또는 영역별 세분화된 DOM 업데이트를 적용하여, **데이터가 실제로 변하지 않은 요소는 재렌더링하지 않을 것**.
  - 특히 로그 뷰어(`#outputLogPre`, `#promptPre`)는 텍스트 내용만 업데이트하되, **사용자의 현재 `scrollTop` 위치(또는 하단 자동 스크롤 고정 여부)와 텍스트 선택 영역을 보존**할 것.
  - 컨트롤 박스(`.control-box`)의 입력 폼은 선택된 `subSessionId`가 바뀔 때만 초기화하고, 2초 폴링 시에는 버튼 활성화 상태나 메타 텍스트만 부분 갱신할 것.

### 문제 3: 단독 토론(`asd debate`) 가상 세션 분리(`sessionId::debateId`)의 복잡성
- **원인**:
  - 하나의 세션 안에서 `asd debate`만 여러 번 실행된 경우 이를 좌측 세션 목록에서 개별 항목으로 보여주려고 백엔드(`collectDashboardSnapshot`)에서 `<sessionId>::<debateId>`라는 가상 세션 ID를 합성하여 내려주고, 프론트엔드 곳곳에서 `.includes('::')`와 `.split('::')`로 분기 처리하고 있습니다.
- **해결 방안**:
  - 세션과 토론의 데이터 모델을 명확히 분리하거나, 좌측 네비게이션에 **[세션 목록]** 탭과 **[적대적 토론 이력]** 필터/그룹을 깔끔하게 구분하여 `::` 문자열 파싱 해킹 없이 직관적으로 탐색할 수 있게 개선할 것.

### 문제 4: 태스크 상세 정보 및 워크트리 상태 가시성 부족
- **원인**:
  - 현재 중앙 태스크 카드에는 제목과 한 줄 요약만 나오고, 태스크에 지정된 **`target_files` (허용된 대상 파일 목록)**, **`context_hint`**, **`verification_cmd` (검증 명령어)**, **`worktree_path`**, **`error_message`**를 UI 어디에서도 자세히 볼 수 없습니다.
  - 또한 CLI 서브에이전트가 종료되기 전까지 stdout을 버퍼링하는 경우 `output.log`가 비어 있어서 작업이 진행 중인지 알 수 없습니다.
- **해결 방안**:
  - 태스크를 선택했을 때 우측 인스펙터 상단(또는 탭)에 **태스크 상세 명세(Target Files, Context Hint, Verification Cmd, Worktree Path, Branch, Commit SHA, Error Message)**를 명확히 표시할 것.
  - 가능하면 실행 중인 워크트리(`.asd/wt/<turn>-<taskId>`)의 변경된 파일 상태(`git status --short`)를 함께 조회하여 표시하면 디버깅 및 모니터링 효율이 크게 향상됩니다.

---

## 6. 재구현 시 준수해야 할 인터페이스 제약 사항

[`src/cli/dashboard.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts)를 재구현할 때 외부 모듈과의 호환성을 위해 아래 export 시그니처들은 반드시 유지해야 합니다:

```typescript
export interface DashboardOptions {
  projectRoot?: string;
  port?: number;
  host?: string;
  openBrowser?: boolean;
}

export function collectDashboardSnapshot(projectRoot?: string): DashboardSnapshot;
export function renderDashboardHtml(initial: DashboardSnapshot): string;
export async function startDashboardServer(
  options?: DashboardOptions,
): Promise<{ url: string; close: () => Promise<void> }>;
```
