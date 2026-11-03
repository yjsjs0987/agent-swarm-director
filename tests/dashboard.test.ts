import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverHarnessModels,
  getModelsDiskCachePath,
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
