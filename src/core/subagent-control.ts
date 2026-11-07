/**
 * ASD Subagent Control Actions (src/core/subagent-control.ts)
 *
 * Pure data service for executing runtime actions on subagents:
 * kill, retry, fallback, custom, resume.
 * No UI/server dependencies.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { atomicWriteFileSync, renderPlanMd } from "./render.ts";
import {
  type DebateRow,
  type DriverRow,
  openProjectDb,
  type SessionRow,
  SqliteDriver,
  type TaskRow,
} from "./db.ts";
import {
  buildDefaultHarnessCommand,
  buildRound1Prompt,
  buildRound2Prompt,
  parseReviewerOpening,
  synthesizeInsightVerdict,
} from "./debate.ts";
import {
  createTaskWorktree,
  verifyAndCommitLightTask,
  verifyAndMergeHeavyTask,
} from "./workspace.ts";
import {
  inferModelFamily,
  normalizeAgentRole,
  resolveFallback,
  resolveNextLightSubagentFallback,
} from "./router.ts";
import {
  type CommandRunner,
  DEFAULT_DEBATE_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  killProcessTree,
  finalizeSubagentArtifacts,
  spawnSubagent,
} from "./spawner.ts";
import { buildPromptForTask } from "../mcp/server.ts";
import { buildResumeHarnessCommand } from "./session-tracker.ts";
import { loadRoutingConfig, resolveAsdPaths } from "./config.ts";
import { scanSubagentLogs, type SubagentLogRecord } from "./subagent-logs.ts";
import type { HarnessId, AgentRole, DifficultyTier, TaskTrack } from "./types.ts";

export async function runSubagentControlAction(options: {
  projectRoot: string;
  homeDir?: string;
  sessionId: string;
  subSessionId: string;
  action: "kill" | "retry" | "fallback" | "custom" | "resume";
  prompt?: string;
  harness?: HarnessId;
  model?: string;
  commandRunner?: CommandRunner;
  waitForCompletion?: boolean;
}): Promise<{
  ok: boolean;
  action: string;
  sessionId: string;
  subSessionId: string;
  newSubSessionId?: string;
  taskId?: string;
  followUpTaskId?: string;
  harness?: string;
  model?: string;
  status: string;
}> {
  const projectRoot = path.resolve(options.projectRoot);
  const logs = scanSubagentLogs(projectRoot);
  const realSessionId = options.sessionId.includes("::")
    ? options.sessionId.split("::")[0]!
    : options.sessionId;

  const target =
    logs.find(
      (l) =>
        l.subSessionId === options.subSessionId &&
        (!realSessionId || l.sessionId === realSessionId)
    ) ?? logs.find((l) => l.subSessionId === options.subSessionId);

  if (!target) {
    throw new Error(`Subagent not found: ${options.subSessionId}`);
  }

  const metaPath = path.join(target.dirPath, "meta.json");

  // 1. Action: kill
  if (options.action === "kill") {
    if (target.pid && target.pid > 0) {
      killProcessTree(target.pid);
    }
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
        meta.status = "failed";
        meta.finishedAt = Date.now();
        atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
      }
      const logPath = path.join(target.dirPath, "output.log");
      fs.appendFileSync(logPath, "\n[ASD UI] Process terminated by user.\n", "utf8");
    } catch {
      // Ignore
    }
    finalizeSubagentArtifacts({
      projectRoot,
      sessionId: target.sessionId,
      subSessionId: target.subSessionId,
    });
    return {
      ok: true,
      action: "kill",
      sessionId: target.sessionId,
      subSessionId: target.subSessionId,
      taskId: target.taskId,
      harness: target.harness,
      model: target.model,
      status: "failed",
    };
  }

  // CR-13: Validate resume preconditions immediately
  if (options.action === "resume") {
    if (!target.harnessSessionId || !target.harnessSessionId.trim()) {
      throw new Error("NO_HARNESS_SESSION");
    }
    if (options.harness && options.harness !== target.harness) {
      throw new Error("RESUME_HARNESS_MISMATCH");
    }
  }

  // 2. Determine target harness & model for retry / fallback / custom / resume
  const routingCfg = loadRoutingConfig(projectRoot, options.homeDir);
  const normRole = normalizeAgentRole(target.role) ?? "worker";
  const roleRoute = routingCfg.agents[normRole];

  let nextHarness = (target.harness || "claude-code") as HarnessId;
  let nextModel = target.model || "claude-sonnet-4-6";
  let suffix = "retry";

  if (options.action === "retry") {
    suffix = `retry-${Date.now().toString(36).slice(-4)}`;
  } else if (options.action === "fallback") {
    suffix = `fb-${Date.now().toString(36).slice(-4)}`;
    let isClaimOnlySub = false;
    try {
      if (fs.existsSync(metaPath)) {
        const m = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
          dispatchMode?: string;
        };
        isClaimOnlySub = m.dispatchMode === "claim_only";
      }
    } catch {
      // ignore
    }

    const lightFbModel = isClaimOnlySub
      ? resolveNextLightSubagentFallback(
          nextHarness,
          normRole,
          nextModel,
          routingCfg
        )
      : undefined;

    if (lightFbModel) {
      nextModel = lightFbModel;
    } else {
      const candidates = roleRoute
        ? [
            {
              harness: roleRoute.harness,
              model: roleRoute.model,
              modelFamily: roleRoute.modelFamily,
            },
            ...(roleRoute.fallbacks ?? []),
          ]
        : [];

      const curIdx = candidates.findIndex(
        (c) => c.harness === target.harness && c.model === target.model
      );
      const fbCandidate =
        curIdx >= 0 && curIdx + 1 < candidates.length
          ? candidates[curIdx + 1]
          : candidates.find(
              (c) => c.harness !== target.harness || c.model !== target.model
            );

      if (fbCandidate) {
        nextHarness = fbCandidate.harness;
        nextModel = fbCandidate.model;
      } else {
        const resolvedFb = resolveFallback(
          {
            harness: nextHarness,
            model: nextModel,
            modelFamily: inferModelFamily(nextModel, nextHarness),
            fallbacks: roleRoute?.fallbacks ?? [],
            tier: 2,
          },
          routingCfg
        );
        if (resolvedFb) {
          nextHarness = resolvedFb.harness;
          nextModel = resolvedFb.model;
        } else {
          const fallbackLight = resolveNextLightSubagentFallback(
            nextHarness,
            normRole,
            nextModel,
            routingCfg
          );
          if (fallbackLight) {
            nextModel = fallbackLight;
          }
        }
      }
    }
    } else if (options.action === "custom") {
    suffix = `custom-${Date.now().toString(36).slice(-4)}`;
    if (!options.harness) {
      throw new Error("Missing harness for custom execution");
    }
    nextHarness = options.harness;
    nextModel =
      options.model && options.model.trim()
        ? options.model.trim()
        : roleRoute?.harness === nextHarness
          ? roleRoute.model
          : "";
  } else if (options.action === "resume") {
    suffix = `resume-${Date.now().toString(36).slice(-4)}`;
    if (options.model && options.model.trim()) {
      nextModel = options.model.trim();
    }
  }

  const baseSubId = target.subSessionId.replace(/-(?:retry|fb|custom|resume)-[a-z0-9]+$/i, "");
  const newSubSessionId = `${baseSubId}-${suffix}`;
  let reconstructedPrompt = "";
  if (!(options.prompt && options.prompt.trim()) && !target.prompt) {
    let db: SqliteDriver | undefined;
    try {
      const paths = resolveAsdPaths(projectRoot, options.homeDir);
      const coreDbFallback = path.join(projectRoot, ".asd", "core.db");
      if (fs.existsSync(paths.dbPath) || fs.existsSync(coreDbFallback)) {
        db = fs.existsSync(paths.dbPath)
          ? openProjectDb(projectRoot, options.homeDir)
          : new SqliteDriver(coreDbFallback, projectRoot);
        const debMatchInfo = target.subSessionId.match(/-deb-(D-[A-Za-z0-9-]+)-(r1|r2)/);
        if (debMatchInfo) {
          const debId = debMatchInfo[1]!;
          const roundTag = debMatchInfo[2]!;
          const debRow = db.getAllDebates().find((d) => d.debate_id === debId);
          if (debRow) {
            if (roundTag === "r2" && debRow.round1_bundle_json) {
              try {
                const r1Bundle = JSON.parse(debRow.round1_bundle_json);
                reconstructedPrompt = buildRound2Prompt(
                  debRow.topic,
                  debRow.proposal ?? "",
                  r1Bundle,
                  debRow.task_id ?? undefined
                );
              } catch {
                reconstructedPrompt = buildRound1Prompt(
                  debRow.topic,
                  debRow.proposal ?? "",
                  debRow.task_id ?? undefined
                );
              }
            } else {
              reconstructedPrompt = buildRound1Prompt(
                debRow.topic,
                debRow.proposal ?? "",
                debRow.task_id ?? undefined
              );
            }
          }
        } else if (target.taskId) {
          const taskRow = db.getTask(target.sessionId, target.taskId);
          if (taskRow) {
            reconstructedPrompt = buildPromptForTask(taskRow, [], []);
          }
        }
      }
    } catch {
      // ignore reconstruction read errors
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }
  const promptText =
    options.prompt && options.prompt.trim()
      ? options.prompt.trim()
      : target.prompt ||
        reconstructedPrompt ||
        (options.action === "resume" ? "Continue task." : "");
  if (!promptText) {
    throw new Error("Missing prompt: prompt.md was purged and task/debate record was not found in DB");
  }

  const debMatch = target.subSessionId.match(/-deb-(D-[A-Za-z0-9-]+)-/);
  let effectiveTaskId = target.taskId || debMatch?.[1] || normRole;
  let followUpTaskId: string | undefined;
  let execWorktreePath: string | null = target.worktreePath ?? null;
  let effectiveAllowedFiles: string[] = target.allowedFiles ?? [];
  let origTaskStatus: string | undefined;
  let hasDbTask = false;

  // CR-13: State-dependent task setup when action === "resume"
  if (options.action === "resume" && target.taskId) {
    const paths = resolveAsdPaths(projectRoot, options.homeDir);
    const coreDbFallback = path.join(projectRoot, ".asd", "core.db");
    if (fs.existsSync(paths.dbPath) || fs.existsSync(coreDbFallback)) {
      const db = fs.existsSync(paths.dbPath)
        ? openProjectDb(projectRoot, options.homeDir)
        : new SqliteDriver(coreDbFallback, projectRoot);
      try {
        const taskRow = db.getTask(target.sessionId, target.taskId);
        if (taskRow) {
          hasDbTask = true;
          origTaskStatus = taskRow.status;
          if (taskRow.status === "running") {
            throw new Error("TASK_RUNNING");
          }

          let parsedTargetFiles: string[] = [];
          try {
            parsedTargetFiles = JSON.parse(taskRow.target_files_json || "[]");
          } catch {
            parsedTargetFiles = [];
          }
          effectiveAllowedFiles = [...parsedTargetFiles];
          if (
            effectiveAllowedFiles.length > 0 &&
            !effectiveAllowedFiles.includes("tests/**")
          ) {
            effectiveAllowedFiles.push("tests/**", "**/*.test.ts", "**/*.spec.ts");
          }

          if (taskRow.status === "done") {
            const allTasks = db.getSessionTasks(target.sessionId);
            let maxN = 0;
            for (const t of allTasks) {
              if (t.turn !== taskRow.turn) continue;
              const m = t.task_id.match(/^T\d+\.(\d+)$/i);
              if (m) {
                const n = Number.parseInt(m[1]!, 10);
                if (n > maxN) maxN = n;
              }
            }
            followUpTaskId = `T${taskRow.turn}.${maxN + 1}`;
            effectiveTaskId = followUpTaskId;
            const cleanHead = promptText.replace(/\r?\n+/g, " ").trim().slice(0, 50);
            const followUpTitle = `[Follow-up of ${taskRow.task_id}] ${cleanHead}`;

            db.upsertTasks(target.sessionId, [
              {
                taskId: followUpTaskId,
                turn: taskRow.turn,
                title: followUpTitle,
                track: taskRow.track as TaskTrack,
                role: taskRow.role as AgentRole,
                category: taskRow.category,
                difficulty: taskRow.difficulty as DifficultyTier,
                dependsOn: [taskRow.task_id],
                targetFiles: parsedTargetFiles,
                contextHint: taskRow.context_hint,
                acceptance: taskRow.acceptance,
                verifyCmd: taskRow.verify_cmd,
                followUpOf: taskRow.task_id,
              },
            ]);

            if (taskRow.track === "HEAVY") {
              const wt = createTaskWorktree(projectRoot, taskRow.turn, followUpTaskId);
              execWorktreePath = wt.wtPath;
            } else {
              execWorktreePath = null;
            }

            db.updateTaskStatus(target.sessionId, followUpTaskId, "running", {
              assignedHarness: nextHarness,
              assignedModel: nextModel,
              worktreePath: execWorktreePath ?? undefined,
              subSessionId: newSubSessionId,
            });

            const sess = db.getSession(target.sessionId);
            if (sess) {
              renderPlanMd(sess, db.getSessionTasks(target.sessionId));
            }
          } else if (
            taskRow.status === "merge_conflict" ||
            taskRow.status === "verifying"
          ) {
            const candidateWt =
              taskRow.worktree_path ||
              (taskRow.track === "HEAVY"
                ? path.join(projectRoot, ".asd", "wt", `${taskRow.turn}-${taskRow.task_id}`)
                : null);
            execWorktreePath =
              candidateWt && fs.existsSync(candidateWt) ? candidateWt : null;
            db.updateTaskStatus(target.sessionId, taskRow.task_id, "running", {
              subSessionId: newSubSessionId,
              worktreePath: execWorktreePath ?? undefined,
            });
          } else {
            const existingWt =
              taskRow.worktree_path && fs.existsSync(taskRow.worktree_path)
                ? taskRow.worktree_path
                : null;
            if (existingWt) {
              execWorktreePath = existingWt;
            } else if (taskRow.track === "HEAVY") {
              const wt = createTaskWorktree(projectRoot, taskRow.turn, taskRow.task_id);
              execWorktreePath = wt.wtPath;
            } else {
              execWorktreePath = null;
            }
            db.updateTaskStatus(target.sessionId, taskRow.task_id, "running", {
              subSessionId: newSubSessionId,
              worktreePath: execWorktreePath ?? undefined,
            });
          }
        }
      } finally {
        db.close();
      }
    }
  }

  const cmdInfo =
    options.action === "resume" && target.harnessSessionId
      ? buildResumeHarnessCommand(
          nextHarness,
          target.harnessSessionId,
          promptText,
          nextModel
        )
      : buildDefaultHarnessCommand(nextHarness, promptText, nextModel);

  const runPromise = spawnSubagent({
    projectRoot,
    homeDir: options.homeDir,
    mainSessionId: target.sessionId,
    subSessionId: newSubSessionId,
    role: normRole as AgentRole,
    harness: nextHarness,
    model: nextModel || "default",
    harnessSessionId: target.harnessSessionId ?? null,
    taskId: effectiveTaskId,
    prompt: promptText,
    allowedFiles: effectiveAllowedFiles,
    worktreePath: execWorktreePath,
    cwd:
      execWorktreePath && fs.existsSync(execWorktreePath)
        ? execWorktreePath
        : projectRoot,
    command: cmdInfo.command,
    args: cmdInfo.args,
    dispatchMode: "control_action",
    ownerPid: process.pid,
    commandRunner: options.commandRunner,
    timeoutMs: DEFAULT_DEBATE_TIMEOUT_MS,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  }).then(async (res) => {
    let finalTaskStatus: string = res.exitCode === 0 ? "done" : "failed";

    if (options.action === "resume" && hasDbTask) {
      const paths = resolveAsdPaths(projectRoot, options.homeDir);
      const coreDbFallback = path.join(projectRoot, ".asd", "core.db");
      const db = fs.existsSync(paths.dbPath)
        ? openProjectDb(projectRoot, options.homeDir)
        : new SqliteDriver(coreDbFallback, projectRoot);
      try {
        const sess = db.getSession(target.sessionId);
        const execTask = db.getTask(target.sessionId, effectiveTaskId);
        const autoApprove = sess ? sess.auto_approve !== 0 : true;

        if (execTask) {
          if (res.exitCode !== 0) {
            if (origTaskStatus === "failed" || origTaskStatus === "escalated") {
              const bumped = db.recordTaskAttemptFailure(
                target.sessionId,
                execTask.task_id
              );
              finalTaskStatus = bumped.status;
            } else {
              db.updateTaskStatus(target.sessionId, execTask.task_id, "failed");
              finalTaskStatus = "failed";
            }
          } else if (execTask.track === "HEAVY") {
            const vRes = await verifyAndMergeHeavyTask({
              projectRoot,
              turn: execTask.turn,
              taskId: execTask.task_id,
              title: execTask.title,
              wtPath: execWorktreePath ?? undefined,
              allowedFiles: effectiveAllowedFiles,
              verifyCmd: execTask.verify_cmd,
              sessionId: target.sessionId,
              db,
              autoApprove,
            });
            finalTaskStatus = vRes.status;
            if (vRes.verified && vRes.status === "done") {
              db.recordTaskVerified(
                target.sessionId,
                execTask.task_id,
                vRes.commitSha || "",
                {
                  summary: `Resumed and verified task ${execTask.task_id}: ${execTask.title}`,
                  changed_files: vRes.changedFiles ?? effectiveAllowedFiles,
                  key_decisions: ["Verified via subagent resume"],
                  risks: [],
                },
                res.durationMs
              );
            } else if (
              !vRes.verified &&
              (origTaskStatus === "failed" || origTaskStatus === "escalated")
            ) {
              const bumped = db.recordTaskAttemptFailure(
                target.sessionId,
                execTask.task_id
              );
              finalTaskStatus = bumped.status;
            }
          } else {
            const vRes = verifyAndCommitLightTask({
              projectRoot,
              taskId: execTask.task_id,
              title: execTask.title,
              allowedFiles: effectiveAllowedFiles,
              verifyCmd: execTask.verify_cmd,
              sessionId: target.sessionId,
              db,
              autoApprove,
            });
            finalTaskStatus = vRes.status ?? (vRes.verified ? "done" : "failed");
            if (vRes.verified && finalTaskStatus === "done") {
              db.recordTaskVerified(
                target.sessionId,
                execTask.task_id,
                vRes.commitSha || "",
                {
                  summary: `Resumed and verified task ${execTask.task_id}: ${execTask.title}`,
                  changed_files: vRes.changedFiles ?? effectiveAllowedFiles,
                  key_decisions: ["Verified via subagent resume"],
                  risks: [],
                },
                res.durationMs
              );
            } else if (
              !vRes.verified &&
              (origTaskStatus === "failed" || origTaskStatus === "escalated")
            ) {
              const bumped = db.recordTaskAttemptFailure(
                target.sessionId,
                execTask.task_id
              );
              finalTaskStatus = bumped.status;
            }
          }

          if (sess) {
            renderPlanMd(sess, db.getSessionTasks(target.sessionId));
          }
        }
      } finally {
        db.close();
      }
    } else {
      try {
        const outPath = path.join(path.dirname(res.metaPath), "output.log");
        const rawOut = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
        if (res.exitCode === 0 && rawOut) {
          tryRefreshDebateVerdictFromLog(
            projectRoot,
            options.homeDir,
            target.sessionId,
            effectiveTaskId,
            newSubSessionId,
            normRole,
            nextHarness,
            nextModel || "default",
            rawOut
          );
        }
      } catch {
        // Ignore post-processing errors
      }
    }

    if (finalTaskStatus === "done" || finalTaskStatus === "failed") {
      finalizeSubagentArtifacts({
        projectRoot,
        sessionId: target.sessionId,
        subSessionId: newSubSessionId,
      });
      finalizeSubagentArtifacts({
        projectRoot,
        sessionId: target.sessionId,
        subSessionId: target.subSessionId,
      });
    }

    return { ...res, finalTaskStatus };
  });

  if (options.waitForCompletion || options.commandRunner) {
    const completed = await runPromise;
    return {
      ok: completed.finalTaskStatus === "done" || completed.finalTaskStatus === "verifying",
      action: options.action,
      sessionId: options.sessionId || target.sessionId,
      subSessionId: target.subSessionId,
      newSubSessionId,
      taskId: effectiveTaskId,
      ...(followUpTaskId ? { followUpTaskId } : {}),
      harness: nextHarness,
      model: nextModel || "default",
      status: completed.finalTaskStatus,
    };
  }

  // Fire-and-forget for real live UI responsiveness
  void runPromise.catch(() => {});

  return {
    ok: true,
    action: options.action,
    sessionId: options.sessionId || target.sessionId,
    subSessionId: target.subSessionId,
    newSubSessionId,
    taskId: effectiveTaskId,
    ...(followUpTaskId ? { followUpTaskId } : {}),
    harness: nextHarness,
    model: nextModel || "default",
    status: "running",
  };
}

function tryRefreshDebateVerdictFromLog(
  projectRoot: string,
  homeDir: string | undefined,
  sessionId: string,
  taskId: string,
  subSessionId: string,
  role: string,
  harness: string,
  model: string,
  rawOutput: string
): void {
  const parsed = parseReviewerOpening(rawOutput);
  if (!parsed) return;

  const paths = resolveAsdPaths(projectRoot, homeDir);
  if (!fs.existsSync(paths.dbPath)) return;

  const realSessionId = sessionId.includes("::")
    ? sessionId.split("::")[0]!
    : sessionId;

  let db: SqliteDriver | undefined;
  try {
    db = openProjectDb(projectRoot, homeDir);
    const debates = db.getSessionDebates(realSessionId);
    const debMatch = subSessionId.match(/-deb-(D-[A-Za-z0-9-]+)-/);
    const debateId = debMatch?.[1] || taskId;
    const debateRow = debates.find(
      (d) => d.debate_id === debateId || (d.task_id && d.task_id === taskId)
    );
    if (!debateRow) return;

    let r1: { openings?: Array<Record<string, unknown>>; failedReviewers?: unknown[] } = {
      openings: [],
      failedReviewers: [],
    };
    try {
      if (debateRow.round1_bundle_json) {
        r1 = JSON.parse(debateRow.round1_bundle_json);
      }
    } catch {}

    const openings = Array.isArray(r1.openings) ? r1.openings : [];
    const newOpening = {
      reviewerId: subSessionId,
      role,
      harness,
      model,
      modelFamily: inferModelFamily(model, harness as import("./types.ts").HarnessId),
      verdict: parsed.verdict,
      hard_constraints: parsed.hard_constraints,
      decisions: parsed.decisions,
      risks: parsed.risks,
      reasoning: parsed.reasoning,
      rawOutput,
    };

    const existingIdx = openings.findIndex(
      (o) => o.role === role && o.harness === harness
    );
    if (existingIdx >= 0) {
      openings[existingIdx] = newOpening;
    } else {
      openings.push(newOpening);
    }

    const insightVerdict = synthesizeInsightVerdict(openings);

    db.updateDebateVerdict(debateRow.debate_id, "done", {
      round1BundleJson: JSON.stringify({
        openings,
        failedReviewers: r1.failedReviewers ?? [],
      }),
      insightVerdictJson: JSON.stringify(insightVerdict),
    });
  } catch {
    // Ignore DB refresh error
  } finally {
    db?.close();
  }
}