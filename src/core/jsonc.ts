/**
 * Zero-dependency JSONC parser and TOML fence manager.
 * Strips // and block comments, trailing commas, then JSON.parse.
 * String-literal safe: comment-like sequences inside strings are preserved.
 */

import { ASD_VERSION } from "./types.ts";

const BEGIN_FENCE = `# >>> BEGIN MANAGED BY ASD-V2 (v${ASD_VERSION}) >>>`;
const END_FENCE = `# <<< END MANAGED BY ASD-V2 <<<`;

/**
 * Parse JSONC (JSON with Comments) text into a typed value.
 * - Removes // single-line comments
 * - Removes block comments
 * - Removes trailing commas before ] or }
 * - Preserves comment-like sequences inside string literals
 * - Throws descriptive SyntaxError on invalid JSON
 */
export function parseJsonc<T>(text: string): T {
  const cleaned = stripJsoncComments(text);
  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    if (e instanceof SyntaxError) {
      const msg = e.message;
      throw new SyntaxError(`Invalid JSONC: ${msg}`);
    }
    throw e;
  }
}

/**
 * Strip JSONC comments and trailing commas from text.
 * Returns cleaned text ready for JSON.parse.
 */
function stripJsoncComments(text: string): string {
  let result = "";
  let i = 0;
  const len = text.length;
  let inString = false;
  let stringChar = "";
  let escapeNext = false;

  while (i < len) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      result += ch;
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }

    // Not in string - check for comment starts or string starts
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      i++;
      continue;
    }

    // Single-line comment //
    if (ch === "/" && next === "/") {
      // Skip to end of line
      i += 2;
      while (i < len && text[i] !== "\n" && text[i] !== "\r") {
        i++;
      }
      // Keep the newline if present
      if (i < len && (text[i] === "\n" || text[i] === "\r")) {
        result += text[i];
        i++;
        if (text[i] === "\n" && text[i - 1] === "\r") {
          result += text[i];
          i++;
        }
      }
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len - 1) {
        if (text[i] === "*" && text[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result += ch;
    i++;
  }

  // Remove trailing commas before ] or }
  return removeTrailingCommas(result);
}

/**
 * Remove trailing commas before ] or } in JSON-like text.
 * String-literal safe.
 */
function removeTrailingCommas(text: string): string {
  let result = "";
  let i = 0;
  const len = text.length;
  let inString = false;
  let stringChar = "";
  let escapeNext = false;

  while (i < len) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      result += ch;
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      i++;
      continue;
    }

    // Check for trailing comma: comma followed by optional whitespace then ] or }
    if (ch === ",") {
      let j = i + 1;
      // Skip whitespace
      while (j < len && /\s/.test(text[j])) {
        j++;
      }
      if (j < len && (text[j] === "]" || text[j] === "}")) {
        // Skip the comma, don't add to result
        i++;
        continue;
      }
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * Upsert a managed TOML fence block.
 * Idempotent: calling twice with same content yields identical output.
 * If a fence with different version marker exists, replaces it.
 */
export function upsertTomlFence(
  existingToml: string,
  blockContent: string,
  version?: string
): string {
  const beginMarker = version
    ? `# >>> BEGIN MANAGED BY ASD-V2 (v${version}) >>>`
    : BEGIN_FENCE;
  const endMarker = END_FENCE;

  const fenceRegex = new RegExp(
    `# >>> BEGIN MANAGED BY ASD-V2 \\(v[^)]+\\) >>>[\\s\\S]*?# <<< END MANAGED BY ASD-V2 <<<`,
    "g"
  );

  const newBlock = `${beginMarker}\n${blockContent.trimEnd()}\n${endMarker}`;

  if (fenceRegex.test(existingToml)) {
    // Replace existing fence(s)
    return existingToml.replace(fenceRegex, newBlock);
  }

  // No existing fence - append to end
  const trimmed = existingToml.trimEnd();
  if (trimmed.length === 0) {
    return newBlock;
  }
  return `${trimmed}\n\n${newBlock}`;
}

/**
 * Remove the managed TOML fence block entirely.
 * Leaves surrounding content intact.
 */
export function removeTomlFence(existingToml: string): string {
  const fenceRegex = new RegExp(
    `# >>> BEGIN MANAGED BY ASD-V2 \\(v[^)]+\\) >>>[\\s\\S]*?# <<< END MANAGED BY ASD-V2 <<<\\n?`,
    "g"
  );
  return existingToml.replace(fenceRegex, "").trimEnd();
}