/**
 * ASD v2.2 MCP Core Server Comprehensive Test Suite (tests/mcp-server.test.ts).
 *
 * Verifies:
 * 1. Tool list & MCP initialization (tools/list has all 4 tools with accurate schemas).
 * 2. Subagent Shield Guard:
 *    - Rejects asd_plan, asd_dispatch, and asd_debate when ASD_SESSION_ROLE=subagent.
 *    - Allows asd_verify and tools/list for subagents.
 *    - Bypasses autoSync when role is subagent; runs onMainServerStart when role is main.
 * 3. asd_plan:
 *    - 'create': initializes session, writes main.json, writes PLAN.md, returns progressBoard.
 *    - 'update': updates task metadata and re-renders.
 *    - 'get': retrieves session, phase, tasks, and progressBoard.
 *    - 'sync_from_md': syncs manual PLAN.md edits into SQLite and bumps state_version.
 * 4. asd_dispatch:
 *    - mode: 'claim_only' transitions pending tasks to running and creates worktree for HEAVY.
 *    - mode: 'parallel_spawn' verifies upstream depends_on, injects upstream key_decisions & files,
 *      concurrently executes via CommandRunner, verifies & commits, updates PLAN.md.
 *    - Emits progressBoard in all responses.
 * 5. asd_verify:
 *    - LIGHT task: runs in-place verification & checkpoint commit.
 *    - HEAVY task: runs worktree verification & mutexed merge into main.
 *    - Resets no_progress_count to 0.
 *    - When all tasks complete, sets phase = 'done' and writes .asd/summary.md.
 * 6. asd_debate:
 *    - Delegates to debate broker and returns verdict, constraints, decisions, risks, and progressBoard.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsdMcpServer, ASD_MCP_TOOLS } from "../src/mcp/server.ts";
import { openProjectDb, type SqliteDriver } from "../src/core/db.ts";
import { ensureGitUserIdentity, prepareBaseline, runGit } from "../src/core/workspace.ts";
import type { CommandRunner } from "../src/core/spawner.ts";
import { ASD_VERSION, type AsdPlanOutput, type AsdDispatchOutput, type AsdVerifyOutput, type AsdDebateOutput, type DoneClaim } from "../src/core/types.ts";

const tmpDirs: string[] = [];
const openServers: AsdMcpServer[] = [];

function makeProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-mcp-test-"));
  tmpDirs.push(dir);
  runGit(["init"], { cwd: dir });
  ensureGitUserIdentity(dir);
  prepareBaseline(dir);
  return dir;
}

afterEach(() => {
  for (const srv of openServers) {
    try {
      srv.close();
    } catch {
      // ignore
    }
  }
  openServers.length = 0;

  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs.length = 0;
  delete process.env.ASD_SESSION_ROLE;
});

describe("ASD MCP Server (src/mcp/server.ts)", () => {
  describe("1. Protocol Handshake & Tool Schemas", () => {
    test("initialize returns protocol version and serverInfo", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      const resp = (await server.handleRequest("initialize", {})) as {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
      };

      assert.equal(resp.protocolVersion, "2024-11-05");
      assert.equal(resp.serverInfo.name, "asd-core");
      assert.equal(resp.serverInfo.version, ASD_VERSION);
    });

    test("tools/list returns exactly the 4 ASD tools with complete schemas", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      const resp = (await server.handleRequest("tools/list", {})) as {
        tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }>;
      };

      assert.ok(Array.isArray(resp.tools));
      assert.equal(resp.tools.length, 4);

      const toolNames = resp.tools.map((t) => t.name).sort();
      assert.deepEqual(toolNames, ["asd_debate", "asd_dispatch", "asd_plan", "asd_verify"]);

      // Verify asd_plan schema
      const planTool = resp.tools.find((t) => t.name === "asd_plan")!;
      assert.ok(planTool.description.includes("plan"));
      assert.deepEqual(planTool.inputSchema.required, ["action"]);
      assert.ok(planTool.inputSchema.properties["tasks"]);

      // Verify asd_dispatch schema
      const dispatchTool = resp.tools.find((t) => t.name === "asd_dispatch")!;
      assert.ok(dispatchTool.description.includes("Dispatch"));
      assert.deepEqual(dispatchTool.inputSchema.required, ["sessionId"]);

      // Verify asd_verify schema
      const verifyTool = resp.tools.find((t) => t.name === "asd_verify")!;
      assert.ok(verifyTool.description.includes("verification"));
      assert.deepEqual(verifyTool.inputSchema.required, ["sessionId", "taskId", "doneClaim"]);

      // Verify asd_debate schema
      const debateTool = resp.tools.find((t) => t.name === "asd_debate")!;
      assert.ok(debateTool.description.includes("debate"));
      assert.deepEqual(debateTool.inputSchema.required, ["sessionId", "topic", "proposal"]);
    });

    test("ping and notifications/initialized return empty object", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      const pingResp = await server.handleRequest("ping", {});
      assert.deepEqual(pingResp, {});

      const notifResp = await server.handleRequest("notifications/initialized", {});
      assert.deepEqual(notifResp, {});
    });
  });

  describe("2. Subagent Isolation Guard", () => {
    test("rejects orchestration tools when sessionRole is 'subagent'", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({
        projectRoot,
        sessionRole: "subagent",
        autoSync: false,
      });
      openServers.push(server);

      // asd_plan must be rejected
      await assert.rejects(
        async () => {
          await server.handleRequest("asd_plan", { action: "create" });
        },
        {
          name: "Error",
          message: "Subagents cannot invoke orchestration tools",
        }
      );

      // asd_dispatch must be rejected
      await assert.rejects(
        async () => {
          await server.handleRequest("asd_dispatch", { sessionId: "s1" });
        },
        {
          name: "Error",
          message: "Subagents cannot invoke orchestration tools",
        }
      );

      // asd_debate must be rejected
      await assert.rejects(
        async () => {
          await server.handleRequest("asd_debate", { sessionId: "s1", topic: "t", proposal: "p" });
        },
        {
          name: "Error",
          message: "Subagents cannot invoke orchestration tools",
        }
      );

      // Rejection also works when called via tools/call wrapper
      await assert.rejects(
        async () => {
          await server.handleRequest("tools/call", {
            name: "asd_plan",
            arguments: { action: "create" },
          });
        },
        {
          name: "Error",
          message: "Subagents cannot invoke orchestration tools",
        }
      );
    });

    test("detects subagent via process.env.ASD_SESSION_ROLE = 'subagent'", async () => {
      process.env.ASD_SESSION_ROLE = "subagent";
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      await assert.rejects(
        async () => {
          await server.handleRequest("asd_dispatch", { sessionId: "test" });
        },
        {
          name: "Error",
          message: "Subagents cannot invoke orchestration tools",
        }
      );
    });

    test("subagents ARE permitted to call asd_verify and tools/list", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({
        projectRoot,
        sessionRole: "subagent",
        autoSync: false,
      });
      openServers.push(server);

      // tools/list is allowed
      const listResp = (await server.handleRequest("tools/list", {})) as { tools: unknown[] };
      assert.equal(listResp.tools.length, 4);

      // asd_verify is allowed to reach verify logic (will throw Task not found, NOT subagent rejection)
      await assert.rejects(
        async () => {
          await server.handleRequest("asd_verify", {
            sessionId: "missing",
            taskId: "T1.1",
            doneClaim: { summary: "ok", changed_files: [], key_decisions: [], risks: [] },
          });
        },
        (err: Error) => {
          assert.notEqual(err.message, "Subagents cannot invoke orchestration tools");
          assert.ok(err.message.includes("Session not found"));
          return true;
        }
      );
    });

    test("subagent role skips autoSync; main role invokes onMainServerStart", async () => {
      const projectRoot = makeProjectRoot();
      let mainStarted = false;

      // When subagent: onMainServerStart must NOT be called
      const subServer = new AsdMcpServer({
        projectRoot,
        sessionRole: "subagent",
        onMainServerStart: () => {
          mainStarted = true;
        },
      });
      openServers.push(subServer);
      assert.equal(mainStarted, false, "Subagent must not run startup hook");

      // When main: onMainServerStart MUST be called
      const mainServer = new AsdMcpServer({
        projectRoot,
        sessionRole: "main",
        onMainServerStart: () => {
          mainStarted = true;
        },
      });
      openServers.push(mainServer);
      assert.equal(mainStarted, true, "Main session must trigger onMainServerStart");
    });
  });

  describe("3. asd_plan Tool", () => {
    test("action: 'create' creates session, writes main.json & PLAN.md, returns progressBoard", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      const resp = (await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "session-create-1",
        mainHarness: "claude-code",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Implement auth module",
            track: "LIGHT",
            role: "worker",
            category: "general",
            difficulty: "medium",
            targetFiles: ["src/auth.ts"],
            contextHint: "src/auth.ts:1-20",
            acceptance: "Must support JWT verification",
          },
          {
            taskId: "T1.2",
            turn: 1,
            title: "Heavy database migration",
            track: "HEAVY",
            role: "builder",
            category: "general",
            difficulty: "high",
            targetFiles: ["src/db/migrate.ts"],
          },
        ],
      })) as AsdPlanOutput;

      assert.equal(resp.sessionId, "session-create-1");
      assert.equal(resp.stateVersion, 1);
      assert.equal(resp.phase, "planning");
      assert.equal(resp.tasks.length, 2);
      assert.equal(resp.tasks[0]?.taskId, "T1.1");
      assert.equal(resp.tasks[0]?.track, "LIGHT");
      assert.equal(resp.tasks[1]?.taskId, "T1.2");
      assert.equal(resp.tasks[1]?.track, "HEAVY");

      // progressBoard check: MUST include ### 📊 ASD TODO 진행 현황
      assert.ok(resp.progressBoard.includes("### 📊 ASD TODO 진행 현황"));
      assert.ok(resp.progressBoard.includes("T1.1"));
      assert.ok(resp.progressBoard.includes("T1.2"));

      // Verify .asd/sessions/session-create-1/main.json
      const mainJsonPath = path.join(projectRoot, ".asd", "sessions", "session-create-1", "main.json");
      assert.ok(fs.existsSync(mainJsonPath));
      const mainMeta = JSON.parse(fs.readFileSync(mainJsonPath, "utf8"));
      assert.equal(mainMeta.sessionId, "session-create-1");
      assert.equal(mainMeta.roleType, "main");
      assert.equal(mainMeta.role, "director");
      assert.equal(mainMeta.phase, "planning");

      // Verify .asd/PLAN.md
      const planMdPath = path.join(projectRoot, ".asd", "PLAN.md");
      assert.ok(fs.existsSync(planMdPath));
      const planContent = fs.readFileSync(planMdPath, "utf8");
      assert.ok(planContent.includes("T1.1"));
      assert.ok(planContent.includes("Implement auth module"));
      assert.ok(planContent.includes("T1.2"));
    });

    test("action: 'update' modifies task definitions in SQLite and updates PLAN.md", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      // Create initial plan
      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "session-update-1",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Original title",
            targetFiles: ["src/a.ts"],
          },
        ],
      });

      // Update task
      const updated = (await server.handleRequest("asd_plan", {
        action: "update",
        sessionId: "session-update-1",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Updated title with more details",
            targetFiles: ["src/a.ts", "src/b.ts"],
            acceptance: "New acceptance",
          },
        ],
      })) as AsdPlanOutput;

      assert.equal(updated.tasks[0]?.title, "Updated title with more details");
      assert.deepEqual(updated.tasks[0]?.targetFiles, ["src/a.ts", "src/b.ts"]);
      assert.equal(updated.tasks[0]?.acceptance, "New acceptance");

      const planContent = fs.readFileSync(path.join(projectRoot, ".asd", "PLAN.md"), "utf8");
      assert.ok(planContent.includes("Updated title with more details"));
    });

    test("action: 'get' retrieves current session state", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "session-get-1",
        tasks: [{ taskId: "T1.1", turn: 1, title: "Task 1", targetFiles: ["a.ts"] }],
      });

      const getResp = (await server.handleRequest("asd_plan", {
        action: "get",
        sessionId: "session-get-1",
      })) as AsdPlanOutput;

      assert.equal(getResp.sessionId, "session-get-1");
      assert.equal(getResp.tasks.length, 1);
      assert.equal(getResp.tasks[0]?.taskId, "T1.1");
      assert.ok(getResp.progressBoard.includes("### 📊 ASD TODO 진행 현황"));
    });

    test("action: 'sync_from_md' syncs manual checkbox and title edits from PLAN.md to SQLite", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "session-sync-1",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Task to complete manually", targetFiles: ["src/a.ts"] },
        ],
      });

      // Manually edit PLAN.md to mark task done: - [x] **T1.1** ...
      const planMdPath = path.join(projectRoot, ".asd", "PLAN.md");
      let planContent = fs.readFileSync(planMdPath, "utf8");
      planContent = planContent.replace("- [ ] **T1.1**", "- [x] **T1.1**");
      fs.writeFileSync(planMdPath, planContent, "utf8");

      // sync_from_md
      const syncResp = (await server.handleRequest("asd_plan", {
        action: "sync_from_md",
        sessionId: "session-sync-1",
      })) as AsdPlanOutput;

      assert.equal(syncResp.tasks[0]?.status, "done");
      assert.equal(syncResp.stateVersion, 2); // stateVersion incremented
      assert.ok(syncResp.progressBoard.includes("완료"));
    });

    test("calling asd_plan through tools/call returns both content and structured fields", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      const resp = (await server.handleRequest("tools/call", {
        name: "asd_plan",
        arguments: {
          action: "create",
          sessionId: "session-tools-call",
          tasks: [{ taskId: "T1.1", turn: 1, title: "Tools Call Task", targetFiles: ["a.ts"] }],
        },
      })) as { content: Array<{ type: string; text: string }>; sessionId: string; progressBoard: string };

      assert.ok(Array.isArray(resp.content));
      assert.equal(resp.content[0]?.type, "text");
      assert.equal(resp.sessionId, "session-tools-call");
      assert.ok(resp.progressBoard.includes("### 📊 ASD TODO 진행 현황"));
    });

    test("implicit 'create' never mutates a completed latest session", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "sess-guard-done",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Original done work", track: "LIGHT", targetFiles: ["a.ts"] },
        ],
      });
      const db = openProjectDb(projectRoot);
      db.updateSessionPhase("sess-guard-done", "done");
      db.close();

      const resp = (await server.handleRequest("asd_plan", {
        action: "create",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Fresh probe work", track: "HEAVY", targetFiles: ["b.ts"] },
        ],
      })) as AsdPlanOutput;

      assert.notEqual(resp.sessionId, "sess-guard-done");
      const dbAfter = openProjectDb(projectRoot);
      const oldTask = dbAfter.getTask("sess-guard-done", "T1.1");
      assert.equal(oldTask?.title, "Original done work");
      const newSession = dbAfter.getSession(resp.sessionId);
      assert.ok(newSession);
      assert.notEqual(newSession.phase, "done");
      dbAfter.close();
    });
  });

  describe("4. asd_dispatch Tool", () => {
    test("mode: 'claim_only' claims pending tasks, creates worktree for HEAVY, updates PLAN.md", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "dispatch-claim-1",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Light Worker", track: "LIGHT", targetFiles: ["light.ts"] },
          { taskId: "T1.2", turn: 1, title: "Heavy Worker", track: "HEAVY", targetFiles: ["heavy.ts"] },
        ],
      });

      const dispatchResp = (await server.handleRequest("asd_dispatch", {
        sessionId: "dispatch-claim-1",
        turn: 1,
        mode: "claim_only",
      })) as AsdDispatchOutput & { dispatchedTasks: AsdDispatchOutput["results"] };

      assert.equal(dispatchResp.sessionId, "dispatch-claim-1");
      assert.equal(dispatchResp.turn, 1);
      assert.equal(dispatchResp.results.length, 2);
      assert.deepEqual(dispatchResp.dispatchedTasks, dispatchResp.results);

      // Status transitioned to running
      assert.equal(dispatchResp.results[0]?.taskId, "T1.1");
      assert.equal(dispatchResp.results[0]?.status, "running");
      assert.equal(dispatchResp.results[1]?.taskId, "T1.2");
      assert.equal(dispatchResp.results[1]?.status, "running");

      // HEAVY task worktree created
      const wtDir = path.join(projectRoot, ".asd", "wt", "1-T1.2");
      assert.ok(fs.existsSync(wtDir), "HEAVY task worktree must exist");

      // Progress board emitted
      assert.ok(dispatchResp.progressBoard.includes("### 📊 ASD TODO 진행 현황"));
      assert.ok(dispatchResp.progressBoard.includes("실행중"));
    });

    test("verifies upstream depends_on and blocks dispatch when dependencies are unfinished", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "dispatch-dep-test",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Upstream Task", track: "LIGHT", targetFiles: ["a.ts"] },
          {
            taskId: "T2.1",
            turn: 2,
            title: "Downstream Task",
            track: "LIGHT",
            dependsOn: ["T1.1"],
            targetFiles: ["b.ts"],
          },
        ],
      });

      // Try to dispatch Turn 2 while Turn 1 is still pending
      const resp = (await server.handleRequest("asd_dispatch", {
        sessionId: "dispatch-dep-test",
        turn: 2,
        mode: "claim_only",
      })) as AsdDispatchOutput;

      assert.equal(resp.results.length, 1);
      assert.ok(resp.results[0]?.error?.includes("Upstream dependencies not satisfied: T1.1"));
      assert.equal(resp.results[0]?.status, "pending");
    });

    test("mode: 'parallel_spawn' executes tasks via CommandRunner, verifies & merges", async () => {
      const projectRoot = makeProjectRoot();
      const executedCommands: string[] = [];

      // Mock CommandRunner that writes target files upon spawn
      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          executedCommands.push(`${cmd} ${args.join(" ")}`);
          opts.onSpawn?.(9999);

          // Simulate worker modifying target file in its cwd
          const targetFile = path.join(opts.cwd, "hello.ts");
          fs.writeFileSync(targetFile, "export const hello = 'world';\n", "utf8");

          opts.onStdout("Task completed successfully\n");
          return { exitCode: 0, pid: 9999 };
        },
      };

      const server = new AsdMcpServer({
        projectRoot,
        commandRunner: mockRunner,
        autoSync: false,
      });
      openServers.push(server);

      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "dispatch-spawn-1",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Build widget",
            track: "LIGHT",
            role: "worker",
            category: "general",
            difficulty: "medium",
            targetFiles: ["hello.ts"],
          },
        ],
      });

      const dispatchResp = (await server.handleRequest("asd_dispatch", {
        sessionId: "dispatch-spawn-1",
        turn: 1,
        mode: "parallel_spawn",
      })) as AsdDispatchOutput & { dispatchedTasks: AsdDispatchOutput["results"] };

      assert.equal(dispatchResp.results.length, 1);
      assert.equal(dispatchResp.results[0]?.taskId, "T1.1");
      assert.equal(dispatchResp.results[0]?.status, "done");
      assert.ok(dispatchResp.results[0]?.commitSha, "Commit SHA must be recorded");
      assert.ok(dispatchResp.progressBoard.includes("### 📊 ASD TODO 진행 현황"));
      assert.ok(dispatchResp.progressBoard.includes("완료"));

      // Subagent session directory and prompt.md written
      const subSessionDir = path.join(
        projectRoot,
        ".asd",
        "sessions",
        "dispatch-spawn-1",
        "subagents"
      );
      assert.ok(fs.existsSync(subSessionDir));
      const subDirs = fs.readdirSync(subSessionDir);
      assert.ok(subDirs.length > 0);
      assert.ok(fs.existsSync(path.join(subSessionDir, subDirs[0]!, "prompt.md")));
      assert.ok(fs.existsSync(path.join(subSessionDir, subDirs[0]!, "meta.json")));
    });

    test("default mode (omitted): LIGHT tasks claim_only on mainHarness without external CLI spawn", async () => {
      const projectRoot = makeProjectRoot();
      let spawnedCount = 0;
      const mockRunner: CommandRunner = {
        async run() {
          spawnedCount++;
          return { exitCode: 0, pid: 1111 };
        },
      };

      const server = new AsdMcpServer({
        projectRoot,
        commandRunner: mockRunner,
        autoSync: false,
      });
      openServers.push(server);

      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "dispatch-light-default",
        mainHarness: "opencode",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Architect LIGHT task in current harness",
            track: "LIGHT",
            role: "architect",
            category: "general",
            difficulty: "high",
            targetFiles: ["light-arch.ts"],
          },
        ],
      });

      const dispatchResp = (await server.handleRequest("asd_dispatch", {
        sessionId: "dispatch-light-default",
        turn: 1,
      })) as AsdDispatchOutput;

      assert.equal(spawnedCount, 0, "LIGHT task must not spawn external CLI by default");
      assert.equal(dispatchResp.results.length, 1);
      assert.equal(dispatchResp.results[0]?.taskId, "T1.1");
      assert.equal(dispatchResp.results[0]?.status, "running");
      assert.equal(dispatchResp.results[0]?.harness, "opencode");
    });

    test("parallel_spawn automatically steps through same-harness & cross-harness fallbacks on rate-limit or network error", async () => {
      const projectRoot = makeProjectRoot();
      // Write a custom project routing.jsonc with multiple models on opencode in fallbacks
      const asdDir = path.join(projectRoot, ".asd");
      fs.mkdirSync(asdDir, { recursive: true });
      fs.writeFileSync(
        path.join(asdDir, "routing.jsonc"),
        JSON.stringify(
          {
            version: "2.2.0",
            agents: {
              critic: {
                harness: "opencode",
                model: "glm-5",
                modelFamily: "glm",
                fallbacks: [
                  { harness: "opencode", model: "deepseek-r1", modelFamily: "deepseek" },
                  { harness: "opencode", model: "qwen-2.5-coder", modelFamily: "qwen" },
                ],
              },
              worker: {
                harness: "opencode",
                model: "glm-5",
                modelFamily: "glm",
                fallbacks: [],
              },
            },
            categories: {
              medium: {
                harness: "opencode",
                model: "glm-5",
                modelFamily: "glm",
                fallbacks: [],
              },
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const triedModels: string[] = [];
      const mockRunner: CommandRunner = {
        async run(_cmd, args, opts) {
          const modelIdx = args.indexOf("--model");
          const model = modelIdx !== -1 ? args[modelIdx + 1] ?? "" : "";
          triedModels.push(model);
          opts.onSpawn?.(8888);

          // Simulate 1st model (glm-5) failing with 429 Rate Limit, 2nd model (deepseek-r1) failing with network error,
          // and 3rd model (qwen-2.5-coder) succeeding!
          if (model === "glm-5") {
            opts.onStderr("Error: 429 Too Many Requests - rate limit exceeded\n");
            return { exitCode: 1, pid: 8888 };
          }
          if (model === "deepseek-r1") {
            opts.onStderr("Error: ECONNRESET network error\n");
            return { exitCode: 1, pid: 8888 };
          }

          fs.writeFileSync(path.join(opts.cwd, "fallback-ok.ts"), "export const ok = true;\n", "utf8");
          opts.onStdout("Done with qwen-2.5-coder\n");
          return { exitCode: 0, pid: 8888 };
        },
      };

      const server = new AsdMcpServer({
        projectRoot,
        commandRunner: mockRunner,
        autoSync: false,
      });
      openServers.push(server);

      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "dispatch-fb-chain",
        mainHarness: "opencode",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Task with multi-model fallback on same harness",
            track: "LIGHT",
            role: "critic",
            category: "general",
            difficulty: "medium",
            targetFiles: ["fallback-ok.ts"],
          },
        ],
      });

      const dispatchResp = (await server.handleRequest("asd_dispatch", {
        sessionId: "dispatch-fb-chain",
        turn: 1,
        mode: "parallel_spawn",
      })) as AsdDispatchOutput;

      assert.deepEqual(triedModels, ["glm-5", "deepseek-r1", "qwen-2.5-coder"]);
      assert.equal(dispatchResp.results[0]?.status, "done");
      assert.equal(dispatchResp.results[0]?.harness, "opencode");
      assert.equal(dispatchResp.results[0]?.model, "qwen-2.5-coder");
    });
  });

  describe("5. asd_verify Tool", () => {
    test("verifies LIGHT task, commits changes, resets no_progress_count", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      // Create session & task
      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "verify-light-1",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Light Feature", track: "LIGHT", targetFiles: ["feature.ts"] },
          { taskId: "T1.2", turn: 1, title: "Second Task", track: "LIGHT", targetFiles: ["other.ts"] },
        ],
      });

      // Bump no_progress_count
      const db = openProjectDb(projectRoot);
      db.incrementNoProgress("verify-light-1");
      db.incrementNoProgress("verify-light-1");
      assert.equal(db.getSession("verify-light-1")?.no_progress_count, 2);
      db.close();

      // Make edit in allowed file
      fs.writeFileSync(path.join(projectRoot, "feature.ts"), "export const x = 1;\n", "utf8");

      const claim: DoneClaim = {
        summary: "Implemented feature.ts",
        changed_files: ["feature.ts"],
        key_decisions: ["Use TS export"],
        risks: [],
      };

      const verifyResp = (await server.handleRequest("asd_verify", {
        sessionId: "verify-light-1",
        taskId: "T1.1",
        doneClaim: claim,
      })) as AsdVerifyOutput;

      assert.equal(verifyResp.verified, true);
      assert.equal(verifyResp.taskId, "T1.1");
      assert.equal(verifyResp.status, "done");
      assert.ok(verifyResp.commitSha);
      assert.ok(verifyResp.progressBoard.includes("### 📊 ASD TODO 진행 현황"));

      // no_progress_count must be reset to 0
      const dbAfter = openProjectDb(projectRoot);
      assert.equal(dbAfter.getSession("verify-light-1")?.no_progress_count, 0);
      dbAfter.close();
    });

    test("verifies HEAVY task worktree, merges into main, cleans up worktree", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      // Create session & task
      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "verify-heavy-1",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Heavy Work", track: "HEAVY", targetFiles: ["heavy_worker.ts"] },
        ],
      });

      // Claim task to create worktree
      await server.handleRequest("asd_dispatch", {
        sessionId: "verify-heavy-1",
        turn: 1,
        mode: "claim_only",
      });

      const wtPath = path.join(projectRoot, ".asd", "wt", "1-T1.1");
      assert.ok(fs.existsSync(wtPath), "Worktree must exist before verify");

      // Edit file inside worktree
      fs.writeFileSync(path.join(wtPath, "heavy_worker.ts"), "export const worker = true;\n", "utf8");

      const claim: DoneClaim = {
        summary: "Completed heavy task",
        changed_files: ["heavy_worker.ts"],
        key_decisions: ["Worktree isolation merged"],
        risks: [],
      };

      const verifyResp = (await server.handleRequest("asd_verify", {
        sessionId: "verify-heavy-1",
        taskId: "T1.1",
        doneClaim: claim,
      })) as AsdVerifyOutput;

      assert.equal(verifyResp.verified, true);
      assert.equal(verifyResp.status, "done");
      assert.ok(verifyResp.commitSha);

      // Worktree must be cleaned up after merge
      assert.equal(fs.existsSync(wtPath), false, "Worktree must be removed after successful merge");

      // File must now exist in main projectRoot
      assert.ok(fs.existsSync(path.join(projectRoot, "heavy_worker.ts")));
    });

    test("when all tasks complete, sets session phase = 'done' and generates summary.md", async () => {
      const projectRoot = makeProjectRoot();
      const server = new AsdMcpServer({ projectRoot, autoSync: false });
      openServers.push(server);

      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "complete-session-1",
        tasks: [
          { taskId: "T1.1", turn: 1, title: "Sole Task", track: "LIGHT", targetFiles: ["sole.ts"] },
        ],
      });

      fs.writeFileSync(path.join(projectRoot, "sole.ts"), "export const sole = 42;\n", "utf8");

      const verifyResp = (await server.handleRequest("asd_verify", {
        sessionId: "complete-session-1",
        taskId: "T1.1",
        doneClaim: {
          summary: "Sole task done",
          changed_files: ["sole.ts"],
          key_decisions: [],
          risks: [],
        },
      })) as AsdVerifyOutput;

      assert.equal(verifyResp.verified, true);
      assert.equal(verifyResp.status, "done");

      // Session phase must now be 'done'
      const db = openProjectDb(projectRoot);
      const session = db.getSession("complete-session-1");
      assert.equal(session?.phase, "done");
      db.close();

      // Both .asd/summary.md and .asd/sessions/<sessionId>/summary.md must exist
      assert.ok(fs.existsSync(path.join(projectRoot, ".asd", "summary.md")));
      assert.ok(fs.existsSync(path.join(projectRoot, ".asd", "sessions", "complete-session-1", "summary.md")));

      const summaryContent = fs.readFileSync(path.join(projectRoot, ".asd", "summary.md"), "utf8");
      assert.ok(summaryContent.includes("ASD Session Summary"));
      assert.ok(summaryContent.includes("complete-session-1"));
      assert.ok(summaryContent.includes("100%"));
    });
  });

  describe("6. asd_debate Tool", () => {
    test("delegates to debate broker and includes progressBoard in response", async () => {
      const projectRoot = makeProjectRoot();

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          opts.onSpawn?.(1111);
          const responseJson = JSON.stringify({
            verdict: "APPROVE",
            hard_constraints: ["Constraint 1"],
            decisions: ["Decision 1"],
            risks: ["Risk 1"],
            reasoning: "Proposal is sound",
          });
          opts.onStdout(`\`\`\`json\n${responseJson}\n\`\`\`\n`);
          return { exitCode: 0, pid: 1111 };
        },
      };

      const server = new AsdMcpServer({
        projectRoot,
        commandRunner: mockRunner,
        autoSync: false,
      });
      openServers.push(server);

      // Create a session first
      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "debate-session-1",
        tasks: [{ taskId: "T1.1", turn: 1, title: "Debate Target", targetFiles: ["a.ts"] }],
      });

      const debateResp = (await server.handleRequest("asd_debate", {
        sessionId: "debate-session-1",
        taskId: "T1.1",
        topic: "Architecture strategy",
        proposal: "Use erasable typescript syntax only",
      })) as AsdDebateOutput;

      assert.ok(debateResp.debateId);
      assert.equal(debateResp.status, "done");
      assert.equal(debateResp.verdict, "APPROVE");
      assert.deepEqual(debateResp.hardConstraints, ["Constraint 1"]);
      assert.deepEqual(debateResp.decisions, ["Decision 1"]);
      assert.deepEqual(debateResp.risks, ["Risk 1"]);
      assert.equal(typeof debateResp.diversityDegraded, "boolean");

      // Progress board must be present and contain header
      assert.ok(debateResp.progressBoard.includes("### 📊 ASD TODO 진행 현황"));
    });

    test("cross-scope requests bundle caller A files with target B file, link dependsOn [A, B], cap at 2 per subagent, and forward excess to Main Agent", async () => {
      const projectRoot = makeProjectRoot();

      const mockRunner: CommandRunner = {
        async run(_cmd, _args, opts) {
          opts.onSpawn?.(7777);
          const loginPath = path.join(opts.cwd, "src", "ui", "LoginForm.tsx");
          const authPath = path.join(opts.cwd, "src", "api", "auth.ts");

          if (opts.cwd.includes("T1.1")) {
            fs.mkdirSync(path.dirname(loginPath), { recursive: true });
            fs.writeFileSync(loginPath, "export const LoginForm = () => 'login';\n", "utf8");
            const reportBlock = [
              "Implemented LoginForm, but backend API files need additional fields.",
              "```asd-report",
              JSON.stringify(
                {
                  summary: "LoginForm UI implemented",
                  key_decisions: ["Added refreshToken hook call in LoginForm"],
                  risks: ["Requires backend AuthResponse update"],
                  cross_scope_requests: [
                    {
                      target_file: "src/api/auth.ts",
                      caller_files: ["src/ui/LoginForm.tsx"],
                      reason: "LoginForm requires refreshToken field on AuthResponse",
                      suggested_change: "Add refreshToken?: string to AuthResponse interface",
                    },
                    {
                      target_file: "src/api/session.ts",
                      reason: "Session expiry helper needed by UI",
                      suggested_change: "Export isSessionExpired(token: string): boolean",
                    },
                    {
                      target_file: "src/api/audit.ts",
                      reason: "Optional audit log hook for login attempts",
                      suggested_change: "Add recordLoginAttempt()",
                    },
                  ],
                },
                null,
                2
              ),
              "```",
            ].join("\n");
            opts.onStdout(reportBlock + "\n");
          } else if (opts.cwd.includes("T1.2")) {
            fs.mkdirSync(path.dirname(authPath), { recursive: true });
            fs.writeFileSync(authPath, "export interface AuthResponse { token: string; }\n", "utf8");
            opts.onStdout("Completed T1.2 backend auth.ts\n");
          }
          return { exitCode: 0, pid: 7777 };
        },
      };

      const server = new AsdMcpServer({
        projectRoot,
        commandRunner: mockRunner,
        autoSync: false,
      });
      openServers.push(server);

      await server.handleRequest("asd_plan", {
        action: "create",
        sessionId: "cross-scope-session",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Frontend LoginForm",
            track: "HEAVY",
            role: "worker",
            category: "visual-ui",
            difficulty: "medium",
            targetFiles: ["src/ui/LoginForm.tsx", "src/ui/useAuth.ts"],
          },
          {
            taskId: "T1.2",
            turn: 1,
            title: "Backend Auth API",
            track: "HEAVY",
            role: "architect",
            category: "general",
            difficulty: "high",
            targetFiles: ["src/api/auth.ts"],
          },
        ],
      });

      const dispatchResp = (await server.handleRequest("asd_dispatch", {
        sessionId: "cross-scope-session",
        turn: 1,
        mode: "parallel_spawn",
      })) as AsdDispatchOutput;

      assert.equal(dispatchResp.results.length, 2);
      assert.ok(dispatchResp.results.every((r) => r.status === "done"));

      assert.ok(Array.isArray(dispatchResp.autoCreatedTasks));
      assert.equal(dispatchResp.autoCreatedTasks!.length, 2);

      const t21 = dispatchResp.autoCreatedTasks![0]!;
      assert.equal(t21.taskId, "T2.1");
      assert.equal(t21.turn, 2);
      assert.deepEqual(t21.targetFiles, ["src/api/auth.ts", "src/ui/LoginForm.tsx"]);
      assert.deepEqual(t21.dependsOn, ["T1.1", "T1.2"]);

      const t22 = dispatchResp.autoCreatedTasks![1]!;
      assert.equal(t22.taskId, "T2.2");
      assert.equal(t22.turn, 2);
      assert.deepEqual(t22.targetFiles, ["src/api/session.ts", "src/ui/LoginForm.tsx"]);
      assert.deepEqual(t22.dependsOn, ["T1.1"]);

      assert.ok(Array.isArray(dispatchResp.deferredCrossScopeRequests));
      assert.equal(dispatchResp.deferredCrossScopeRequests!.length, 1);
      assert.equal(dispatchResp.deferredCrossScopeRequests![0]!.requestedByTaskId, "T1.1");
      assert.equal(dispatchResp.deferredCrossScopeRequests![0]!.target_file, "src/api/audit.ts");

      assert.ok(dispatchResp.progressBoard.includes("자동 생성된 Cross-Scope 후속 태스크"));
      assert.ok(dispatchResp.progressBoard.includes("메인 에이전트 판단 필요"));
      const db = openProjectDb(projectRoot);
      const session = db.getSession("cross-scope-session");
      assert.notEqual(session?.phase, "done");
      db.close();
    });
  });
});
