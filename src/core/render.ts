/**
 * ASD v2.2 Markdown Renderer & Parser.
 *
 * Implements:
 * - renderPlanMd: renders .asd/PLAN.md using ARCHITECTURE_PLAN.md inline format
 *   grouped by Turn with atomic write (temp file + renameSync).
 * - parsePlanMd: parses inline format and bracketed variant with tolerance for malformed lines.
 * - syncPlanFromMd: reconciles manual edits back into SQLite tasks and increments state_version.
 * - renderProgressBoard: produces live TODO progress board markdown.
 * - renderSessionSummaryMd: writes .asd/sessions/<sessionId>/summary.md with secret redaction.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readCachedUpdateNotice, resolveAsdPaths } from "./config.ts";
import { redactSecrets } from "./redact.ts";
import type {
  DebateInput,
  DebateRow,
  SessionRow,
  SqliteDriver,
  TaskInput,
  TaskRow,
} from "./db.ts";
import type {
  AgentRole,
  DifficultyTier,
  TaskStatus,
  TaskTrack,
} from "./types.ts";

// ============================================================================
// Standard Regex for PLAN.md task line
// ============================================================================

export const TASK_LINE_REGEX =
  /^- \[([ x~])\] \*\*(T(?:-)?(\d+)(?:\.\d+|-\d+)?)\*\* \[(?:Turn:\s*(\d+)\s*\|\s*)?Track:\s*(LIGHT|HEAVY)\s*\|\s*Role:\s*([a-z]+)\s*\|\s*Cat:\s*([a-z-]+)\s*\|\s*Diff:\s*([a-z]+)(?:\s*\|\s*Files:\s*([^\]]*))?\]:\s*(.+?)(?:\s*\(Files:\s*([^|)]*?)(?:\s*\|\s*Hint:\s*([^)]*))?\))?$/;

// ============================================================================
// Parsed Task Interface
// ============================================================================

export interface ParsedPlanTask {
  taskId: string;
  turn: number;
  title: string;
  track: TaskTrack;
  role: AgentRole;
  category: string;
  difficulty: DifficultyTier;
  status: TaskStatus;
  targetFiles: string[];
  contextHint: string | null;
  acceptance: string | null;
  dependsOn: string[];
}

// ============================================================================
// Atomic File Write Helper
// ============================================================================

/**
 * Atomically writes content to filePath using a temporary file in the same
 * directory and fs.renameSync. Ensures parent directories exist.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Windows file-locking retry / fallback
    try {
      fs.copyFileSync(tmpPath, filePath);
      fs.unlinkSync(tmpPath);
    } catch {
      throw err;
    }
  }
}

// ============================================================================
// 1. renderPlanMd
// ============================================================================

/**
 * Renders .asd/PLAN.md using ARCHITECTURE_PLAN.md inline format:
 * `- [ ] **T1.1** [Track: LIGHT | Role: worker | Cat: general | Diff: medium]: <title> (Files: ... | Hint: ...)`
 * grouped under `## Turn <N>` headings, with optional indented `- Acceptance: ...` and `- DependsOn: ...`
 * lines when present so DB round-trips never lose turn, acceptance, or depends_on.
 *
 * Status markers:
 * `[ ]` for pending / running / verifying
 * `[x]` for done
 * `[~]` for failed / escalated / merge_conflict
 *
 * Writes atomically via temp file + fs.renameSync.
 */
