### 📊 ASD TODO 진행 현황 [Turn 5/5 완료 | 진행률: 14/14 (100%)]
- [x] **T1.1** (Turn 1, `@oc/nvidia/z-ai/glm-5.3-flash`, 완료): CR-15 & CR-17.4: ASD 세션 ID 생성·검증([`generateAsdSessionId`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L55-L76), [`isValidAsdSessionId`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L45-L49)) 및 [`getAdapter`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/registry.ts#L21-L36) 코어 레지스트리 분리 — 완료 (`6f1a231`)
- [x] **T1.2** (Turn 1, `@oc/default`, 완료): CR-11: 크로스 프로세스 병합 잠금(`.asd/merge.lock`) 및 [`withMergeLock`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L341-L395) 2단계 확장 — 완료 (`3843009`)
- [x] **T1.3** (Turn 1, `@oc/nvidia/z-ai/glm-5.3-flash`, 완료): CR-10: 5대 하네스 원본 트랜스크립트 리더([`readHarnessTranscript`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts), [`locateHarnessTranscript`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts)) 구현 — 완료 (`1619b4e`)
- [x] **T2.1** (Turn 2, `@cc/z-ai/glm-5.3-flash[1m]`, 완료): CR-01: `session_drivers` 테이블·마이그레이션 및 드라이버 관리 API([`attachDriver`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L98-L186), [`detachDriver`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L239-L260) 등) — 완료 (`57ac289`)
- [x] **T2.2** (Turn 2, `@oc/nvidia/z-ai/glm-5.3-flash`, 완료): CR-08: 커밋된 Worktree Diff(`merge-base` 모드) 및 HEAVY 승인/병합 시 경계 검사 보강 — 완료 (`ace5067`)
- [x] **T2.3** (Turn 2, `@oc/nvidia/z-ai/glm-5.3-flash`, 완료): CR-14: `PLAN.md` 전경 세션([`getForegroundSessionId`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L108-L125), [`setForegroundSession`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L636-L677)) 및 덮어쓰기/동기화 가드 — 완료 (`569c0e6`)
- [x] **T3.1** (Turn 3, `@oc/nvidia/z-ai/glm-5.3-flash`, 완료): CR-02: 0-Token 드라이버 브리핑([`buildDriverBriefing`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L277-L460)) 생성·절삭·마스킹 구현 — 완료 (`a855766`)
- [x] **T3.2** (Turn 3, `@cc/z-ai/glm-5.3-flash[1m]`, 완료): CR-09: `output.log` / `prompt.md` 수명 관리([`finalizeSubagentArtifacts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/spawner.ts#L502-L544)) 및 DB 기반 프롬프트 재구성 — 완료 (`920dad2`)
- [x] **T3.3** (Turn 3, `@oc/nvidia/z-ai/glm-5.3-flash`, 완료): CR-12: 고아 태스크 복구([`recoverOrphanedTasks`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L1664-L1805)) 및 디스패치 원자적 점유 확인([`tryClaimTask`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L711-L720)) — 완료 (`3ea53dc`)
- [x] **T4.1** (Turn 4, `@cc/z-ai/glm-5.3-flash[1m]`, 완료): CR-03: [`runDriverTurn`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L549-L779) GUI 헤드리스 드라이버 실행 및 [`executeHarnessProcess`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/spawner.ts#L317-L426) 공통 실행부 분리 — 완료 (`99e5670`)
- [x] **T4.2** (Turn 4, `@cc/z-ai/glm-5.3-flash[1m]`, 완료): CR-04: 훅 자동 연결 제거, `ASD_DRIVER_ID` 처리, [`linkHarnessSessionToAsdSession`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L810-L953) 위임 및 MCP 부착 규칙 — 완료 (`2d6f19e`)
- [x] **T4.3** (Turn 4, `@cc/z-ai/glm-5.3-flash[1m]`, 완료): CR-13: 서브에이전트 Resume 의미 재정의(`tasks.follow_up_of`, 상태별 [`runSubagentControlAction`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L604-L1090) 및 `done` 후속 태스크 생성) — 완료 (`7b4bae4`)
- [x] **T4.4** (Turn 4, `@oc/nvidia/z-ai/glm-5.3-flash`, 완료): CR-07: LIGHT 롤백 범위 축소([`rollbackLightChanges`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L796-L844) `files` 옵션 및 `untouchedFiles` 보존) — 완료 (`92c272e`, `c6a08aa`)
- [x] **T5.1** (Turn 5, `@oc/nvidia/z-ai/glm-5.3-flash`, 완료): CR-17 & Release `v2.3.2`: 기타 정리(`thinking_effort`, 어댑터 테스트, [`SessionPhase`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/types.ts#L94-L101) 문서화) 및 `2.3.2` 버전·문서 동기화 — 완료 (`4adbc2a`)

---

## Turn 3~5 `[CR 완료 보고]` 블록

```text
[CR 완료 보고]
- CR: CR-02 (0-Token 드라이버 브리핑 buildDriverBriefing)
- 커밋: a85576642ff9673999044520e19579e7d06cb8a9
- 버전: 2.3.1 (최종 2.3.2는 T5.1에서 반영)
- 추가/변경 export: buildDriverBriefing(input: { db, projectRoot, sessionId, maxChars?, locale? }): string
- 테스트: node --no-warnings --test tests/driver-briefing.test.ts (4 pass / 0 fail)
- 문서와 다른 점 / 결정 사항: 7개 섹션 조합 후 maxChars(기본 6,000자) 초과 시 5번(최근 완료 태스크 요약) -> 6번(summary.md) -> 3번(progressBoard) 순서로 절삭하고 "…(truncated)" 접미사를 부여한 뒤 redactSecrets 적용.
- 알려진 한계: 없음
```

```text
[CR 완료 보고]
- CR: CR-09 (output.log / prompt.md 수명 관리 및 DB 기반 프롬프트 재구성)
- 커밋: 920dad2ba2f04e2100765e2a4f7cde7688d13051
- 버전: 2.3.1 (최종 2.3.2는 T5.1에서 반영)
- 추가/변경 export: finalizeSubagentArtifacts(input: { projectRoot, sessionId, subSessionId, keep?: "none" | "tail" }): void, buildPromptForTask, SubagentLogRecord.artifactsPurged
- 테스트: node --no-warnings --test tests/artifact-lifecycle.test.ts (2 pass / 0 fail)
- 문서와 다른 점 / 결정 사항: 종결 상태(done/failed) 도달 직후 prompt.md 및 output.log를 삭제하고(verifying/merge_conflict/escalated 상태에서는 보존), retry/fallback 시 tasks 또는 debates 테이블에서 프롬프트를 재구성하도록 구현.
- 알려진 한계: 없음
```

```text
[CR 완료 보고]
- CR: CR-12 (고아 태스크 복구 recoverOrphanedTasks 및 원자적 점유 tryClaimTask)
- 커밋: 3ea53dca6623fe6307ea21388b655c40698652bf
- 버전: 2.3.1 (최종 2.3.2는 T5.1에서 반영)
- 추가/변경 export: recoverOrphanedTasks(input: { db, projectRoot, sessionId?, now? }), SqliteDriver.tryClaimTask(sessionId, taskId), SubagentSessionMeta.{dispatchMode, ownerPid, exitCode}
- 테스트: node --no-warnings --test tests/orphan-recovery.test.ts (3 pass / 0 fail)
- 문서와 다른 점 / 결정 사항: parallel_spawn/control_action/debate 태스크는 pid와 ownerPid가 모두 죽었을 때 failed(reason='orphaned')로 복구하되 Worktree는 보존하고, createTaskWorktree 재호출 시 기존 Worktree/브랜치를 안전하게 정리 후 재생성하도록 보완. claim_only는 자동 실패 처리하지 않으며 레거시 메타는 24시간 TTL 적용.
- 알려진 한계: 없음
```

```text
[CR 완료 보고]
- CR: CR-03 (runDriverTurn GUI 헤드리스 드라이버 실행 및 공통 실행부 분리)
- 커밋: 99e56709b3de8020220354eb811104c92cd34d3d
- 버전: 2.3.1 (최종 2.3.2는 T5.1에서 반영)
- 추가/변경 export: runDriverTurn(input): Promise<DriverRunResult>, type DriverRunResult, executeHarnessProcess
- 테스트: node --no-warnings --test tests/driver-runner.test.ts tests/spawner.test.ts (6 pass / 0 fail)
- 문서와 다른 점 / 결정 사항: spawnSubagent 내부 실행 로직을 executeHarnessProcess로 분리하여 재사용. 프로세스 내 Set + runs/*/meta.json(status=running & 살아있는 pid) 이중 검사로 DRIVER_BUSY 차단, 첫 실행 시 자동 브리핑 주입 및 markDriverBriefingInjected 기록, 종료 즉시 output.log 삭제 및 드라이버당 최신 50개 run 보존.
- 알려진 한계: 없음
```

```text
[CR 완료 보고]
- CR: CR-04 (훅 자동 연결 제거, ASD_DRIVER_ID 처리, linkHarnessSessionToAsdSession 위임 및 MCP 부착 규칙)
- 커밋: 2d6f19e2744795379d1068c5b65b78044f518dfb
- 버전: 2.3.1 (최종 2.3.2는 T5.1에서 반영)
- 추가/변경 export: linkHarnessSessionToAsdSession(options /* + source?, now? */)
- 테스트: node --no-warnings --test tests/driver-hooks.test.ts (3 pass / 0 fail)
- 문서와 다른 점 / 결정 사항: 일반 대화 훅(ASD_DRIVER_ID 없음)에서 자동 linkHarnessSessionToAsdSession 호출을 제거하여 무관한 대화가 ASD 세션을 덮어쓰지 않도록 수정. ASD_DRIVER_ID가 있을 때만 해당 드라이버의 harness_session_id가 null이면 setDriverHarnessSessionId로 바인딩. cli-recent.json 추정은 updatedAt이 10분 이내인 항목만 허용.
- 알려진 한계: 없음
```

```text
[CR 완료 보고]
- CR: CR-07 (LIGHT 롤백 범위 축소 rollbackLightChanges files 옵션 및 untouchedFiles 보존)
- 커밋: 92c272e23068d2fd82a96853ae2c233695be, c6a08aa70e92ec4d569152b6189eec6c16c2e48f
- 버전: 2.3.1 (최종 2.3.2는 T5.1에서 반영)
- 추가/변경 export: rollbackLightChanges(projectRoot, options?: { files?: string[] }), VerifyTaskResult.untouchedFiles, rejectPendingTask 반환값 untouchedFiles
- 테스트: node --no-warnings --test tests/light-rollback.test.ts tests/workspace-worktree.test.ts (15 pass / 0 fail)
- 문서와 다른 점 / 결정 사항: LIGHT 검증 실패(경계 위반 및 테스트 실패 모두)와 LIGHT 반려(rejectPendingTask) 시 allowedFiles 글롭에 매칭되는 파일(scopedFiles)만 롤백하고, 범위 밖 파일은 삭제하지 않고 untouchedFiles 배열로 반환하도록 결정(사용자 미커밋 작업 손실 방지).
- 알려진 한계: 없음
```

```text
[CR 완료 보고]
- CR: CR-13 (서브에이전트 Resume 의미 재정의 및 tasks.follow_up_of 추가)
- 커밋: 7b4bae4eb2131b6a2e98b4f224593a25ad65aee8
- 버전: 2.3.1 (최종 2.3.2는 T5.1에서 반영)
- 추가/변경 export: runSubagentControlAction 반환값 { taskId?, followUpTaskId? }, TaskRow.follow_up_of, TaskInput.followUpOf, ParsedPlanTask.followUpOf
- 테스트: node --no-warnings --test tests/subagent-resume.test.ts (2 pass / 0 fail)
- 문서와 다른 점 / 결정 사항: running 태스크는 TASK_RUNNING, harness 불일치는 RESUME_HARNESS_MISMATCH, 세션 ID 부재는 NO_HARNESS_SESSION 에러 반환. done 태스크 resume 시 동일 Turn의 다음 번호 T<turn>.<n>으로 후속 태스크(follow_up_of = 원본 ID, depends_on = [원본 ID])를 자동 생성하여 Worktree 격리 실행 및 검증 게이트를 거치도록 구현. PLAN.md에 '- FollowUpOf: <id>' 인덴트 라인으로 왕복 보존.
- 알려진 한계: 없음
```

```text
[CR 완료 보고]
- CR: CR-17 (기타 정리 및 v2.3.2 릴리즈)
- 커밋: 4adbc2a396180927bd8569aad6477f5506abdd89
- 버전: 2.3.2
- 추가/변경 export: ASD_VERSION ("2.3.2"), TaskInput.thinkingEffort, TaskRow.thinking_effort (DDL/마이그레이션 포함), 부록 B 전체 심볼 src/index.ts export 검증
- 테스트: node --no-warnings --test tests/adapters-resume.test.ts (2 pass / 0 fail), 전체 npm test (304 pass / 0 fail)
- 문서와 다른 점 / 결정 사항: tasks.thinking_effort 컬럼을 DDL 및 자동 마이그레이션에 정식 추가하여 TaskRow 타입 및 server.ts 참조와 정합성 확보. SessionPhase('planning' | 'running' | 'paused' | 'done') 전이 시점을 src/core/types.ts 및 README.md에 문서화.
- 알려진 한계: 없음
```

---

## 부록 A. 확인 결과 기록 (코어 담당 작성 완료본)

| 항목 | 관련 CR | 결과 | 확인 방법/근거 | 일자 |
|---|---|---|---|---|
| 하네스별 헤드리스 모드에서 ASD MCP 로드 여부 | CR-03 | `asd sync`로 글로벌 설정(`~/.claude.json`, `~/.config/opencode/opencode.json`, `~/.codex/config.toml`, `~/.gemini/antigravity/mcp_config.json`, `~/.cursor/mcp.json`)에 등록된 `asd` MCP 서버가 헤드리스 실행 시에도 동일하게 로드됨 | 각 어댑터 글로벌 설정 타겟 및 [`installer.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/adapters/installer.ts) 검증 | 2026-11-01 |
| 하네스별 헤드리스 모드에서 훅 실행 여부 | CR-03/04 | 헤드리스 실행 시에도 글로벌 훅이 실행되며, `ASD_DRIVER_ID` 환경변수가 주입된 경우 [`src/cli/index.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/index.ts#L1068-L1119) 훅 경로와 [`runDriverTurn`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L549-L779) 출력 추출 경로 양쪽에서 멱등하게 `setDriverHarnessSessionId` 호출 | [`tests/driver-hooks.test.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/tests/driver-hooks.test.ts), [`tests/driver-runner.test.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/tests/driver-runner.test.ts) | 2026-11-01 |
| claude 트랜스크립트 경로 인코딩·스키마 | CR-10 | `~/.claude/projects/<projectRoot의 :/\ 등을 -로 치환>/<sessionId>.jsonl` 및 `projects/*/<sessionId>.jsonl` 폴백 지원, `{ type: "user" \| "assistant", message: { role, content } }` 파싱 | [`src/core/transcripts.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts), [`tests/transcripts.test.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/tests/transcripts.test.ts) | 2026-11-01 |
| codex rollout 파일명·스키마 | CR-10 | `~/.codex/sessions/**/rollout-*<threadId>*.jsonl` 탐색, `response_item` (`payload.type === "message"`, `role`, `content`) 및 `function_call` 추출 | [`src/core/transcripts.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts), [`tests/transcripts.test.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/tests/transcripts.test.ts) | 2026-11-01 |
| opencode.db 스키마 | CR-10 | `~/.local/share/opencode/opencode.db` (`node:sqlite` `readOnly: true` + `PRAGMA busy_timeout = 1000`)의 `message`/`part` 테이블 조회 및 `storage/message/<sessionId>/*.json` 파일 폴백 지원 | [`src/core/transcripts.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts), [`tests/transcripts.test.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/tests/transcripts.test.ts) | 2026-11-01 |
| cursor 트랜스크립트 위치 | CR-10 | 로컬 안정 경로 미확정으로 `locateHarnessTranscript`는 `null`, `readHarnessTranscript`는 `{ found: false, error: "unsupported", messages: [], truncated: false }` 반환 | [`src/core/transcripts.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts), [`tests/transcripts.test.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/tests/transcripts.test.ts) | 2026-11-01 |
| 하네스별 헤드리스 실행 기록 보존 여부 | CR-10 | `claude -p`, `codex exec`, `opencode run`, `agy -p`는 각 하네스 로컬 저장소에 세션 로그를 남기며 종료 시 `meta.json`에 `harnessSessionId`가 기록됨(`cursor`는 `error: "unsupported"` 안내) | [`src/core/transcripts.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts) | 2026-11-01 |
| 태스크 점유 원자성 | CR-12 | [`SqliteDriver.tryClaimTask`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L711-L720)가 `withImmediateTx` 안에서 `UPDATE tasks SET status = 'running' WHERE ... AND status IN ('pending', 'escalated', 'failed')`의 `changes > 0`을 확인하여 동시 디스패치 시 중복 스폰 원천 차단 | [`tests/orphan-recovery.test.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/tests/orphan-recovery.test.ts) | 2026-11-01 |
| 경계 위반 시 LIGHT 롤백 방식 결정 | CR-07 | [`verifyAndCommitLightTask`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L853-L980) 및 [`rejectPendingTask`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L1557-L1614)에서 `allowedFiles` 매칭 파일(`scopedFiles`)만 롤백하고 범위 밖 파일은 보존하여 `untouchedFiles` 및 `violations`로 반환 | [`tests/light-rollback.test.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/tests/light-rollback.test.ts) | 2026-11-01 |
| 커밋된 변경의 경계 검사 방식 결정 | CR-08 | [`getCommittedWorktreeChanges`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/workspace.ts#L520-L560)에서 `git diff --name-only <merge-base> <wtHead>` ∩ `git diff --name-only <mainHead> <wtHead>` 교집합을 사용해 메인 브랜치 병합으로 유입된 파일은 위반에서 제외하고 실제 반영될 커밋 변경만 검사 | [`tests/workspace-worktree.test.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/tests/workspace-worktree.test.ts) | 2026-11-01 |
| `getLatestSession` 의존 동작 처리 방침 | CR-04 | 훅의 자동 세션 덮어쓰기는 완전히 제거했으며, `asd status`/Stop 훅 등 CLI 기본 세션 조회는 전경 세션([`getForegroundSessionId`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L108-L125))과 호환되도록 유지하되 명시적 `--session` 및 전경 전환([`setForegroundSession`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/render.ts#L636-L677))을 제공 | [`tests/driver-hooks.test.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/tests/driver-hooks.test.ts), [`tests/foreground-session.test.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/tests/foreground-session.test.ts) | 2026-11-01 |
