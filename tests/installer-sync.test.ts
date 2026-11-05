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
  buildCodexManagedTomlBlock,
  doctorProbe,
  generateAgentContent,
  generateAllAgentsMarkdown,
  getSkillTemplate,
  runAsdDoctor,
  runAsdSync,
  runAsdUninstall,
  syncHarnessConfigs,
  syncRepoVersionStrings,
  uninstallHarnessConfigs,
} from "../src/adapters/installer.ts";
import { AGENT_ROLES, ASD_VERSION, type HarnessId } from "../src/core/types.ts";
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
      assert.equal(
        settings.hooks.PreToolUse[0].matcher,
        "Write|Edit|MultiEdit|NotebookEdit|Bash"
      );
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].type, "command");
      assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes("hook pre-tool-use"));
      assert.equal(settings.hooks.Stop[0].matcher, "");
      assert.equal(settings.hooks.Stop[0].hooks[0].type, "command");
      assert.ok(settings.hooks.Stop[0].hooks[0].command.includes("hook stop"));

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
      assert.equal(parsed._asdVersion, ASD_VERSION);
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
      assert.ok(
        toml.includes('notify = ["node", "--no-warnings",') &&
          toml.includes('"hook", "stop", "--harness", "codex"]'),
        "Codex config.toml managed block must include notify hook"
      );
      assert.ok(
        toml.indexOf("notify =") < toml.indexOf("[mcp_servers."),
        "notify must appear before any [mcp_servers.*] table header"
      );
      assert.ok(!toml.includes("[mcp_servers.asd-core]"));
      assert.ok(toml.includes("[mcp_servers.context7]"));
      assert.ok(toml.includes("# <<< END MANAGED BY ASD-V2 <<<"));
    });

    test("Cursor targets exist and hooks.json uses nested { version: 1, hooks: {...} } schema", () => {
      const cursorDir = path.join(tmpHome, ".cursor");
      const hooksJsonPath = path.join(cursorDir, "hooks.json");
      assert.ok(fs.existsSync(hooksJsonPath));
      const parsedHooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
      assert.equal(parsedHooks.version, 1);
      assert.ok(parsedHooks.hooks && typeof parsedHooks.hooks === "object");
      assert.ok(Array.isArray(parsedHooks.hooks.sessionStart));
      assert.ok(Array.isArray(parsedHooks.hooks.preToolUse));
      assert.ok(Array.isArray(parsedHooks.hooks.beforeShellExecution));
      assert.ok(Array.isArray(parsedHooks.hooks.stop));
      assert.equal(parsedHooks.SessionStart, undefined);
      assert.equal(parsedHooks.PreToolUse, undefined);
      assert.equal(parsedHooks.Stop, undefined);
    });

    test("Antigravity targets exist and contain config/agents (with normalized models & subagent flags), skills, config/hooks.json, and MCP config", () => {
      const geminiDir = path.join(tmpHome, ".gemini");

      // 5 agents in ~/.gemini/config/agents/ (and legacy ~/.gemini/agents/ must not exist)
      assert.equal(fs.existsSync(path.join(geminiDir, "agents")), false);
      for (const role of AGENT_ROLES) {
        const agentFile = path.join(geminiDir, "config", "agents", `asd-${role}.md`);
        assert.ok(fs.existsSync(agentFile), `Missing agent: ${agentFile}`);
        const content = fs.readFileSync(agentFile, "utf8");
        assert.ok(content.includes("mainAgent: false"), `${role} must have mainAgent: false`);
        assert.ok(content.includes("subagent: true"), `${role} must have subagent: true`);
        if (role === "scout") {
          assert.ok(content.includes("model: flash_lite"), "scout must use normalized model: flash_lite");
        } else if (role === "architect" || role === "critic") {
          assert.ok(content.includes("model: pro"), `${role} must use normalized model: pro`);
        } else {
          assert.ok(content.includes("model: flash"), `${role} must use normalized model: flash`);
        }
      }

      // 5 skills
      for (const skill of ASD_SKILLS) {
        const skillFile = path.join(geminiDir, "skills", skill, "SKILL.md");
        assert.ok(fs.existsSync(skillFile), `Missing skill: ${skillFile}`);
      }

      // Legacy ~/.gemini/hooks.json is NOT created; consolidated in ~/.gemini/config/hooks.json
      assert.equal(fs.existsSync(path.join(geminiDir, "hooks.json")), false);
      const configHooksJson = path.join(geminiDir, "config", "hooks.json");
      assert.ok(fs.existsSync(configHooksJson));
      const hooks = JSON.parse(fs.readFileSync(configHooksJson, "utf8"));
      const tracker = hooks["asd-session-tracker"];
      assert.ok(tracker, "Missing asd-session-tracker hook group");
      assert.equal(tracker.PreInvocation, undefined, "PreInvocation should not be registered");
      assert.ok(tracker.PreToolUse?.length > 0);
      assert.equal(
        tracker.PreToolUse[0].matcher,
        "write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|run_command|invoke_subagent"
      );
      assert.ok(tracker.Stop?.length > 0);

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
      assert.equal(fs.existsSync(path.join(userHome, ".gemini", "config", "agents")), false);

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

    test("buildCodexManagedTomlBlock skips notify when unmanagedToml already defines notify", () => {
      const withCustomNotify = buildCodexManagedTomlBlock({
        unmanagedToml: 'model = "gpt-5"\nnotify = ["custom-notify"]\n',
        catalog: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } },
        nativeCapabilities: new Set(),
        asdCliPath: "/tmp/asd/src/cli/index.ts",
      });
      assert.equal(withCustomNotify.includes("notify ="), false);
      assert.ok(withCustomNotify.includes("[mcp_servers.context7]"));
    });

    test("syncRepoVersionStrings and syncHarnessConfigs never mutate repo README.md, README_ko.md, or historical version strings", async () => {
      const fixtureRepo = createTempDir("asd-test-repo-fixture-");
      const fixtureHome = createTempDir("asd-test-repo-home-");
      try {
        const readmeContent = "# ASD\nHistorical note: ASD v2.1.0 and (v2.2.0) release.\n";
        const readmeKoContent = "# ASD 한국어\n> **버전**: `2.1.0`\n이전 버전 ASD v2.1.0 (v2.2.0) 기록\n";
        fs.writeFileSync(path.join(fixtureRepo, "README.md"), readmeContent, "utf8");
        fs.writeFileSync(path.join(fixtureRepo, "README_ko.md"), readmeKoContent, "utf8");

        syncRepoVersionStrings(fixtureRepo);

        assert.equal(fs.readFileSync(path.join(fixtureRepo, "README.md"), "utf8"), readmeContent);
        assert.equal(fs.readFileSync(path.join(fixtureRepo, "README_ko.md"), "utf8"), readmeKoContent);

        const realReadmePath = path.resolve(process.cwd(), "README.md");
        const realReadmeKoPath = path.resolve(process.cwd(), "README_ko.md");
        const realReadmeBefore = fs.existsSync(realReadmePath)
          ? fs.readFileSync(realReadmePath, "utf8")
          : null;
        const realReadmeKoBefore = fs.existsSync(realReadmeKoPath)
          ? fs.readFileSync(realReadmeKoPath, "utf8")
          : null;

        await syncHarnessConfigs({ homeDir: fixtureHome, projectRoot: fixtureRepo, noPath: true });

        if (realReadmeBefore !== null) {
          assert.equal(fs.readFileSync(realReadmePath, "utf8"), realReadmeBefore);
        }
        if (realReadmeKoBefore !== null) {
          assert.equal(fs.readFileSync(realReadmeKoPath, "utf8"), realReadmeKoBefore);
        }
        assert.equal(fs.readFileSync(path.join(fixtureRepo, "README.md"), "utf8"), readmeContent);
        assert.equal(fs.readFileSync(path.join(fixtureRepo, "README_ko.md"), "utf8"), readmeKoContent);

        // Installed copies in homeDir receive the current ASD_VERSION
        const installedRouting = fs.readFileSync(
          path.join(fixtureHome, ".asd", "routing.jsonc"),
          "utf8"
        );
        const installedMcp = fs.readFileSync(
          path.join(fixtureHome, ".asd", "mcp.jsonc"),
          "utf8"
        );
        const installedSkill = fs.readFileSync(
          path.join(fixtureHome, ".claude", "skills", "asd", "SKILL.md"),
          "utf8"
        );
        assert.ok(installedRouting.includes(`"_asdVersion": "${ASD_VERSION}"`));
        assert.ok(installedMcp.includes(`"_asdVersion": "${ASD_VERSION}"`));
        assert.ok(installedSkill.includes(`ASD v${ASD_VERSION}`));
      } finally {
        removeTempDir(fixtureRepo);
        removeTempDir(fixtureHome);
      }
    });

    test("getSkillTemplate, generateAgentContent, and generateAllAgentsMarkdown enforce Protected .asd/ Directory & Official CLI-Only Rule", () => {
      const skillsToCheck = ["asd", "asd-plan", "asd-run", "asd-debate", "asd-debug", "handoff", "asd-handoff"];
      for (const skill of skillsToCheck) {
        const content = getSkillTemplate(skill);
        assert.ok(
          content.includes("Protected `.asd/` Directory & Official CLI-Only Rule"),
          `Skill '${skill}' must include Protected .asd/ Directory & Official CLI-Only Rule`
        );
        assert.ok(
          content.includes("IMMEDIATELY HALT"),
          `Skill '${skill}' must instruct agent to IMMEDIATELY HALT when no official CLI/MCP command exists`
        );
      }

      for (const role of AGENT_ROLES) {
        const agentMd = generateAgentContent(role);
        assert.ok(
          agentMd.includes("Protected `.asd/` Directory & Official CLI-Only Rule"),
          `Agent '${role}' must include Protected .asd/ Directory & Official CLI-Only Rule`
        );
        assert.ok(
          agentMd.includes("IMMEDIATELY HALT"),
          `Agent '${role}' must instruct agent to IMMEDIATELY HALT when no official CLI/MCP command exists`
        );
      }

      const allAgentsMd = generateAllAgentsMarkdown();
      assert.ok(allAgentsMd.includes("Protected `.asd/` Directory & Official CLI-Only Rule"));
      assert.ok(allAgentsMd.includes("IMMEDIATELY HALT"));
    });
  });
});

