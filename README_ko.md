# Agent Swarm Director (`agent-swarm-director` / ASD v2.2)

[English](./README.md) | **한국어**

> **외부 의존성 0개(Zero-Dependency)로 Claude Code, OpenCode, Codex CLI, Antigravity 4개 AI 코딩 하네스를 통합 제어하는 범용 멀티 에이전트 오케스트레이션 하네스**

**Agent Swarm Director (ASD v2.2)**는 기존 Antigravity 전용이었던 `agy-agent-swarm-director`를 4대 AI 코딩 하네스 전체에서 동작하도록 확장한 범용 멀티 에이전트 컨트롤 플레인입니다. 외부 npm 런타임 패키지를 단 하나도 사용하지 않고(`dependencies: {}`), 순수 Node.js(`>=22.13.0`) 네이티브 TypeScript 실행과 내장 `node:sqlite`(WAL 모드)만으로 동작합니다.

---

## 핵심 기능

- **외부 런타임 의존성 0개 (`dependencies: {}`)**
  - 무거운 서드파티 패키지나 빌드 과정 없이 Node.js `>=22.13.0`의 네이티브 TypeScript 실행(`--no-warnings`)과 표준 라이브러리(`node:sqlite` 등)만으로 즉시 구동됩니다.
- **4대 AI 하네스 통합 컨트롤 플레인**
  - **Claude Code** (`claude`)
  - **OpenCode** (`opencode`)
  - **Codex CLI** (`codex`)
  - **Antigravity** (`agy`)
- **빈자리만 채우는 지능형 MCP 및 스킬 동기화 (`asd sync`)**
  - 프로젝트 폴더를 오염시키지 않고 글로벌 사용자 홈 디렉토리(`~/.claude`, `~/.config/opencode`, `~/.codex`, `~/.gemini`)에만 5개 핵심 스킬(`/asd`, `/asd-plan`, `/asd-run`, `/asd-debate`, `/asd-debug`), 10개 전문 에이전트 페르소나, 보안 훅(`PreToolUse`, `Stop`), MCP 서버를 자동 설치합니다.
  - **중복 방지(Gap-Filling) 주입**: 각 하네스가 기본 내장한 기능(예: OpenCode의 내장 `lsp`, Claude Code·Codex·Antigravity의 내장 `websearch`)이나 사용자가 이미 등록해 둔 MCP는 건너뛰고, **해당 하네스에 없는 도구만 자동으로 채워 넣습니다.**
- **이중 트랙(Dual-Track) 워크스페이스 격리**
  - **LIGHT 트랙**: 빠른 인플레이스(In-place) 작업 수행 후 자동 Git 체크포인트 커밋을 생성하며, 검증 실패 시 즉시 이전 상태로 롤백합니다.
  - **HEAVY 트랙**: 독립된 Git 워크트리(`.asd/wt/<taskId>`)를 생성하고 `node_modules` 정션(Junction) 심볼릭 링크를 자동 연결/해제하며, 뮤텍스(Mutex) 직렬화 잠금 하에 안전하게 `--no-ff` 병합을 수행합니다.
- **블라인드 교차 모델 적대적 토론 (`asd_debate`)**
  - 서로 다른 모델 패밀리(`claude`, `gpt`, `gemini`, `glm`)를 병렬 호출하여 1라운드 블라인드 비평을 수행하고, 2라운드 심판(`arbiter`) 판결을 통해 도출된 필수 제약 사항을 작업 인수 조건(`acceptance`)에 자동 주입합니다.
- **1ms Fail-Closed 보안 가드 & 서브에이전트 실드(Subagent Shield)**
  - 대소문자 우회(`.GIT/config`, `.Asd/meta.json`, `.ENV`)까지 차단하는 정규화 경로 검증으로 허용된 파일(`allowedFiles`) 외부 수정을 원천 차단합니다.
  - 서브에이전트가 오케스트레이션 도구를 재귀 호출하거나 무한 루프에 빠지는 것을 방지합니다.

---

## 요구 사항

- **Node.js**: `>=22.13.0`
- **Git**: `>=2.30.0`

---

## 빠른 시작 (Quick Start)

