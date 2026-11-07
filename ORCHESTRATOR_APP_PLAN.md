# ASD 오케스트레이터 TUI/GUI 앱 개발 계획

> 작성일: 2026-11-06 · 근거: 5개 하네스 로컬 실측 + 공식 문서 조사 + ASD v2.4.2 코드 검증
> 상태: 기획 (구현 미착수)

---

## 0. 핵심 전제 — 이미 구현된 것을 다시 만들지 않는다

ASD v2.4.2(`asd-multiagent`)에는 앱의 코어 로직 대부분이 이미 구현·출시 상태다.
새 앱은 **"새 하네스 연동 레이어"가 아니라 "기존 ASD SDK 위의 쉘"**이다.

| 계획한 기능 | 기존 구현 | 위치 |
|---|---|---|
| 하네스 호출 + 실시간 스트리밍(thinking/tool_use/tool_result/assistant) | `runDriverTurn` + `parseDriverStreamLine` | `src/core/drivers.ts` |
| 세션 기록 불러오기(4분류 파싱) | `readHarnessTranscript` | `src/core/transcripts.ts` |
| 프로젝트 세션 자동 탐색 | `discoverProjectCliSessions` | `src/core/session-tracker.ts` |
| ASD 진행도 보드 | `renderProgressBoard`, `asd status --json` | `src/core/render.ts`, `src/cli/index.ts` |
| 전체 상태 스냅샷 | `collectDashboardSnapshot()` | `src/cli/dashboard.ts` |
| 웹 UI 원형 | `asd ui` (node:http, :3847) | `src/cli/dashboard.ts` |
| 서브세션 스폰/로그 | `spawnSubagent`, `scanSubagentLogs` | `src/core/spawner.ts` |
| 하네스 명령 조립 | 5종 어댑터 (headless/resume/interactive) | `src/adapters/*.ts` |
| GUI 프로젝트 | ASD-Nexus (`yjsjs0987/ASD-Nexus`) | 별도 리포 |

---

## 1. 하네스별 실측 매트릭스

| 하네스 | 세션 저장 | 스트리밍 1순위 | 스트리밍 2순위(CLI 파이프) | 세션 이어가기 | 증거 |
|---|---|---|---|---|---|
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite WAL, 단일) | `opencode serve` + SSE `GET /api/event/subscribe` | `opencode run "..." --format json` | `-s <id>` / `-c` / `--fork`, `opencode export <id>` | 데모 실행 ✅ |
| Claude Code | `~/.claude/projects/<cwd인코딩>/<uuid>.jsonl` | Agent SDK `query({ resume, includePartialMessages })` | `claude -p --output-format stream-json --verbose --include-partial-messages` | `--resume <id>` + 스트림 동시 공식 지원, `--fork-session` | 스트림 이벤트 실측 ✅ |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (구세션 `.zst`) | `codex app-server` JSON-RPC (양방향, 런타임 승인 가능) | `codex exec --json` | `codex exec resume <id>`, `codex fork` | **데모 완주 ✅** |
| Cursor CLI | `~/.cursor/chats/<workspace-md5>/<uuid>/store.db` (SQLite) + `meta.json` | `@cursor/sdk` (GA) | `cursor-agent -p --output-format stream-json --stream-partial-output` | `--resume <chatId>`, `create-chat` | 헬프+문서+저장소 실측 |
| Antigravity | `~/.gemini/antigravity-cli/conversations/<id>.db` + `brain/<id>/.system_generated/logs/transcript.jsonl`(→`transcript_full.jsonl` 폴백) | Python/Rust SDK | `agy -p --output-format stream-json`, `--input-format stream-json`(상주 멀티턴) | `--conversation <id>`, `-c` | 헬프+문서+디렉토리 실측 |

### 하네스별 핵심 노트

- **OpenCode**: TUI 자체가 서버 클라이언트. `run --attach http://localhost:4096`으로 웜 서버 재사용(MCP 콜드부트 회피). 공식 SDK `@opencode/sdk`(임베디드)/`@opencode/client`.
- **Claude**: 세션 JSONL에 thinking/tool_use/tool_result 전부 저장. 단 **포맷 불안정 공식 경고** → `readHarnessTranscript` 파서 유지보수 필요. Agent SDK로 권한 승인 UI(`canUseTool`)까지 제어 가능.
- **Codex**: app-server는 `initialize` 핸드셰이크 → `thread/start|resume|fork`, `turn/start|steer|interrupt`, `item/agentMessage/delta` 알림, 승인 RPC(`execCommandApproval`) 제공. `codex app-server generate-ts`로 TS 바인딩 자동 생성. 구 `codex mcp` 서버는 제거됨(app-server가 후계). 실측 함정: stdin 파이프 환경에서 stdin을 닫아야 함.
- **Cursor**: `--stream-partial-output`에서 `model_call_id` 없으면 진짜 델타, 있으면 버퍼 플러시(중복 스킵). IDE와 CLI 세션 저장소 분리.
- **Antigravity**: `agy acp`(ACP stdio JSON-RPC 서버) 존재. App(IDE) 쪽 아티팩트는 `~/.gemini/antigravity/brain/<id>/task.md` 등 Markdown.

