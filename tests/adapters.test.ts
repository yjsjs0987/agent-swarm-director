/**
 * Tests for ASD v2.2 Harness Adapters (tests/adapters.test.ts)
 *
 * Verifies:
 * 1. All 4 adapters instantiate and satisfy HarnessAdapter contract.
 * 2. Headless CLI command builders match expected flags and parameters.
 * 3. Hook translation formats adhere to Table 3.2 of ARCHITECTURE_PLAN.md.
 * 4. Global configuration path resolution respects homeDir argument.
 * 5. Antigravity headless probing handles absence cleanly without throwing.
 * 6. Configuration helpers (settings merge, TOML fence, opencode json) behave correctly.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import {
  AntigravityAdapter,
  antigravityAdapter,
  probeAntigravityHeadless,
} from "../src/adapters/antigravity.ts";
import {
  ASD_SKILLS,
  ClaudeCodeAdapter,
  claudeCodeAdapter,
  createClaudeHookConfig,
  mergeClaudeSettings,
} from "../src/adapters/claude-code.ts";
import {
  CodexAdapter,
  codexAdapter,
  mergeCodexConfigToml,
  removeCodexConfigToml,
} from "../src/adapters/codex.ts";
import {
  OpencodeAdapter,
  opencodeAdapter,
  createOpencodeConfig,
} from "../src/adapters/opencode.ts";
import { AGENT_ROLES, type HarnessAdapter } from "../src/core/types.ts";

describe("Harness Adapters", () => {
  describe("1. Adapter Instantiation & HarnessAdapter Contract", () => {
    test("all 4 adapters instantiate via constructor and satisfy HarnessAdapter", () => {
      const cc: HarnessAdapter = new ClaudeCodeAdapter();
      const oc: HarnessAdapter = new OpencodeAdapter();
      const cx: HarnessAdapter = new CodexAdapter();
      const ag: HarnessAdapter = new AntigravityAdapter({ supportsHeadlessSpawn: false });

      assert.equal(cc.harnessId, "claude-code");
      assert.equal(oc.harnessId, "opencode");
      assert.equal(cx.harnessId, "codex");
      assert.equal(ag.harnessId, "antigravity");

      assert.equal(typeof cc.buildHeadlessCommand, "function");
      assert.equal(typeof oc.buildHeadlessCommand, "function");
      assert.equal(typeof cx.buildHeadlessCommand, "function");
      assert.equal(typeof ag.buildHeadlessCommand, "function");

      assert.equal(typeof cc.formatPreToolUseDeny, "function");
      assert.equal(typeof oc.formatPreToolUseDeny, "function");
      assert.equal(typeof cx.formatPreToolUseDeny, "function");
      assert.equal(typeof ag.formatPreToolUseDeny, "function");

      assert.equal(typeof cc.formatStopBlock, "function");
      assert.equal(typeof oc.formatStopBlock, "function");
      assert.equal(typeof cx.formatStopBlock, "function");
      assert.equal(typeof ag.formatStopBlock, "function");

      assert.equal(typeof cc.globalConfigTargets, "function");
      assert.equal(typeof oc.globalConfigTargets, "function");
      assert.equal(typeof cx.globalConfigTargets, "function");
      assert.equal(typeof ag.globalConfigTargets, "function");
    });

    test("singleton adapter exports conform to HarnessAdapter", () => {
      assert.equal(claudeCodeAdapter.harnessId, "claude-code");
      assert.equal(opencodeAdapter.harnessId, "opencode");
      assert.equal(codexAdapter.harnessId, "codex");
      assert.equal(antigravityAdapter.harnessId, "antigravity");
    });

    test("headless spawn capability is accurately reported", () => {
      const cc = new ClaudeCodeAdapter();
      const oc = new OpencodeAdapter();
      const cx = new CodexAdapter();

      assert.equal(cc.supportsHeadlessSpawn, true);
      assert.equal(oc.supportsHeadlessSpawn, true);
      assert.equal(cx.supportsHeadlessSpawn, true);

      const agExplicitTrue = new AntigravityAdapter({ supportsHeadlessSpawn: true });
      assert.equal(agExplicitTrue.supportsHeadlessSpawn, true);

      const agExplicitFalse = new AntigravityAdapter({ supportsHeadlessSpawn: false });
      assert.equal(agExplicitFalse.supportsHeadlessSpawn, false);
    });
  });

  describe("2. Headless CLI Command Generation", () => {
    test("claude-code: builds `claude -p <prompt> --output-format json --model <model>`", () => {
      const adapter = new ClaudeCodeAdapter();
      const res = adapter.buildHeadlessCommand("Analyze code", "claude-sonnet-4-6");

      assert.equal(res.cmd, "claude");
      assert.deepEqual(res.args, [
        "-p",
        "Analyze code",
        "--output-format",
        "json",
        "--model",
        "claude-sonnet-4-6",
      ]);

      const resNoModel = adapter.buildHeadlessCommand("Hello", "");
      assert.deepEqual(resNoModel.args, ["-p", "Hello", "--output-format", "json"]);
    });

    test("opencode: builds `opencode run <prompt> --format json --model <model>`", () => {
      const adapter = new OpencodeAdapter();
      const res = adapter.buildHeadlessCommand("Implement feature", "glm-5");

      assert.equal(res.cmd, "opencode");
      assert.deepEqual(res.args, [
        "run",
        "Implement feature",
        "--format",
        "json",
        "--model",
        "glm-5",
      ]);
    });

    test("codex: builds `codex exec <prompt> --json -m <model> -c model_reasoning_effort=<level>`", () => {
      const adapter = new CodexAdapter();

      // With model & reasoning effort
      const resWithEffort = adapter.buildHeadlessCommand("Refactor tests", "gpt-5-codex", {
        reasoningEffort: "high",
      });
      assert.equal(resWithEffort.cmd, "codex");
      assert.deepEqual(resWithEffort.args, [
        "exec",
        "Refactor tests",
        "--json",
        "-m",
        "gpt-5-codex",
        "-c",
        "model_reasoning_effort=high",
      ]);

      // Without reasoning effort
      const resNoEffort = adapter.buildHeadlessCommand("Simple task", "gpt-5-codex");
      assert.deepEqual(resNoEffort.args, [
        "exec",
        "Simple task",
        "--json",
        "-m",
        "gpt-5-codex",
      ]);
    });

    test("antigravity: builds `agy -p <prompt> --output-format json --model <model> --effort <level>`", () => {
      const adapter = new AntigravityAdapter({ supportsHeadlessSpawn: true });

      const res = adapter.buildHeadlessCommand("Scout repo", "gemini-3-flash", {
        reasoningEffort: "low",
      });
      assert.equal(res.cmd, "agy");
      assert.deepEqual(res.args, [
        "-p",
        "Scout repo",
        "--output-format",
        "json",
        "--model",
        "gemini-3-flash",
        "--effort",
        "low",
      ]);

      const resNoEffort = adapter.buildHeadlessCommand("Hello", "gemini-3-pro");
      assert.deepEqual(resNoEffort.args, [
        "-p",
        "Hello",
        "--output-format",
        "json",
        "--model",
        "gemini-3-pro",
      ]);
    });
  });

  describe("3. Hook Translation Formats", () => {
    test("claude-code: PreToolUse deny -> exitCode 2 + stderr; Stop block -> stdout block JSON", () => {
      const adapter = new ClaudeCodeAdapter();

      const preDeny = adapter.formatPreToolUseDeny("Path out of bounds");
      assert.equal(preDeny.exitCode, 2);
      assert.equal(preDeny.stderr, "Path out of bounds");
      assert.equal(preDeny.stdout, undefined);

      const stopBlock = adapter.formatStopBlock("Unfinished acceptance criteria");
      assert.equal(stopBlock.exitCode, 0);
      assert.equal(
        stopBlock.stdout,
        JSON.stringify({ decision: "block", reason: "Unfinished acceptance criteria" })
      );
    });

    test("opencode: PreToolUse deny -> exitCode 2 + stderr & stdout; Stop block -> stdout block JSON", () => {
      const adapter = new OpencodeAdapter();

      const preDeny = adapter.formatPreToolUseDeny("Modification denied");
      assert.equal(preDeny.exitCode, 2);
      assert.equal(preDeny.stderr, "Modification denied");
      const parsed = JSON.parse(preDeny.stdout ?? "{}");
      assert.deepEqual(parsed, { decision: "deny", reason: "Modification denied" });

      const stopBlock = adapter.formatStopBlock("Turn limit not reached");
      assert.equal(stopBlock.exitCode, 0);
      assert.deepEqual(JSON.parse(stopBlock.stdout ?? "{}"), {
        decision: "block",
        reason: "Turn limit not reached",
      });
    });

    test("codex: PreToolUse deny -> exitCode 2 + stderr & stdout; Stop block -> stdout block JSON", () => {
      const adapter = new CodexAdapter();

      const preDeny = adapter.formatPreToolUseDeny("Outside sandbox");
      assert.equal(preDeny.exitCode, 2);
      assert.equal(preDeny.stderr, "Outside sandbox");
      assert.deepEqual(JSON.parse(preDeny.stdout ?? "{}"), {
        decision: "deny",
        reason: "Outside sandbox",
      });

      const stopBlock = adapter.formatStopBlock("Loop guard active");
      assert.equal(stopBlock.exitCode, 0);
      assert.deepEqual(JSON.parse(stopBlock.stdout ?? "{}"), {
        decision: "block",
        reason: "Loop guard active",
      });
    });

    test("antigravity: PreToolUse deny -> stdout deny JSON; Stop continue -> stdout continue JSON", () => {
      const adapter = new AntigravityAdapter({ supportsHeadlessSpawn: false });

      const preDeny = adapter.formatPreToolUseDeny("Subagent Shield triggered");
      assert.equal(preDeny.exitCode, 0);
      assert.deepEqual(JSON.parse(preDeny.stdout ?? "{}"), {
        decision: "deny",
        reason: "Subagent Shield triggered",
      });

      const stopBlock = adapter.formatStopBlock("Keep working on subtask");
      assert.equal(stopBlock.exitCode, 0);
      assert.deepEqual(JSON.parse(stopBlock.stdout ?? "{}"), {
        decision: "continue",
        reason: "Keep working on subtask",
      });
    });
  });

  describe("4. Global Configuration Target Paths", () => {
    const mockHome = path.join(os.tmpdir(), "asd-mock-home");

    test("all adapters prefix targets with specified homeDir", () => {
      const adapters: HarnessAdapter[] = [
        new ClaudeCodeAdapter(),
        new OpencodeAdapter(),
        new CodexAdapter(),
        new AntigravityAdapter({ supportsHeadlessSpawn: false }),
      ];

      for (const adapter of adapters) {
        const targets = adapter.globalConfigTargets(mockHome);
        assert.ok(targets.length > 0, `${adapter.harnessId} targets list is not empty`);
        for (const t of targets) {
          assert.ok(
            t.startsWith(mockHome),
            `${t} does not start with mock home ${mockHome}`
          );
        }
      }
    });

    test("claude-code targets include all 10 roles, 5 skills, settings.json, and mcp configs", () => {
      const adapter = new ClaudeCodeAdapter();
      const targets = adapter.globalConfigTargets(mockHome);

      for (const role of AGENT_ROLES) {
        const expected = path.join(mockHome, ".claude", "agents", `asd-${role}.md`);
        assert.ok(targets.includes(expected), `Missing agent target: ${expected}`);
      }

      for (const skill of ASD_SKILLS) {
        const expected = path.join(mockHome, ".claude", "skills", skill, "SKILL.md");
        assert.ok(targets.includes(expected), `Missing skill target: ${expected}`);
      }

      assert.ok(targets.includes(path.join(mockHome, ".claude", "settings.json")));
      assert.ok(targets.includes(path.join(mockHome, ".claude.json")));
      assert.ok(targets.includes(path.join(mockHome, ".claude", ".mcp.json")));
    });

    test("opencode targets include opencode.json, 5 commands, and AGENTS.md", () => {
      const adapter = new OpencodeAdapter();
      const targets = adapter.globalConfigTargets(mockHome);

      assert.ok(targets.includes(path.join(mockHome, ".config", "opencode", "opencode.json")));
      for (const skill of ASD_SKILLS) {
        const expected = path.join(mockHome, ".config", "opencode", "command", `${skill}.md`);
        assert.ok(targets.includes(expected), `Missing command target: ${expected}`);
      }
      assert.ok(targets.includes(path.join(mockHome, ".config", "opencode", "AGENTS.md")));
    });

    test("codex targets include config.toml, 5 skills, and AGENTS.md", () => {
      const adapter = new CodexAdapter();
      const targets = adapter.globalConfigTargets(mockHome);

      assert.ok(targets.includes(path.join(mockHome, ".codex", "config.toml")));
      for (const skill of ASD_SKILLS) {
        const expected = path.join(mockHome, ".codex", "skills", skill, "SKILL.md");
        assert.ok(targets.includes(expected), `Missing skill target: ${expected}`);
      }
      assert.ok(targets.includes(path.join(mockHome, ".codex", "AGENTS.md")));
    });

    test("antigravity targets include 10 roles, 5 skills, hooks.json, and mcp_config.json", () => {
      const adapter = new AntigravityAdapter({ supportsHeadlessSpawn: false });
      const targets = adapter.globalConfigTargets(mockHome);

      for (const role of AGENT_ROLES) {
        const expected = path.join(mockHome, ".gemini", "agents", `asd-${role}.md`);
        assert.ok(targets.includes(expected), `Missing agent target: ${expected}`);
      }
      for (const skill of ASD_SKILLS) {
        const expected = path.join(mockHome, ".gemini", "skills", skill, "SKILL.md");
        assert.ok(targets.includes(expected), `Missing skill target: ${expected}`);
      }
      assert.ok(targets.includes(path.join(mockHome, ".gemini", "hooks.json")));
      assert.ok(targets.includes(path.join(mockHome, ".gemini", "mcp_config.json")));
    });
  });

  describe("5. Antigravity Headless CLI Detection & Failure Handling", () => {
    test("probeAntigravityHeadless returns false cleanly for non-existent binary without throwing", () => {
      const result = probeAntigravityHeadless("definitely-non-existent-binary-12345");
      assert.equal(result, false);
    });

    test("AntigravityAdapter defaults to probe without throwing when binary absent", () => {
      // Testing with a guaranteed non-existent binary via options
      const adapter = new AntigravityAdapter({ binaryName: "non-existent-agy-binary-999" });
      assert.equal(adapter.supportsHeadlessSpawn, false);
    });
  });

  describe("6. Configuration Helpers", () => {
    test("claude-code: mergeClaudeSettings merges hooks non-destructively and marks _asdManaged", () => {
      const existing = {
        theme: "dark",
        hooks: {
          PreToolUse: [{ command: "my-custom-audit-tool", _asdManaged: false }],
        },
      };

      const merged = mergeClaudeSettings(existing, "/path/to/asd-cli");
      const hooks = merged.hooks as {
        PreToolUse: Array<{ command: string; _asdManaged?: boolean }>;
        Stop: Array<{ command: string; _asdManaged?: boolean }>;
      };

      // Custom tool preserved
      assert.equal(hooks.PreToolUse.length, 2);
      assert.equal(hooks.PreToolUse[0]?.command, "my-custom-audit-tool");
      assert.equal(hooks.PreToolUse[0]?._asdManaged, false);

      // Managed tool added
      assert.ok(hooks.PreToolUse[1]?.command.includes("/path/to/asd-cli"));
      assert.equal(hooks.PreToolUse[1]?._asdManaged, true);

      // Stop hook added
      assert.equal(hooks.Stop.length, 1);
      assert.equal(hooks.Stop[0]?._asdManaged, true);

      // Idempotent re-merge does not duplicate
      const reMerged = mergeClaudeSettings(merged, "/path/to/asd-cli");
      const reHooks = reMerged.hooks as typeof hooks;
      assert.equal(reHooks.PreToolUse.length, 2);
      assert.equal(reHooks.Stop.length, 1);
    });

    test("opencode: createOpencodeConfig creates valid payload with version", () => {
      const cfg = createOpencodeConfig(
        { "asd-core": { command: "node", args: ["server.ts"] } },
        { director: { harness: "claude-code", model: "claude-opus-4-6" } }
      );

      assert.equal(cfg._asdVersion, "2.2.0");
      assert.ok(cfg.mcpServers);
      assert.ok(cfg.agentRouting);
    });

    test("codex: mergeCodexConfigToml and removeCodexConfigToml manage fence blocks", () => {
      const original = 'model = "gpt-5"\ntemperature = 0.2';
      const managed = '[mcp_servers.asd-core]\ncommand = "node"';

      const merged = mergeCodexConfigToml(original, managed, "2.2.0");
      assert.ok(merged.includes("# >>> BEGIN MANAGED BY ASD-V2 (v2.2.0) >>>"));
      assert.ok(merged.includes('[mcp_servers.asd-core]'));
      assert.ok(merged.includes("# <<< END MANAGED BY ASD-V2 <<<"));
      assert.ok(merged.includes('model = "gpt-5"'));

      const cleaned = removeCodexConfigToml(merged);
      assert.equal(cleaned, original);
    });
  });
});