test("F19: Codex config.toml with user [table] sections places notify in root scope before any [table]", async () => {
  const f19Home = createTempDir("asd-f19-home-");
  try {
    const codexDir = path.join(f19Home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    // User config has [features] and [some_table] with a table-scoped notify = false
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      [
        'model = "gpt-5.4"',
        "",
        "[features]",
        "fast_apply = true",
        "notify = false",
      ].join("\n") + "\n",
      "utf8"
    );

    await syncHarnessConfigs({ homeDir: f19Home });

    const syncedToml = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
    const idxRootNotify = syncedToml.indexOf('notify = ["node"');
    const idxFeaturesTable = syncedToml.indexOf("[features]");

    assert.ok(idxRootNotify !== -1, "Managed root notify hook must be injected even if a table has notify = false");
    assert.ok(idxFeaturesTable !== -1, "User [features] table must be preserved");
    assert.ok(
      idxRootNotify < idxFeaturesTable,
      "Managed notify hook must appear in TOML root scope BEFORE [features]"
    );
  } finally {
    removeTempDir(f19Home);
  }
});

test("F20: OpenCode opencode.jsonc with comments is preserved and prevents duplicate catalog MCP servers across idempotent syncs", async () => {
  const f20Home = createTempDir("asd-f20-home-");
  try {
    const opencodeDir = path.join(f20Home, ".config", "opencode");
    fs.mkdirSync(opencodeDir, { recursive: true });
    const originalJsonc = [
      "// User OpenCode JSONC config with comments",
      "{",
      "  \"model\": \"openai/gpt-5.4\",",
      "  // User already configured context7 in opencode.jsonc",
      "  \"mcp\": {",
      "    \"context7\": { \"type\": \"local\", \"command\": [\"custom-c7\"] },",
      "  },",
      "  \"mcpServers\": {",
      "    \"grep_app\": { \"url\": \"https://custom.grep.app/mcp\" },",
      "  },",
      "}",
    ].join("\n") + "\n";
    const jsoncPath = path.join(opencodeDir, "opencode.jsonc");
    fs.writeFileSync(jsoncPath, originalJsonc, "utf8");

    const firstSync = await syncHarnessConfigs({ homeDir: f20Home });
    assert.equal(firstSync.status, "updated");

    // 1. opencode.jsonc is preserved intact (including comments)
    assert.equal(fs.readFileSync(jsoncPath, "utf8"), originalJsonc);

    // 2. opencode.json exists and does NOT duplicate context7 or grep_app from opencode.jsonc
    const jsonPath = path.join(opencodeDir, "opencode.json");
    assert.ok(fs.existsSync(jsonPath));
    const syncedJson = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.equal(syncedJson.mcpServers.context7, undefined, "context7 in opencode.jsonc mcp must not be duplicated");
    assert.equal(syncedJson.mcpServers.grep_app, undefined, "grep_app in opencode.jsonc mcpServers must not be duplicated");
    assert.ok(syncedJson.mcpServers.websearch, "Remaining catalog server websearch must be injected");

    // 3. Second sync is idempotent (skipped)
    const secondSync = await syncHarnessConfigs({ homeDir: f20Home });
    assert.equal(secondSync.harnesses.opencode.status, "skipped");
    assert.equal(secondSync.harnesses.opencode.skipped, true);
  } finally {
    removeTempDir(f20Home);
  }
});

