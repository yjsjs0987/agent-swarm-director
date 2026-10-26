/**
 * Tests for src/core/render.ts
 *
 * Verifies:
 * 1. Atomic PLAN.md write and concurrency (no corruption under concurrent writes).
 * 2. Manual edit round-trip (syncPlanFromMd on inline format preserving turn and acceptance).
 * 3. parsePlanMd tolerance for bracketed variants, trailing hint/files, and malformed lines.
 * 4. renderProgressBoard output formatting and progress calculations.
 * 5. renderSessionSummaryMd with secret redaction.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteDriver } from "../src/core/db.ts";
import type { TaskInput, TaskRow } from "../src/core/db.ts";
import {
  TASK_LINE_REGEX,
  parsePlanMd,
  renderPlanMd,
  renderProgressBoard,
  renderSessionSummaryMd,
  syncPlanFromMd,
} from "../src/core/render.ts";

// LIFO cleanup registry
const cleanups: Array<() => void> = [];
after(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      // Ignore cleanup error
    }
  }
  cleanups.length = 0;
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeDriver(): SqliteDriver {
  const dir = tempDir("asd-render-db-");
  const drv = new SqliteDriver(path.join(dir, "core.db"));
  cleanups.push(() => drv.close());
  return drv;
}

function makeSession(drv: SqliteDriver, rootDir: string, sessionId = "s-render-1") {
  return drv.createOrGetSession({
    sessionId,
    projectRoot: rootDir,
    mainHarness: "opencode",
    mainPid: 9999,
    baseSha: "base123",
  });
}

// ============================================================================
// 1. TASK_LINE_REGEX and parsePlanMd
// ============================================================================

test("TASK_LINE_REGEX matches ARCHITECTURE_PLAN.md standard inline format", () => {
  const line =
    "- [ ] **T1.1** [Track: LIGHT | Role: worker | Cat: general | Diff: medium]: 로그인 API 구현 (Files: src/auth.ts | Hint: src/auth.ts:10-40)";
  const match = line.match(TASK_LINE_REGEX);
  assert.ok(match, "Standard line must match TASK_LINE_REGEX");
  assert.equal(match![1], " ");
  assert.equal(match![2], "T1.1");
  assert.equal(match![3], "1");
  assert.equal(match![5], "LIGHT");
  assert.equal(match![6], "worker");
  assert.equal(match![7], "general");
  assert.equal(match![8], "medium");
  assert.equal(match![10], "로그인 API 구현");
  assert.equal(match![11], "src/auth.ts");
  assert.equal(match![12], "src/auth.ts:10-40");
});

test("parsePlanMd: parses inline format, derives turn from heading & prefix, extracts files/hint", () => {
  const md = `# Execution Plan

## Turn 1
- [ ] **T1.1** [Track: LIGHT | Role: worker | Cat: general | Diff: medium]: SQLite 드라이버 구현 (Files: src/db.ts, tests/db.test.ts | Hint: src/db.ts:1-50 BEGIN IMMEDIATE)
  - Acceptance: 모든 트랜잭션은 BEGIN IMMEDIATE 사용
  - DependsOn: T0.1, T0.2
- [x] **T1.2** [Track: HEAVY | Role: builder | Cat: visual-ui | Diff: high]: 로그인 폼 UI (Files: src/ui/login.tsx)
  - Acceptance: 반응형 레이아웃 필수

## Turn 2
- [~] **T2.1** [Track: LIGHT | Role: verifier | Cat: writing | Diff: low]: 검증 리포트 작성
`;

  const tasks = parsePlanMd(md);
  assert.equal(tasks.length, 3);

  // Task 1
  assert.equal(tasks[0]!.taskId, "T1.1");
  assert.equal(tasks[0]!.turn, 1);
  assert.equal(tasks[0]!.track, "LIGHT");
  assert.equal(tasks[0]!.role, "worker");
  assert.equal(tasks[0]!.category, "general");
  assert.equal(tasks[0]!.difficulty, "medium");
  assert.equal(tasks[0]!.status, "pending");
  assert.equal(tasks[0]!.title, "SQLite 드라이버 구현");
  assert.deepEqual(tasks[0]!.targetFiles, ["src/db.ts", "tests/db.test.ts"]);
  assert.equal(tasks[0]!.contextHint, "src/db.ts:1-50 BEGIN IMMEDIATE");
  assert.equal(tasks[0]!.acceptance, "모든 트랜잭션은 BEGIN IMMEDIATE 사용");
  assert.deepEqual(tasks[0]!.dependsOn, ["T0.1", "T0.2"]);

  // Task 2
  assert.equal(tasks[1]!.taskId, "T1.2");
  assert.equal(tasks[1]!.turn, 1);
  assert.equal(tasks[1]!.status, "done");
  assert.equal(tasks[1]!.track, "HEAVY");
  assert.equal(tasks[1]!.role, "builder");
  assert.equal(tasks[1]!.category, "visual-ui");
  assert.equal(tasks[1]!.difficulty, "high");
  assert.deepEqual(tasks[1]!.targetFiles, ["src/ui/login.tsx"]);
  assert.equal(tasks[1]!.contextHint, null);
  assert.equal(tasks[1]!.acceptance, "반응형 레이아웃 필수");

  // Task 3
  assert.equal(tasks[2]!.taskId, "T2.1");
  assert.equal(tasks[2]!.turn, 2);
  assert.equal(tasks[2]!.status, "failed");
  assert.equal(tasks[2]!.track, "LIGHT");
  assert.equal(tasks[2]!.role, "verifier");
  assert.equal(tasks[2]!.category, "writing");
  assert.equal(tasks[2]!.difficulty, "low");
});

test("parsePlanMd: tolerates bracketed [Turn: 1 | ... | Files: ...] variant", () => {
  const md = `
- [ ] **T1.1** [Turn: 1 | Track: HEAVY | Role: builder | Cat: design | Diff: critical | Files: src/theme.ts, src/styles.css]: 글로벌 테마 시스템 구축 (Hint: CSS 변수 사용)
  - Acceptance: 다크모드 지원
`;

  const tasks = parsePlanMd(md);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.taskId, "T1.1");
  assert.equal(tasks[0]!.turn, 1);
  assert.equal(tasks[0]!.track, "HEAVY");
  assert.equal(tasks[0]!.role, "builder");
  assert.equal(tasks[0]!.category, "design");
  assert.equal(tasks[0]!.difficulty, "critical");
  assert.deepEqual(tasks[0]!.targetFiles, ["src/theme.ts", "src/styles.css"]);
  assert.equal(tasks[0]!.contextHint, "CSS 변수 사용");
  assert.equal(tasks[0]!.acceptance, "다크모드 지원");
});

test("parsePlanMd: tolerates malformed markdown and arbitrary non-task lines without crashing", () => {
  const md = `
# Random Header
Some explanation text here.
> Alert blockquote
- Normal unordered list item 1
- Normal unordered list item 2
- [ ] Broken task without brackets or colons
- [?] Unknown marker **T1.1** [Track: LIGHT]: foo
- [ ] **T1.1** [Track: LIGHT | Role: worker | Cat: general | Diff: medium]: 유효한 태스크
<!-- HTML comment -->
\`\`\`ts
const x = 1;
\`\`\`
`;

  const tasks = parsePlanMd(md);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.taskId, "T1.1");
  assert.equal(tasks[0]!.title, "유효한 태스크");
});

// ============================================================================
// 2. renderPlanMd & Concurrency / Atomic Write
// ============================================================================

test("renderPlanMd: generates inline format grouped by turn with acceptance and dependsOn", () => {
  const dir = tempDir("asd-plan-render-");
  const planPath = path.join(dir, "PLAN.md");

  const session = {
    project_root: dir,
    session_id: "s1",
  };

  const tasks: TaskInput[] = [
    {
      taskId: "T1.1",
      turn: 1,
      title: "DB 초기화",
      track: "LIGHT",
      role: "worker",
      category: "general",
      difficulty: "medium",
      targetFiles: ["src/db.ts"],
      contextHint: "WAL 필수",
      acceptance: "WAL 모드 활성화",
    },
    {
      taskId: "T1.2",
      turn: 1,
      title: "인증 미들웨어",
      track: "HEAVY",
      role: "builder",
      category: "general",
      difficulty: "high",
      dependsOn: ["T1.1"],
      targetFiles: ["src/auth.ts"],
    },
    {
      taskId: "T2.1",
      turn: 2,
      title: "통합 테스트",
      track: "LIGHT",
      role: "verifier",
      category: "writing",
      difficulty: "low",
    },
  ];

  const rendered = renderPlanMd(session, tasks, planPath);
  assert.ok(fs.existsSync(planPath), "PLAN.md should be written");
  assert.ok(rendered.includes("## Turn 1"));
  assert.ok(rendered.includes("## Turn 2"));
  assert.ok(
    rendered.includes(
      "- [ ] **T1.1** [Track: LIGHT | Role: worker | Cat: general | Diff: medium]: DB 초기화 (Files: src/db.ts | Hint: WAL 필수)"
    )
  );
  assert.ok(rendered.includes("  - Acceptance: WAL 모드 활성화"));
  assert.ok(rendered.includes("  - DependsOn: T1.1"));

  // Verify round-trip parsing matches input exactly
  const parsed = parsePlanMd(rendered);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]!.taskId, "T1.1");
  assert.equal(parsed[0]!.turn, 1);
  assert.equal(parsed[0]!.acceptance, "WAL 모드 활성화");
  assert.deepEqual(parsed[1]!.dependsOn, ["T1.1"]);
});

test("atomic write concurrency: concurrent renderPlanMd calls write without corruption", async () => {
  const dir = tempDir("asd-atomic-write-");
  const planPath = path.join(dir, "PLAN.md");
  const session = { project_root: dir, session_id: "concurrent-session" };

  // 20 concurrent writers
  const writers = Array.from({ length: 20 }, (_, idx) => {
    const tasks: TaskInput[] = [
      {
        taskId: `T1.${idx}`,
        turn: 1,
        title: `동시 작업 ${idx}`,
        track: idx % 2 === 0 ? "LIGHT" : "HEAVY",
        role: "worker",
        category: "general",
        difficulty: "medium",
        targetFiles: [`src/worker_${idx}.ts`],
        contextHint: `idx=${idx}`,
        acceptance: `테스크 ${idx} 통과`,
      },
    ];
    return () => renderPlanMd(session, tasks, planPath);
  });

  // Run all simultaneously
  await Promise.all(writers.map((fn) => Promise.resolve().then(fn)));

  // File exists and is valid markdown that parses without error
  assert.ok(fs.existsSync(planPath));
  const finalContent = fs.readFileSync(planPath, "utf8");
  assert.ok(finalContent.includes("## Turn 1"));
  const parsed = parsePlanMd(finalContent);
  assert.equal(parsed.length, 1);
  assert.ok(parsed[0]!.taskId.startsWith("T1."));

  // Check no leftover .tmp files
  const files = fs.readdirSync(dir);
  const tmpFiles = files.filter((f) => f.includes(".tmp"));
  assert.equal(tmpFiles.length, 0, "No dangling temporary files should remain");
});

// ============================================================================
// 3. syncPlanFromMd: DB Round-Trip Reconciliation
// ============================================================================

test("syncPlanFromMd: reconciles manual edits (checkbox, title, track, files, acceptance, new task) and increments state_version", () => {
  const drv = makeDriver();
  const dir = tempDir("asd-sync-test-");
  const planPath = path.join(dir, "PLAN.md");
  const session = makeSession(drv, dir, "sync-session-1");

  // Initial tasks in DB
  const initialTasks: TaskInput[] = [
    {
      taskId: "T1.1",
      turn: 1,
      title: "초기 DB 스키마",
      track: "LIGHT",
      role: "worker",
      category: "general",
      difficulty: "medium",
      targetFiles: ["src/db.ts"],
      contextHint: "초기 힌트",
      acceptance: "초기 수용 기준",
    },
    {
      taskId: "T1.2",
      turn: 1,
      title: "인증 모듈",
      track: "LIGHT",
      role: "worker",
      category: "general",
      difficulty: "low",
      targetFiles: ["src/auth.ts"],
    },
  ];
  drv.upsertTasks(session.session_id, initialTasks);
  const initialVersion = drv.getSession(session.session_id)!.state_version;

  // Render to PLAN.md
  renderPlanMd(session, drv.getSessionTasks(session.session_id), planPath);

  // Simulate manual edits by a human user in PLAN.md:
  // 1. T1.1: check box [x], update title, update acceptance
  // 2. T1.2: switch to HEAVY track, update files
  // 3. T2.1: add completely new task line
  const editedMarkdown = `# ASD PLAN

Session: sync-session-1

## Turn 1
- [x] **T1.1** [Track: LIGHT | Role: worker | Cat: general | Diff: medium]: DB 스키마 완성본 (Files: src/db.ts | Hint: 초기 힌트)
  - Acceptance: 수정된 수용 기준
- [ ] **T1.2** [Track: HEAVY | Role: builder | Cat: general | Diff: high]: 인증 모듈 강화 (Files: src/auth.ts, src/jwt.ts)
  - DependsOn: T1.1

## Turn 2
- [ ] **T2.1** [Track: HEAVY | Role: architect | Cat: design | Diff: critical]: 마이크로서비스 연동 (Files: src/gateway.ts)
  - Acceptance: 무중단 배포 지원
`;

  fs.writeFileSync(planPath, editedMarkdown, "utf8");

  // Reconcile back into DB
  const parsed = syncPlanFromMd(drv, session.session_id, planPath);
  assert.equal(parsed.length, 3);

  // Check DB state
  const updatedTasks = drv.getSessionTasks(session.session_id);
  assert.equal(updatedTasks.length, 3);

  // T1.1 check
  const t1 = drv.getTask(session.session_id, "T1.1")!;
  assert.equal(t1.status, "done", "T1.1 status should be updated to done");
  assert.equal(t1.title, "DB 스키마 완성본");
  assert.equal(t1.acceptance, "수정된 수용 기준");

  // T1.2 check
  const t2 = drv.getTask(session.session_id, "T1.2")!;
  assert.equal(t2.track, "HEAVY", "T1.2 track should be updated to HEAVY");
  assert.equal(t2.role, "builder");
  assert.equal(t2.difficulty, "high");
  assert.equal(t2.title, "인증 모듈 강화");
  assert.deepEqual(JSON.parse(t2.target_files_json), ["src/auth.ts", "src/jwt.ts"]);
  assert.deepEqual(JSON.parse(t2.depends_on_json), ["T1.1"]);

  // T2.1 check (newly added task)
  const t3 = drv.getTask(session.session_id, "T2.1")!;
  assert.equal(t3.turn, 2);
  assert.equal(t3.role, "architect");
  assert.equal(t3.category, "design");
  assert.equal(t3.difficulty, "critical");
  assert.equal(t3.status, "pending");
  assert.equal(t3.acceptance, "무중단 배포 지원");

  // Verify sessions.state_version was incremented
  const updatedSession = drv.getSession(session.session_id)!;
  assert.equal(
    updatedSession.state_version,
    initialVersion + 1,
    "state_version must be incremented by 1"
  );
});

// ============================================================================
// 4. renderProgressBoard
// ============================================================================

test("renderProgressBoard: generates live TODO board with Turn completion, percent, models, and durations", () => {
  const tasks: TaskRow[] = [
    {
      task_id: "T1.1",
      session_id: "s1",
      turn: 1,
      title: "DB 스키마 작성",
      track: "LIGHT",
      role: "worker",
      category: "general",
      difficulty: "medium",
      status: "done",
      attempts: 0,
      assigned_harness: "opencode",
      assigned_model: "glm-5",
      depends_on_json: "[]",
      target_files_json: "[]",
      context_hint: null,
      acceptance: null,
      verify_cmd: null,
      done_claim_json: null,
      worktree_path: null,
      sub_session_id: null,
      commit_sha: "a1b2c3d4e5f",
      duration_ms: 12400,
    },
    {
      task_id: "T1.2",
      session_id: "s1",
      turn: 1,
      title: "인증 미들웨어 구현",
      track: "HEAVY",
      role: "builder",
      category: "general",
      difficulty: "high",
      status: "done",
      attempts: 0,
      assigned_harness: "codex",
      assigned_model: "gpt-5-codex",
      depends_on_json: "[]",
      target_files_json: "[]",
      context_hint: null,
      acceptance: null,
      verify_cmd: null,
      done_claim_json: null,
      worktree_path: null,
      sub_session_id: null,
      commit_sha: "e4f5g6h7i8j",
      duration_ms: 18100,
    },
    {
      task_id: "T2.1",
      session_id: "s1",
      turn: 2,
      title: "통합 라우터 연결",
      track: "LIGHT",
      role: "worker",
      category: "general",
      difficulty: "medium",
      status: "pending",
      attempts: 0,
      assigned_harness: "claude-code",
      assigned_model: "claude-sonnet-4-6",
      depends_on_json: "[]",
      target_files_json: "[]",
      context_hint: null,
      acceptance: null,
      verify_cmd: null,
      done_claim_json: null,
      worktree_path: null,
      sub_session_id: null,
      commit_sha: null,
      duration_ms: null,
    },
  ];

  const board = renderProgressBoard(null, tasks);

  // 1. Header
  assert.ok(
    board.includes("### 📊 ASD TODO 진행 현황 [Turn 1/2 완료 | 진행률: 2/3 (67%)]"),
    `Board header mismatch: ${board}`
  );

  // 2. Task 1 (Turn 1, @oc/glm-5, 12.4s, commit sha)
  assert.ok(
    board.includes(
      "- [x] **T1.1** (Turn 1, `@oc/glm-5`, 12.4s): DB 스키마 작성 — 완료 (`a1b2c3d`)"
    ),
    `T1.1 line mismatch: ${board}`
  );

  // 3. Task 2 (Turn 1, @cx/gpt-5-codex, 18.1s, commit sha)
  assert.ok(
    board.includes(
      "- [x] **T1.2** (Turn 1, `@cx/gpt-5-codex`, 18.1s): 인증 미들웨어 구현 — 완료 (`e4f5g6h`)"
    ),
    `T1.2 line mismatch: ${board}`
  );

  // 4. Task 3 (Turn 2, @cc/claude-sonnet-4-6, 대기중)
  assert.ok(
    board.includes(
      "- [ ] **T2.1** (Turn 2, `@cc/claude-sonnet-4-6`, 대기중): 통합 라우터 연결"
    ),
    `T2.1 line mismatch: ${board}`
  );
});

// ============================================================================
// 5. renderSessionSummaryMd & Secret Redaction
// ============================================================================

test("renderSessionSummaryMd: writes summary with secret redaction", () => {
  const dir = tempDir("asd-summary-test-");
  const summaryPath = path.join(dir, "summary.md");

  const session = {
    session_id: "test-session-secret",
    project_root: dir,
    main_harness: "opencode",
    phase: "done",
    state_version: 5,
    base_sha: "head999",
    created_at: 1730000000000,
    updated_at: 1730000050000,
  };

  const tasks: TaskRow[] = [
    {
      task_id: "T1.1",
      session_id: "test-session-secret",
      turn: 1,
      title: "AWS S3 클라이언트 구현",
      track: "LIGHT",
      role: "worker",
      category: "general",
      difficulty: "medium",
      status: "done",
      attempts: 0,
      assigned_harness: "opencode",
      assigned_model: "glm-5",
      depends_on_json: "[]",
      target_files_json: '["src/s3.ts"]',
      context_hint: "AKIAIOSFODNN7EXAMPLE 사용 주의",
      acceptance: "sk-ant-api03-abcdef1234567890abcdef 토큰 인증 검증",
      verify_cmd: null,
      done_claim_json: JSON.stringify({
        summary: "S3 연동 완료. password='SuperSecretPassword123'",
        changed_files: ["src/s3.ts"],
        key_decisions: ["AWS 키 AKIA1111222233334444 설정"],
        risks: [],
      }),
      worktree_path: null,
      sub_session_id: null,
      commit_sha: "cafebabe",
      duration_ms: 5500,
    },
  ];

  const debates = [
    {
      debate_id: "D1",
      session_id: "test-session-secret",
      task_id: "T1.1",
      topic: "보안 토큰 sk-1234567890123456 관리 방안",
      status: "done",
      insight_verdict_json: JSON.stringify({
        verdict: "APPROVE",
        decisions: ["토큰은 환경변수로 관리: api_key=MySecretApiKey999"],
        hard_constraints: ["AWS ASIA9999888877776666 노출 금지"],
      }),
    },
  ];

  const output = renderSessionSummaryMd(session, tasks, debates, summaryPath);

  assert.ok(fs.existsSync(summaryPath), "summary.md should be written");

  // Verify all secrets are REDACTED
  assert.ok(output.includes("[REDACTED]"));
  assert.ok(!output.includes("AKIAIOSFODNN7EXAMPLE"), "AKIA must be redacted");
  assert.ok(!output.includes("AKIA1111222233334444"), "AKIA must be redacted");
  assert.ok(!output.includes("ASIA9999888877776666"), "ASIA must be redacted");
  assert.ok(!output.includes("sk-ant-api03-abcdef1234567890abcdef"), "sk- key must be redacted");
  assert.ok(!output.includes("sk-1234567890123456"), "sk- key must be redacted");
  assert.ok(!output.includes("SuperSecretPassword123"), "password must be redacted");
  assert.ok(!output.includes("MySecretApiKey999"), "api_key must be redacted");

  // Verify structure
  assert.ok(output.includes("# ASD Session Summary: test-session-secret"));
  assert.ok(output.includes("## Session Overview"));
  assert.ok(output.includes("## Execution Statistics"));
  assert.ok(output.includes("## Tasks Detail"));
  assert.ok(output.includes("## Debates Detail"));
  assert.ok(output.includes("### T1.1: AWS S3 클라이언트 구현"));
  assert.ok(output.includes("### Debate D1:"));
});
