/**
 * Claude Code Harness Adapter (@cc)
 *
 * Implements HarnessAdapter for Anthropic's Claude Code CLI:
 * - Headless CLI execution via `claude -p "<prompt>" --output-format json --model <model>`
 * - PreToolUse hook denial via exit code 2 and stderr message
 * - Stop hook block via stdout JSON `{"decision":"block","reason":"..."}`
 * - Global target paths under `<homeDir>/.claude/` and `<homeDir>/.claude.json`
 */

import * as path from "node:path";
import { AGENT_ROLES, type HarnessAdapter, type HarnessId } from "../core/types.ts";

export const ASD_SKILLS = [
  "asd",
  "asd-plan",
  "asd-run",
  "asd-debate",
  "asd-debug",
] as const;

export type AsdSkill = (typeof ASD_SKILLS)[number];

export interface ClaudeHookEntry {
  command: string;
  _asdManaged?: boolean;
  [key: string]: unknown;
}

/**
 * Generates the ASD managed hook configuration entries for Claude Code.
 */
export function createClaudeHookConfig(asdCliPath: string): {
  PreToolUse: ClaudeHookEntry[];
  Stop: ClaudeHookEntry[];
} {
  return {
    PreToolUse: [
      {
        command: `node --no-warnings "${asdCliPath}" hook pre-tool-use`,
        _asdManaged: true,
      },
    ],
    Stop: [
      {
        command: `node --no-warnings "${asdCliPath}" hook stop`,
        _asdManaged: true,
      },
    ],
  };
}

/**
 * Merges ASD hooks non-destructively into existing settings.json object.
 * Replaces any previous _asdManaged entries while preserving user hooks.
 */
export function mergeClaudeSettings(
  existing: Record<string, unknown> | null | undefined,
  asdCliPath: string
): Record<string, unknown> {
  const base = existing ? { ...existing } : {};
  const hooks = (
    base.hooks && typeof base.hooks === "object"
      ? { ...(base.hooks as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  const managed = createClaudeHookConfig(asdCliPath);

  const existingPre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  hooks.PreToolUse = [
    ...existingPre.filter(
      (h: unknown) =>
        !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
    ),
    ...managed.PreToolUse,
  ];

  const existingStop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  hooks.Stop = [
    ...existingStop.filter(
      (h: unknown) =>
        !(h && typeof h === "object" && (h as Record<string, unknown>)._asdManaged)
    ),
    ...managed.Stop,
  ];

  base.hooks = hooks;
  return base;
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = "claude-code";
  readonly supportsHeadlessSpawn: boolean = true;

  buildHeadlessCommand(
    prompt: string,
    model: string,
    _opts?: { reasoningEffort?: string }
  ): { cmd: string; args: string[] } {
    const args: string[] = ["-p", prompt, "--output-format", "json"];
    if (model) {
      args.push("--model", model);
    }
    return { cmd: "claude", args };
  }

  formatPreToolUseDeny(reason: string): {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  } {
    return {
      exitCode: 2,
      stderr: reason,
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
    const claudeDir = path.join(homeDir, ".claude");

    for (const role of AGENT_ROLES) {
      targets.push(path.join(claudeDir, "agents", `asd-${role}.md`));
    }
    for (const skill of ASD_SKILLS) {
      targets.push(path.join(claudeDir, "skills", skill, "SKILL.md"));
    }
    targets.push(path.join(claudeDir, "settings.json"));
    targets.push(path.join(homeDir, ".claude.json"));
    targets.push(path.join(claudeDir, ".mcp.json"));

    return targets;
  }
}

export const claudeCodeAdapter: HarnessAdapter = new ClaudeCodeAdapter();
export default claudeCodeAdapter;