test("Runtime Isolation: syncHarnessConfigs stages isolated runtime copy and wires all harness hooks to the isolated runtime path", async () => {
  const isoHome = createTempDir("asd-iso-home-");
  const customRuntimeDir = createTempDir("asd-iso-runtime-");
  try {
    const res = await syncHarnessConfigs({
      homeDir: isoHome,
      runtimeDir: customRuntimeDir,
    });
    assert.equal(res.status, "updated");

    const expectedCliPath = path.join(customRuntimeDir, "src", "cli", "index.ts");
    assert.ok(fs.existsSync(expectedCliPath), "Staged CLI entrypoint must exist in isolated runtimeDir");
    assert.ok(fs.existsSync(path.join(customRuntimeDir, "package.json")), "Staged package.json must exist");

    const claudeSettings = JSON.parse(
      fs.readFileSync(path.join(isoHome, ".claude", "settings.json"), "utf8")
    );
    const claudeHookCmd = claudeSettings.hooks.PreToolUse[0].hooks[0].command;
    assert.ok(
      claudeHookCmd.includes(expectedCliPath),
      `Claude PreToolUse hook (${claudeHookCmd}) must point to isolated runtime (${expectedCliPath})`
    );
    assert.equal(
      claudeHookCmd.includes(process.cwd()),
      false,
      "Claude hook must NOT point directly to live development repository"
    );
  } finally {
    removeTempDir(isoHome);
    removeTempDir(customRuntimeDir);
  }
});