export function renderPlanMd(
  session: SessionRow | { project_root: string; session_id?: string },
  tasks: Array<TaskRow | TaskInput>,
  planMdPath?: string
): string {
  const lines: string[] = ["# ASD PLAN", ""];
  if (session.session_id) {
    lines.push(`Session: ${session.session_id}`, "");
  }

  // Group tasks by turn (defaulting to 1)
  const turnMap = new Map<number, Array<TaskRow | TaskInput>>();
  for (const t of tasks) {
    const turn = t.turn ?? 1;
    if (!turnMap.has(turn)) {
      turnMap.set(turn, []);
    }
    turnMap.get(turn)!.push(t);
  }

  const sortedTurns = Array.from(turnMap.keys()).sort((a, b) => a - b);
  if (sortedTurns.length === 0) {
    sortedTurns.push(1);
  }

  for (const turn of sortedTurns) {
    lines.push(`## Turn ${turn}`);
    const turnTasks = turnMap.get(turn) ?? [];

    for (const t of turnTasks) {
      const taskId = "task_id" in t ? t.task_id : t.taskId;
      const status: TaskStatus = "status" in t ? (t.status as TaskStatus) : "pending";

      let marker = " ";
      if (status === "done") {
        marker = "x";
      } else if (
        status === "failed" ||
        status === "escalated" ||
        status === "merge_conflict"
      ) {
        marker = "~";
      }

      const track = t.track ?? "LIGHT";
      const role = t.role ?? "worker";
      const category = t.category ?? "general";
      const difficulty = t.difficulty ?? "medium";
      const title = t.title;

      // Extract target files
      let files: string[] = [];
      if ("targetFiles" in t && Array.isArray(t.targetFiles)) {
        files = t.targetFiles;
      } else if ("target_files_json" in t && t.target_files_json) {
        try {
          files = JSON.parse(t.target_files_json);
        } catch {
          files = [];
        }
      }

      // Extract context hint
      const hint =
        ("contextHint" in t ? t.contextHint : (t as TaskRow).context_hint) ?? null;

      const filesPart =
        files.length > 0 ? `Files: ${files.join(", ")}` : "";
      const hintPart = hint ? `Hint: ${hint}` : "";

      let tail = "";
      if (filesPart && hintPart) {
        tail = ` (${filesPart} | ${hintPart})`;
      } else if (filesPart) {
        tail = ` (${filesPart})`;
      } else if (hintPart) {
        tail = ` (${hintPart})`;
      }

      lines.push(
        `- [${marker}] **${taskId}** [Track: ${track} | Role: ${role} | Cat: ${category} | Diff: ${difficulty}]: ${title}${tail}`
      );

      // Optional indented acceptance
      if (t.acceptance && t.acceptance.trim().length > 0) {
        lines.push(`  - Acceptance: ${t.acceptance.trim()}`);
      }

      // Optional indented dependsOn
      let deps: string[] = [];
      if ("dependsOn" in t && Array.isArray(t.dependsOn)) {
        deps = t.dependsOn;
      } else if ("depends_on_json" in t && t.depends_on_json) {
        try {
          deps = JSON.parse(t.depends_on_json);
        } catch {
          deps = [];
        }
      }

      if (deps.length > 0) {
        lines.push(`  - DependsOn: ${deps.join(", ")}`);
      }
    }
    lines.push("");
  }

  const content = lines.join("\n").trimEnd() + "\n";
  const targetPath =
    planMdPath ?? resolveAsdPaths(session.project_root).planMdPath;

  atomicWriteFileSync(targetPath, content);
  return content;
}

// ============================================================================
// 2. parsePlanMd
// ============================================================================

/**
 * Parses markdown text into an array of ParsedPlanTask.
 *
 * Supports:
 * - ARCHITECTURE_PLAN.md inline format (`TASK_LINE_REGEX`)
 * - Heading-derived turns (`## Turn <N>`) or taskId-derived turn prefix (`T<turn>.<seq>`)
 * - Trailing `(Files: ... | Hint: ...)` extraction
 * - Bracketed variant `[Turn: 1 | ... | Files: ...]`
 * - Optional indented `- Acceptance:` and `- DependsOn:` lines
 * - Tolerant to malformed lines and arbitrary markdown text without crashing
 */
