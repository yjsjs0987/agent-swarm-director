import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverHarnessModels,
  getModelsDiskCachePath,
  collectDashboardSnapshot,
  resetDashboardTranscriptSyncThrottle,
} from "../src/cli/dashboard.ts";

function makeTempDir(prefix = "asd-dashboard-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("T1.2: discoverHarnessModels persists models-cache.json and serves warm disk cache without CLI spawns", async () => {
  const homeDir = makeTempDir("asd-t12-home-");
  const projA = makeTempDir("asd-t12-proja-");
  const projB = makeTempDir("asd-t12-projb-");
  try {
    // Ensure ~/.asd exists so disk cache is automatically written
    fs.mkdirSync(path.join(homeDir, ".asd", "state"), { recursive: true });

    // Seed local harness configs
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".claude", "settings.json"),
      JSON.stringify({ model: "claude-sonnet-4-6" }),
      "utf8"
    );

    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".codex", "models_cache.json"),
      JSON.stringify({ models: [{ slug: "gpt-5.4" }] }),
      "utf8"
    );

    fs.mkdirSync(path.join(homeDir, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".config", "opencode", "opencode.json"),
      JSON.stringify({ model: "openai/gpt-5.4-mini" }),
      "utf8"
    );

    const firstCatalog = await discoverHarnessModels({
      projectRoot: projA,
      homeDir,
      skipCliSpawn: true,
    });

    assert.ok(firstCatalog["claude-code"].includes("claude-sonnet-4-6"));
    assert.ok(firstCatalog.codex.includes("gpt-5.4"));
    assert.ok(firstCatalog.opencode.includes("openai/gpt-5.4-mini"));

    const cacheFile = getModelsDiskCachePath(homeDir);
    assert.ok(fs.existsSync(cacheFile), "models-cache.json must be written to ~/.asd/state/models-cache.json");

    // Mutate models-cache.json with a marker model and call discoverHarnessModels with a different projectRoot (projB)
    // and skipCliSpawn: false -> must hit disk cache in <20ms without spawning CLIs!
    const customDiskCatalog = {
      ...firstCatalog,
      antigravity: ["gemini-3.1-pro-disk-cached"],
    };
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ updatedAt: Date.now(), catalog: customDiskCatalog }, null, 2),
      "utf8"
    );

    const startMs = Date.now();
    const fromDisk = await discoverHarnessModels({
      projectRoot: projB,
      homeDir,
      skipCliSpawn: false,
    });
    const elapsedMs = Date.now() - startMs;

    assert.ok(fromDisk.antigravity.includes("gemini-3.1-pro-disk-cached"));
    assert.ok(elapsedMs < 200, `Expected instant disk cache hit (<200ms), got ${elapsedMs}ms`);

    // forceRefresh: true must bypass disk cache and re-scan local files
    fs.writeFileSync(
      path.join(homeDir, ".claude", "settings.json"),
      JSON.stringify({ model: "claude-opus-4-6" }),
      "utf8"
    );
    const refreshed = await discoverHarnessModels({
      projectRoot: projB,
      homeDir,
      forceRefresh: true,
      skipCliSpawn: true,
    });
    assert.ok(refreshed["claude-code"].includes("claude-opus-4-6"));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projA, { recursive: true, force: true });
    fs.rmSync(projB, { recursive: true, force: true });
  }
});

