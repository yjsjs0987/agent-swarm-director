/**
 * Tests for ASD v2.2 Core MCP Schema & Capability-Aware Gap-Filling MCP Sync
 * (tests/lsp-and-mcp-sync.test.ts).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import {
  syncHarnessConfigs,
  uninstallHarnessConfigs,
} from "../src/adapters/installer.ts";
import { ASD_MCP_TOOLS } from "../src/mcp/server.ts";

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

describe("1. Core MCP Tools Surface (`src/mcp/server.ts`)", () => {
  test("asd-core exposes only the 4 orchestration tools without fake regex LSP bloat", () => {
    const coreToolNames = ASD_MCP_TOOLS.map((t) => t.name);
    assert.deepEqual(coreToolNames, [
      "asd_plan",
      "asd_dispatch",
      "asd_verify",
      "asd_debate",
    ]);
    assert.ok(!coreToolNames.some((n) => n.startsWith("lsp_")));
  });
});

describe("2. Capability-Aware & Dedup Gap-Filling MCP Sync", () => {
  test("fills ONLY missing capabilities per harness on a clean home directory", async () => {
    const cleanHome = createTempDir("asd-test-gapfill-clean-");
    try {
      await syncHarnessConfigs({ homeDir: cleanHome });

      // 1. Claude Code: has native `websearch` -> gets `context7`, `grep_app` (NO `websearch`, NO `asd-core`)
      const claudeJson = JSON.parse(
        fs.readFileSync(path.join(cleanHome, ".claude.json"), "utf8")
      );
      assert.equal(claudeJson.mcpServers["asd-core"], undefined);
      assert.equal(claudeJson.mcpServers["lsp"], undefined);
      assert.ok(claudeJson.mcpServers["context7"]);
      assert.equal(claudeJson.mcpServers["context7"].type, "http");
      assert.ok(claudeJson.mcpServers["grep_app"]);
      assert.equal(claudeJson.mcpServers["websearch"], undefined);

      // 2. OpenCode: has native `lsp` -> gets `context7`, `grep_app`, `websearch` (NO `lsp`, NO `asd-core`)
      const opencodeJson = JSON.parse(
        fs.readFileSync(path.join(cleanHome, ".config", "opencode", "opencode.json"), "utf8")
      );
      assert.equal(opencodeJson.mcpServers["asd-core"], undefined);
      assert.ok(opencodeJson.mcpServers["context7"]);
      assert.ok(opencodeJson.mcpServers["grep_app"]);
      assert.ok(opencodeJson.mcpServers["websearch"]);
      assert.equal(opencodeJson.mcpServers["lsp"], undefined);

      // 3. Codex: has native `websearch` -> gets `context7`, `grep_app` (NO `websearch`, NO `asd-core`)
      const codexToml = fs.readFileSync(
        path.join(cleanHome, ".codex", "config.toml"),
        "utf8"
      );
      assert.ok(!codexToml.includes("[mcp_servers.asd-core]"));
      assert.ok(!codexToml.includes("[mcp_servers.lsp]"));
      assert.ok(codexToml.includes("[mcp_servers.context7]"));
      assert.ok(codexToml.includes("[mcp_servers.grep_app]"));
      assert.ok(!codexToml.includes("[mcp_servers.websearch]"));

      // 4. Antigravity (clean): has native `websearch` -> gets `context7`, `grep_app` with `serverUrl` (NO `websearch`, NO `asd-core`)
      const geminiMcp = JSON.parse(
        fs.readFileSync(path.join(cleanHome, ".gemini", "mcp_config.json"), "utf8")
      );
      assert.equal(geminiMcp.mcpServers["asd-core"], undefined);
      assert.equal(geminiMcp.mcpServers["lsp"], undefined);
      assert.equal(
        geminiMcp.mcpServers["context7"].serverUrl,
        "https://mcp.context7.com/mcp"
      );
      assert.ok(geminiMcp.mcpServers["grep_app"]);
      assert.equal(geminiMcp.mcpServers["websearch"], undefined);
    } finally {
      removeTempDir(cleanHome);
    }
  });

  test("skips MCP entries already present in user/OMO configs (zero duplication)", async () => {
    const omoHome = createTempDir("asd-test-gapfill-omo-");
    try {
      // Simulate user's OMO-for-AGY ~/.gemini/config/mcp_config.json having context7, grep_app, websearch
      const geminiConfigDir = path.join(omoHome, ".gemini", "config");
      fs.mkdirSync(geminiConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(geminiConfigDir, "mcp_config.json"),
        JSON.stringify(
          {
            mcpServers: {
              context7: { serverUrl: "https://mcp.context7.com/mcp" },
              grep_app: { serverUrl: "https://mcp.grep.app" },
              websearch: { serverUrl: "https://mcp.exa.ai/mcp?tools=web_search_exa" },
            },
          },
          null,
          2
        )
      );

      // Simulate user's Codex config.toml already having [mcp_servers.context7]
      const codexDir = path.join(omoHome, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(
        path.join(codexDir, "config.toml"),
        '[mcp_servers.context7]\nurl = "https://custom.context7.local/mcp"\n'
      );

      await syncHarnessConfigs({ homeDir: omoHome });

      // Antigravity mcp_config.json should have 0 duplicated entries because context7, grep_app, websearch already exist in ~/.gemini/config/mcp_config.json
      const geminiMcp = JSON.parse(
        fs.readFileSync(path.join(omoHome, ".gemini", "mcp_config.json"), "utf8")
      );
      assert.deepEqual(Object.keys(geminiMcp.mcpServers), []);

      // Codex config.toml should keep user's custom context7 and NOT duplicate it inside the fence
      const codexToml = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
      const matches = codexToml.match(/\[mcp_servers\.context7\]/g) ?? [];
      assert.equal(matches.length, 1, "context7 should appear only once in config.toml");
      assert.ok(codexToml.includes("https://custom.context7.local/mcp"));
      assert.ok(!codexToml.includes("[mcp_servers.asd-core]"));
      assert.ok(codexToml.includes("[mcp_servers.grep_app]"));

      // Uninstall cleanly removes all ASD-managed entries while preserving user entries
      await uninstallHarnessConfigs({ homeDir: omoHome });
      const restoredToml = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
      assert.ok(restoredToml.includes("https://custom.context7.local/mcp"));
      assert.ok(!restoredToml.includes("[mcp_servers.grep_app]"));
    } finally {
      removeTempDir(omoHome);
    }
  });
});