export function parsePlanMd(markdownText: string): ParsedPlanTask[] {
  const lines = markdownText.split(/\r?\n/);
  const tasks: ParsedPlanTask[] = [];
  let currentTurn = 1;
  let currentTask: ParsedPlanTask | null = null;

  for (const line of lines) {
    // 1. Check for Turn heading
    const headingMatch = line.match(/^#{1,6}\s+Turn\s+(\d+)/i);
    if (headingMatch) {
      currentTurn = parseInt(headingMatch[1]!, 10);
      currentTask = null;
      continue;
    }

    // 2. Check for indented Acceptance / DependsOn under current task
    if (currentTask && /^\s{2,}-\s+/i.test(line)) {
      const acceptanceMatch = line.match(/^\s{2,}-\s*Acceptance:\s*(.*)$/i);
      if (acceptanceMatch) {
        currentTask.acceptance = acceptanceMatch[1]!.trim();
        continue;
      }
      const dependsMatch = line.match(
        /^\s{2,}-\s*Depends(?:On|\s*on):\s*(.*)$/i
      );
      if (dependsMatch) {
        const deps = dependsMatch[1]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        currentTask.dependsOn = deps;
        continue;
      }
    }

    // 3. Try standard TASK_LINE_REGEX
    const regexMatch = line.match(TASK_LINE_REGEX);
    if (regexMatch) {
      const marker = regexMatch[1]!;
      const taskId = regexMatch[2]!;
      const turnFromId = taskId.includes(".")
        ? parseInt(regexMatch[3]!, 10)
        : undefined;
      const turnFromBracket = regexMatch[4]
        ? parseInt(regexMatch[4], 10)
        : undefined;
      const track = (
        regexMatch[5]!.toUpperCase() === "HEAVY" ? "HEAVY" : "LIGHT"
      ) as TaskTrack;
      const role = regexMatch[6]!.toLowerCase() as AgentRole;
      const category = regexMatch[7]!.toLowerCase();
      const difficulty = regexMatch[8]!.toLowerCase() as DifficultyTier;
      const filesFromBracket = regexMatch[9]
        ? regexMatch[9]
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s && s.toLowerCase() !== "none")
        : [];
      let title = regexMatch[10]!.trim();
      const filesFromParens = regexMatch[11]
        ? regexMatch[11]
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s && s.toLowerCase() !== "none")
        : [];
      const hintFromParens = regexMatch[12] ? regexMatch[12].trim() : null;

      let targetFiles =
        filesFromParens.length > 0 ? filesFromParens : filesFromBracket;
      let contextHint = hintFromParens;

      // If trailing parens contained only Hint (no Files:), extract it from title
      const trailingParenMatch = title.match(/^(.*?)(?:\s*\((.*?)\))\s*$/);
      if (trailingParenMatch) {
        const candidateTitle = trailingParenMatch[1]!.trim();
        const parenInner = trailingParenMatch[2]!.trim();
        let matchedMeta = false;
        let extractedHint: string | null = null;
        const extractedFiles: string[] = [];

        for (const segment of parenInner.split("|")) {
          const s = segment.trim();
          const fMatch = s.match(/^Files:\s*(.*)$/i);
          if (fMatch) {
            matchedMeta = true;
            extractedFiles.push(
              ...fMatch[1]!
                .split(",")
                .map((x) => x.trim())
                .filter((x) => x && x.toLowerCase() !== "none")
            );
          }
          const hMatch = s.match(/^Hint:\s*(.*)$/i);
          if (hMatch) {
            matchedMeta = true;
            extractedHint = hMatch[1]!.trim();
          }
        }

        if (matchedMeta) {
          title = candidateTitle;
          if (extractedFiles.length > 0 && targetFiles.length === 0) {
            targetFiles = extractedFiles;
          }
          if (extractedHint) {
            contextHint = extractedHint;
          }
        }
      }

      const turn = turnFromBracket ?? currentTurn ?? turnFromId ?? 1;

      let status: TaskStatus = "pending";
      if (marker.toLowerCase() === "x") {
        status = "done";
      } else if (marker === "~") {
        status = "failed";
      }

      currentTask = {
        taskId,
        turn,
        title,
        track,
        role,
        category,
        difficulty,
        status,
        targetFiles,
        contextHint,
        acceptance: null,
        dependsOn: [],
      };
      tasks.push(currentTask);
      continue;
    }

    // 4. Flexible fallback parser (tolerates bracketed Turn/Files variants and slight syntax differences)
    const taskMatch = line.match(
      /^\s*-\s*\[([ x~X])\]\s+(?:\*\*)?([A-Za-z0-9_.-]+)(?:\*\*)?\s*\[(.*?)\]:\s*(.*)$/
    );
    if (taskMatch) {
      const marker = taskMatch[1]!;
      const taskId = taskMatch[2]!;
      const bracketContent = taskMatch[3]!;
      const rest = taskMatch[4]!.trim();

      let turn = currentTurn;
      const turnFromIdMatch = taskId.match(/^T(\d+)\./i);
      if (turnFromIdMatch) {
        turn = parseInt(turnFromIdMatch[1]!, 10);
      }

      let track: TaskTrack = "LIGHT";
      let role: AgentRole = "worker";
      let category = "general";
      let difficulty: DifficultyTier = "medium";
      let bracketFiles: string[] = [];

      for (const part of bracketContent.split("|")) {
        const colonIdx = part.indexOf(":");
        if (colonIdx === -1) continue;
        const key = part.slice(0, colonIdx).trim().toLowerCase();
        const val = part.slice(colonIdx + 1).trim();
        if (key === "turn") {
          const parsedTurn = parseInt(val, 10);
          if (!isNaN(parsedTurn)) turn = parsedTurn;
        } else if (key === "track") {
          track = val.toUpperCase() === "HEAVY" ? "HEAVY" : "LIGHT";
        } else if (key === "role") {
          role = val.toLowerCase() as AgentRole;
        } else if (key === "cat" || key === "category") {
          category = val.toLowerCase();
        } else if (key === "diff" || key === "difficulty") {
          difficulty = val.toLowerCase() as DifficultyTier;
        } else if (key === "files") {
          bracketFiles = val
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s && s.toLowerCase() !== "none");
        }
      }

      let title = rest;
      let targetFiles = bracketFiles;
      let contextHint: string | null = null;

      // Extract trailing parens e.g. (Files: ... | Hint: ...) or (Files: ...) or (Hint: ...)
      const parenMatch = rest.match(/^(.*?)(?:\s*\((.*?)\))\s*$/);
      if (parenMatch) {
        const candidateTitle = parenMatch[1]!.trim();
        const parenInner = parenMatch[2]!.trim();
        let matchedMeta = false;
        const parenFiles: string[] = [];

        for (const segment of parenInner.split("|")) {
          const s = segment.trim();
          const fMatch = s.match(/^Files:\s*(.*)$/i);
          if (fMatch) {
            matchedMeta = true;
            parenFiles.push(
              ...fMatch[1]!
                .split(",")
                .map((x) => x.trim())
                .filter((x) => x && x.toLowerCase() !== "none")
            );
          }
          const hMatch = s.match(/^Hint:\s*(.*)$/i);
          if (hMatch) {
            matchedMeta = true;
            contextHint = hMatch[1]!.trim();
          }
        }

        if (matchedMeta) {
          title = candidateTitle;
          if (parenFiles.length > 0) {
            targetFiles = parenFiles;
          }
        }
      }

      let status: TaskStatus = "pending";
      if (marker.toLowerCase() === "x") {
        status = "done";
      } else if (marker === "~") {
        status = "failed";
      }

      currentTask = {
        taskId,
        turn,
        title,
        track,
        role,
        category,
        difficulty,
        status,
        targetFiles,
        contextHint,
        acceptance: null,
        dependsOn: [],
      };
      tasks.push(currentTask);
      continue;
    }

    // Any other line: reset currentTask context
    currentTask = null;
  }

  return tasks;
}