### 공통 결론

5종 전부 **자식 프로세스 stdout JSONL 파싱만으로 실시간 스트리밍 가능**. OpenCode·Codex·Claude는 추가로 상주 서버/프로토콜 경로 제공. 세션 렌더링(과거 기록)은 전부 저장 파일/DB 파싱으로 해결.

---

## 2. 아키텍처 — 코어 서버 + 2개 클라이언트 (OpenCode 패턴 채택)

```
┌──────────────┐   SSE/HTTP    ┌───────────────────────────────┐   자식 프로세스
│  TUI 클라이언트│ ────────────▶ │ 오케스트레이터 서버 (GUI 리포)  │ ──▶ claude -p --output-format stream-json
│  (터미널)     │ ◀──────────── │  - asd-gui src/server 확장     │ ──▶ codex exec --json
└──────────────┘   SSE 이벤트   │  - runDriverTurn (Core SDK)    │ ──▶ opencode run --format json
┌──────────────┐               │  - openProjectDb (core.db)    │ ──▶ agy -p --output-format stream-json
│  GUI 클라이언트│ ────────────▶ │  - 이벤트 정규화 + 브로드캐스트  │ ──▶ cursor-agent -p --output-format stream-json
│ (Tauri/Electron)│ ◀────────── └───────────────────────────────┘
└──────────────┘
```

- **오케스트레이터 서버(GUI 리포 소속)**: `asd-gui`의 `src/server`(HTTP+WS)를 확장. 신규 엔드포인트: `/api/turn/stream`(POST: 프롬프트→SSE 정규화 이벤트 푸시), `/api/sessions`, `/api/transcript/:harness/:id`, `/api/board`, `/api/subagents`.
- **경계 원칙 (2026-11-06 확정)**: Core(asd-multiagent)는 **CLI + 코어 관리(계획·`asd ui` 대시보드·git worktree 등) + 최소 SDK/API**만 유지하고, 모든 UI·서버·렌더링은 GUI 리포가 담당한다. `asd ui`는 기능 동결(확장 금지 — 새 UI 기능은 GUI 리포로). Core 경계 위반 정리는 [CORE_GUI_BOUNDARY_AUDIT.md](./CORE_GUI_BOUNDARY_AUDIT.md) 참조.
- **TUI**: 같은 SSE 소비. GUI: 같은 SSE 소비(웹뷰는 얇다). ASD-Nexus는 이 코어 서버 기반으로 발전시키는 것 권장(SDK가 `asd-gui` 연동 전제로 설계됨).

### 이벤트 정규화 계약

```ts
type OrchestratorEvent = DriverStreamEvent & {
  kind: "thinking" | "tool_use" | "tool_result" | "text" | "status" | "usage" | "error";
  sessionId?: string;
  usage?: { input: number; output: number; cost?: number };
  status?: "running" | "done" | "interrupted";
};
```

렌더링 규칙(하네스 무관): thinking=접이식 실시간 append, tool_use=아이콘+이름+인자+스피너, tool_result=접이식(is_error시 빨강), text=마크다운 점진 렌더, usage=턴 푸터.

### 승인(권한) 처리

- v1: 자동승인 플래그(`--auto`, `--dangerously-skip-permissions`, `--force`) — ASD 기존 방식.
- v2: Claude=Agent SDK `canUseTool`, Codex=`app-server` 승인 RPC, OpenCode=permissions API, Cursor=`--auto-review`.

### 스택 권장

| 레이어 | 권장 | 이유 |
|---|---|---|
| Core | Node 22+ TS, `agent-swarm-director` import, 의존성 0 유지 | SDK 그대로 import |
| TUI | Ink (React for CLIs) | 채팅 스트림+포커스+스크롤 신속 구현. 우선순위 낮으면 v1은 `asd ui` 강화로 대체 |
| GUI | Tauri + React (대안: Electron) | 코어 서버 분리로 웹뷰 얇음. Electron은 ASD-Nexus 재사용에 유리 |

