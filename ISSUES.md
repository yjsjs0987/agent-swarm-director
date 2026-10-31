# ASD v2.3.1 알려진 이슈 및 기술 부채 보고서

> 작성일: 2026-10-31 · 기준 커밋: 현재 워킹 트리 · 검증: `npm test` 237/237 통과
> 범위: 전체 소스 직접 코드 리뷰에서 도출된 **미해결** 이슈. 우선순위는 영향도 × 발생 확률 기준.

---

## P1 — 높음 (실전 장애 또는 데이터 손실 가능)

### 1.1 다중 디렉터 동시 실행 시 LIGHT 트랙에서 작업 소실 가능

- **위치**: `src/mcp/server.ts` (`getLatestSession` 폴백, `handleDispatch`), `src/core/workspace.ts:454` (`rollbackLightChanges`), `src/core/workspace.ts:380` (`prepareBaseline`)
- **증상**: 하나의 프로젝트에서 두 하네스(예: agy 실행 중 opencode에서 `/asd-run`)가 각각 디렉터로 동작하면:
  - sessionId 미지정 시 `getLatestSession()`이 상대방의 활성 세션을 반환 → **세션 교차 오염**
  - 같은 LIGHT 태스크 이중 claim(상태 덮어쓰기, 소유자 개념 없음)
  - 검증 실패 시 `git checkout -- .` + `git clean -fd`로 **상대 하네스의 진행 중 편집 전체 소멸**
  - `prepareBaseline`이 더티 트리를 `git stash push -u`로 통째로 가져감 → 상대 작업과 분기
- **DB 자체는 안전**: WAL + `busy_timeout=5000` + `BEGIN IMMEDIATE`로 데이터 손상 없음. 문제는 논리적 경합.
- **완화(현행)**: HEAVY 워크트리는 브랜치/경로 중복 예외로 충돌 실패(보존됨). `withMergeLock`은 프로세스 내부 뮤텍스라 프로세스 간엔 무력 → `git index.lock` 충돌 시 merge_conflict 마킹.
- **제안 수정**: `<projectRoot>/.asd/director.lock`(PID + 갱신 시각 기록)을 `handlePlan`/`handleDispatch` 입구에서 검사. 스톨 감지(예: 5분 무갱신) 후 인계 허용. 규모: ~20줄.

### 1.2 긴 프롬프트가 Windows 인자 한도를 넘으면 원인 불명의 3회 실패 — **부분 해결됨(2026-10-31)**

- **위치**: `src/core/spawner.ts:104-173` (`resolveSpawnCommand`), `src/core/spawner.ts:185-195` (claude 전용 stdin 폴백)
- **증상**: Windows `CreateProcess` 명령줄 한도 ~32,767자. 프롬프트에는 태스크 메타 + acceptance + 업스트림 DoneClaim(key_decisions/changed_files)이 전부 포함되므로 대형 태스크/긴 체인에서 근접 가능.
- **조치(2026-10-31)**: `defaultCommandRunner`의 `child.on("error")`에서 스폰 실패 원인과 명령줄 인자 길이(>8,000자 시 OS 한도 초과 힌트)를 `output.log`(`onStderr`)에 기록하도록 개선하여 무로그 원인 불명 실패 해소. (비-claude CLI의 stdin 일괄 전환은 CLI별 인자 파서 차이로 보류)

### 1.3 `--dangerously-skip-permissions`가 훅 존재와 무관하게 무조건 주입