test("v2.4.2 Auto-Migration: syncHarnessConfigs upgrades legacy (< 2.4.2) ~/.asd/routing.jsonc with lightSubagents while preserving user agents & categories", async () => {
  const migHome = createTempDir("asd-mig-home-");
  try {
    const asdDir = path.join(migHome, ".asd");
    fs.mkdirSync(asdDir, { recursive: true });
    const legacyRouting = {
      _asdVersion: "2.2.0",
      agents: {
        worker: {
          harness: "opencode",
          model: "nvidia/z-ai/glm-5.3-flash",
          modelFamily: "glm",
          fallbacks: [{ harness: "antigravity", model: "gemini-3.8-flash", modelFamily: "gemini" }],
        },
      },
      categories: {
        general: {
          harness: "opencode",
          model: "nvidia/z-ai/glm-5.3-flash",
          modelFamily: "glm",
        },
      },
    };
    const routingPath = path.join(asdDir, "routing.jsonc");
    fs.writeFileSync(routingPath, JSON.stringify(legacyRouting, null, 2), "utf8");

    await syncHarnessConfigs({ homeDir: migHome, noPath: true });

    const migratedRaw = fs.readFileSync(routingPath, "utf8");
    const migrated = JSON.parse(
      migratedRaw
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n")
    );
    assert.equal(migrated._asdVersion, "2.4.2");
    assert.ok(migrated.lightSubagents, "Migrated routing.jsonc must include lightSubagents block");
    assert.ok(migrated.lightSubagents.antigravity, "Migrated lightSubagents must include antigravity");
    assert.equal(
      migrated.agents.worker.model,
      "nvidia/z-ai/glm-5.3-flash",
      "User custom agents.worker must be preserved intact"
    );
    assert.equal(
      migrated.categories.general.model,
      "nvidia/z-ai/glm-5.3-flash",
      "User custom categories.general must be preserved intact"
    );
  } finally {
    removeTempDir(migHome);
  }
});
