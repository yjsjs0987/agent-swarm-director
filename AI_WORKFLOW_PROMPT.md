# AI 에이전트 작업 지침 프롬프트 (`AI_WORKFLOW_PROMPT.md`)

> **사용법**: 다른 AI(Claude Code, OpenCode, Codex, Antigravity, Cursor 등)에게 이 프로젝트 작업을 맡길 때, 아래 프롬프트 블록을 그대로 복사해 붙여넣거나 `@AI_WORKFLOW_PROMPT.md 읽고 시작해`라고 지시하세요.

---

## 📋 복사해서 바로 쓰는 AI 작업 프롬프트 (Copy & Paste)

```markdown
너는 지금 `asd-multiagent` (Agent Swarm Director v2.4.0) 프로젝트를 수정/개발하는 엔지니어다.
작업 시작 전 반드시 아래 규칙과 절차를 끝까지 준수해라.

### 1. 필수 사전 숙지 문서 (작업 전 먼저 읽을 것)
- `PROJECT_STATUS.md`: 전체 디렉토리 구조 및 각 파일별/주요 함수별 상세 역할
- `EXTERNAL_SDK_REFERENCE.md`: 외부 GUI(`asd-gui`) 연동용 공개 SDK 및 단일 공유 DB(`~/.asd/state/core.db`) 명세

### 2. 절대 어기면 안 되는 5대 코어 제약 사항 (Hard Constraints)
1. **외부 런타임 의존성 0% (`dependencies: {}`)**:
   - `npm install <패키지>`로 외부 라이브러리를 절대 추가하지 마라.
   - 반드시 Node.js(`>=22.13.0`) 내장 모듈(`node:sqlite`, `node:fs`, `node:path`, `node:child_process`, `node:http`, `node:crypto`)만 사용해라.
2. **네이티브 TypeScript 문법 및 JSDoc 주석 주의 (`erasableSyntaxOnly: true`)**:
   - 별도 빌드(`tsc`) 없이 `node --no-warnings src/cli/index.ts`로 바로 실행된다. `enum`, `namespace`, 생성자 `private/public` 파라미터 프로퍼티를 쓰지 마라.
   - **특히 `src/` 내부 파일의 `/** ... */` JSDoc 블록 주석 안에 `/*` 또는 `*/`(예: `projects/*/*.jsonl`)를 절대 적지 마라.** 주석이 중간에 닫혀 PreToolUse 훅 전체가 구문 에러로 멈춘다 (대신 `projects/<dir>/*.jsonl` 형태로 표기할 것).
3. **단일 공유 DB (`~/.asd/state/core.db`) 및 테스트 홈 격리**:
   - DB 연결 시 반드시 `openProjectDb(projectRoot, homeDir)` 또는 `new SqliteDriver(dbPath, projectRoot)`로 프로젝트 스코프를 지정해라.
   - 테스트 실행 시 실제 사용자 홈(`~/.asd`)이 오염되지 않도록 반드시 `node scripts/run-tests.mjs` (또는 `node scripts/run-tests.mjs tests/<파일명>.test.ts`)를 사용해라.
4. **코어 순수성 및 공개 SDK 동기화**:
   - `src/core/*`는 `src/adapters/*`를 직접 import하지 않는다.
   - 외부(`asd-gui`)에서 쓸 함수나 타입을 추가/변경했다면 `src/index.ts` export와 `EXTERNAL_SDK_REFERENCE.md`, `PROJECT_STATUS.md`를 함께 업데이트해라.
5. **Git 커밋 위생 (Contributor 오염 금지)**:
   - 커밋 메시지에 `Co-Authored-By: Claude ...` 등 AI 공동 작성자 트레일러를 **절대 넣지 마라**. 모든 커밋은 사용자 단독 명의로만 기록되어야 한다.

### 3. 매 작업 시 표준 수행 절차 (Step-by-Step)
1. **탐색 및 계획 보고**:
   - 관련 파일(`PROJECT_STATUS.md` 참고)을 먼저 읽고, 수정할 파일 경로·변경 내용·예상 영향을 간결하게 요약해 보고해라. (단, 사용자가 "알아서 끝까지 해"라고 지시한 경우 즉시 실행)
2. **최소 범위 구현**:
   - 요청받은 기능과 직접 관련된 파일만 수정하고, 기존 주석이나 인터페이스를 임의로 삭제하지 마라.
3. **격리 테스트 검증**:
   - 수정한 모듈에 대응하는 단위 테스트를 추가/수정한 뒤 `node scripts/run-tests.mjs tests/<대상>.test.ts`를 실행해 100% 통과를 확인해라.
4. **문서 최신화 및 커밋/푸시**:
   - 함수 시그니처나 기능이 추가/변경되면 `PROJECT_STATUS.md`, `EXTERNAL_SDK_REFERENCE.md`, `PATCH_NOTES.md`, `PATCH_NOTES_ko.md`를 최신 상태로 반영해라.
   - 사용자가 커밋/푸시를 지시한 경우 `Co-Authored-By` 없이 깔끔하게 커밋하고 `git push origin main`을 수행해라.
```

---

## ⚡ 상황별 초단축 지시어 예시

- **일반 기능 추가/수정 시**:
  > `@AI_WORKFLOW_PROMPT.md 읽고 [원하는 기능] 구현해줘. 테스트 통과 확인하고 문서까지 업데이트한 뒤 커밋/푸시해.`
- **ASD 멀티에이전트 자율 실행 시**:
  > `/asd @AI_WORKFLOW_PROMPT.md 규칙 준수해서 [원하는 기능] 알아서 끝까지 구현하고 태스크마다 커밋/푸시해.`
- **버그 디버깅 시**:
  > `/asd-debug @AI_WORKFLOW_PROMPT.md 규칙 준수해서 [오류 증상] 원인 찾고 재현 테스트 작성 후 고쳐줘.`