```bash
# 1. 최초 1회 설치: 4개 하네스 글로벌 설정 동기화 및 전역 PATH에 'asd' 명령어 자동 등록
node --no-warnings src/cli/index.ts sync
# (선택: 전역 PATH에 'asd' 명령어를 등록하고 싶지 않다면 --no-path 옵션 사용)
# node --no-warnings src/cli/index.ts sync --no-path

# 2. 이후부터는 어느 프로젝트 폴더에서든 'asd' 명령어를 바로 사용할 수 있습니다!
asd doctor
asd status
asd logs
asd logs T1.1
asd ui

# 3. 전체 자동화 테스트 스위트 실행
npm test
```

---

## CLI 명령어

| 명령어 | 설명 |
| :--- | :--- |
| `asd sync [--force] [--no-path]` | 4개 하네스의 글로벌 설정에 스킬, 10개 에이전트, 보안 훅, 부족한 MCP 도구를 동기화하고 전역 `PATH`에 `asd` 명령어를 자동 등록합니다 (`--no-path` 지정 시 `PATH` 등록 생략). |
| `asd status` | 현재 프로젝트의 SQLite 세션 상태, 실시간 TODO 진행 보드, 미적용 자동 스태시(auto-stash) 경고를 출력합니다. |
| `asd logs [taskId] [--json]` | 인자 없이 실행하면 가장 최근 서브에이전트 실행 로그를 자동 출력하며, `T1.1`(또는 `t1.1`)처럼 작업 번호를 지정하면 해당 작업의 서브에이전트 로그를 조회합니다. |
| `asd ui [--port <num>]` | 외부 패키지 0개의 경량 로컬 웹 대시보드(`http://127.0.0.1:3847`)를 실행하여 실시간 진행률, 마우스 클릭을 통한 서브에이전트 로그/프롬프트 조회, 토론 판결문을 브라우저에서 제공합니다. |
| `asd doctor [--json]` | Node 버전, SQLite WAL, Git 저장소, 4대 하네스 CLI 바이너리 경로 및 Headless 지원 여부, `PreToolUse` 보안 차단 여부를 100ms 이내에 점검합니다. |
| `asd clean [--pop]` | 잔여 `.asd/wt/*` 워크트리와 `asd/*` 브랜치를 정리하고, `--pop` 옵션 사용 시 자동 스태시된 변경사항을 복원합니다. |
| `asd uninstall` | ASD가 주입한 글로벌 훅, TOML 펜스 블록, 스킬, 에이전트, MCP 항목만 외과적으로 제거하고 사용자의 기존 설정을 100% 원복합니다. |

---

## 내장 MCP 서버 및 제공 도구

### 1. `asd-core` (`src/mcp/server.ts`)
- `asd_plan`: `.asd/PLAN.md`와 3-테이블 SQLite SSOT(`sessions`, `tasks`, `debates`) 간의 계획 생성, 조회, 수정 및 양방향 동기화(`sync_from_md`)를 수행합니다.
- `asd_dispatch`: 선행 작업(`depends_on`)의 완료 결과(`DoneClaim`)를 컨텍스트로 자동 주입하며 웨이브 단위로 서브에이전트를 병렬 디스패치합니다.
- `asd_verify`: 수정 파일 경계(`allowedFiles`) 검증, 시크릿 유출 차단, 테스트 명령 실행 후 LIGHT 체크포인트 커밋 또는 HEAVY 워크트리 병합을 수행합니다.
- `asd_debate`: 이기종 모델 간 병렬 블라인드 비평과 심판 합의를 수행합니다.

### 2. `asd-lsp` (`src/mcp/lsp-server.ts`)
자체 CLI LSP가 없는 하네스에 자동으로 채워지는 내장 코드 인텔리전스 서버입니다:
- `lsp_diagnostics`: 정적 타입 및 문법 오류 진단 (`tsc`, `node --check`, 병합 충돌 마커 감지)
- `lsp_symbols`: 파일/디렉토리 내 심볼 선언 추출 (`function`, `class`, `interface`, `type`, `variable`, `struct`)
- `lsp_definition`: 심볼 정의부 위치(`file`, `line`, `column`) 정밀 탐색
- `lsp_references`: 프로젝트 전체에서 특정 심볼의 참조 위치(`file`, `line`, `column`, `isDefinition`) 탐색

---

## 라이선스

[Functional Source License, Version 1.1, Apache 2.0 Future License (FSL-1.1-ALv2)](./LICENSE) © 2026 yjsjs0987
