/**
 * Antigravity Harness Adapter (@ag)
 *
 * Implements HarnessAdapter for Google's Antigravity CLI (agy):
 * - Headless CLI detection via `probeAntigravityHeadless`: checks for `agy` binary
 *   and headless print mode support; exposes `supportsHeadlessSpawn` for router fallback.
 * - Headless CLI execution via `agy -p "<prompt>" --output-format json --model <model>`
 * - PreToolUse hook denial via stdout JSON `{"decision":"deny","reason":"..."}`
 * - Stop hook continuation via stdout JSON `{"decision":"continue","reason":"..."}`
 * - Global target paths under `<homeDir>/.gemini/`
 */

import * as child_process from "node:child_process";
import * as path from "node:path";
import { AGENT_ROLES, type HarnessAdapter, type HarnessId } from "../core/types.ts";
import { ASD_SKILLS } from "./claude-code.ts";

/**
 * Checks whether the local Antigravity binary (agy) is available and supports headless execution.
 * Never throws — returns false on binary absence, spawn failure, timeout, or lack of print mode.
 */
export function probeAntigravityHeadless(binaryName = "agy"): boolean {
  try {
    const res = child_process.spawnSync(binaryName, ["--help"], {
      stdio: "pipe",
      timeout: 2000,
      windowsHide: true,
      encoding: "utf8",
    });
    if (res.error || res.status !== 0) {
      return false;
    }
    const out = (res.stdout ?? "") + (res.stderr ?? "");
    return out.includes("--print") || out.includes("-p");
  } catch {
    return false;
  }
}

export class AntigravityAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = "antigravity";
  readonly supportsHeadlessSpawn: boolean;

  constructor(opts?: { supportsHeadlessSpawn?: boolean; binaryName?: string }) {
    if (opts?.supportsHeadlessSpawn !== undefined) {
      this.supportsHeadlessSpawn = opts.supportsHeadlessSpawn;
    } else {
      this.supportsHeadlessSpawn = probeAntigravityHeadless(opts?.binaryName ?? "agy");
    }
  }

  buildHeadlessCommand(
    prompt: string,
    model: string,
    opts?: { reasoningEffort?: string }
  ): { cmd: string; args: string[] } {
    const args: string[] = ["-p", prompt, "--output-format", "json"];
    if (model) {
      args.push("--model", model);
    }
    if (opts?.reasoningEffort) {
      args.push("--effort", opts.reasoningEffort);
    }
    return { cmd: "agy", args };
  }

  formatPreToolUseDeny(reason: string): {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  } {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "deny", reason }),
    };
  }

  formatStopBlock(reason: string): {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  } {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "continue", reason }),
    };
  }

  globalConfigTargets(homeDir: string): string[] {
    const targets: string[] = [];
    const geminiDir = path.join(homeDir, ".gemini");

    for (const role of AGENT_ROLES) {
      targets.push(path.join(geminiDir, "agents", `asd-${role}.md`));
    }
    for (const skill of ASD_SKILLS) {
      targets.push(path.join(geminiDir, "skills", skill, "SKILL.md"));
    }
    targets.push(path.join(geminiDir, "hooks.json"));
    targets.push(path.join(geminiDir, "mcp_config.json"));
    targets.push(path.join(geminiDir, "config", "mcp_config.json"));

    return targets;
  }
}

export const antigravityAdapter: HarnessAdapter = new AntigravityAdapter();