---

## 3. 세션 자동 로드 + 서브세션/진행도 모니터링

### 3.1 메인 세션 오픈 시 자동 로드 (3단계)

1. **세션 후보 수집**: `openProjectDb(projectRoot)` → ASD 세션 목록 + `discoverProjectCliSessions(projectRoot)` → 5하네스 CLI 세션 일괄(승격 여부 포함).
2. **트랜스크립트 복원**: `readHarnessTranscript({ harness, projectRoot, harnessSessionId })` → 4분류 렌더.
3. **이어달리기**: `session_drivers.harness_session_id`로 다음 턴부터 `runDriverTurn`이 resume 플래그로 이어감.

### 3.2 실시간 갱신 전략

- 파일형(Claude jsonl / Codex rollout / agy transcript): `chokidar` append 감지 → 증분 파싱. **Codex 구세션 `.zst`는 로드 시 zstd 복원 필요(발견된 갭).**
- DB형(OpenCode `opencode.db` 2.29GB / Cursor `store.db`): 세션ID 스코프 쿼리만 + 1~2초 폴링. OpenCode는 서버 SSE가 폴링 대체.
- Claude jsonl 포맷 불안정 → 파서 버전별 회귀테스트.

### 3.3 단축키 모니터링 패널 (Ctrl+B 오버레이)

| 섹션 | 데이터 소스 (전부 기존 구현) |
|---|---|
| 진행 보드 | `asd status --json` → `progressBoard` |
| 서브세션 목록 | `collectDashboardSnapshot()` tasks + `session_drivers` |
| 서브세션 라이브 로그 | `scanSubagentLogs()` (`output.log` 실시간 append) + `sub_session_id` tail |
| HEAVY 모드 | `.asd/wt/<turn>-<task>` 확인 + `getWorktreeDiff()` |
| 컨트롤 | `/api/subagent-action` (kill/retry/fallback/resume) |

키맵 제안: Ctrl+B 보드, Ctrl+L 로그, Ctrl+D diff. 갱신: 패널 열림 중 1초 폴링 + 로그 tail.

---

## 4. 하네스 전환 이어가기 — 제외 확정

세션 포맷이 하네스마다 완전히 달라 무손실 이관은 비용 대비 가치 없음. **`/handoff`(asd-handoff) 스킬의 "대화 요약 → 어느 하네스에서든 재개"를 표준 방법으로 채택**. 변환 레이어/신규 DB 미생성.

---

## 5. 구현 시퀀스

- **M1**: 오케스트레이터 서버(GUI 리포 소속, SSE 스트리밍, Claude 1하네스) + 웹 채팅 화면
- **M2**: 5하네스 어댑터 완성 + 세션 자동 로드
- **M3**: 단축키 모니터링 패널 + 승인 UI(v2 착수)
- **M4**: TUI 쉘 → GUI 패키징

---

## 부록 A. 실측 증거 발췌

```
$ codex exec --json "Reply with exactly: OK" --skip-git-repo-check --sandbox read-only
{"type":"thread.started","thread_id":"01a1b12a-..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":18720,...}}

$ opencode run "Reply with exactly: OK" --format json
{"type":"step_start",...,"sessionID":"ses_..."}
{"type":"text","part":{"type":"text","text":"OK",...}}
{"type":"step_finish","part":{...,"tokens":{...},"cost":0}}

$ claude -p "..." --output-format stream-json --verbose
{"type":"system","subtype":"init",...,"session_id":"...","tools":[...]}
{"type":"system","subtype":"api_retry",...}   ← 모델 프록시 오류로 턴 미완주, 프로토콜은 정상
```

## 부록 B. 알려진 갭/리스크

1. Codex 구세션 `.jsonl.zst` — 히스토리 전체 로드 시 zstd 복원 필요 (파서 대응 여부 확인 필요).
2. Claude 세션 JSONL 공식 "포맷 불안정" — 파서 회귀테스트 필요.
3. OpenCode `opencode.db` 2.29GB — 전체 로드 금지, 세션 스코프 쿼리만.
4. agy 어댑터의 stream-json 플래그 미사용 — 라이브 실측으로 확정, 부록 C 참조.

---

## 부록 C. ASD-Nexus 스트리밍 미작동 원인 (2026-11-06 라이브 실측 확정)

### 원인 매트릭스

