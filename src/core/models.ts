/**
 * ASD Model Discovery & Cache (src/core/models.ts)
 *
 * Pure data service for discovering available models per harness and managing
 * the disk cache (~/.asd/state/models-cache.json). No UI/server dependencies.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { atomicWriteFileSync } from "./render.ts";
import {
  resolveSpawnCommand,
  type CommandRunner,
} from "./spawner.ts";
import { runAsdDoctor, syncAgentModelsIfNeeded } from "../adapters/installer.ts";
import type { HarnessId } from "./types.ts";

export type HarnessModelCatalog = Record<HarnessId, string[]>;

const DEFAULT_MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

const doctorCache = new Map<string, HarnessModelCatalog["harnesses"]>();
const modelCatalogCache = new Map<string, HarnessModelCatalog>();

function detectSystemLocale(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    if (resolved) return resolved;
  } catch {
    // Ignore
  }
  return process.env.LC_ALL || process.env.LANG || "en-US";
}

export function getModelsDiskCachePath(homeDir: string): string {
  return path.join(path.resolve(homeDir), ".asd", "state", "models-cache.json");
}

function readModelsDiskCache(
  homeDir: string,
  ttlMs = DEFAULT_MODELS_CACHE_TTL_MS
): HarnessModelCatalog | null {
  try {
    const cachePath = getModelsDiskCachePath(homeDir);
    if (!fs.existsSync(cachePath)) return null;
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      updatedAt?: number;
      catalog?: HarnessModelCatalog;
    };
    if (
      !raw ||
      typeof raw.updatedAt !== "number" ||
      Date.now() - raw.updatedAt > ttlMs ||
      !raw.catalog ||
      typeof raw.catalog !== "object"
    ) {
      return null;
    }
    return raw.catalog;
  } catch {
    return null;
  }
}

function writeModelsDiskCache(
  homeDir: string,
  catalog: HarnessModelCatalog,
  forceCreateDir = false
): void {
  try {
    const resolvedHome = path.resolve(homeDir);
    const asdDir = path.join(resolvedHome, ".asd");
    if (!forceCreateDir && !fs.existsSync(asdDir)) return;
    const cachePath = getModelsDiskCachePath(resolvedHome);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    atomicWriteFileSync(
      cachePath,
      JSON.stringify({ updatedAt: Date.now(), catalog }, null, 2) + "\n"
    );
  } catch {
    // Ignore disk cache write errors
  }
}

function execCliOutputAsync(
  command: string,
  args: string[],
  timeoutMs = 3500,
  cwd?: string
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ status, stdout });
    };

    try {
      const resolved = resolveSpawnCommand(command, args);
      const child = child_process.spawn(resolved.command, resolved.args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: resolved.shell,
        ...(cwd ? { cwd } : {}),
      });

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish(null);
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (stdout.length < 256 * 1024) {
          stdout += chunk.toString();
        }
      });

      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        finish(code);
      });
    } catch {
      finish(null);
    }
  });
}

/**
 * Dynamically discovers ALL real available models for Antigravity, Claude Code, Codex, and OpenCode
 * by querying each harness's live CLI (`agy models`, `opencode models`), local model caches
 * (`~/.codex/models_cache.json`, `~/.claude/settings.json`, `~/.claude/litellm_config.yaml`),
 * and any configured remote OpenAI-compatible gateway (`integrate.api.nvidia.com/v1/models`, etc.).
 * Uses an in-memory + disk cache (`~/.asd/state/models-cache.json`) and parallel async probes
 * so `asd ui` startup never blocks on synchronous CLI spawns.
 */