test("F21: discoverHarnessModels never sends ANTHROPIC_AUTH_TOKEN to default NVIDIA gateway without explicit gateway base URL", async () => {
  const homeDir = makeTempDir("asd-f21-home-");
  const projDir = makeTempDir("asd-f21-proj-");
  const origFetch = globalThis.fetch;
  const origAnthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const origAnthropicBase = process.env.ANTHROPIC_BASE_URL;
  const origNvidiaKey = process.env.NVIDIA_NIM_API_KEY;
  const fetchedCalls: Array<{ url: string; auth: string }> = [];

  try {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.NVIDIA_NIM_API_KEY;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      fetchedCalls.push({ url, auth: headers.Authorization ?? "" });
      return new Response(JSON.stringify({ data: [{ id: "custom-gateway-model-1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    // Case 1: ANTHROPIC_AUTH_TOKEN set WITHOUT ANTHROPIC_BASE_URL or litellm api_base
    // -> must NOT leak token to https://integrate.api.nvidia.com/v1/models
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-secret-token-123" } }),
      "utf8"
    );

    await discoverHarnessModels({
      projectRoot: projDir,
      homeDir,
      forceRefresh: true,
      skipCliSpawn: true,
      enableGatewayProbe: true,
    });

    const leakedToNvidia = fetchedCalls.some((c) => c.url.includes("integrate.api.nvidia.com"));
    assert.equal(leakedToNvidia, false, "ANTHROPIC_AUTH_TOKEN must NEVER be sent to default NVIDIA endpoint");
    assert.equal(fetchedCalls.length, 0, "No remote gateway probe should fire when ANTHROPIC_AUTH_TOKEN has no explicit base URL");

    // Case 2: ANTHROPIC_AUTH_TOKEN paired with explicit ANTHROPIC_BASE_URL -> probes explicit base URL
    fs.writeFileSync(
      path.join(homeDir, ".claude", "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-ant-proxy-token-456",
          ANTHROPIC_BASE_URL: "https://my-litellm.example.com/v1/",
        },
      }),
      "utf8"
    );

    const catalogWithBase = await discoverHarnessModels({
      projectRoot: projDir,
      homeDir,
      forceRefresh: true,
      skipCliSpawn: true,
      enableGatewayProbe: true,
    });

    assert.equal(fetchedCalls.length, 1);
    assert.equal(fetchedCalls[0]!.url, "https://my-litellm.example.com/v1/models");
    assert.equal(fetchedCalls[0]!.auth, "Bearer sk-ant-proxy-token-456");
    assert.ok(catalogWithBase["claude-code"].includes("custom-gateway-model-1"));
  } finally {
    globalThis.fetch = origFetch;
    if (origAnthropicToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = origAnthropicToken;
    else delete process.env.ANTHROPIC_AUTH_TOKEN;
    if (origAnthropicBase !== undefined) process.env.ANTHROPIC_BASE_URL = origAnthropicBase;
    else delete process.env.ANTHROPIC_BASE_URL;
    if (origNvidiaKey !== undefined) process.env.NVIDIA_NIM_API_KEY = origNvidiaKey;
    else delete process.env.NVIDIA_NIM_API_KEY;
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});

test("F22: collectDashboardSnapshot throttles syncLocalTranscripts across rapid /api/state polls", async () => {
  const homeDir = makeTempDir("asd-f22-home-");
  const projDir = makeTempDir("asd-f22-proj-");
  try {
    resetDashboardTranscriptSyncThrottle();
    fs.mkdirSync(path.join(projDir, ".asd", "sessions"), { recursive: true });
    // Seed initial cli-recent.json so we can verify throttled reads vs full transcript sync
    fs.writeFileSync(
      path.join(projDir, ".asd", "sessions", "cli-recent.json"),
      JSON.stringify({ sessions: [] }, null, 2),
      "utf8"
    );

    // First snapshot triggers syncLocalTranscripts: true and records throttle timestamp
    await collectDashboardSnapshot({
      projectRoot: projDir,
      homeDir,
      skipCliSpawn: true,
      transcriptSyncThrottleMs: 60_000,
    });

    // Now create a new Claude transcript file in ~/.claude/projects/...
    const claudeProjDir = path.join(homeDir, ".claude", "projects", "test-proj");
    fs.mkdirSync(claudeProjDir, { recursive: true });
    const transcriptFile = path.join(claudeProjDir, "sess-after-first-poll.jsonl");
    fs.writeFileSync(
      transcriptFile,
      JSON.stringify({
        sessionId: "sess-after-first-poll",
        cwd: projDir,
        type: "user",
        message: { role: "user", content: "Hello throttled scan" },
      }) + "\n",
      "utf8"
    );

    // Immediate second poll within throttle window skips heavy disk scan
    const secondSnap = await collectDashboardSnapshot({
      projectRoot: projDir,
      homeDir,
      skipCliSpawn: true,
      transcriptSyncThrottleMs: 60_000,
    });
    assert.equal(
      secondSnap.cliRecentSessions.some((s) => s.harnessSessionId === "sess-after-first-poll"),
      false,
      "Second poll within throttle window must skip full transcript directory scan"
    );

    // Poll after throttle reset (or expiry) performs transcript sync and picks up the new session
    resetDashboardTranscriptSyncThrottle();
    const thirdSnap = await collectDashboardSnapshot({
      projectRoot: projDir,
      homeDir,
      skipCliSpawn: true,
      transcriptSyncThrottleMs: 60_000,
    });
    assert.equal(
      thirdSnap.cliRecentSessions.some((s) => s.harnessSessionId === "sess-after-first-poll"),
      true,
      "Poll after throttle window expiry must sync local transcripts"
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});
