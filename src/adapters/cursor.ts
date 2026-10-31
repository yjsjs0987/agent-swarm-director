/**
 * Cursor CLI Harness Adapter (@cr)
 *
 * Implements HarnessAdapter for Cursor CLI (`agent` / `cursor-agent`):
 * - Headless CLI execution via `agent -p "<prompt>" --force --output-format json --model <model>`
 *   (or `cursor-agent` when configured)
 * - PreToolUse hook denial via exit code 2 / stderr & stdout JSON `{"decision":"deny","reason":"..."}`
 * - Stop hook block via stdout JSON `{"decision":"block","reason":"..."}`
 * - Global target paths under `<homeDir>/.cursor/`
 */

import * as child_process from "node:child_process";
import * as path from "node:path";
import { resolveBinaryOnPath } from "../core/router.ts";
import { AGENT_ROLES, type HarnessAdapter, type HarnessId } from "../core/types.ts";
import { ASD_SKILLS } from "./claude-code.ts";

/**
 * Resolves the Cursor CLI binary name (`agent` or `cursor-agent`) available on PATH or Windows local appdata.
 * Defaults to `"agent"` when neither is explicitly found.
 */
export function resolveCursorBinaryName(
  env: Record<string, string | undefined> = process.env
): string {
  if (resolveBinaryOnPath("cursor-agent", env)) return "cursor-agent";
  if (resolveBinaryOnPath("agent", env)) return "agent";
  return "agent";
}

/**
 * Checks whether the local Cursor CLI binary (`agent` or `cursor-agent`) is available
 * and supports headless `-p` / `--print` execution. Never throws.
 */
export function probeCursorHeadless(binaryName?: string): boolean {
  const bin = binaryName ?? resolveCursorBinaryName();
  try {
    const res = child_process.spawnSync(bin, ["--help"], {
      stdio: "pipe",
      timeout: 2000,
      windowsHide: true,
      encoding: "utf8",
      shell: process.platform === "win32",
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

export class CursorAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = "cursor";
  readonly supportsHeadlessSpawn: boolean = true;
  private readonly binaryName: string;

  constructor(opts?: { supportsHeadlessSpawn?: boolean; binaryName?: string }) {
    this.binaryName = opts?.binaryName ?? "agent";
    if (opts?.supportsHeadlessSpawn !== undefined) {
      this.supportsHeadlessSpawn = opts.supportsHeadlessSpawn;
    }
  }

  buildHeadlessCommand(
    prompt: string,
    model: string,
    _opts?: { reasoningEffort?: string }
  ): { cmd: string; args: string[] } {
    const args: string[] = ["-p", prompt, "--force", "--output-format", "json"];
    if (model) {
      args.push("--model", model);
    }
    return { cmd: this.binaryName, args };
  }

  buildResumeCommand(
    harnessSessionId: string,
    prompt: string,
    model?: string
  ): { cmd: string; args: string[] } {
    const args: string[] = [
      "-p",
      prompt,
      "--resume",
      harnessSessionId,
      "--force",
      "--output-format",
      "json",
    ];
    if (model) {
      args.push("--model", model);
    }
    return { cmd: this.binaryName, args };
  }

  buildInteractiveResumeCommand(
    harnessSessionId: string,
    model?: string
  ): { cmd: string; args: string[] } {
    const args: string[] = ["--resume", harnessSessionId];
    if (model) {
      args.push("--model", model);
    }
    return { cmd: this.binaryName, args };
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
    const cursorDir = path.join(homeDir, ".cursor");

    for (const role of AGENT_ROLES) {
      targets.push(path.join(cursorDir, "agents", `asd-${role}.md`));
    }
    for (const skill of ASD_SKILLS) {
      targets.push(path.join(cursorDir, "skills", skill, "SKILL.md"));
    }
    targets.push(path.join(cursorDir, "hooks.json"));
    targets.push(path.join(cursorDir, "mcp.json"));
    targets.push(path.join(cursorDir, "cli-config.json"));

    return targets;
  }
}

export const cursorAdapter: HarnessAdapter = new CursorAdapter();