- **위치**: `src/core/spawner.ts:192-194` (`defaultCommandRunner`)
- **배경(타당함)**: `claude -p` headless 모드는 권한 승인 프롬프트를 못 받으므로 권한 필요 툴에서 영구 스톨 발생(실사용 관찰됨). `acceptEdits`/`--allowedTools`는 나머지 툴에서 재스톨. headless 자동화에선 전면 우회가 사실상 유일한 실용 선택.
- **보완 계층(현존)**: 플래그는 서브에이전트 스폰에만 적용(메인 세션 무영향). ASD 자체 PreToolUse 훅이 대체 권한 계층으로 동작 + 사후 boundary 검증/롤백 + 커밋 전 시크릿 스캔.
- **잔여 리스크**: ① `~/.claude/settings.json`에 ASD 훅이 등록 안 된 환경(미 sync, 수동 삭제)에서는 **보호막 없는 전면 우회**가 됨. ② 훅의 툴 매니페스트에 없는 신규 쓰기 툴은 무조건 통과. ③ Bash 차단이 블랙리스트 정규식이라 `git clean`, `python -c "os.remove(...)"` 등 우회 가능(사후 boundary+롤백이 최후 방어).
- **제안 수정**: claude 스폰 시 ASD 훅 등록 여부를 확인(기존 `doctor` 로직 재사용)하고, 등록돼 있을 때만 플래그 주입. 없으면 `--permission-mode acceptEdits`로 폴백 + 경고 로그.

---

## P2 — 중간 (오동작·유지보수 부채)

### 2.1 Cross-Scope 체인 깊이 판별이 태스크 제목 문자열에 의존 — **완료됨(2026-10-31)**

- **위치**: `src/mcp/server.ts:1347` (`getCrossScopeChainDepth`), `src/core/db.ts`
- **조치**: `tasks` 테이블에 `is_cross_scope INTEGER NOT NULL DEFAULT 0` 컬럼 및 자동 마이그레이션(`ALTER TABLE`)을 추가하고, `upsertTasks` 시 `MAX(tasks.is_cross_scope, excluded.is_cross_scope)`로 보존하도록 수정하여 `PLAN.md` 역동기화(`sync_from_md`)로 제목이 수정되더라도 체인 깊이 제한(2)이 우회되지 않도록 해결.

### 2.2 `detectAvailableCliHarnesses`가 미검출 시 전체 하네스를 "있음"으로 반환

- **위치**: `src/core/router.ts:247`
- **증상**: CLI가 하나도 설치 안 된 환경에서 `["claude-code","opencode","codex","cursor"]` 반환 → 존재하지 않는 바이너리로 라우팅 → spawn 실패 → fallback 체인 소모 → 3회 실패. 오류가 "CLI 미설치"를 가리키지 않음.
- **의도 추정**: CLI 없는 CI/테스트 환경에서 라우팅이 죽지 않게 하는 폴백.
- **제안 수정**: `[]` 반환 + 호출자가 빈 배열 처리. 테스트 편의는 `ASD_ASSUME_HARNESSES` env 플래그로 분리.

### 2.3 PLAN.md 파서 포맷 결합도 (괴물 정규식 + 이중 파서)

- **위치**: `src/core/render.ts:37` (`TASK_LINE_REGEX`, 13개 캡처 그룹), `render.ts:371-479` (폴백 파서)
- **증상**: 렌더러와 파서가 포맷 문자열을 공유하지 않아 render→parse 왕복에서 침묵 속 데이터 손실 가능. 알려진 오탐: 제목에 `]` 포함, 제목 괄호 안에 우연히 `Files:` 텍스트가 있으면 메타로 오인 추출(`matchedMeta` 가드가 부분 완화).
- **장기 제안**: 기계용 데이터를 PLAN.md 프론트매터(JSON 블록)로 분리하고, 사람이 읽는 줄은 표시용으로 격하. 단기는 왕복 라운드트립 테스트(특수문자 제목) 보강.

### 2.4 PreToolUse 툴 매니페스트가 미등록 쓰기 툴을 통과시킴

- **위치**: `src/core/policy.ts:551-560` (`isWriteTool` 판정)
- **증상**: 하네스가 매니페스트에 없는 신규 쓰기 가능 툴을 도입하면 `isWriteTool=false → allowed`로 무검증 통과. Claude Code 등의 툴 셋이 바뀌면 보호막에 자동 공백 발생.
- **완화(현존)**: 사후 boundary 검증(git status 기반)이 삭제/수정을 잡고 롤백. `asd doctor`가 훅 존재를 검증.
- **제안 수정**: 매니페스트에 알려진 **읽기 전용 툴 화이트리스트**를 두고, 그 외 미분류 툴은 서브에이전트에 한해 경고 또는 차단(fail-closed) 옵션 검토.