// ============================================================================
// 3. syncPlanFromMd
// ============================================================================

/**
 * Reconciles manual user edits in .asd/PLAN.md back into the SQLite tasks table
 * and increments sessions.state_version.
 */
export function syncPlanFromMd(
  db: SqliteDriver,
  sessionId: string,
  planMdPath: string
): ParsedPlanTask[] {
  if (!fs.existsSync(planMdPath)) {
    throw new Error(`PLAN.md not found at ${planMdPath}`);
  }

  const content = fs.readFileSync(planMdPath, "utf8");
  const parsedTasks = parsePlanMd(content);

  db.withImmediateTx(() => {
    const session = db.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const existingTasks = db.getSessionTasks(sessionId);
    const existingMap = new Map<string, TaskRow>(
      existingTasks.map((t) => [t.task_id, t])
    );

    if (parsedTasks.length > 0) {
      const parsedIds = new Set(parsedTasks.map((t) => t.taskId));
      for (const existing of existingTasks) {
        if (!parsedIds.has(existing.task_id)) {
          db.deleteTask(sessionId, existing.task_id);
        }
      }
    }

    for (const parsed of parsedTasks) {
      const existing = existingMap.get(parsed.taskId);
      const taskInput: TaskInput = {
        taskId: parsed.taskId,
        turn: parsed.turn,
        title: parsed.title,
        track: parsed.track,
        role: parsed.role,
        category: parsed.category,
        difficulty: parsed.difficulty,
        dependsOn: parsed.dependsOn,
        targetFiles: parsed.targetFiles,
        contextHint: parsed.contextHint,
        acceptance: parsed.acceptance ?? existing?.acceptance ?? null,
        verifyCmd: existing?.verify_cmd ?? null,
      };

      db.upsertTasks(sessionId, [taskInput]);

      if (existing) {
        if (parsed.status === "done" && existing.status !== "done") {
          db.updateTaskStatus(sessionId, parsed.taskId, "done");
        } else if (
          parsed.status === "pending" &&
          (existing.status === "done" ||
            existing.status === "failed" ||
            existing.status === "escalated" ||
            existing.status === "merge_conflict")
        ) {
          db.updateTaskStatus(sessionId, parsed.taskId, "pending");
        } else if (
          parsed.status === "failed" &&
          existing.status !== "failed"
        ) {
          db.updateTaskStatus(sessionId, parsed.taskId, "failed");
        }
      } else {
        if (parsed.status !== "pending") {
          db.updateTaskStatus(sessionId, parsed.taskId, parsed.status);
        }
      }
    }

    // Increment sessions.state_version
    db.incrementStateVersion(sessionId);
  });

  return parsedTasks;
}

