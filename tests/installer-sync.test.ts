/**
 * Tests for ASD v2.2 Harness Installer & Sync (tests/installer-sync.test.ts)
 *
 * Verifies:
 * 1. Strictly Global-Only sync across all 4 harnesses under isolated temp homeDir.
 * 2. Idempotency on second run ({ status: "skipped", skipped: true }).
 * 3. Surgical rollback restoring pre-existing user configurations 100% cleanly.
 * 4. Fast zero-token doctorProbe passing with 0 errors in < 100ms.
 * 5. Main-session autoSyncIfNeeded respecting the Subagent Shield.
 * 6. Zero pollution of project directory during sync.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import {
  autoSyncIfNeeded,
  doctorProbe,
  runAsdDoctor,
  runAsdSync,
  runAsdUninstall,
  syncHarnessConfigs,
  uninstallHarnessConfigs,
} from "../src/adapters/installer.ts";
import { AGENT_ROLES, type HarnessId } from "../src/core/types.ts";
import { ASD_SKILLS } from "../src/adapters/claude-code.ts";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup error
  }
}

describe("Installer & Sync Engine", () => {
  let tmpHome: string;
  let tmpProject: string;

  before(() => {
    tmpHome = createTempDir("asd-test-installer-home-");
    tmpProject = createTempDir("asd-test-installer-project-");
  });

  after(() => {
    removeTempDir(tmpHome);
    removeTempDir(tmpProject);
  });

  describe("1. Strictly Global-Only Sync (`syncHarnessConfigs`)", () => {
    test("initial sync updates all 4 harnesses into isolated homeDir", async () => {
      const res = await syncHarnessConfigs({
        homeDir: tmpHome,
        projectRoot: tmpProject,
      });

      assert.equal(res.status, "updated");
      assert.equal(res.skipped, false);
      assert.ok(res.configHash && res.configHash.length > 0);

      const harnesses: HarnessId[] = ["claude-code", "opencode", "codex", "antigravity"];
      for (const h of harnesses) {
        assert.equal(res.harnesses[h].status, "updated");
        assert.equal(res.harnesses[h].skipped, false);
        assert.ok(res.harnesses[h].filesWritten.length > 0);
      }
    });

    test("Claude Code targets exist and contain hooks and MCP config", () => {
      const claudeDir = path.join(tmpHome, ".claude");

      // 10 agent files
      for (const role of AGENT_ROLES) {
        const agentFile = path.join(claudeDir, "agents", `asd-${role}.md`);
        assert.ok(fs.existsSync(agentFile), `Missing agent: ${agentFile}`);
        const content = fs.readFileSync(agentFile, "utf8");
        assert.ok(content.includes(`asd-${role}`));
      }

      // 5 skill files
      for (const skill of ASD_SKILLS) {
        const skillFile = path.join(claudeDir, "skills", skill, "SKILL.md");
        assert.ok(fs.existsSync(skillFile), `Missing skill: ${skillFile}`);
        const content = fs.readFileSync(skillFile, "utf8");
        assert.ok(content.includes("progressBoard"));
      }

      // settings.json
      const settingsFile = path.join(claudeDir, "settings.json");
      assert.ok(fs.existsSync(settingsFile));
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      assert.ok(settings.hooks?.PreToolUse?.length > 0);
      assert.ok(settings.hooks?.Stop?.length > 0);
      assert.equal(settings.hooks.PreToolUse[0]._asdManaged, true);
      assert.equal(settings.hooks.Stop[0]._asdManaged, true);

      // .claude.json & .claude/.mcp.json
      const claudeJson = path.join(tmpHome, ".claude.json");
      assert.ok(fs.existsSync(claudeJson));
      const parsedClaudeJson = JSON.parse(fs.readFileSync(claudeJson, "utf8"));
      assert.equal(parsedClaudeJson.mcpServers["asd-core"], undefined);
      assert.ok(parsedClaudeJson.mcpServers["context7"]);
      assert.equal(parsedClaudeJson.mcpServers["context7"]._asdManaged, true);

      const dotMcpJson = path.join(claudeDir, ".mcp.json");
      assert.ok(fs.existsSync(dotMcpJson));
      const parsedDotMcp = JSON.parse(fs.readFileSync(dotMcpJson, "utf8"));
      assert.equal(parsedDotMcp.mcpServers["asd-core"], undefined);
      assert.ok(parsedDotMcp.mcpServers["context7"]);
    });

    test("OpenCode targets exist and contain commands, AGENTS.md, and MCP config", () => {
      const opencodeDir = path.join(tmpHome, ".config", "opencode");

      // 5 commands
      for (const skill of ASD_SKILLS) {
        const cmdFile = path.join(opencodeDir, "command", `${skill}.md`);
        assert.ok(fs.existsSync(cmdFile), `Missing command: ${cmdFile}`);
      }

      // AGENTS.md
      const agentsMd = path.join(opencodeDir, "AGENTS.md");
      assert.ok(fs.existsSync(agentsMd));
      const content = fs.readFileSync(agentsMd, "utf8");
      assert.ok(content.includes("asd-planner"));
      assert.ok(content.includes("asd-critic"));

      // opencode.json
      const opencodeJson = path.join(opencodeDir, "opencode.json");
      assert.ok(fs.existsSync(opencodeJson));
      const parsed = JSON.parse(fs.readFileSync(opencodeJson, "utf8"));
      assert.equal(parsed._asdVersion, "2.2.0");
      assert.equal(parsed.mcpServers["asd-core"], undefined);
      assert.ok(parsed.mcpServers["context7"]);
      assert.equal(parsed.mcpServers["context7"]._asdManaged, true);
    });

    test("Codex targets exist and contain skills, AGENTS.md, and config.toml fence", () => {
      const codexDir = path.join(tmpHome, ".codex");

      // 5 skills
      for (const skill of ASD_SKILLS) {
        const skillFile = path.join(codexDir, "skills", skill, "SKILL.md");
        assert.ok(fs.existsSync(skillFile), `Missing skill: ${skillFile}`);
      }

      // AGENTS.md
      const agentsMd = path.join(codexDir, "AGENTS.md");
      assert.ok(fs.existsSync(agentsMd));

      // config.toml
      const configToml = path.join(codexDir, "config.toml");
      assert.ok(fs.existsSync(configToml));
      const toml = fs.readFileSync(configToml, "utf8");
      assert.ok(toml.includes("# >>> BEGIN MANAGED BY ASD-V2"));
      assert.ok(!toml.includes("[mcp_servers.asd-core]"));
      assert.ok(toml.includes("[mcp_servers.context7]"));
      assert.ok(toml.includes("# <<< END MANAGED BY ASD-V2 <<<"));
    });

    test("Antigravity targets exist and contain agents, skills, hooks, and MCP config", () => {
      const geminiDir = path.join(tmpHome, ".gemini");

      // 10 agents
      for (const role of AGENT_ROLES) {
        const agentFile = path.join(geminiDir, "agents", `asd-${role}.md`);
        assert.ok(fs.existsSync(agentFile), `Missing agent: ${agentFile}`);
      }

      // 5 skills
      for (const skill of ASD_SKILLS) {
        const skillFile = path.join(geminiDir, "skills", skill, "SKILL.md");
        assert.ok(fs.existsSync(skillFile), `Missing skill: ${skillFile}`);
      }

      // hooks.json
      const hooksJson = path.join(geminiDir, "hooks.json");
      assert.ok(fs.existsSync(hooksJson));
      const hooks = JSON.parse(fs.readFileSync(hooksJson, "utf8"));
      assert.ok(hooks.PreToolUse?.length > 0);
      assert.ok(hooks.Stop?.length > 0);
      assert.equal(hooks.PreToolUse[0]._asdManaged, true);

      // mcp_config.json
      const mcpConfig = path.join(geminiDir, "mcp_config.json");
      assert.ok(fs.existsSync(mcpConfig));
      const parsed = JSON.parse(fs.readFileSync(mcpConfig, "utf8"));
      assert.equal(parsed.mcpServers["asd-core"], undefined);
      assert.ok(parsed.mcpServers["context7"]);
      assert.equal(parsed.mcpServers["context7"]._asdManaged, true);
    });

    test("project directory is NEVER touched or polluted during sync", () => {
      assert.equal(fs.existsSync(path.join(tmpProject, ".claude")), false);
      assert.equal(fs.existsSync(path.join(tmpProject, ".gemini")), false);
      assert.equal(fs.existsSync(path.join(tmpProject, ".codex")), false);
      assert.equal(fs.existsSync(path.join(tmpProject, "opencode.json")), false);
    });
  });

  describe("2. Idempotency on Second Run", () => {
    test("subsequent sync skips all harnesses without re-writing", async () => {
      const res = await syncHarnessConfigs({
        homeDir: tmpHome,
        projectRoot: tmpProject,
      });

      assert.equal(res.status, "skipped");
      assert.equal(res.skipped, true);

      const harnesses: HarnessId[] = ["claude-code", "opencode", "codex", "antigravity"];
      for (const h of harnesses) {
        assert.equal(res.harnesses[h].status, "skipped");
        assert.equal(res.harnesses[h].skipped, true);
        assert.equal(res.harnesses[h].filesWritten.length, 0);
      }
    });

    test("force option forces re-sync despite matching hash", async () => {
      const res = await syncHarnessConfigs({
        homeDir: tmpHome,
        projectRoot: tmpProject,
        force: true,
      });

      assert.equal(res.status, "updated");
      assert.equal(res.skipped, false);
      assert.equal(res.harnesses["claude-code"].status, "updated");
    });
  });

  describe("3. Surgical Uninstall & Config Restoration", () => {
    let userHome: string;

    before(() => {
      userHome = createTempDir("asd-test-user-home-");

      // Seed pre-existing user configurations
      const claudeDir = path.join(userHome, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          theme: "dark",
          hooks: {
            PreToolUse: [{ command: "my-custom-guard", _asdManaged: false }],
          },
        }, null, 2)
      );

      const codexDir = path.join(userHome, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(
        path.join(codexDir, "config.toml"),
        'model = "gpt-5"\ntemperature = 0.7\n'
      );

      const opencodeDir = path.join(userHome, ".config", "opencode");
      fs.mkdirSync(opencodeDir, { recursive: true });
      fs.writeFileSync(
        path.join(opencodeDir, "opencode.json"),
        JSON.stringify({
          editor: "neovim",
          mcpServers: {
            "custom-mcp": { command: "custom-bin" },
          },
        }, null, 2)
      );
    });

    after(() => {
      removeTempDir(userHome);
    });

    test("sync bakes in managed entries while backing up user files", async () => {
      const syncRes = await syncHarnessConfigs({ homeDir: userHome });
      assert.equal(syncRes.status, "updated");

      // Backups should exist
      assert.ok(fs.existsSync(path.join(userHome, ".claude", "settings.json.asd-backup")));
      assert.ok(fs.existsSync(path.join(userHome, ".codex", "config.toml.asd-backup")));
      assert.ok(fs.existsSync(path.join(userHome, ".config", "opencode", "opencode.json.asd-backup")));

      // Simulate user adding a new MCP entry AFTER asd sync ran
      const ocPath = path.join(userHome, ".config", "opencode", "opencode.json");
      const ocCurrent = JSON.parse(fs.readFileSync(ocPath, "utf8"));
      ocCurrent.mcpServers["added-after-sync-mcp"] = { command: "post-sync-bin" };
      fs.writeFileSync(ocPath, JSON.stringify(ocCurrent, null, 2), "utf8");
    });

    test("uninstall surgically restores original user configurations 100%", async () => {
      const uninstRes = await uninstallHarnessConfigs({ homeDir: userHome });
      assert.equal(uninstRes.status, "success");

      // User configs restored
      const claudeSettings = JSON.parse(
        fs.readFileSync(path.join(userHome, ".claude", "settings.json"), "utf8")
      );
      assert.equal(claudeSettings.theme, "dark");
      assert.equal(claudeSettings.hooks.PreToolUse.length, 1);
      assert.equal(claudeSettings.hooks.PreToolUse[0].command, "my-custom-guard");
      assert.equal(claudeSettings.hooks.PreToolUse[0]._asdManaged, false);
      assert.equal(claudeSettings.hooks.Stop, undefined);

      const codexToml = fs.readFileSync(path.join(userHome, ".codex", "config.toml"), "utf8");
      assert.ok(codexToml.includes('model = "gpt-5"'));
      assert.ok(codexToml.includes("temperature = 0.7"));
      assert.equal(codexToml.includes("BEGIN MANAGED BY ASD-V2"), false);

      const opencodeJson = JSON.parse(
        fs.readFileSync(path.join(userHome, ".config", "opencode", "opencode.json"), "utf8")
      );
      assert.equal(opencodeJson.editor, "neovim");
      assert.ok(opencodeJson.mcpServers["custom-mcp"]);
      assert.ok(opencodeJson.mcpServers["added-after-sync-mcp"]);
      assert.equal(opencodeJson.mcpServers["asd-core"], undefined);
      assert.equal(opencodeJson.mcpServers["context7"], undefined);

      // ASD-generated files removed
      assert.equal(fs.existsSync(path.join(userHome, ".claude", "agents")), false);
      assert.equal(fs.existsSync(path.join(userHome, ".claude", "skills")), false);
      assert.equal(fs.existsSync(path.join(userHome, ".config", "opencode", "AGENTS.md")), false);
      assert.equal(fs.existsSync(path.join(userHome, ".codex", "AGENTS.md")), false);
      assert.equal(fs.existsSync(path.join(userHome, ".gemini", "agents")), false);

      // Backups removed
      assert.equal(fs.existsSync(path.join(userHome, ".claude", "settings.json.asd-backup")), false);
      assert.equal(fs.existsSync(path.join(userHome, ".codex", "config.toml.asd-backup")), false);
    });
  });

  describe("4. Doctor Diagnostic Probe (`doctorProbe` / `runAsdDoctor`)", () => {
    test("fast zero-token probe executes in < 100ms with 0 errors", async () => {
      const probe = await doctorProbe({
        homeDir: tmpHome,
        projectRoot: process.cwd(),
      });

      assert.equal(probe.ok, true);
      assert.equal(probe.errors.length, 0);
      assert.ok(probe.durationMs < 100, `durationMs: ${probe.durationMs}ms >= 100ms`);

      // Node.js version
      assert.equal(probe.nodeVersion.ok, true);
      assert.ok(probe.nodeVersion.version.length > 0);

      // SQLite WAL
      assert.equal(probe.sqliteWal.ok, true);

      // Security Policy Probe (.GIT/config and .ENV blocked)
      assert.equal(probe.policyProbe.ok, true);
      assert.equal(probe.policyProbe.gitBlocked, true);
      assert.equal(probe.policyProbe.envBlocked, true);

      // Git repo
      assert.equal(probe.gitRepo.ok, true);
      assert.equal(probe.gitRepo.isRepo, true);

      // Harnesses
      assert.ok(probe.harnesses["claude-code"]);
      assert.ok(probe.harnesses.opencode);
      assert.ok(probe.harnesses.codex);
      assert.ok(probe.harnesses.antigravity);
    });
  });

  describe("5. Main-Session Auto-Sync (`autoSyncIfNeeded`)", () => {
    test("subagent session skips auto-sync via Subagent Shield", async () => {
      const prevRole = process.env.ASD_SESSION_ROLE;
      try {
        process.env.ASD_SESSION_ROLE = "subagent";
        const res = await autoSyncIfNeeded({ homeDir: tmpHome });
        assert.equal(res.synced, false);
        assert.equal(res.skipped, true);
        assert.equal(res.reason, "subagent_shield");
      } finally {
        if (prevRole !== undefined) {
          process.env.ASD_SESSION_ROLE = prevRole;
        } else {
          delete process.env.ASD_SESSION_ROLE;
        }
      }
    });

    test("main session triggers sync when config changed", async () => {
      const prevRole = process.env.ASD_SESSION_ROLE;
      try {
        delete process.env.ASD_SESSION_ROLE;
        const res = await autoSyncIfNeeded({ homeDir: tmpHome, force: true });
        assert.equal(res.synced, true);
        assert.equal(res.skipped, false);
      } finally {
        if (prevRole !== undefined) {
          process.env.ASD_SESSION_ROLE = prevRole;
        }
      }
    });
  });

  describe("6. Function Aliases & Acceptance Criteria", () => {
    test("runAsdSync, runAsdUninstall, runAsdDoctor aliases exist and match", () => {
      assert.equal(runAsdSync, syncHarnessConfigs);
      assert.equal(runAsdUninstall, uninstallHarnessConfigs);
      assert.equal(runAsdDoctor, doctorProbe);
    });
  });
});