| 하네스 | 현재 실행 명령(어댑터) | 실측 결과 | 판정 |
|---|---|---|---|
| Claude Code | 어댑터 `--output-format json` → 코어가 stream-json으로 승격 (`drivers.ts:1066-1073`, claude-code 전용) | 블록 단위 스트리밍 정상 | ✅ 정상 |
| Codex | `codex exec --json` (codex.ts:25) | JSONL 이벤트 실시간 (데모 완주) | ✅ 정상 |
| Antigravity | `agy -p --output-format json` (antigravity.ts:57 하드코딩) | 최종 1회 단일 JSON만 출력. 반면 `--output-format stream-json`은 `step_update`/`text_delta` 토큰 델타(~25ms 간격) 완벽 실측 | ❌ 플래그 + 파서 수정 필요 |
| Cursor | `agent -p --output-format json` (cursor.ts:71 하드코딩) | 최종 1회. 코어의 stream-json 승격이 claude-code 전용이라 cursor는 미적용 | ❌ 플래그 + 파서 수정 필요 |
| OpenCode | `run --format json` (opencode.ts:38) | **part 완료 단위** — 15문장 전체가 단일 `text` 이벤트로 도착(토큰 델타 없음). MCP 콜드부트 ~28s 후에야 첫 이벤트 | ⚠️ 구조적 한계 → serve+SSE 필요 |

### 핵심 사실

1. **원인은 GUI(asd-gui)가 아니라 코어 어댑터/파서다.** GUI의 스트리밍 파이프라인(`createGuiDriverCommandRunner` → WS `driver_stream_event` → `useWsDriverStreamEvent`)은 정상이며, 이벤트가 도착하면 전파된다. 문제는 "애초에 들어오는 이벤트가 없는 것".
2. agy 파서(`parseDriverStreamLine` 868-921행)가 기대하는 `PLANNER_RESPONSE`/`TOOL_RESPONSE`는 transcript.jsonl 포맷이고, CLI `--output-format stream-json`의 실측 스키마(`{"event":"init"|"step_update"|"result", "text_delta":"..."}`)와 불일치. 플래그만 바꿔도 파싱이 안 됨.
3. `EXTERNAL_SDK_REFERENCE.md`의 "Claude/Cursor stream-json 자동 활성화" 주석은 코드와 불일치(실제로는 claude-code만 승격).
4. OpenCode는 `run --format json`이 part 완료 시점에만 이벤트를 내보내는 CLI 구현 특성 → 토큰 단위 실시간은 `opencode serve` + SSE `/api/event/subscribe`(`session.message.part.updated` 델타)로만 가능.

### 수정 목록 (국소 수정 권고 — 백지화 불필요)

1. `src/adapters/antigravity.ts`: `--output-format json` → `stream-json` (라이브 검증됨)
2. `src/adapters/cursor.ts`: `--output-format json` → `stream-json` (+ `--stream-partial-output` 옵션 검토)
3. `src/core/drivers.ts`: claude-code 전용 stream-json 승격 분기 제거, 어댑터가 처음부터 올바른 포맷을 사용하도록 일원화
4. `src/core/drivers.ts::parseDriverStreamLine`: agy 실측 스키마(`event: init|step_update|result`, `text_delta`) 추가, cursor `tool_call`(started/completed) 추가
5. OpenCode: v1은 블록 단위 수용 + `--attach` 웜서버로 콜드부트 완화 → v2에서 `opencode serve` SSE 연동으로 토큰 스트리밍
6. `EXTERNAL_SDK_REFERENCE.md` 주석을 실제 동작과 일치시킴

### 실행 상태 (2026-11-06)

- [x] 1-2. agy·Cursor 스트리밍 플래그 — `buildHeadless/ResumeHarnessCommand`(session-tracker)에 `streaming` 옵션 추가, 하네스별 `stream-json` 분기. 비스트리밍 기본값(json)은 서브에이전트·debate 등 배치 경로 보호용으로 유지.
- [x] 3. drivers.ts claude 전용 splice 제거 — `runDriverTurn`이 `streaming: useStreamJson`을 빌더에 직접 전달(포맷 결정이 빌더로 일원화).
- [x] 4. 파서 — Cursor 실측 스키마(톱레벨 thinking 델타, `tool_call.<family>ToolCall` started/completed, user 프롬프트 에코 스킵) + agy stream-json(`step_update` 델타/`result`/`init`) 추가. 라이브 캡처 바이트 기반 단위 검증 통과(카테고리 전건 정확).
- [x] 6. `EXTERNAL_SDK_REFERENCE.md` 주석 갱신.
- [ ] 5. OpenCode serve+SSE — 미착수(별도 과제, 앱 계획 M2).
- 검증: Core 355/356(유일 실패 = 기존 유령 테스트 installer-sync), asd-gui 14/14. 미커밋.