// ============================================================================
// 4. renderProgressBoard
// ============================================================================

function formatHarnessModel(
  harness: string | null,
  model: string | null
): string {
  let prefix = "";
  if (harness === "claude-code") prefix = "@cc";
  else if (harness === "opencode") prefix = "@oc";
  else if (harness === "codex") prefix = "@cx";
  else if (harness === "antigravity") prefix = "@ag";
  else if (harness) prefix = harness.startsWith("@") ? harness : `@${harness}`;

  if (prefix && model) {
    return `\`${prefix}/${model}\``;
  }
  if (model) {
    return model.startsWith("@") ? `\`${model}\`` : `\`@${model}\``;
  }
  if (prefix) {
    return `\`${prefix}\``;
  }
  return "`대기중`";
}

/**
 * Produces live TODO Progress Board markdown:
 * `### 📊 ASD TODO 진행 현황 [Turn X/Y 완료 | 진행률: M/N (P%)]`
 * followed by per-task lines:
 * `- [x] **T1.1** (Turn 1, \`@oc/glm-5\`, 12.4s): DB 스키마 작성 — 완료 (\`a1b2c3d\`)`
 */
export function renderProgressBoard(
  session:
    | SessionRow
    | { session_id?: string; phase?: string }
    | null
    | undefined,
  tasks: Array<TaskRow | TaskInput>
): string {
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter((t) => {
    const s = "status" in t ? t.status : "pending";
    return s === "done";
  });
  const doneCount = doneTasks.length;
  const pct =
    totalTasks === 0 ? 0 : Math.round((doneCount / totalTasks) * 100);

  // Group by turn
  const turnMap = new Map<number, Array<TaskRow | TaskInput>>();
  for (const t of tasks) {
    const turn = t.turn ?? 1;
    if (!turnMap.has(turn)) {
      turnMap.set(turn, []);
    }
    turnMap.get(turn)!.push(t);
  }

  const sortedTurns = Array.from(turnMap.keys()).sort((a, b) => a - b);
  const totalTurns = sortedTurns.length;
  let completedTurns = 0;
  for (const turn of sortedTurns) {
    const turnTasks = turnMap.get(turn)!;
    if (
      turnTasks.length > 0 &&
      turnTasks.every(
        (t) => ("status" in t ? t.status : "pending") === "done"
      )
    ) {
      completedTurns++;
    }
  }

  const header = `### 📊 ASD TODO 진행 현황 [Turn ${completedTurns}/${totalTurns} 완료 | 진행률: ${doneCount}/${totalTasks} (${pct}%)]`;
  const lines: string[] = [header];
  const updateNotice = readCachedUpdateNotice();
  if (updateNotice?.updateAvailable) {
    lines.push(
      `> 💡 **ASD Update Available (\`v${updateNotice.currentVersion}\` → \`v${updateNotice.latestVersion}\`)**: Run \`asd update\` in your terminal to update and sync automatically.`
    );
  }

  for (const t of tasks) {
    const taskId = "task_id" in t ? t.task_id : t.taskId;
    const status: TaskStatus =
      "status" in t ? (t.status as TaskStatus) : "pending";
    const turn = t.turn ?? 1;

    let marker = " ";
    if (status === "done") {
      marker = "x";
    } else if (
      status === "failed" ||
      status === "escalated" ||
      status === "merge_conflict"
    ) {
      marker = "~";
    }

    const harness =
      ("assigned_harness" in t
        ? t.assigned_harness
        : (t as unknown as { assignedHarness?: string }).assignedHarness) ??
      null;
    const model =
      ("assigned_model" in t
        ? t.assigned_model
        : (t as unknown as { assignedModel?: string }).assignedModel) ?? null;
    const harnessModelStr = formatHarnessModel(harness, model);

    const durationMs =
      ("duration_ms" in t
        ? t.duration_ms
        : (t as unknown as { durationMs?: number }).durationMs) ?? null;
    let thirdPart = "";
    if (durationMs != null && durationMs > 0) {
      thirdPart = `${(durationMs / 1000).toFixed(1)}s`;
    } else {
      switch (status) {
        case "running":
          thirdPart = "실행중";
          break;
        case "verifying":
          thirdPart = "검증중";
          break;
        case "escalated":
          thirdPart = "에스컬레이션";
          break;
        case "merge_conflict":
          thirdPart = "충돌";
          break;
        case "failed":
          thirdPart = "실패";
          break;
        case "done":
          thirdPart = "완료";
          break;
        case "pending":
        default:
          thirdPart = "대기중";
          break;
      }
    }

    const commitSha =
      ("commit_sha" in t
        ? t.commit_sha
        : (t as unknown as { commitSha?: string }).commitSha) ?? null;
    let commitStr = "";
    if (commitSha) {
      const shortSha = commitSha.slice(0, 7);
      commitStr = ` (\`${shortSha}\`)`;
    }

    let statusSuffix = "";
    if (status === "done") {
      statusSuffix = ` — 완료${commitStr}`;
    } else if (status === "failed") {
      statusSuffix = " — 실패";
    } else if (status === "merge_conflict") {
      statusSuffix = " — 병합 충돌";
    } else if (status === "escalated") {
      statusSuffix = " — 에스컬레이션";
    }

    lines.push(
      `- [${marker}] **${taskId}** (Turn ${turn}, ${harnessModelStr}, ${thirdPart}): ${t.title}${statusSuffix}`
    );
  }

  return lines.join("\n");
}

