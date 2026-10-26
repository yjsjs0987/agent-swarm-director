/**
 * Tests for ASD v2.2 Built-in LSP Engine, Standalone LSP MCP Server,
 * and Capability-Aware Gap-Filling MCP Sync (tests/lsp-and-mcp-sync.test.ts).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, test } from "node:test";

import {
  syncHarnessConfigs,
  uninstallHarnessConfigs,
} from "../src/adapters/installer.ts";
import {
  detectLanguage,
  extractSymbols,
  findDefinition,
  findReferences,
  parseTscOutput,
  runDiagnostics,
} from "../src/core/lsp.ts";
import { ASD_LSP_MCP_TOOLS, createAsdLspMcpServer } from "../src/mcp/lsp-server.ts";
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

describe("1. Core LSP & Code Intelligence Engine (`src/core/lsp.ts`)", () => {
  let tmpProj: string;

  before(() => {
    tmpProj = createTempDir("asd-test-lsp-proj-");
    fs.writeFileSync(
      path.join(tmpProj, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }, null, 2)
    );
    fs.mkdirSync(path.join(tmpProj, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProj, "src", "math.ts"),
      [
        "export interface CalcOptions {",
        "  precision: number;",
        "}",
        "",
        "export type CalcResult = number;",
        "",
        "export class Calculator {",
        "  add(a: number, b: number): CalcResult {",
        "    return computeSum(a, b);",
        "  }",
        "}",
        "",
        "export function computeSum(x: number, y: number): CalcResult {",
        "  return x + y;",
        "}",
        "",
        "export const DEFAULT_PRECISION = 2;",
      ].join("\n"),
      "utf8"
    );
  });

  after(() => {
    removeTempDir(tmpProj);
  });

  test("detects TypeScript language from file extension and tsconfig.json", () => {
    assert.equal(detectLanguage(tmpProj, "src/math.ts"), "typescript");
    assert.equal(detectLanguage(tmpProj), "typescript");
    assert.equal(detectLanguage(tmpProj, "script.py"), "python");
    assert.equal(detectLanguage(tmpProj, "main.go"), "go");
    assert.equal(detectLanguage(tmpProj, "lib.rs"), "rust");
  });

  test("extracts symbols (interface, type, class, function, variable)", () => {
    const symbols = extractSymbols({ projectRoot: tmpProj });
    const names = symbols.map((s) => `${s.kind}:${s.name}`);
    assert.ok(names.includes("interface:CalcOptions"));
    assert.ok(names.includes("type:CalcResult"));
    assert.ok(names.includes("class:Calculator"));
    assert.ok(names.includes("function:computeSum"));
    assert.ok(names.includes("variable:DEFAULT_PRECISION"));
  });

  test("finds exact symbol definition with file, line, and column", () => {
    const defs = findDefinition({ projectRoot: tmpProj, symbol: "computeSum" });
    assert.equal(defs.length, 1);
    assert.equal(defs[0]!.file, "src/math.ts");
    assert.equal(defs[0]!.kind, "function");
    assert.equal(defs[0]!.line, 13);
    assert.ok(defs[0]!.preview.includes("export function computeSum"));
  });

  test("finds all symbol references and marks definition site", () => {
    const refs = findReferences({ projectRoot: tmpProj, symbol: "computeSum" });
    assert.equal(refs.length, 2);
    const callSite = refs.find((r) => !r.isDefinition);
    const defSite = refs.find((r) => r.isDefinition);
    assert.ok(callSite);
    assert.ok(defSite);
    assert.equal(callSite.line, 9);
    assert.equal(defSite.line, 13);
  });

  test("parses tsc diagnostic lines and runs syntax diagnostics cleanly", () => {
    const rawTsc =
      "src/math.ts(9,12): error TS2304: Cannot find name 'unknownVar'.\n" +
      "src/math.ts(14,3): warning TS6133: 'unused' is declared but its value is never read.";
    const parsed = parseTscOutput(rawTsc, tmpProj);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], {
      file: "src/math.ts",
      line: 9,
      column: 12,
      severity: "error",
      code: "TS2304",
      message: "Cannot find name 'unknownVar'.",
    });

    const diagRes = runDiagnostics({ projectRoot: tmpProj });
    assert.equal(diagRes.ok, true);
    assert.equal(diagRes.diagnostics.length, 0);
  });
});

describe("2. Standalone LSP MCP Server (`src/mcp/lsp-server.ts`)", () => {
  let tmpProj: string;

  before(() => {
    tmpProj = createTempDir("asd-test-lsp-mcp-");
    fs.writeFileSync(
      path.join(tmpProj, "index.ts"),
      "export function greetUser(name: string): string {\n  return `Hello ${name}`;\n}\n",
      "utf8"
    );
  });

  after(() => {
    removeTempDir(tmpProj);
  });

  test("asd-core does not contain duplicate LSP tools, while asd-lsp exposes 4 LSP tools", () => {
    const coreToolNames = ASD_MCP_TOOLS.map((t) => t.name);
    assert.ok(!coreToolNames.some((n) => n.startsWith("lsp_")));

    const lspToolNames = ASD_LSP_MCP_TOOLS.map((t) => t.name);
    assert.deepEqual(lspToolNames, [
      "lsp_diagnostics",
      "lsp_symbols",
      "lsp_definition",
      "lsp_references",
    ]);
  });

  test("serves initialize, tools/list, and tools/call over JSON-RPC protocol", async () => {
    const server = createAsdLspMcpServer({ projectRoot: tmpProj });

    const initRes = (await server.handleRequest("initialize", {})) as {
      serverInfo: { name: string };
    };
    assert.equal(initRes.serverInfo.name, "asd-lsp");

    const listRes = (await server.handleRequest("tools/list", {})) as {
      tools: Array<{ name: string }>;
    };
    assert.equal(listRes.tools.length, 4);

    const defCall = (await server.handleRequest("tools/call", {
      name: "lsp_definition",
      arguments: { symbol: "greetUser" },
    })) as {
      structuredContent: { count: number; definitions: Array<{ file: string; line: number }> };
    };
    assert.equal(defCall.structuredContent.count, 1);
    assert.equal(defCall.structuredContent.definitions[0]!.file, "index.ts");
    assert.equal(defCall.structuredContent.definitions[0]!.line, 1);
  });
});

describe("3. Capability-Aware & Dedup Gap-Filling MCP Sync", () => {
  test("fills ONLY missing capabilities per harness on a clean home directory", async () => {
    const cleanHome = createTempDir("asd-test-gapfill-clean-");
    try {
      await syncHarnessConfigs({ homeDir: cleanHome });

      // 1. Claude Code: has native `websearch` -> gets `asd-core`, `lsp`, `context7`, `grep_app` (NO `websearch`)
      const claudeJson = JSON.parse(
        fs.readFileSync(path.join(cleanHome, ".claude.json"), "utf8")
      );
      assert.ok(claudeJson.mcpServers["asd-core"]);
      assert.ok(claudeJson.mcpServers["lsp"]);
      assert.ok(claudeJson.mcpServers["context7"]);
      assert.equal(claudeJson.mcpServers["context7"].type, "http");
      assert.ok(claudeJson.mcpServers["grep_app"]);
      assert.equal(claudeJson.mcpServers["websearch"], undefined);

      // 2. OpenCode: has native `lsp` -> gets `asd-core`, `context7`, `grep_app`, `websearch` (NO `lsp`)
      const opencodeJson = JSON.parse(
        fs.readFileSync(path.join(cleanHome, ".config", "opencode", "opencode.json"), "utf8")
      );
      assert.ok(opencodeJson.mcpServers["asd-core"]);
      assert.ok(opencodeJson.mcpServers["context7"]);
      assert.ok(opencodeJson.mcpServers["grep_app"]);
      assert.ok(opencodeJson.mcpServers["websearch"]);
      assert.equal(opencodeJson.mcpServers["lsp"], undefined);

      // 3. Codex: has native `websearch` -> gets `asd-core`, `lsp`, `context7`, `grep_app` (NO `websearch`)
      const codexToml = fs.readFileSync(
        path.join(cleanHome, ".codex", "config.toml"),
        "utf8"
      );
      assert.ok(codexToml.includes("[mcp_servers.asd-core]"));
      assert.ok(codexToml.includes("[mcp_servers.lsp]"));
      assert.ok(codexToml.includes("[mcp_servers.context7]"));
      assert.ok(codexToml.includes("[mcp_servers.grep_app]"));
      assert.ok(!codexToml.includes("[mcp_servers.websearch]"));

      // 4. Antigravity (clean): has native `websearch` -> gets `asd-core`, `lsp`, `context7`, `grep_app` with `serverUrl` (NO `websearch`)
      const geminiMcp = JSON.parse(
        fs.readFileSync(path.join(cleanHome, ".gemini", "mcp_config.json"), "utf8")
      );
      assert.ok(geminiMcp.mcpServers["asd-core"]);
      assert.ok(geminiMcp.mcpServers["lsp"]);
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
      // Simulate user's OMO-for-AGY ~/.gemini/config/mcp_config.json having context7, grep_app, websearch, lsp
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
              lsp: { command: "node", args: ["custom-lsp.js"] },
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

      // Antigravity mcp_config.json should ONLY have `asd-core` because context7, grep_app, websearch, lsp already exist in ~/.gemini/config/mcp_config.json
      const geminiMcp = JSON.parse(
        fs.readFileSync(path.join(omoHome, ".gemini", "mcp_config.json"), "utf8")
      );
      assert.deepEqual(Object.keys(geminiMcp.mcpServers), ["asd-core"]);

      // Codex config.toml should keep user's custom context7 and NOT duplicate it inside the fence
      const codexToml = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
      const matches = codexToml.match(/\[mcp_servers\.context7\]/g) ?? [];
      assert.equal(matches.length, 1, "context7 should appear only once in config.toml");
      assert.ok(codexToml.includes("https://custom.context7.local/mcp"));
      assert.ok(codexToml.includes("[mcp_servers.asd-core]"));
      assert.ok(codexToml.includes("[mcp_servers.lsp]"));
      assert.ok(codexToml.includes("[mcp_servers.grep_app]"));

      // Uninstall cleanly removes all ASD-managed entries while preserving user entries
      await uninstallHarnessConfigs({ homeDir: omoHome });
      const restoredToml = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
      assert.ok(restoredToml.includes("https://custom.context7.local/mcp"));
      assert.ok(!restoredToml.includes("[mcp_servers.asd-core]"));
    } finally {
      removeTempDir(omoHome);
    }
  });
});
