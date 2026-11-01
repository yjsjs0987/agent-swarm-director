/**
 * ASD v2.3 Harness Adapter Registry (src/adapters/registry.ts)
 *
 * Single resolver that maps a `HarnessId` to its adapter implementation so the
 * CLI, MCP server, and spawner share one lookup table without importing all
 * five adapter modules individually.
 *
 * Invariants:
 * - Erasable TypeScript only (zero enums, type-only imports where applicable).
 * - Zero external runtime npm dependencies.
 */

import { antigravityAdapter } from "./antigravity.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { codexAdapter } from "./codex.ts";
import { cursorAdapter } from "./cursor.ts";
import { opencodeAdapter } from "./opencode.ts";
import type { HarnessAdapter } from "../core/types.ts";

/** Resolves a harness ID to its adapter; unknown IDs fall back to claude-code. */
export function getAdapter(harnessId?: string): HarnessAdapter {
  switch (harnessId) {
    case "claude-code":
      return claudeCodeAdapter;
    case "opencode":
      return opencodeAdapter;
    case "codex":
      return codexAdapter;
    case "antigravity":
      return antigravityAdapter;
    case "cursor":
      return cursorAdapter;
    default:
      return claudeCodeAdapter;
  }
}