---

## P3 — 낮음 (정리 대상)

### 3.1 `allowedFiles` tests/** 삽입 블록 중복 및 `parallel_spawn` 누락 — **완료됨(2026-10-31)**

- **위치**: `src/mcp/server.ts:938-940`, `src/mcp/server.ts:1110-1112`
- **조치**: `claim_only` 구간의 중복 `if` 블록을 제거하고, 누락되어 있던 `parallel_spawn` 구간에 `tests/**`, `**/*.test.ts`, `**/*.spec.ts` 허용 블록을 추가하여 병렬 스폰 시 서브에이전트의 테스트 파일 수정이 boundary 위반으로 차단되던 버그까지 함께 수정.

### 3.2 db.ts DDL 주석 드리프트 — **완료됨(2026-10-31)**

- **위치**: `src/core/db.ts:156-158`
- **조치**: `role`(5대 역할) 및 `difficulty`(3단계: `low | medium | high`) 주석을 현행 타입 정의에 맞게 정정.

### 3.3 `mcp/server.ts` serverInfo 버전 상수화 — **완료됨(2026-10-31)**

- `ASD_VERSION` 상수 참조로 통일. installer 로스터 헤더도 동일 처리. 테스트 단언 2.3.0 갱신. 잔여: 문서 주석 헤더의 "ASD v2.3.1" 표기(파일 상단 docstring) — 동작 무영향.

### 3.4 dashboard.ts 단일 거대 파일

- **위치**: `src/cli/dashboard.ts` (약 106KB, `renderDashboardHtml`이 993–2544행)
- **증상**: 제로디펜던시 설계상 의도된 셀프컨테인드 HTML이지만, 대시보드 JS 버그는 브라우저 수동 확인 외 검증 경로 없음. EN/KO 문자열 인라인 중복.
- **제안**: 우선순위 낮음. 손볼 일이 있을 때 템플릿을 상수 문자열 단위로 분리 + 스냅샷 테스트 도입.

---

## 이미 해결된 항목 (추적용)

| 항목 | 해결일 | 내용 |
|---|---|---|
| README/README_ko의 미존재 `lsp-server.ts` 문서화 | 2026-10-31 | LSP 섹션 제거, 섹션 제목 정정. PROJECT_STATUS 파일 트리·카탈로그·페르소나 수(10→5)·테스트 수(231→237) 갱신 |
| serverInfo 버전 2.2.0 하드코딩 | 2026-10-31 | `ASD_VERSION` 상수화 |
| 3.1 `allowedFiles` 중복 제거 및 `parallel_spawn` 테스트 허용 누락 수정 | 2026-10-31 | `claim_only` 중복 블록 제거 + `parallel_spawn`에 `tests/**` 허용 추가 |
| 3.2 `db.ts` DDL 주석 정정 | 2026-10-31 | `role`(5대 역할), `difficulty`(3단계) 주석 현행화 |
| 2.1 Cross-Scope 체인 깊이 DB 컬럼화 | 2026-10-31 | `tasks.is_cross_scope` 컬럼 및 `ALTER TABLE` 마이그레이션 추가 |
| 1.2 스폰 실패(`error` 이벤트) 시 명령어·인자 길이 진단 로그 추가 | 2026-10-31 | `spawner.ts` `child.on("error")`에서 `onStderr`로 실패 원인 및 인자 길이 힌트 기록 |

---

## 권장 처리 순서

1. **3.1 + 3.2** (5분) — 죽은 코드/주석 정리, 즉시 커밋 가능
2. **1.2** — 프롬프트 stdin/파일 전환 + 실패 힌트 (실전 장애 예방 효과 최대)
3. **1.3** — skip-permissions 훅 게이트 (보안 공백 제거)
4. **1.1** — director.lock (멀티 하네스 혼용 가드)
5. **2.1, 2.2** — DB 플래그 컬럼 + 하네스 검출 정직화
6. **2.3, 2.4** — 파서 분리/매니페스트 fail-closed는 다음 마이너 버전에서 검토
