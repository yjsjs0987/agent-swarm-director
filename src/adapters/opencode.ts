/**
 * OpenCode Harness Adapter (@oc)
 *
 * Implements HarnessAdapter for OpenCode CLI:
 * - Headless CLI execution via `opencode run "<prompt>" --format json --model <model>`
 * - PreToolUse hook denial via exit code 2 / stderr & stdout JSON
 * - Stop hook block via stdout JSON `{"decision":"block","reason":"..."}`
 * - Global target paths under `<homeDir>/.config/opencode/`
 */

import * as path from "node:path";
import { _asdVersion, type HarnessAdapter, type HarnessId } from "../core/types.ts";
import { ASD_SKILLS } from "./claude-code.ts";

/**
 * Creates OpenCode configuration payload with MCP server catalog and optional routing config.
 */
export function createOpencodeConfig(
  mcpServers: Record<string, unknown>,
  routingConfig?: Record<string, unknown>
): Record<string, unknown> {
  return {
    _asdVersion,
    mcpServers: { ...mcpServers },
    ...(routingConfig ? { agentRouting: routingConfig } : {}),
  };
}

export class OpencodeAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = "opencode";
  readonly supportsHeadlessSpawn: boolean = true;

  buildHeadlessCommand(
    prompt: string,
    model: string,
    _opts?: { reasoningEffort?: string }
  ): { cmd: string; args: string[] } {
    const args: string[] = ["run", prompt, "--format", "json"];
    if (model) {
      args.push("--model", model);
    }
    return { cmd: "opencode", args };
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
    const baseDir = path.join(homeDir, ".config", "opencode");

    targets.push(path.join(baseDir, "opencode.json"));
    for (const skill of ASD_SKILLS) {
      targets.push(path.join(baseDir, "command", `${skill}.md`));
    }
    targets.push(path.join(baseDir, "AGENTS.md"));

    return targets;
  }
}

export const opencodeAdapter: HarnessAdapter = new OpencodeAdapter();
export default opencodeAdapter;
