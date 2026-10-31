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
  "asd-handoff",
  "handoff",
] as const;

export interface ClaudeHookCommand {
  type: "command";
  command: string;
}

export interface ClaudeHookMatcherEntry {
  matcher: string;
  hooks: ClaudeHookCommand[];
  [key: string]: unknown;
}

/**
 * Checks whether a Claude Code hook entry (either legacy flat `{ command, _asdManaged }`
 * or modern `{ matcher, hooks: [{ type: "command", command }] }`) is managed by ASD.
 */
export function isAsdManagedClaudeHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const obj = entry as Record<string, unknown>;
  if (obj._asdManaged === true) return true;
  if (
    typeof obj.command === "string" &&
    (obj.command.includes("hook pre-tool-use") || obj.command.includes("hook stop"))
  ) {
    return true;
  }
  if (Array.isArray(obj.hooks)) {
    return obj.hooks.some((h: unknown) => {
      if (!h || typeof h !== "object") return false;
      const hObj = h as Record<string, unknown>;
      if (hObj._asdManaged === true) return true;
      const cmd = typeof hObj.command === "string" ? hObj.command : "";
      return cmd.includes("hook pre-tool-use") || cmd.includes("hook stop");
    });
  }
  return false;
}

/**
 * Generates the ASD managed hook configuration entries for Claude Code
 * using the official `{ matcher, hooks: [{ type: "command", command }] }` schema.
 */
export function createClaudeHookConfig(asdCliPath: string): {
  PreToolUse: ClaudeHookMatcherEntry[];
  Stop: ClaudeHookMatcherEntry[];
} {
  return {
    PreToolUse: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node --no-warnings "${asdCliPath}" hook pre-tool-use`,
          },
        ],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node --no-warnings "${asdCliPath}" hook stop`,
          },
        ],
      },
    ],
  };
}

/**
 * Merges ASD hooks non-destructively into existing settings.json object.
 * Replaces any previous ASD-managed entries (legacy or current) while preserving user hooks.
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
    ...existingPre.filter((h: unknown) => !isAsdManagedClaudeHook(h)),
    ...managed.PreToolUse,
  ];

  const existingStop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  hooks.Stop = [
    ...existingStop.filter((h: unknown) => !isAsdManagedClaudeHook(h)),
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
