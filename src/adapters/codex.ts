/**
 * Codex Harness Adapter (@cx)
 *
 * Implements HarnessAdapter for OpenAI's Codex CLI:
 * - Headless CLI execution via `codex exec "<prompt>" --json -m <model>`
 *   (plus `-c model_reasoning_effort=<level>` when configured)
 * - PreToolUse hook denial via exit code 2 / stderr & stdout JSON
 * - Stop hook block via stdout JSON `{"decision":"block","reason":"..."}`
 * - Global target paths under `<homeDir>/.codex/` with TOML fence merging
 */

import * as path from "node:path";
import { upsertTomlFence, removeTomlFence } from "../core/jsonc.ts";
import { type HarnessAdapter, type HarnessId } from "../core/types.ts";
import { ASD_SKILLS } from "./claude-code.ts";

/**
 * Merges ASD managed configuration into Codex config.toml using managed fence blocks.
 */
export function mergeCodexConfigToml(
  existingToml: string,
  managedBlock: string,
  version?: string
): string {
  return upsertTomlFence(existingToml, managedBlock, version);
}

/**
 * Removes ASD managed fence block from Codex config.toml.
 */
export function removeCodexConfigToml(existingToml: string): string {
  return removeTomlFence(existingToml);
}

export class CodexAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = "codex";
  readonly supportsHeadlessSpawn: boolean = true;

  buildHeadlessCommand(
    prompt: string,
    model: string,
    opts?: { reasoningEffort?: string }
  ): { cmd: string; args: string[] } {
    const args: string[] = ["exec", prompt, "--json"];
    if (model) {
      args.push("-m", model);
    }
    if (opts?.reasoningEffort) {
      args.push("-c", `model_reasoning_effort=${opts.reasoningEffort}`);
    }
    return { cmd: "codex", args };
  }

  formatPreToolUseDeny(reason: string): {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  } {
    return {
      exitCode: 2,
      stderr: reason,
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
      stdout: JSON.stringify({ decision: "block", reason }),
    };
  }

  globalConfigTargets(homeDir: string): string[] {
    const targets: string[] = [];
    const baseDir = path.join(homeDir, ".codex");

    targets.push(path.join(baseDir, "config.toml"));
    for (const skill of ASD_SKILLS) {
      targets.push(path.join(baseDir, "skills", skill, "SKILL.md"));
    }
    targets.push(path.join(baseDir, "AGENTS.md"));

    return targets;
  }
}

export const codexAdapter: HarnessAdapter = new CodexAdapter();
export default codexAdapter;