export async function discoverHarnessModels(options?: {
  projectRoot?: string;
  homeDir?: string;
  forceRefresh?: boolean;
  skipCliSpawn?: boolean;
  enableGatewayProbe?: boolean;
  cacheTtlMs?: number;
  persistCache?: boolean;
}): Promise<HarnessModelCatalog> {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const homeDir = path.resolve(options?.homeDir || os.homedir());
  const cacheKey = `${projectRoot}::${homeDir}`;
  const ttlMs = options?.cacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS;

  if (!options?.forceRefresh) {
    if (modelCatalogCache.has(cacheKey)) {
      return modelCatalogCache.get(cacheKey)!;
    }
    const diskCached = readModelsDiskCache(homeDir, ttlMs);
    if (diskCached) {
      modelCatalogCache.set(cacheKey, diskCached);
      return diskCached;
    }
  }

  const sets: Record<HarnessId, Set<string>> = {
    antigravity: new Set<string>(),
    "claude-code": new Set<string>(),
    codex: new Set<string>(),
    opencode: new Set<string>(),
    cursor: new Set<string>(),
  };

  // 1. Antigravity: local `~/.gemini/antigravity-cli/settings.json`
  try {
    const agySettingsPath = path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
    if (fs.existsSync(agySettingsPath)) {
      const agySettings = JSON.parse(fs.readFileSync(agySettingsPath, "utf8")) as {
        model?: string;
      };
      if (typeof agySettings.model === "string" && agySettings.model.trim()) {
        sets.antigravity.add(agySettings.model.trim());
      }
    }
  } catch {
    // Ignore antigravity settings scan errors
  }

  // 2. Codex: scan `~/.codex/models_cache.json` and `~/.codex/config.toml`
  try {
    const codexCachePath = path.join(homeDir, ".codex", "models_cache.json");
    if (fs.existsSync(codexCachePath)) {
      const cacheObj = JSON.parse(fs.readFileSync(codexCachePath, "utf8")) as {
        models?: Array<{ slug?: string }>;
      };
      if (Array.isArray(cacheObj.models)) {
        for (const item of cacheObj.models) {
          if (item?.slug && typeof item.slug === "string" && item.slug.trim()) {
            sets.codex.add(item.slug.trim());
          }
        }
      }
    }
    const codexTomlPath = path.join(homeDir, ".codex", "config.toml");
    if (fs.existsSync(codexTomlPath)) {
      const tomlText = fs.readFileSync(codexTomlPath, "utf8");
      const matches = tomlText.matchAll(/^\s*model\s*=\s*["']([^"']+)["']/gm);
      for (const m of matches) {
        if (m[1]?.trim()) sets.codex.add(m[1].trim());
      }
    }
  } catch {
    // Ignore codex scan errors
  }

  // 3. Claude Code: scan `~/.claude/settings.json` and `~/.claude/litellm_config.yaml`
  let anthropicToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim() || "";
  let anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL?.trim() || "";
  let nvidiaToken = process.env.NVIDIA_NIM_API_KEY?.trim() || "";
  let litellmBaseUrl = "";
  try {
    const addClaudeModel = (raw: string | undefined) => {
      if (!raw || typeof raw !== "string") return;
      const trimmed = raw.trim();
      if (!trimmed) return;
      sets["claude-code"].add(trimmed);
      const stripped = trimmed.replace(/\[.*\]$/, "").trim();
      if (stripped) sets["claude-code"].add(stripped);
    };

    addClaudeModel(process.env.ANTHROPIC_MODEL);
    addClaudeModel(process.env.ANTHROPIC_CUSTOM_MODEL_OPTION);
    addClaudeModel(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL);
    addClaudeModel(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
    addClaudeModel(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL);

    const claudeSettingsPath = path.join(homeDir, ".claude", "settings.json");
    if (fs.existsSync(claudeSettingsPath)) {
      const settingsObj = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8")) as {
        model?: string;
        env?: Record<string, string>;
      };
      addClaudeModel(settingsObj.model);
      const env = settingsObj.env ?? {};
      addClaudeModel(env.ANTHROPIC_MODEL);
      addClaudeModel(env.ANTHROPIC_CUSTOM_MODEL_OPTION);
      addClaudeModel(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
      addClaudeModel(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
      addClaudeModel(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
      if (env.ANTHROPIC_AUTH_TOKEN?.trim()) {
        anthropicToken = env.ANTHROPIC_AUTH_TOKEN.trim();
      }
      if (env.ANTHROPIC_BASE_URL?.trim()) {
        anthropicBaseUrl = env.ANTHROPIC_BASE_URL.trim();
      }
      if (env.NVIDIA_NIM_API_KEY?.trim()) {
        nvidiaToken = env.NVIDIA_NIM_API_KEY.trim();
      }
    }

    const litellmYamlPath = path.join(homeDir, ".claude", "litellm_config.yaml");
    if (fs.existsSync(litellmYamlPath)) {
      const yamlText = fs.readFileSync(litellmYamlPath, "utf8");
      const defMatch = yamlText.match(/default_model:\s*["']?([^"'\r\n#]+)["']?/);
      if (defMatch?.[1]) addClaudeModel(defMatch[1]);
      const baseMatch = yamlText.match(/api_base:\s*["']?([^"'\r\n#]+)["']?/);
      if (baseMatch?.[1]?.trim()) {
        litellmBaseUrl = baseMatch[1].trim().replace(/\/+$/, "");
      }
      for (const m of yamlText.matchAll(/-\s*model_name:\s*["']?([^"'\r\n#]+)["']?/g)) {
        if (m[1]) addClaudeModel(m[1]);
      }
      for (const m of yamlText.matchAll(/model:\s*["']?([^"'\r\n#]+)["']?/g)) {
        if (m[1]) addClaudeModel(m[1].trim().replace(/^nvidia_nim\//, ""));
      }
    }
  } catch {
    // Ignore claude local scan errors
  }

  // 4. OpenCode: scan opencode.json, opencode.jsonc, agent/*.md, and ~/.asd/routing.jsonc
  try {
    const parseOpencodeConfig = (cfgText: string) => {
      try {
        const cleaned = cfgText.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, "");
        const ocObj = JSON.parse(cleaned) as {
          model?: string;
          small_model?: string;
          provider?: Record<string, { models?: Record<string, unknown> }>;
        };
        if (typeof ocObj.model === "string" && ocObj.model.trim()) {
          sets.opencode.add(ocObj.model.trim());
        }
        if (typeof ocObj.small_model === "string" && ocObj.small_model.trim()) {
          sets.opencode.add(ocObj.small_model.trim());
        }
        if (ocObj.provider && typeof ocObj.provider === "object") {
          for (const [provKey, provVal] of Object.entries(ocObj.provider)) {
            if (provVal?.models && typeof provVal.models === "object") {
              for (const mKey of Object.keys(provVal.models)) {
                sets.opencode.add(`${provKey}/${mKey}`);
              }
            }
          }
        }
      } catch {
        // ignore parse error
      }
    };

    const ocJsonPath = path.join(homeDir, ".config", "opencode", "opencode.json");
    if (fs.existsSync(ocJsonPath)) {
      parseOpencodeConfig(fs.readFileSync(ocJsonPath, "utf8"));
    }

    const ocJsoncPath = path.join(homeDir, ".config", "opencode", "opencode.jsonc");
    if (fs.existsSync(ocJsoncPath)) {
      parseOpencodeConfig(fs.readFileSync(ocJsoncPath, "utf8"));
    }

    // Scan ~/.config/opencode/agent/*.md frontmatter for configured models
    const agentDir = path.join(homeDir, ".config", "opencode", "agent");
    if (fs.existsSync(agentDir)) {
      for (const entry of fs.readdirSync(agentDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const text = fs.readFileSync(path.join(agentDir, entry.name), "utf8");
            const m = /^model:\s*["']?([^"'\r\n#]+)["']?/m.exec(text);
            if (m?.[1]?.trim()) {
              sets.opencode.add(m[1].trim());
            }
          } catch {
            // ignore agent read error
          }
        }
      }
    }

    // Scan global ~/.asd/routing.jsonc for opencode models
    const globalRoutingPath = path.join(homeDir, ".asd", "routing.jsonc");
    if (fs.existsSync(globalRoutingPath)) {
      try {
        const text = fs.readFileSync(globalRoutingPath, "utf8");
        const matches = text.matchAll(/"harness"\s*:\s*"opencode"\s*,\s*"model"\s*:\s*"([^"]+)"/g);
        for (const match of matches) {
          if (match[1]?.trim()) {
            sets.opencode.add(match[1].trim());
          }
        }
      } catch {
        // ignore routing read error
      }
    }
  } catch {
    // Ignore opencode scan errors
  }

  // 5. Cursor: scan ~/.cursor/cli-config.json, ~/.cursor/agents/*.md, and ~/.asd/routing.jsonc
  try {
    const cursorCfgPath = path.join(homeDir, ".cursor", "cli-config.json");
    if (fs.existsSync(cursorCfgPath)) {
      const cObj = JSON.parse(fs.readFileSync(cursorCfgPath, "utf8")) as { model?: { modelId?: string } | string };
      if (typeof cObj.model === "string" && cObj.model.trim()) {
        sets.cursor.add(cObj.model.trim());
      } else if (cObj.model && typeof cObj.model === "object" && typeof cObj.model.modelId === "string" && cObj.model.modelId.trim()) {
        sets.cursor.add(cObj.model.modelId.trim());
      }
    }

    const cursorAgentDir = path.join(homeDir, ".cursor", "agents");
    if (fs.existsSync(cursorAgentDir)) {
      for (const entry of fs.readdirSync(cursorAgentDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const text = fs.readFileSync(path.join(cursorAgentDir, entry.name), "utf8");
            const m = /^model:\s*["']?([^"'\r\n#]+)["']?/m.exec(text);
            if (m?.[1]?.trim()) {
              sets.cursor.add(m[1].trim());
            }
          } catch {
            // ignore
          }
        }
      }
    }

    const globalRoutingPath = path.join(homeDir, ".asd", "routing.jsonc");
    if (fs.existsSync(globalRoutingPath)) {
      try {
        const text = fs.readFileSync(globalRoutingPath, "utf8");
        const matches = text.matchAll(/"harness"\s*:\s*"cursor"\s*,\s*"model"\s*:\s*"([^"]+)"/g);
        for (const match of matches) {
          if (match[1]?.trim()) {
            sets.cursor.add(match[1].trim());
          }
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // Ignore cursor scan errors
  }

  // 6. Parallel non-blocking CLI & remote gateway probes
  const runCliProbes = !options?.skipCliSpawn;
  const runGatewayProbe = !options?.skipCliSpawn || Boolean(options?.enableGatewayProbe);
  if (runCliProbes || runGatewayProbe) {
    const agyProbe = !runCliProbes ? Promise.resolve() : execCliOutputAsync("agy", ["models"], 3500).then((res) => {
      if (!res.stdout) return;
      for (const rawLine of res.stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("Fetching")) continue;
        const firstCol = line.split("\t")[0]?.trim();
        if (firstCol && !firstCol.includes(" ")) {
          sets.antigravity.add(firstCol);
        }
      }
    });

    const opencodeProbe = !runCliProbes ? Promise.resolve() : execCliOutputAsync("opencode", ["models"], 3500, homeDir).then((res) => {
      if (res.status !== 0 || !res.stdout) return;
      const lines = res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("[") && !l.includes(" "));
      for (const line of lines) {
        sets.opencode.add(line);
      }
    });

    const parseCursorModelsOutput = (stdout: string) => {
      for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("Available models") || line.startsWith("Tip:")) continue;
        const modelId = line.split(" - ")[0]?.trim();
        if (modelId && !modelId.includes(" ")) {
          sets.cursor.add(modelId);
        }
      }
    };

    const cursorProbe = !runCliProbes ? Promise.resolve() : execCliOutputAsync("cursor-agent", ["models"], 3500).then((res) => {
      if (res.stdout) {
        parseCursorModelsOutput(res.stdout);
      } else {
        return execCliOutputAsync("agent", ["models"], 3500).then((agentRes) => {
          if (agentRes.stdout) parseCursorModelsOutput(agentRes.stdout);
        });
      }
    });

    // Pair each token strictly with its matching gateway base URL (F21)
    let gatewayToken = "";
    let gatewayBase = "";
    const explicitGatewayBase = (anthropicBaseUrl || litellmBaseUrl).replace(/\/+$/, "");
    if (anthropicToken && explicitGatewayBase) {
      gatewayToken = anthropicToken;
      gatewayBase = explicitGatewayBase;
    } else if (nvidiaToken) {
      gatewayToken = nvidiaToken;
      gatewayBase = explicitGatewayBase || "https://integrate.api.nvidia.com/v1";
    }

    const gatewayProbe = (async () => {
      if (
        !gatewayToken ||
        !gatewayBase ||
        gatewayToken.includes("dummy") ||
        gatewayToken.includes("\uC5EC\uAE30\uC5D0_")
      ) {
        return;
      }
      try {
        const modelsEndpoint = gatewayBase.endsWith("/models") ? gatewayBase : `${gatewayBase}/models`;
        const res = await fetch(modelsEndpoint, {
          headers: { Authorization: `Bearer ${gatewayToken}` },
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) {
          const data = (await res.json()) as { data?: Array<{ id?: string }> };
          if (Array.isArray(data.data)) {
            for (const item of data.data) {
              if (item?.id && typeof item.id === "string" && item.id.trim()) {
                sets["claude-code"].add(item.id.trim());
              }
            }
          }
        }
      } catch {
        // Ignore remote gateway timeout/network error
      }
    })();

    await Promise.all([agyProbe, opencodeProbe, cursorProbe, gatewayProbe]);
  }

  const catalog: HarnessModelCatalog = {
    antigravity: [...sets.antigravity],
    "claude-code": [...sets["claude-code"]],
    codex: [...sets.codex],
    opencode: [...sets.opencode],
    cursor: [...sets.cursor],
  };

  modelCatalogCache.set(cacheKey, catalog);
  writeModelsDiskCache(homeDir, catalog, Boolean(options?.persistCache));
  return catalog;
}