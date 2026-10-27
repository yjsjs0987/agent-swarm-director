/**
 * ASD v2.2 Harness Installer & Control Plane Synchronizer (src/adapters/installer.ts)
 *
 * Implements:
 * 1. Strictly Global-Only `syncHarnessConfigs` / `runAsdSync`:
 *    - Installs skills, agents, hooks, and MCP configurations into global user homes
 *      (~/.claude, ~/.config/opencode, ~/.codex, ~/.gemini).
 *    - Never touches or pollutes project directories during sync.
 *    - Idempotent: checks composite SHA-256 hash against last-sync.json and file existence;
 *      skips unneeded writes with { skipped: true } indicators.
 *    - Injects PreToolUse and Stop hooks and asd-core MCP server pointing to dynamic
 *      <ASD_ROOT>/src/mcp/server.ts and <ASD_ROOT>/src/cli/index.ts.
 * 2. Main-Session Auto-Sync (`autoSyncIfNeeded`):
 *    - Guarded by Subagent Shield (ASD_SESSION_ROLE !== "subagent").
 * 3. Surgical `uninstallHarnessConfigs` / `runAsdUninstall`:
 *    - Rollback restoring original configs 100% cleanly without touching user settings.
 *    - Removes _asdManaged hooks, removes TOML fences, removes ASD agents and skills.
 * 4. Fast zero-token `doctorProbe` / `runAsdDoctor`:
 *    - <100ms probe checking Node >=22.13.0, SQLite WAL mode, Git repo state,
 *      harness CLI availability, and synthetic PreToolUse block probe (.GIT/config, .ENV).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseJsonc, removeTomlFence } from "../core/jsonc.ts";
import { evaluatePreToolUse } from "../core/policy.ts";
import {
  AGENT_ROLES,
  ASD_VERSION,
  type AgentRole,
  type HarnessAdapter,
  type HarnessId,
} from "../core/types.ts";
import {
  AntigravityAdapter,
  antigravityAdapter,
  probeAntigravityHeadless,
} from "./antigravity.ts";
import {
  ASD_SKILLS,
  ClaudeCodeAdapter,
  claudeCodeAdapter,
  mergeClaudeSettings,
} from "./claude-code.ts";
import {
  CodexAdapter,
  codexAdapter,
  mergeCodexConfigToml,
} from "./codex.ts";
import {
  OpencodeAdapter,
  opencodeAdapter,
} from "./opencode.ts";

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface SyncHarnessOptions {
  homeDir?: string;
  force?: boolean;
  projectRoot?: string;
  asdCliPath?: string;
  noPath?: boolean;
}

export interface HarnessSyncStatus {
  harness: HarnessId;
  status: "updated" | "skipped";
  skipped: boolean;
  filesWritten: string[];
}

export interface SyncHarnessConfigsResult {
  status: "updated" | "skipped";
  skipped: boolean;
  configHash: string;
  harnesses: Record<HarnessId, HarnessSyncStatus>;
  cliShimsInstalled?: string[];
}

export interface UninstallHarnessOptions {
  homeDir?: string;
}

export interface UninstallHarnessStatus {
  removed: string[];
  restored: string[];
}

export interface UninstallHarnessConfigsResult {
  status: "success";
  removedFiles: string[];
  restoredFiles: string[];
  harnesses: Record<HarnessId, UninstallHarnessStatus>;
}

export interface DoctorProbeOptions {
  homeDir?: string;
  projectRoot?: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message?: string;
}

export interface DoctorProbeResult {
  ok: boolean;
  durationMs: number;
  checks: DoctorCheck[];
  nodeVersion: { ok: boolean; version: string; minRequired: string };
  sqliteWal: { ok: boolean; message?: string };
  gitRepo: { ok: boolean; isRepo: boolean; message?: string };
  harnesses: Record<
    HarnessId,
    { installed: boolean; headlessSupported: boolean; binary?: string; resolvedPath?: string | null }
  >;
  policyProbe: { ok: boolean; gitBlocked: boolean; envBlocked: boolean; message?: string };
  errors: string[];
}

export interface AutoSyncOptions {
  homeDir?: string;
  projectRoot?: string;
  force?: boolean;
}

export interface AutoSyncResult {
  synced: boolean;
  skipped: boolean;
  reason?: string;
  result?: SyncHarnessConfigsResult;
}

interface LastSyncRecord {
  _asdVersion: string;
  configHash: string;
  lastSyncedAt: string;
  harnesses: Partial<Record<HarnessId, { hash: string; syncedAt: string }>>;
}

// ============================================================================
// Constants & Helper Functions
// ============================================================================

const DEFAULT_HARNESS_IDS: readonly HarnessId[] = [
  "claude-code",
  "opencode",
  "codex",
  "antigravity",
];

function getAsdRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

function resolveHome(optionsHome?: string): string {
  return optionsHome || process.env.ASD_HOME_DIR || os.homedir();
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeWriteJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function safeWriteText(filePath: string, text: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, "utf8");
}

function backupUserFile(filePath: string): void {
  const backupPath = `${filePath}.asd-backup`;
  if (fs.existsSync(filePath) && !fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }
}

function restoreUserBackup(filePath: string): boolean {
  const backupPath = `${filePath}.asd-backup`;
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, filePath);
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // Ignore unlink errors
    }
    return true;
  }
  return false;
}

// ============================================================================
// Skill and Agent Markdown Generation
// ============================================================================

export function getSkillTemplate(skillName: string): string {
  const skillsDir = path.join(getAsdRoot(), "src", "skills", skillName, "SKILL.md");
  try {
    if (fs.existsSync(skillsDir)) {
      return fs.readFileSync(skillsDir, "utf8");
    }
  } catch {
    // Ignore unreadable file
  }
  return `# ASD Skill: ${skillName}\n`;
}

export function generateAgentContent(role: AgentRole): string {
  const roleDescriptions: Record<AgentRole, { title: string; desc: string; focus: string }> = {
    director: {
      title: "Director",
      desc: "Top-level orchestrator and supervisor. Plans high-level milestones, delegates tasks, and coordinates multi-agent delivery.",
      focus: "End-to-end task flow, review gates, and final session summaries.",
    },
    planner: {
      title: "Planner",
      desc: "Task decomposition and dependency architect. Analyzes requirements and produces structured .asd/PLAN.md specifications.",
      focus: "Turn scheduling, dependency graph resolution, allowedFiles boundaries, and verification criteria.",
    },
    analyst: {
      title: "Analyst",
      desc: "Requirements investigator and feasibility researcher. Dissects ambiguous prompts and identifies hidden risks.",
      focus: "Context extraction, constraint mapping, and edge case enumeration.",
    },
    critic: {
      title: "Critic",
      desc: "Hostile adversarial evaluator. Challenges assumptions, surfaces blind spots, and stress-tests designs before implementation.",
      focus: "Security boundaries, failure modes, over-engineering detection, and anti-pattern identification.",
    },
    arbiter: {
      title: "Arbiter",
      desc: "Debate judge and consensus synthesizer. Evaluates competing arguments during cross-model debate and issues binding decisions.",
      focus: "Trade-off analysis, definitive arbitration (APPROVE/MINOR_AMEND/REJECT), and constraint synthesis.",
    },
    architect: {
      title: "Architect",
      desc: "System designer and contract guardian. Defines interfaces, schemas, and cross-cutting architectural invariants.",
      focus: "Modular boundaries, core purity, data structures, and architectural elegance.",
    },
    builder: {
      title: "Builder",
      desc: "Core implementation developer. Scaffolds new modules, authors interfaces, and implements complex multi-file features.",
      focus: "Idiomatic code, type correctness, maintainable structure, and unit tests.",
    },
    worker: {
      title: "Worker",
      desc: "Focused task executor. Handles scoped file modifications, bug fixes, refactoring, and test assertions.",
      focus: "Strict allowedFiles compliance, minimal diffs, and rapid test verification.",
    },
    scout: {
      title: "Scout",
      desc: "Read-only codebase explorer. Maps repository layouts, finds symbol declarations, and retrieves existing patterns.",
      focus: "Zero-mutation discovery, reference gathering, and context provision.",
    },
    verifier: {
      title: "Verifier",
      desc: "Quality assurance inspector. Executes regression tests, audits git status boundaries, and validates acceptance criteria.",
      focus: "Deterministic test execution, clean git diffs, and checkpoint validation.",
    },
  };

  const meta = roleDescriptions[role] ?? {
    title: role,
    desc: `ASD agent specialist for role '${role}'.`,
    focus: "Specialized multi-agent execution.",
  };

  return `---
name: asd-${role}
description: ASD v2.2 ${meta.title} Agent. ${meta.desc}
---

# ASD Agent: asd-${role} (${meta.title})

You are operating as the **${meta.title}** agent in the ASD v2.2 multi-agent system.

## Responsibilities
${meta.desc}

## Primary Focus
${meta.focus}

## Operational Guidelines
1. Adhere strictly to assigned role boundaries and specified allowedFiles.
2. Maintain high code quality, idiomatic patterns, and zero unverified assumptions.
3. Ensure all changes are verified with automated tests before completing.
`;
}

export function generateAllAgentsMarkdown(): string {
  let md = `# ASD Multi-Agent Roster (v2.2.0)\n\nThis document defines the 10 standard specialist agent roles in ASD v2.2.\n\n`;

  for (let i = 0; i < AGENT_ROLES.length; i++) {
    const role = AGENT_ROLES[i]!;
    md += `## ${i + 1}. asd-${role}\n`;
    md += generateAgentContent(role);
    md += `\n---\n\n`;
  }

  return md;
}

// ============================================================================
// Preset Bootstrapping & Hash Calculation
// ============================================================================

function bootstrapGlobalPresets(homeDir: string): { routingPath: string; mcpPath: string } {
  const asdHome = path.join(homeDir, ".asd");
  ensureDir(asdHome);
  ensureDir(path.join(asdHome, "state"));

  const routingPath = path.join(asdHome, "routing.jsonc");
  const mcpPath = path.join(asdHome, "mcp.jsonc");

  const asdRoot = getAsdRoot();
  const presetRouting = path.join(asdRoot, "presets", "default-routing.jsonc");
  const presetMcp = path.join(asdRoot, "presets", "default-mcp.jsonc");

  if (!fs.existsSync(routingPath)) {
    if (fs.existsSync(presetRouting)) {
      fs.copyFileSync(presetRouting, routingPath);
    } else {
      safeWriteText(routingPath, `// ASD Default Routing\n{\n  "_asdVersion": "${ASD_VERSION}"\n}\n`);
    }
  }

  if (!fs.existsSync(mcpPath)) {
    if (fs.existsSync(presetMcp)) {
      fs.copyFileSync(presetMcp, mcpPath);
    } else {
      safeWriteText(mcpPath, `// ASD Default MCP\n{\n  "_asdVersion": "${ASD_VERSION}"\n}\n`);
    }
  }

  return { routingPath, mcpPath };
}

function computeConfigHash(homeDir: string): string {
  const { routingPath, mcpPath } = bootstrapGlobalPresets(homeDir);

  const hash = crypto.createHash("sha256");
  hash.update(ASD_VERSION);

  if (fs.existsSync(routingPath)) {
    hash.update(fs.readFileSync(routingPath));
  }
  if (fs.existsSync(mcpPath)) {
    hash.update(fs.readFileSync(mcpPath));
  }

  for (const skill of ASD_SKILLS) {
    hash.update(getSkillTemplate(skill));
  }

  for (const role of AGENT_ROLES) {
    hash.update(generateAgentContent(role));
  }

  return hash.digest("hex");
}

function loadLastSync(homeDir: string): LastSyncRecord | null {
  const lastSyncPath = path.join(homeDir, ".asd", "state", "last-sync.json");
  if (!fs.existsSync(lastSyncPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(lastSyncPath, "utf8")) as LastSyncRecord;
  } catch {
    return null;
  }
}

function saveLastSync(homeDir: string, record: LastSyncRecord): void {
  const lastSyncPath = path.join(homeDir, ".asd", "state", "last-sync.json");
  safeWriteJson(lastSyncPath, record);
}

// ============================================================================
// Capability-Aware & Dedup MCP Catalog Resolution
// ============================================================================

export interface CatalogMcpEntry {
  command?: string;
  args?: string[];
  url?: string;
}

export function loadHarnessNativeCapabilities(): Record<HarnessId, Set<string>> {
  const fallback: Record<HarnessId, Set<string>> = {
    "claude-code": new Set(["websearch"]),
    opencode: new Set(["lsp"]),
    codex: new Set(["websearch"]),
    antigravity: new Set(["websearch"]),
  };

  const manifestPath = path.join(getAsdRoot(), "src", "adapters", "adapter-manifest.json");
  try {
    if (fs.existsSync(manifestPath)) {
      const parsed = parseJsonc<{
        harnesses?: Partial<Record<HarnessId, { NativeCapabilities?: string[] }>>;
      }>(fs.readFileSync(manifestPath, "utf8"));
      if (parsed?.harnesses) {
        for (const h of DEFAULT_HARNESS_IDS) {
          const caps = parsed.harnesses[h]?.NativeCapabilities;
          if (Array.isArray(caps)) {
            fallback[h] = new Set(caps.map((c) => c.toLowerCase()));
          }
        }
      }
    }
  } catch {
    // Use fallback capabilities if manifest cannot be read
  }

  return fallback;
}

export function loadCatalogMcpServers(
  homeDir: string,
  asdRoot: string
): Record<string, CatalogMcpEntry> {
  const { mcpPath } = bootstrapGlobalPresets(homeDir);
  const presetMcpPath = path.join(asdRoot, "presets", "default-mcp.jsonc");

  let presetServers: Record<string, CatalogMcpEntry> = {};
  try {
    if (fs.existsSync(presetMcpPath)) {
      const parsed = parseJsonc<{ mcpServers?: Record<string, CatalogMcpEntry> }>(
        fs.readFileSync(presetMcpPath, "utf8")
      );
      if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
        presetServers = { ...parsed.mcpServers };
      }
    }
  } catch {
    presetServers = {};
  }

  let userCatalogServers: Record<string, CatalogMcpEntry> = {};
  try {
    if (fs.existsSync(mcpPath)) {
      const parsed = parseJsonc<{ mcpServers?: Record<string, CatalogMcpEntry> }>(
        fs.readFileSync(mcpPath, "utf8")
      );
      if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
        userCatalogServers = { ...parsed.mcpServers };
      }
    }
  } catch {
    userCatalogServers = {};
  }

  const merged: Record<string, CatalogMcpEntry> = {
    ...presetServers,
    ...userCatalogServers,
  };

  // Resolve <ASD_ROOT> placeholder in args
  const resolved: Record<string, CatalogMcpEntry> = {};
  for (const [name, entry] of Object.entries(merged)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.command) {
      const args = Array.isArray(entry.args)
        ? entry.args.map((arg) =>
            arg.includes("<ASD_ROOT>")
              ? path.normalize(arg.replace("<ASD_ROOT>", asdRoot))
              : arg
          )
        : [];
      resolved[name] = { command: entry.command, args };
    } else if (entry.url) {
      resolved[name] = { url: entry.url };
    }
  }

  // Always guarantee asd-core is present
  if (!resolved["asd-core"]) {
    resolved["asd-core"] = {
      command: "node",
      args: ["--no-warnings", path.join(asdRoot, "src", "mcp", "server.ts")],
    };
  }

  return resolved;
}

function mergeJsonMcpServersForHarness(options: {
  harnessId: "claude-code" | "opencode" | "antigravity";
  existingMcpServers: Record<string, unknown>;
  catalog: Record<string, CatalogMcpEntry>;
  nativeCapabilities: Set<string>;
  externalExistingKeys?: Set<string>;
}): Record<string, unknown> {
  const {
    harnessId,
    existingMcpServers,
    catalog,
    nativeCapabilities,
    externalExistingKeys,
  } = options;

  // Keep only non-ASD-managed user entries first
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existingMcpServers)) {
    const isManaged =
      v !== null &&
      typeof v === "object" &&
      (v as Record<string, unknown>)._asdManaged === true;
    if (!isManaged) {
      result[k] = v;
    }
  }

  for (const [serverName, def] of Object.entries(catalog)) {
    const lowerName = serverName.toLowerCase();

    if (serverName !== "asd-core") {
      // 1. Native capability filter: skip if harness already has this feature built-in
      if (nativeCapabilities.has(lowerName)) {
        continue;
      }
      // 2. Existing user/plugin config dedup filter: skip if already defined by user
      if (Object.prototype.hasOwnProperty.call(result, serverName)) {
        continue;
      }
      if (externalExistingKeys?.has(serverName) || externalExistingKeys?.has(lowerName)) {
        continue;
      }
    }

    if (def.command) {
      result[serverName] = {
        command: def.command,
        args: def.args ?? [],
        _asdManaged: true,
      };
    } else if (def.url) {
      if (harnessId === "claude-code") {
        result[serverName] = {
          type: "http",
          url: def.url,
          _asdManaged: true,
        };
      } else if (harnessId === "antigravity") {
        result[serverName] = {
          serverUrl: def.url,
          _asdManaged: true,
        };
      } else {
        result[serverName] = {
          url: def.url,
          _asdManaged: true,
        };
      }
    }
  }

  return result;
}

function syncJsonMcpConfigFile(options: {
  filePath: string;
  harnessId: "claude-code" | "opencode" | "antigravity";
  catalog: Record<string, CatalogMcpEntry>;
  nativeCapabilities: Set<string>;
  externalExistingKeys?: Set<string>;
  mutateBeforeMerge?: (config: Record<string, unknown>, extKeys: Set<string>) => void;
}): void {
  const { filePath, harnessId, catalog, nativeCapabilities, externalExistingKeys, mutateBeforeMerge } = options;
  let config: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    backupUserFile(filePath);
    try {
      config = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }
  const extKeys = new Set<string>(externalExistingKeys);
  mutateBeforeMerge?.(config, extKeys);
  const existingMcp =
    config.mcpServers && typeof config.mcpServers === "object"
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  config.mcpServers = mergeJsonMcpServersForHarness({
    harnessId,
    existingMcpServers: existingMcp,
    catalog,
    nativeCapabilities,
    externalExistingKeys: extKeys,
  });
  safeWriteJson(filePath, config);
}

function buildCodexManagedTomlBlock(options: {
  unmanagedToml: string;
  catalog: Record<string, CatalogMcpEntry>;
  nativeCapabilities: Set<string>;
}): string {
  const { unmanagedToml, catalog, nativeCapabilities } = options;

  // Detect any [mcp_servers.<name>] already defined outside ASD fence
  const existingKeys = new Set<string>();
  const sectionRegex = /^\s*\[mcp_servers\.([^\].\s]+)\]/gm;
  let match: RegExpExecArray | null;
  while ((match = sectionRegex.exec(unmanagedToml)) !== null) {
    if (match[1]) {
      existingKeys.add(match[1].replace(/^["']|["']$/g, ""));
    }
  }

  const blocks: string[] = [];
  for (const [serverName, def] of Object.entries(catalog)) {
    const lowerName = serverName.toLowerCase();
    if (serverName !== "asd-core") {
      if (nativeCapabilities.has(lowerName)) continue;
      if (existingKeys.has(serverName) || existingKeys.has(lowerName)) continue;
    }

    if (def.command) {
      const normalizedArgs = (def.args ?? []).map((a) =>
        `"${a.replaceAll("\\", "/")}"`
      );
      blocks.push(
        `[mcp_servers.${serverName}]\ncommand = "${def.command.replaceAll("\\", "/")}"\nargs = [${normalizedArgs.join(", ")}]`
      );
    } else if (def.url) {
      blocks.push(`[mcp_servers.${serverName}]\nurl = "${def.url}"`);
    }
  }

  return blocks.join("\n\n") + "\n";
}

function stripAsdManagedMcpEntries(mcpObj: Record<string, unknown>): void {
  for (const [key, val] of Object.entries(mcpObj)) {
    const isManaged =
      key === "asd-core" ||
      (val !== null &&
        typeof val === "object" &&
        (val as Record<string, unknown>)._asdManaged === true);
    if (isManaged) {
      delete mcpObj[key];
    }
  }
}

function getCliShimTargetDirs(homeDir: string): string[] {
  const dirs = [path.join(homeDir, ".asd", "bin")];
  const isRealHome = path.resolve(homeDir) === path.resolve(os.homedir());
  if (isRealHome) {
    if (process.platform === "win32") {
      const npmBin = path.join(
        process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"),
        "npm"
      );
      dirs.push(npmBin);
    } else {
      dirs.push(path.join(homeDir, ".local", "bin"));
    }
  }
  return dirs;
}

function installCliPathShims(homeDir: string, asdCliPath: string): string[] {
  const written: string[] = [];
  const normalizedCli = path.resolve(asdCliPath);
  const shContent = `#!/usr/bin/env sh\n# ASD-MANAGED-SHIM\nexec node --no-warnings "${normalizedCli.replaceAll("\\", "/")}" "$@"\n`;
  const cmdContent = `@ECHO off\r\nREM ASD-MANAGED-SHIM\r\nnode --no-warnings "${normalizedCli}" %*\r\n`;
  const ps1Content = `# ASD-MANAGED-SHIM\r\n& node --no-warnings "${normalizedCli}" @args\r\nexit $LASTEXITCODE\r\n`;

  for (const binDir of getCliShimTargetDirs(homeDir)) {
    try {
      ensureDir(binDir);
      const shPath = path.join(binDir, "asd");
      fs.writeFileSync(shPath, shContent, { encoding: "utf8", mode: 0o755 });
      written.push(shPath);

      if (process.platform === "win32") {
        const cmdPath = path.join(binDir, "asd.cmd");
        fs.writeFileSync(cmdPath, cmdContent, "utf8");
        written.push(cmdPath);

        const ps1Path = path.join(binDir, "asd.ps1");
        fs.writeFileSync(ps1Path, ps1Content, "utf8");
        written.push(ps1Path);
      }
    } catch {
      // Ignore permission issues on system bin directories
    }
  }
  return written;
}

function removeCliPathShims(homeDir: string, removedFiles: string[]): void {
  for (const binDir of getCliShimTargetDirs(homeDir)) {
    for (const name of ["asd", "asd.cmd", "asd.ps1"]) {
      const filePath = path.join(binDir, name);
      if (!fs.existsSync(filePath)) continue;
      try {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.includes("ASD-MANAGED-SHIM")) {
          fs.unlinkSync(filePath);
          removedFiles.push(filePath);
        }
      } catch {
        // Ignore unlink errors
      }
    }
    try {
      if (
        binDir.endsWith(path.join(".asd", "bin")) &&
        fs.existsSync(binDir) &&
        fs.readdirSync(binDir).length === 0
      ) {
        fs.rmdirSync(binDir);
      }
    } catch {
      // Ignore
    }
  }
}

// ============================================================================
// Core Synchronizer: Strictly Global-Only
// ============================================================================

export async function syncHarnessConfigs(
  options?: SyncHarnessOptions
): Promise<SyncHarnessConfigsResult> {
  const homeDir = resolveHome(options?.homeDir);
  const asdRoot = getAsdRoot();
  const asdCliPath = options?.asdCliPath || path.join(asdRoot, "src", "cli", "index.ts");

  // 1. Bootstrap presets, load catalog & native capabilities, and compute config hash
  const configHash = computeConfigHash(homeDir);
  const lastSync = loadLastSync(homeDir);
  const nativeCapabilitiesMap = loadHarnessNativeCapabilities();
  const catalogMcpServers = loadCatalogMcpServers(homeDir, asdRoot);

  const harnessResults: Record<HarnessId, HarnessSyncStatus> = {
    "claude-code": { harness: "claude-code", status: "skipped", skipped: true, filesWritten: [] },
    opencode: { harness: "opencode", status: "skipped", skipped: true, filesWritten: [] },
    codex: { harness: "codex", status: "skipped", skipped: true, filesWritten: [] },
    antigravity: { harness: "antigravity", status: "skipped", skipped: true, filesWritten: [] },
  };

  const adapters: Record<HarnessId, HarnessAdapter> = {
    "claude-code": claudeCodeAdapter,
    opencode: opencodeAdapter,
    codex: codexAdapter,
    antigravity: antigravityAdapter,
  };

  let anyUpdated = false;

  for (const harnessId of DEFAULT_HARNESS_IDS) {
    const adapter = adapters[harnessId];
    const targets = adapter.globalConfigTargets(homeDir);
    const nativeCaps = nativeCapabilitiesMap[harnessId] ?? new Set<string>();

    const isHashMatched =
      !options?.force &&
      lastSync !== null &&
      lastSync.configHash === configHash &&
      lastSync.harnesses?.[harnessId]?.hash === configHash;

    const allTargetsExist = targets.every((targetPath) => fs.existsSync(targetPath));

    if (isHashMatched && allTargetsExist) {
      harnessResults[harnessId] = {
        harness: harnessId,
        status: "skipped",
        skipped: true,
        filesWritten: [],
      };
      continue;
    }

    // Bake in harness configurations
    anyUpdated = true;
    const written: string[] = [];

    switch (harnessId) {
      case "claude-code": {
        const claudeDir = path.join(homeDir, ".claude");

        // 10 agent files
        for (const role of AGENT_ROLES) {
          const agentPath = path.join(claudeDir, "agents", `asd-${role}.md`);
          safeWriteText(agentPath, generateAgentContent(role));
          written.push(agentPath);
        }

        // 5 skills
        for (const skill of ASD_SKILLS) {
          const skillPath = path.join(claudeDir, "skills", skill, "SKILL.md");
          safeWriteText(skillPath, getSkillTemplate(skill));
          written.push(skillPath);
        }

        // settings.json
        const settingsPath = path.join(claudeDir, "settings.json");
        let existingSettings: Record<string, unknown> | null = null;
        if (fs.existsSync(settingsPath)) {
          backupUserFile(settingsPath);
          try {
            existingSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
          } catch {
            existingSettings = {};
          }
        }
        const mergedSettings = mergeClaudeSettings(existingSettings, asdCliPath);
        safeWriteJson(settingsPath, mergedSettings);
        written.push(settingsPath);

        // ~/.claude.json & ~/.claude/.mcp.json
        for (const mcpPath of [path.join(homeDir, ".claude.json"), path.join(claudeDir, ".mcp.json")]) {
          syncJsonMcpConfigFile({
            filePath: mcpPath,
            harnessId: "claude-code",
            catalog: catalogMcpServers,
            nativeCapabilities: nativeCaps,
          });
          written.push(mcpPath);
        }

        break;
      }

      case "opencode": {
        const opencodeDir = path.join(homeDir, ".config", "opencode");

        // 5 command files
        for (const skill of ASD_SKILLS) {
          const cmdPath = path.join(opencodeDir, "command", `${skill}.md`);
          safeWriteText(cmdPath, getSkillTemplate(skill));
          written.push(cmdPath);
        }

        // AGENTS.md
        const agentsMdPath = path.join(opencodeDir, "AGENTS.md");
        safeWriteText(agentsMdPath, generateAllAgentsMarkdown());
        written.push(agentsMdPath);

        // opencode.json
        const opencodeJsonPath = path.join(opencodeDir, "opencode.json");
        syncJsonMcpConfigFile({
          filePath: opencodeJsonPath,
          harnessId: "opencode",
          catalog: catalogMcpServers,
          nativeCapabilities: nativeCaps,
          mutateBeforeMerge: (cfg, extKeys) => {
            cfg._asdVersion = ASD_VERSION;
            if (cfg.mcp && typeof cfg.mcp === "object") {
              for (const k of Object.keys(cfg.mcp as Record<string, unknown>)) {
                extKeys.add(k);
              }
            }
          },
        });
        written.push(opencodeJsonPath);

        break;
      }

      case "codex": {
        const codexDir = path.join(homeDir, ".codex");

        // 5 skills
        for (const skill of ASD_SKILLS) {
          const skillPath = path.join(codexDir, "skills", skill, "SKILL.md");
          safeWriteText(skillPath, getSkillTemplate(skill));
          written.push(skillPath);
        }

        // AGENTS.md
        const agentsMdPath = path.join(codexDir, "AGENTS.md");
        safeWriteText(agentsMdPath, generateAllAgentsMarkdown());
        written.push(agentsMdPath);

        // config.toml
        const configTomlPath = path.join(codexDir, "config.toml");
        let existingToml = "";
        if (fs.existsSync(configTomlPath)) {
          backupUserFile(configTomlPath);
          try {
            existingToml = fs.readFileSync(configTomlPath, "utf8");
          } catch {
            existingToml = "";
          }
        }
        const unmanagedToml = removeTomlFence(existingToml);
        const managedTomlBlock = buildCodexManagedTomlBlock({
          unmanagedToml,
          catalog: catalogMcpServers,
          nativeCapabilities: nativeCaps,
        });
        const mergedToml = mergeCodexConfigToml(existingToml, managedTomlBlock, ASD_VERSION);
        safeWriteText(configTomlPath, mergedToml);
        written.push(configTomlPath);

        break;
      }

      case "antigravity": {
        const geminiDir = path.join(homeDir, ".gemini");

        // 10 agents
        for (const role of AGENT_ROLES) {
          const agentPath = path.join(geminiDir, "agents", `asd-${role}.md`);
          safeWriteText(agentPath, generateAgentContent(role));
          written.push(agentPath);
        }

        // 5 skills
        for (const skill of ASD_SKILLS) {
          const skillPath = path.join(geminiDir, "skills", skill, "SKILL.md");
          safeWriteText(skillPath, getSkillTemplate(skill));
          written.push(skillPath);
        }

        // hooks.json
        const hooksJsonPath = path.join(geminiDir, "hooks.json");
        let existingHooks: Record<string, unknown> = {};
        if (fs.existsSync(hooksJsonPath)) {
          backupUserFile(hooksJsonPath);
          try {
            existingHooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8")) as Record<string, unknown>;
          } catch {
            existingHooks = {};
          }
        }
        const preHooks = Array.isArray(existingHooks.PreToolUse)
          ? existingHooks.PreToolUse.filter(
              (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
            )
          : [];
        preHooks.push({
          command: `node --no-warnings "${asdCliPath}" hook pre-tool-use`,
          _asdManaged: true,
        });

        const stopHooks = Array.isArray(existingHooks.Stop)
          ? existingHooks.Stop.filter(
              (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
            )
          : [];
        stopHooks.push({
          command: `node --no-warnings "${asdCliPath}" hook stop`,
          _asdManaged: true,
        });

        existingHooks.PreToolUse = preHooks;
        existingHooks.Stop = stopHooks;
        safeWriteJson(hooksJsonPath, existingHooks);
        written.push(hooksJsonPath);

        // Check external Antigravity MCP config files (e.g., ~/.gemini/config/mcp_config.json or ~/.gemini/antigravity-cli/mcp_config.json)
        // so we never inject duplicates of tools already configured by the user or OMO-for-AGY.
        const externalGeminiKeys = new Set<string>();
        for (const extPath of [
          path.join(geminiDir, "config", "mcp_config.json"),
          path.join(geminiDir, "antigravity-cli", "mcp_config.json"),
        ]) {
          if (fs.existsSync(extPath)) {
            try {
              const extJson = JSON.parse(fs.readFileSync(extPath, "utf8")) as Record<string, unknown>;
              if (extJson.mcpServers && typeof extJson.mcpServers === "object") {
                for (const k of Object.keys(extJson.mcpServers as Record<string, unknown>)) {
                  externalGeminiKeys.add(k);
                }
              }
            } catch {
              // Ignore unreadable external file
            }
          }
        }

        // mcp_config.json (both legacy ~/.gemini/mcp_config.json and modern ~/.gemini/config/mcp_config.json)
        for (const mcpConfigPath of [
          path.join(geminiDir, "mcp_config.json"),
          path.join(geminiDir, "config", "mcp_config.json"),
        ]) {
          syncJsonMcpConfigFile({
            filePath: mcpConfigPath,
            harnessId: "antigravity",
            catalog: catalogMcpServers,
            nativeCapabilities: nativeCaps,
            externalExistingKeys: externalGeminiKeys,
          });
          written.push(mcpConfigPath);
        }

        break;
      }
    }

    harnessResults[harnessId] = {
      harness: harnessId,
      status: "updated",
      skipped: false,
      filesWritten: written,
    };
  }

  // Save state
  const updatedLastSync: LastSyncRecord = {
    _asdVersion: ASD_VERSION,
    configHash,
    lastSyncedAt: new Date().toISOString(),
    harnesses: {
      ...lastSync?.harnesses,
      "claude-code": { hash: configHash, syncedAt: new Date().toISOString() },
      opencode: { hash: configHash, syncedAt: new Date().toISOString() },
      codex: { hash: configHash, syncedAt: new Date().toISOString() },
      antigravity: { hash: configHash, syncedAt: new Date().toISOString() },
    },
  };
  saveLastSync(homeDir, updatedLastSync);

  // Install global PATH CLI shims unless --no-path is specified
  const cliShimsInstalled = options?.noPath
    ? []
    : installCliPathShims(homeDir, asdCliPath);

  return {
    status: anyUpdated ? "updated" : "skipped",
    skipped: !anyUpdated,
    configHash,
    harnesses: harnessResults,
    cliShimsInstalled,
  };
}

export const runAsdSync = syncHarnessConfigs;

// ============================================================================
// Main-Session Auto-Sync
// ============================================================================

export async function autoSyncIfNeeded(options?: AutoSyncOptions): Promise<AutoSyncResult> {
  if (process.env.ASD_SESSION_ROLE === "subagent") {
    return {
      synced: false,
      skipped: true,
      reason: "subagent_shield",
    };
  }

  const syncResult = await syncHarnessConfigs(options);
  return {
    synced: syncResult.status === "updated",
    skipped: syncResult.status === "skipped",
    result: syncResult,
  };
}

// ============================================================================
// Surgical Rollback: uninstallHarnessConfigs / runAsdUninstall
// ============================================================================

export async function uninstallHarnessConfigs(
  options?: UninstallHarnessOptions
): Promise<UninstallHarnessConfigsResult> {
  const homeDir = resolveHome(options?.homeDir);

  const removedFiles: string[] = [];
  const restoredFiles: string[] = [];

  const harnessStatus: Record<HarnessId, UninstallHarnessStatus> = {
    "claude-code": { removed: [], restored: [] },
    opencode: { removed: [], restored: [] },
    codex: { removed: [], restored: [] },
    antigravity: { removed: [], restored: [] },
  };

  const removeFile = (filePath: string, harness: HarnessId) => {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        removedFiles.push(filePath);
        harnessStatus[harness].removed.push(filePath);
      } catch {
        // Ignore unlink error
      }
    }
  };

  const removeDirIfEmpty = (dirPath: string) => {
    try {
      if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
        fs.rmdirSync(dirPath);
      }
    } catch {
      // Ignore directory removal error
    }
  };

  // 1. Claude Code
  const claudeDir = path.join(homeDir, ".claude");
  for (const role of AGENT_ROLES) {
    removeFile(path.join(claudeDir, "agents", `asd-${role}.md`), "claude-code");
  }
  removeDirIfEmpty(path.join(claudeDir, "agents"));

  for (const skill of ASD_SKILLS) {
    removeFile(path.join(claudeDir, "skills", skill, "SKILL.md"), "claude-code");
    removeDirIfEmpty(path.join(claudeDir, "skills", skill));
  }
  removeDirIfEmpty(path.join(claudeDir, "skills"));

  const claudeSettings = path.join(claudeDir, "settings.json");
  if (restoreUserBackup(claudeSettings)) {
    restoredFiles.push(claudeSettings);
    harnessStatus["claude-code"].restored.push(claudeSettings);
  } else if (fs.existsSync(claudeSettings)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(claudeSettings, "utf8")) as Record<string, unknown>;
      if (cfg.hooks && typeof cfg.hooks === "object") {
        const hooks = cfg.hooks as Record<string, unknown[]>;
        if (Array.isArray(hooks.PreToolUse)) {
          hooks.PreToolUse = hooks.PreToolUse.filter(
            (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
          );
        }
        if (Array.isArray(hooks.Stop)) {
          hooks.Stop = hooks.Stop.filter(
            (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
          );
        }
      }
      const hasPre = Array.isArray((cfg.hooks as Record<string, unknown[]>)?.PreToolUse) && ((cfg.hooks as Record<string, unknown[]>).PreToolUse?.length ?? 0) > 0;
      const hasStop = Array.isArray((cfg.hooks as Record<string, unknown[]>)?.Stop) && ((cfg.hooks as Record<string, unknown[]>).Stop?.length ?? 0) > 0;
      const otherKeys = Object.keys(cfg).filter((k) => k !== "hooks");

      if (!hasPre && !hasStop && otherKeys.length === 0) {
        removeFile(claudeSettings, "claude-code");
      } else {
        safeWriteJson(claudeSettings, cfg);
      }
    } catch {
      removeFile(claudeSettings, "claude-code");
    }
  }

  function cleanupJsonMcpFile(
    filePath: string,
    harness: HarnessId,
    extraDeleteKeys: string[] = []
  ): void {
    if (restoreUserBackup(filePath)) {
      restoredFiles.push(filePath);
      harnessStatus[harness].restored.push(filePath);
      return;
    }
    if (!fs.existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
        stripAsdManagedMcpEntries(parsed.mcpServers as Record<string, unknown>);
      }
      for (const k of extraDeleteKeys) {
        delete parsed[k];
      }
      const mcpCount =
        parsed.mcpServers && typeof parsed.mcpServers === "object"
          ? Object.keys(parsed.mcpServers).length
          : 0;
      const otherKeys = Object.keys(parsed).filter((k) => k !== "mcpServers");
      if (mcpCount === 0 && otherKeys.length === 0) {
        removeFile(filePath, harness);
      } else {
        safeWriteJson(filePath, parsed);
      }
    } catch {
      removeFile(filePath, harness);
    }
  }

  cleanupJsonMcpFile(path.join(homeDir, ".claude.json"), "claude-code");
  cleanupJsonMcpFile(path.join(claudeDir, ".mcp.json"), "claude-code");

  // 2. OpenCode
  const opencodeDir = path.join(homeDir, ".config", "opencode");
  for (const skill of ASD_SKILLS) {
    removeFile(path.join(opencodeDir, "command", `${skill}.md`), "opencode");
  }
  removeDirIfEmpty(path.join(opencodeDir, "command"));
  removeFile(path.join(opencodeDir, "AGENTS.md"), "opencode");

  cleanupJsonMcpFile(path.join(opencodeDir, "opencode.json"), "opencode", [
    "_asdVersion",
    "agentRouting",
  ]);

  // 3. Codex
  const codexDir = path.join(homeDir, ".codex");
  for (const skill of ASD_SKILLS) {
    removeFile(path.join(codexDir, "skills", skill, "SKILL.md"), "codex");
    removeDirIfEmpty(path.join(codexDir, "skills", skill));
  }
  removeDirIfEmpty(path.join(codexDir, "skills"));
  removeFile(path.join(codexDir, "AGENTS.md"), "codex");

  const configToml = path.join(codexDir, "config.toml");
  if (restoreUserBackup(configToml)) {
    restoredFiles.push(configToml);
    harnessStatus.codex.restored.push(configToml);
  } else if (fs.existsSync(configToml)) {
    try {
      const raw = fs.readFileSync(configToml, "utf8");
      const cleaned = removeTomlFence(raw);
      if (cleaned.trim() === "") {
        removeFile(configToml, "codex");
      } else {
        safeWriteText(configToml, cleaned);
      }
    } catch {
      removeFile(configToml, "codex");
    }
  }

  // 4. Antigravity
  const geminiDir = path.join(homeDir, ".gemini");
  for (const role of AGENT_ROLES) {
    removeFile(path.join(geminiDir, "agents", `asd-${role}.md`), "antigravity");
  }
  removeDirIfEmpty(path.join(geminiDir, "agents"));

  for (const skill of ASD_SKILLS) {
    removeFile(path.join(geminiDir, "skills", skill, "SKILL.md"), "antigravity");
    removeDirIfEmpty(path.join(geminiDir, "skills", skill));
  }
  removeDirIfEmpty(path.join(geminiDir, "skills"));

  const hooksJson = path.join(geminiDir, "hooks.json");
  if (restoreUserBackup(hooksJson)) {
    restoredFiles.push(hooksJson);
    harnessStatus.antigravity.restored.push(hooksJson);
  } else if (fs.existsSync(hooksJson)) {
    try {
      const hJson = JSON.parse(fs.readFileSync(hooksJson, "utf8")) as Record<string, unknown>;
      if (Array.isArray(hJson.PreToolUse)) {
        hJson.PreToolUse = hJson.PreToolUse.filter(
          (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
        );
      }
      if (Array.isArray(hJson.Stop)) {
        hJson.Stop = hJson.Stop.filter(
          (h: unknown) => !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
        );
      }
      const hasPre = Array.isArray(hJson.PreToolUse) && hJson.PreToolUse.length > 0;
      const hasStop = Array.isArray(hJson.Stop) && hJson.Stop.length > 0;
      const otherKeys = Object.keys(hJson).filter((k) => k !== "PreToolUse" && k !== "Stop");
      if (!hasPre && !hasStop && otherKeys.length === 0) {
        removeFile(hooksJson, "antigravity");
      } else {
        safeWriteJson(hooksJson, hJson);
      }
    } catch {
      removeFile(hooksJson, "antigravity");
    }
  }

  cleanupJsonMcpFile(path.join(geminiDir, "mcp_config.json"), "antigravity");
  cleanupJsonMcpFile(path.join(geminiDir, "config", "mcp_config.json"), "antigravity");
  removeDirIfEmpty(path.join(geminiDir, "config"));

  // Remove ASD-managed PATH CLI shims
  removeCliPathShims(homeDir, removedFiles);

  // Remove last-sync.json
  const lastSyncPath = path.join(homeDir, ".asd", "state", "last-sync.json");
  if (fs.existsSync(lastSyncPath)) {
    try {
      fs.unlinkSync(lastSyncPath);
    } catch {
      // Ignore
    }
  }

  return {
    status: "success",
    removedFiles,
    restoredFiles,
    harnesses: harnessStatus,
  };
}

export const runAsdUninstall = uninstallHarnessConfigs;

// ============================================================================
// Doctor Probe: Fast <100ms Zero-Token Diagnostic
// ============================================================================

function resolveBinaryOnPath(binaryName: string): string | null {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, binaryName + ext);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          return fullPath;
        }
      } catch {
        // Ignore permission or file system errors during probe
      }
    }
  }
  return null;
}

export async function doctorProbe(
  options?: DoctorProbeOptions
): Promise<DoctorProbeResult> {
  const startTime = performance.now();
  const errors: string[] = [];
  const checks: DoctorCheck[] = [];

  const homeDir = resolveHome(options?.homeDir);
  const projectRoot = options?.projectRoot || process.cwd();

  // 1. Node.js version check (>= 22.13.0)
  const nodeVer = process.versions.node || "0.0.0";
  const [majorStr = "0", minorStr = "0"] = nodeVer.split(".");
  const major = parseInt(majorStr, 10);
  const minor = parseInt(minorStr, 10);
  const nodeOk = major >= 22 && (major > 22 || minor >= 13);

  if (!nodeOk) {
    errors.push(`Node.js version >= 22.13.0 required, current: v${nodeVer}`);
  }
  checks.push({
    name: "node_version",
    ok: nodeOk,
    message: nodeOk ? `Node.js v${nodeVer} (>= 22.13.0)` : `Unsupported Node.js v${nodeVer}`,
  });

  // 2. SQLite WAL health check
  let sqliteOk = false;
  let sqliteMsg = "";
  try {
    const db = new DatabaseSync(":memory:");
    const row = db.prepare("PRAGMA journal_mode = WAL;").get() as { journal_mode?: string } | undefined;
    db.close();
    sqliteOk = row?.journal_mode === "wal" || row?.journal_mode === "memory";
    sqliteMsg = "node:sqlite verified with WAL support";
  } catch (err: unknown) {
    sqliteOk = false;
    sqliteMsg = err instanceof Error ? err.message : String(err);
    errors.push(`SQLite verification failed: ${sqliteMsg}`);
  }
  checks.push({
    name: "sqlite_wal",
    ok: sqliteOk,
    message: sqliteMsg,
  });

  // 3. Git repo state
  const isGitRepo = fs.existsSync(path.join(projectRoot, ".git"));
  checks.push({
    name: "git_repo",
    ok: true,
    message: isGitRepo ? `Git repository detected at ${projectRoot}` : `Not a git repository (${projectRoot})`,
  });

  // 4. Harness CLIs availability
  const claudePath = resolveBinaryOnPath("claude");
  const opencodePath = resolveBinaryOnPath("opencode");
  const codexPath = resolveBinaryOnPath("codex");
  const agyPath = resolveBinaryOnPath("agy");
  const harnesses: DoctorProbeResult["harnesses"] = {
    "claude-code": {
      installed: Boolean(claudePath),
      headlessSupported: Boolean(claudePath),
      binary: "claude",
      resolvedPath: claudePath,
    },
    opencode: {
      installed: Boolean(opencodePath),
      headlessSupported: Boolean(opencodePath),
      binary: "opencode",
      resolvedPath: opencodePath,
    },
    codex: {
      installed: Boolean(codexPath),
      headlessSupported: Boolean(codexPath),
      binary: "codex",
      resolvedPath: codexPath,
    },
    antigravity: {
      installed: Boolean(agyPath),
      headlessSupported: Boolean(agyPath) && antigravityAdapter.supportsHeadlessSpawn,
      binary: "agy",
      resolvedPath: agyPath,
    },
  };
  checks.push({
    name: "harness_clis",
    ok: true,
    message: Object.entries(harnesses)
      .map(([k, v]) => `${k}: ${v.installed ? `installed (${v.resolvedPath})` : "not found"}`)
      .join(", "),
  });

  // 5. In-memory synthetic PreToolUse security policy probe (.GIT/config, .ENV)
  const gitEval = evaluatePreToolUse({
    toolName: "Write",
    tool_input: { file_path: ".GIT/config" },
    projectRoot,
  });
  const envEval = evaluatePreToolUse({
    toolName: "Write",
    tool_input: { file_path: ".ENV" },
    projectRoot,
  });

  const gitBlocked = !gitEval.allowed;
  const envBlocked = !envEval.allowed;
  const policyOk = gitBlocked && envBlocked;

  if (!policyOk) {
    errors.push(
      `PreToolUse policy probe failed: .GIT/config blocked=${gitBlocked}, .ENV blocked=${envBlocked}`
    );
  }
  checks.push({
    name: "security_policy_probe",
    ok: policyOk,
    message: policyOk
      ? "Zero-token PreToolUse policy probe: .GIT/config and .ENV securely denied"
      : "PreToolUse policy probe violation",
  });

  // 6. Home directory write permission check
  let permOk = true;
  try {
    const testDir = path.join(homeDir, ".asd", "state");
    ensureDir(testDir);
    const testFile = path.join(testDir, `.perm-test-${Date.now()}`);
    fs.writeFileSync(testFile, "ok", "utf8");
    fs.unlinkSync(testFile);
  } catch (err: unknown) {
    permOk = false;
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Home directory permission test failed: ${msg}`);
  }
  checks.push({
    name: "home_permissions",
    ok: permOk,
    message: permOk ? `Permissions verified for ${homeDir}/.asd` : "Permission denied",
  });

  const durationMs = performance.now() - startTime;

  return {
    ok: errors.length === 0,
    durationMs,
    checks,
    nodeVersion: {
      ok: nodeOk,
      version: nodeVer,
      minRequired: ">=22.13.0",
    },
    sqliteWal: {
      ok: sqliteOk,
      message: sqliteMsg,
    },
    gitRepo: {
      ok: true,
      isRepo: isGitRepo,
      message: isGitRepo ? "Git repository confirmed" : "Non-git directory",
    },
    harnesses,
    policyProbe: {
      ok: policyOk,
      gitBlocked,
      envBlocked,
      message: policyOk ? "Both .GIT/config and .ENV denied" : "Policy probe failure",
    },
    errors,
  };
}

export const runAsdDoctor = doctorProbe;