// ============================================================================
// 5. renderSessionSummaryMd
// ============================================================================

/**
 * Writes `<projectRoot>/.asd/sessions/<sessionId>/summary.md` with secret redaction.
 */
export function renderSessionSummaryMd(
  session:
    | SessionRow
    | { session_id: string; project_root: string; [k: string]: unknown },
  tasks: Array<TaskRow | TaskInput>,
  debates?: Array<DebateRow | DebateInput>,
  outPath?: string
): string {
  const lines: string[] = [];

  lines.push(`# ASD Session Summary: ${session.session_id}`, "");

  lines.push("## Session Overview");
  lines.push(`- **Session ID**: ${session.session_id}`);
  lines.push(`- **Project Root**: ${session.project_root}`);
  if ("main_harness" in session) {
    lines.push(`- **Main Harness**: ${session.main_harness}`);
  }
  if ("phase" in session) {
    lines.push(`- **Phase**: ${session.phase}`);
  }
  if ("state_version" in session) {
    lines.push(`- **State Version**: ${session.state_version}`);
  }
  if ("base_sha" in session && session.base_sha) {
    lines.push(`- **Base SHA**: ${session.base_sha}`);
  }
  if ("created_at" in session && session.created_at) {
    lines.push(`- **Created At**: ${new Date(session.created_at as number).toISOString()}`);
  }
  if ("updated_at" in session && session.updated_at) {
    lines.push(`- **Updated At**: ${new Date(session.updated_at as number).toISOString()}`);
  }
  lines.push("");

  const totalTasks = tasks.length;
  const doneCount = tasks.filter(
    (t) => ("status" in t ? t.status : "pending") === "done"
  ).length;
  const failedCount = tasks.filter(
    (t) => ("status" in t ? t.status : "pending") === "failed"
  ).length;

  lines.push("## Execution Statistics");
  lines.push(`- **Total Tasks**: ${totalTasks}`);
  lines.push(`- **Completed Tasks**: ${doneCount}`);
  lines.push(`- **Failed Tasks**: ${failedCount}`);
  const pct =
    totalTasks === 0 ? 0 : Math.round((doneCount / totalTasks) * 100);
  lines.push(`- **Success Rate**: ${pct}%`, "");

  lines.push("## Tasks Detail");
  for (const t of tasks) {
    const taskId = "task_id" in t ? t.task_id : t.taskId;
    const status = "status" in t ? t.status : "pending";
    const turn = t.turn ?? 1;
    const track = t.track ?? "LIGHT";
    const role = t.role ?? "worker";
    const category = t.category ?? "general";
    const difficulty = t.difficulty ?? "medium";

    lines.push(`### ${taskId}: ${t.title}`);
    lines.push(
      `- **Turn**: ${turn} | **Track**: ${track} | **Role**: ${role} | **Category**: ${category} | **Difficulty**: ${difficulty}`
    );
    lines.push(`- **Status**: ${status}`);

    if ("duration_ms" in t && t.duration_ms != null) {
      lines.push(`- **Duration**: ${(t.duration_ms / 1000).toFixed(1)}s`);
    }
    if ("commit_sha" in t && t.commit_sha) {
      lines.push(`- **Commit SHA**: ${t.commit_sha}`);
    }
    if (t.acceptance) {
      lines.push(`- **Acceptance**: ${t.acceptance}`);
    }

    const hint =
      ("contextHint" in t ? t.contextHint : (t as TaskRow).context_hint) ?? null;
    if (hint) {
      lines.push(`- **Context Hint**: ${hint}`);
    }

    if ("done_claim_json" in t && t.done_claim_json) {
      try {
        const claim = JSON.parse(t.done_claim_json);
        if (claim.summary) lines.push(`- **Done Summary**: ${claim.summary}`);
        if (Array.isArray(claim.key_decisions) && claim.key_decisions.length > 0) {
          lines.push(
            `- **Key Decisions**: ${claim.key_decisions.join("; ")}`
          );
        }
        if (Array.isArray(claim.changed_files) && claim.changed_files.length > 0) {
          lines.push(
            `- **Changed Files**: ${claim.changed_files.join(", ")}`
          );
        }
        if (Array.isArray(claim.risks) && claim.risks.length > 0) {
          lines.push(`- **Risks**: ${claim.risks.join("; ")}`);
        }
      } catch {
        // Ignore json parse error
      }
    }
    lines.push("");
  }

  if (debates && debates.length > 0) {
    lines.push("## Debates Detail");
    for (const d of debates) {
      const debateId = "debate_id" in d ? d.debate_id : d.debateId;
      lines.push(`### Debate ${debateId}: ${d.topic}`);
      lines.push(`- **Status**: ${d.status ?? "done"}`);
      const verdictJson =
        "insight_verdict_json" in d
          ? d.insight_verdict_json
          : (d as DebateInput).insightVerdictJson;
      if (verdictJson) {
        try {
          const verdict = JSON.parse(verdictJson);
          if (verdict.verdict) lines.push(`- **Verdict**: ${verdict.verdict}`);
          if (Array.isArray(verdict.decisions) && verdict.decisions.length > 0) {
            lines.push(`- **Decisions**: ${verdict.decisions.join("; ")}`);
          }
          if (
            Array.isArray(verdict.hard_constraints) &&
            verdict.hard_constraints.length > 0
          ) {
            lines.push(
              `- **Hard Constraints**: ${verdict.hard_constraints.join("; ")}`
            );
          }
        } catch {
          // Ignore json parse error
        }
      }
      lines.push("");
    }
  }

  const rawMarkdown = lines.join("\n").trimEnd() + "\n";
  const redacted = redactSecrets(rawMarkdown);

  const targetPath =
    outPath ??
    path.join(
      session.project_root,
      ".asd",
      "sessions",
      session.session_id,
      "summary.md"
    );

  atomicWriteFileSync(targetPath, redacted);
  return redacted;
}
