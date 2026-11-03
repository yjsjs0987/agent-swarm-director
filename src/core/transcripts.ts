/**
 * 5-Harness original transcript reader (CR-10).
 *
 * Locates and reads original conversation transcripts for every supported
 * harness without touching their live state:
 *
 * - claude-code : ~/.claude/projects/<encoded-or-glob>/<sessionId>.jsonl
 * - codex       : ~/.codex/sessions/.../rollout-*threadId*.jsonl (recursive)
 * - opencode    : ~/.local/share/opencode/opencode.db (readOnly DatabaseSync)
 *                 with a ~/.local/share/opencode/storage/ JSON fallback
 * - antigravity : ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl
 *                 (legacy ~/.gemini/antigravity/brain/<id>/...)
 * - cursor      : no stable on-disk transcript format -> found:false / "unsupported"
 *
 * Guarantees:
 * - `transcriptPath` option overrides location entirely (read as JSONL).
 * - Tail/chunk reading capped at 20MB (messages indexed by 0-based line number,
 *   so malformed lines are skipped but pagination stays stable via `before`).
 * - Latest window default: limit=200. `before` is an exclusive upper bound on
 *   message index; pass the first index of the previous page to walk backward.
 * - Every message text is run through `redactSecrets`.
 * - Missing / corrupt / malformed data never throws; results report
 *   found:false with an error string instead.
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactSecrets } from "./redact.ts";
import type { HarnessId } from "./types.ts";

/** Structured tool invocation extracted from a harness transcript turn. */
export interface TranscriptToolUseItem {
  id?: string;
  name: string;
  input?: string;
}

/** Structured tool execution result extracted from a harness transcript turn. */
export interface TranscriptToolResultItem {
  toolUseId?: string;
  name?: string;
  output: string;
  isError?: boolean;
}

/** High-level message classification category for GUI rendering. */
export type TranscriptMessageCategory =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "system";

/** One normalized transcript message. `index` is the stable pagination cursor. */
export interface TranscriptMessage {
  /** 0-based position in the source transcript (JSONL line number or source order). */
  index: number;
  /** "user" | "assistant" | "tool" | "system" | ... (lowercased source role). */
  role: string;
  /** Primary classification category ("user" | "assistant" | "thinking" | "tool_use" | "tool_result" | "system"). */
  category?: TranscriptMessageCategory;
  /** Concatenated text content, already run through redactSecrets. */
  text: string;
  /** Extracted reasoning / thinking text (redacted), when present on this turn/step. */
  thinking?: string;
  /** Extracted tool invocations on this turn/step (redacted). */
  toolUse?: TranscriptToolUseItem[];
  /** Extracted tool execution results on this turn/step (redacted). */
  toolResult?: TranscriptToolResultItem[];
  /** ISO timestamp when the source provides one. */
  timestamp?: string;
}

/** Result of reading a harness transcript (always returns, never throws). */
export interface HarnessTranscript {
  found: boolean;
  harness: HarnessId;
  sessionId: string;
  /** Resolved transcript file (JSONL) or SQLite database path. */
  transcriptPath?: string;
  /** Ascending-by-index window of messages (tail window of `limit`). */
  messages: TranscriptMessage[];
  /** True when older messages exist (pass messages[0].index as `before`). */
  hasMore: boolean;
  /** True when the source was only partially read (20MB cap on huge JSONL). */
  truncated: boolean;
  error?: string;
}

export interface LocateTranscriptOptions {
  /** Override HOME (used by tests; defaults to os.homedir()). */
  homeDir?: string;
  /** Explicit transcript file path — bypasses all discovery when set. */
  transcriptPath?: string;
}

export interface ReadTranscriptOptions extends LocateTranscriptOptions {
  /** Max messages returned from the latest window. Default 200. */
  limit?: number;
  /** Exclusive upper bound on message index for backward pagination. */
  before?: number;
  /** JSONL read cap in bytes. Default 20MB. (Exposed for tests.) */
  maxReadBytes?: number;
}

export interface TranscriptLocation {
  found: boolean;
  harness: HarnessId;
  sessionId: string;
  transcriptPath?: string;
  /** opencode storage fallback root (no single transcript file exists). */
  storageDir?: string;
  error?: string;
}

const DEFAULT_MAX_READ_BYTES = 20 * 1024 * 1024;
const DEFAULT_LIMIT = 200;
const NEWLINE = 10;

// ============================================================================
// Tolerant JSON extraction helpers
// ============================================================================

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function getStr(obj: Rec, key: string): string | undefined {
  return str(obj[key]);
}

function getRec(obj: Rec, key: string): Rec | undefined {
  const v = obj[key];
  return isRec(v) ? v : undefined;
}

function parseJsonObject(raw: unknown): Rec | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRec(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Flatten a message `content` field (string or content-block array) to text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item) parts.push(item);
      continue;
    }
    if (isRec(item) && typeof item.text === "string" && item.text) {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

function epochToIso(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return new Date(v).toISOString();
  }
  return undefined;
}

function normalizeRole(role: string): string {
  const r = role.trim().toLowerCase();
  if (r === "user_message" || r === "user_input" || r === "human") return "user";
  if (r === "agent_message" || r === "planner_response" || r === "model") return "assistant";
  if (r === "tool_response" || r === "function_call_output" || r === "custom_tool_call_output") return "tool";
  return r || "unknown";
}

function cleanAntigravityUserText(raw: string): string {
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(raw);
  const base = match ? match[1]! : raw;
  return base
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, "")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, "")
    .replace(/<\/?USER_REQUEST>/gi, "")
    .trim();
}

function serializeToolInput(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === "string") return redactSecrets(val);
  try {
    return redactSecrets(JSON.stringify(val));
  } catch {
    return redactSecrets(String(val));
  }
}

interface ExtractedMessageFields {
  role: string;
  category: TranscriptMessageCategory;
  text: string;
  thinking?: string;
  toolUse?: TranscriptToolUseItem[];
  toolResult?: TranscriptToolResultItem[];
  timestamp?: string;
}

function deriveCategory(
  role: string,
  text: string,
  thinking: string | undefined,
  toolUse: TranscriptToolUseItem[] | undefined,
  toolResult: TranscriptToolResultItem[] | undefined
): TranscriptMessageCategory {
  if (role === "user") {
    if (!text.trim() && toolResult && toolResult.length > 0) return "tool_result";
    return "user";
  }
  if (role === "tool") return "tool_result";
  if (role === "system" || role === "developer") return "system";
  if (text.trim()) return "assistant";
  if (toolUse && toolUse.length > 0) return "tool_use";
  if (thinking && thinking.trim()) return "thinking";
  if (toolResult && toolResult.length > 0) return "tool_result";
  return "assistant";
}

/**
 * Extract structured message fields (role, category, text, thinking, toolUse, toolResult, timestamp)
 * from one parsed JSONL line across Claude Code, Codex, Antigravity, and generic shapes.
 */
function extractLineMessage(line: Rec): ExtractedMessageFields | null {
  const lineType = getStr(line, "type");
  const lineTs =
    getStr(line, "timestamp") ??
    getStr(line, "created_at") ??
    getStr(line, "ts") ??
    epochToIso(line.time);

  // 1. Antigravity native step types: USER_INPUT, PLANNER_RESPONSE, TOOL_RESPONSE
  if (lineType === "USER_INPUT") {
    const rawContent = contentToText(line.content) || getStr(line, "text") || "";
    const cleaned = cleanAntigravityUserText(rawContent);
    if (!cleaned) return null;
    return {
      role: "user",
      category: "user",
      text: cleaned,
      timestamp: lineTs,
    };
  }

  if (lineType === "PLANNER_RESPONSE") {
    const text = (contentToText(line.content) || getStr(line, "text") || "").trim();
    const thinking = (getStr(line, "thinking") ?? "").trim();
    const rawToolCalls = Array.isArray(line.tool_calls) ? line.tool_calls : [];
    const toolUse: TranscriptToolUseItem[] = [];
    for (const tc of rawToolCalls) {
      if (!isRec(tc)) continue;
      const name = getStr(tc, "name") ?? getStr(tc, "tool_name") ?? "";
      if (!name) continue;
      const item: TranscriptToolUseItem = { name };
      const id = getStr(tc, "id") ?? getStr(tc, "call_id");
      if (id) item.id = id;
      const input = serializeToolInput(tc.args ?? tc.arguments ?? tc.input);
      if (input !== undefined) item.input = input;
      toolUse.push(item);
    }
    if (!text && !thinking && toolUse.length === 0) return null;
    const category = deriveCategory(
      "assistant",
      text,
      thinking || undefined,
      toolUse.length > 0 ? toolUse : undefined,
      undefined
    );
    return {
      role: "assistant",
      category,
      text,
      thinking: thinking || undefined,
      toolUse: toolUse.length > 0 ? toolUse : undefined,
      timestamp: lineTs,
    };
  }

  if (lineType === "TOOL_RESPONSE") {
    const output = (
      contentToText(line.content) ||
      getStr(line, "output") ||
      getStr(line, "result") ||
      getStr(line, "text") ||
      ""
    ).trim();
    const toolName = getStr(line, "tool_name") ?? getStr(line, "name");
    const toolUseId = getStr(line, "tool_call_id") ?? getStr(line, "id");
    if (!output && !toolName) return null;
    const tr: TranscriptToolResultItem = {
      output,
      ...(toolUseId ? { toolUseId } : {}),
      ...(toolName ? { name: toolName } : {}),
      ...(line.status === "ERROR" || line.is_error === true ? { isError: true } : {}),
    };
    return {
      role: "tool",
      category: "tool_result",
      text: output,
      toolResult: [tr],
      timestamp: lineTs,
    };
  }

  if (lineType === "SYSTEM_MESSAGE") {
    return null;
  }

  // 2. Codex rollout: {"type":"response_item","payload":{...}}
  if (lineType === "response_item") {
    const payload = getRec(line, "payload");
    if (!payload) return null;
    const payloadType = getStr(payload, "type");

    if (payloadType === "message") {
      const role = normalizeRole(getStr(payload, "role") ?? "unknown");
      if (role === "developer" || role === "system") return null;
      const text = contentToText(payload.content).trim();
      if (!text) return null;
      return {
        role,
        category: role === "user" ? "user" : "assistant",
        text,
        timestamp: lineTs,
      };
    }

    if (payloadType === "reasoning") {
      const summaryParts: string[] = [];
      if (Array.isArray(payload.summary)) {
        for (const s of payload.summary) {
          if (isRec(s) && typeof s.text === "string" && s.text.trim()) {
            summaryParts.push(s.text.trim());
          }
        }
      }
      const fallbackThinking = contentToText(payload.content) || getStr(payload, "text") || "";
      const thinking = (summaryParts.join("\n") || fallbackThinking).trim();
      if (!thinking) return null;
      return {
        role: "assistant",
        category: "thinking",
        text: "",
        thinking,
        timestamp: lineTs,
      };
    }

    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const name = getStr(payload, "name") ?? "tool";
      const id = getStr(payload, "call_id") ?? getStr(payload, "id");
      const input = serializeToolInput(payload.arguments ?? payload.input);
      const item: TranscriptToolUseItem = {
        name,
        ...(id ? { id } : {}),
        ...(input !== undefined ? { input } : {}),
      };
      return {
        role: "assistant",
        category: "tool_use",
        text: "",
        toolUse: [item],
        timestamp: lineTs,
      };
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const toolUseId = getStr(payload, "call_id") ?? getStr(payload, "id");
      const output = (
        contentToText(payload.output) ||
        getStr(payload, "output") ||
        ""
      ).trim();
      const item: TranscriptToolResultItem = {
        output,
        ...(toolUseId ? { toolUseId } : {}),
      };
      return {
        role: "tool",
        category: "tool_result",
        text: output,
        toolResult: [item],
        timestamp: lineTs,
      };
    }

    return null;
  }

  // 3. Codex event stream: {"type":"event_msg","payload":{"type":"user_message"|"agent_message"|"agent_reasoning",...}}
  if (lineType === "event_msg") {
    const payload = getRec(line, "payload");
    const kind = payload ? getStr(payload, "type") : undefined;
    if (kind === "user_message" || kind === "agent_message") {
      const text = (getStr(payload!, "message") ?? "").trim();
      if (text) {
        const role = normalizeRole(kind);
        return {
          role,
          category: role === "user" ? "user" : "assistant",
          text,
          timestamp: lineTs,
        };
      }
    }
    if (kind === "agent_reasoning") {
      const thinking = (getStr(payload!, "text") ?? getStr(payload!, "message") ?? "").trim();
      if (thinking) {
        return {
          role: "assistant",
          category: "thinking",
          text: "",
          thinking,
          timestamp: lineTs,
        };
      }
    }
    return null;
  }

  // 4. Claude Code: {"type":"user"|"assistant","message":{"role":...,"content":[...]},"timestamp":"..."}
  const message = getRec(line, "message");
  if (message) {
    const rawRole = normalizeRole(getStr(message, "role") ?? lineType ?? "unknown");
    const ts = lineTs ?? getStr(message, "timestamp");
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolUse: TranscriptToolUseItem[] = [];
    const toolResult: TranscriptToolResultItem[] = [];

    if (typeof message.content === "string") {
      if (message.content.trim()) textParts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (typeof block === "string") {
          if (block.trim()) textParts.push(block);
          continue;
        }
        if (!isRec(block)) continue;
        const bType = getStr(block, "type");
        if (bType === "thinking" || bType === "reasoning") {
          const th = (getStr(block, "thinking") ?? getStr(block, "text") ?? "").trim();
          if (th) thinkingParts.push(th);
        } else if (bType === "tool_use") {
          const name = getStr(block, "name") ?? "tool";
          const id = getStr(block, "id");
          const input = serializeToolInput(block.input ?? block.arguments);
          toolUse.push({
            name,
            ...(id ? { id } : {}),
            ...(input !== undefined ? { input } : {}),
          });
        } else if (bType === "tool_result") {
          const toolUseId = getStr(block, "tool_use_id") ?? getStr(block, "id");
          const output = (
            contentToText(block.content) ||
            getStr(block, "output") ||
            ""
          ).trim();
          toolResult.push({
            output,
            ...(toolUseId ? { toolUseId } : {}),
            ...(block.is_error === true ? { isError: true } : {}),
          });
        } else if (typeof block.text === "string" && block.text) {
          textParts.push(block.text);
        }
      }
    }

    const text = textParts.join("\n").trim();
    const thinking = thinkingParts.join("\n").trim();
    if (!text && !thinking && toolUse.length === 0 && toolResult.length === 0) {
      return null;
    }

    const category = deriveCategory(
      rawRole,
      text,
      thinking || undefined,
      toolUse.length > 0 ? toolUse : undefined,
      toolResult.length > 0 ? toolResult : undefined
    );
    const effectiveRole = category === "tool_result" && !text ? "tool" : rawRole;
    return {
      role: effectiveRole,
      category,
      text,
      thinking: thinking || undefined,
      toolUse: toolUse.length > 0 ? toolUse : undefined,
      toolResult: toolResult.length > 0 ? toolResult : undefined,
      timestamp: ts,
    };
  }

  // 5. Generic / legacy Antigravity shape: {"role":"user","content":"..."} or {"text":"..."}
  const text = (contentToText(line.content) || getStr(line, "text") || "").trim();
  const thinking = (getStr(line, "thinking") ?? "").trim();
  if (text || thinking) {
    const role = normalizeRole(getStr(line, "role") ?? lineType ?? "unknown");
    return {
      role,
      category: deriveCategory(role, text, thinking || undefined, undefined, undefined),
      text,
      thinking: thinking || undefined,
      timestamp: lineTs,
    };
  }
  return null;
}

function parseJsonlLine(
  raw: string,
  fullLinesByStepOrIndex?: { byLine: string[]; byStep: Map<number, Rec> },
  lineIndex?: number
): ExtractedMessageFields | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // malformed line: skipped gracefully
  }
  if (!isRec(parsed)) return null;

  let record = parsed;
  if (
    fullLinesByStepOrIndex &&
    Array.isArray(record.truncated_fields) &&
    record.truncated_fields.length > 0
  ) {
    const stepIdx = typeof record.step_index === "number" ? record.step_index : undefined;
    let fullRec: Rec | undefined =
      stepIdx !== undefined ? fullLinesByStepOrIndex.byStep.get(stepIdx) : undefined;
    if (!fullRec && lineIndex !== undefined && lineIndex < fullLinesByStepOrIndex.byLine.length) {
      fullRec = parseJsonObject(fullLinesByStepOrIndex.byLine[lineIndex]);
    }
    if (fullRec) {
      record = { ...record, ...fullRec };
    }
  }

  const extracted = extractLineMessage(record);
  if (!extracted) return null;
  return {
    role: extracted.role,
    category: extracted.category,
    text: redactSecrets(extracted.text),
    ...(extracted.thinking ? { thinking: redactSecrets(extracted.thinking) } : {}),
    ...(extracted.toolUse
      ? {
          toolUse: extracted.toolUse.map((tu) => ({
            ...tu,
            ...(tu.input ? { input: redactSecrets(tu.input) } : {}),
          })),
        }
      : {}),
    ...(extracted.toolResult
      ? {
          toolResult: extracted.toolResult.map((tr) => ({
            ...tr,
            output: redactSecrets(tr.output),
          })),
        }
      : {}),
    ...(extracted.timestamp ? { timestamp: extracted.timestamp } : {}),
  };
}

// ============================================================================
// JSONL tail / chunk reading (20MB cap, stable line-number indexes)
// ============================================================================

/** Count newline bytes in file bytes [0, endOffset). Streaming, 1MB buffer. */
function countNewlinesBefore(filePath: string, endOffset: number): number {
  if (endOffset <= 0) return 0;
  const fd = fs.openSync(filePath, "r");
  try {
    const CHUNK = 1024 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    let count = 0;
    while (pos < endOffset) {
      const want = Math.min(CHUNK, endOffset - pos);
      const read = fs.readSync(fd, buf, 0, want, pos);
      if (read <= 0) break;
      for (let i = 0; i < read; i++) {
        if (buf[i] === NEWLINE) count++;
      }
      pos += read;
    }
    return count;
  } finally {
    fs.closeSync(fd);
  }
}

interface JsonlWindow {
  messages: TranscriptMessage[];
  truncated: boolean;
}

function loadFullTranscriptSibling(
  filePath: string
): { byLine: string[]; byStep: Map<number, Rec> } | undefined {
  try {
    if (path.basename(filePath) !== "transcript.jsonl") return undefined;
    const fullPath = path.join(path.dirname(filePath), "transcript_full.jsonl");
    if (!fs.existsSync(fullPath)) return undefined;
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > DEFAULT_MAX_READ_BYTES) {
      return undefined;
    }
    const raw = fs.readFileSync(fullPath, "utf8");
    const byLine = raw.split("\n");
    const byStep = new Map<number, Rec>();
    for (const line of byLine) {
      const obj = parseJsonObject(line.trim());
      if (obj && typeof obj.step_index === "number") {
        byStep.set(obj.step_index, obj);
      }
    }
    return { byLine, byStep };
  } catch {
    return undefined;
  }
}

// ponytail: before-pagination on >20MB files only sees the last 20MB window;
// widen maxReadBytes if a caller ever needs deeper history.
function readJsonlWindow(
  filePath: string,
  options: { limit: number; before?: number; maxReadBytes: number }
): JsonlWindow | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  let raw: string;
  let baseIndex = 0;
  let truncated = false;

  if (stat.size <= options.maxReadBytes) {
    raw = fs.readFileSync(filePath, "utf8");
  } else {
    // Tail window: read the last maxReadBytes, drop the partial first line,
    // then count newlines in the skipped prefix for stable indexes.
    const window = Math.min(stat.size, options.maxReadBytes);
    let start = stat.size - window;
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(window);
      const read = fs.readSync(fd, buf, 0, window, start);
      const text = buf.toString("utf8", 0, read);
      const firstNl = text.indexOf("\n");
      if (firstNl >= 0) {
        start += firstNl + 1;
        raw = text.slice(firstNl + 1);
      } else {
        raw = ""; // single line larger than the cap: unreadable window
      }
    } finally {
      fs.closeSync(fd);
    }
    baseIndex = countNewlinesBefore(filePath, start);
    truncated = start > 0;
  }

  const lines = raw.split("\n");
  const hasTruncatedFields = raw.includes('"truncated_fields"');
  const fullLookup = hasTruncatedFields ? loadFullTranscriptSibling(filePath) : undefined;
  const messages: TranscriptMessage[] = [];
  for (let i = 0; i < lines.length; i++) {
    const index = baseIndex + i;
    if (options.before !== undefined && index >= options.before) continue;
    const parsed = parseJsonlLine(lines[i] ?? "", fullLookup, index);
    if (!parsed) continue;
    const msg: TranscriptMessage = {
      index,
      role: parsed.role,
      category: parsed.category,
      text: parsed.text,
    };
    if (parsed.thinking) msg.thinking = parsed.thinking;
    if (parsed.toolUse && parsed.toolUse.length > 0) msg.toolUse = parsed.toolUse;
    if (parsed.toolResult && parsed.toolResult.length > 0) msg.toolResult = parsed.toolResult;
    if (parsed.timestamp) msg.timestamp = parsed.timestamp;
    messages.push(msg);
  }

  const start0 = Math.max(0, messages.length - options.limit);
  return { messages: messages.slice(start0), truncated };
}

// ============================================================================
// Harness locators
// ============================================================================

function resolveHome(homeDir?: string): string {
  return homeDir && homeDir.trim() ? homeDir : os.homedir();
}

function listFilesRecursive(root: string, filter: (dirent: fs.Dirent) => boolean): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (filter(entry)) {
      out.push(path.join(entry.parentPath ?? root, entry.name));
    }
  }
  return out;
}

function locateClaudeCode(home: string, sessionId: string): string | null {
  const projectsDir = path.join(home, ".claude", "projects");
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const fileName = `${sessionId}.jsonl`;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const candidate = path.join(dir.parentPath ?? projectsDir, dir.name, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function locateCodex(home: string, threadId: string): string | null {
  const sessionsDir = path.join(home, ".codex", "sessions");
  const matches = listFilesRecursive(sessionsDir, (dirent) => {
    if (!dirent.isFile()) return false;
    const name = dirent.name;
    return name.startsWith("rollout-") && name.endsWith(".jsonl") && name.includes(threadId);
  });
  if (matches.length === 0) return null;
  // Most recent rollout wins when multiple match.
  matches.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  return matches[0] ?? null;
}

const ANTIGRAVITY_BRAIN_ROOTS = [
  path.join(".gemini", "antigravity-cli", "brain"),
  path.join(".gemini", "antigravity", "brain"), // legacy root
];

function locateAntigravity(home: string, sessionId: string): string | null {
  for (const root of ANTIGRAVITY_BRAIN_ROOTS) {
    const brainDir = path.join(home, root);
    for (const rel of [
      path.join(sessionId, ".system_generated", "logs", "transcript.jsonl"),
      path.join(sessionId, "transcript.jsonl"), // legacy flat layout
    ]) {
      const candidate = path.join(brainDir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function opencodeDataDir(home: string): string {
  return path.join(home, ".local", "share", "opencode");
}

/**
 * Exported for tests / advanced callers: resolve where a harness transcript
 * lives without reading it.
 */
export function locateHarnessTranscript(
  harness: HarnessId,
  sessionId: string,
  options: LocateTranscriptOptions = {}
): TranscriptLocation {
  const base: TranscriptLocation = { found: false, harness, sessionId };
  try {
    if (options.transcriptPath && options.transcriptPath.trim()) {
      const p = options.transcriptPath.trim();
      if (!fs.existsSync(p)) {
        return { ...base, error: "transcriptPath does not exist" };
      }
      return { found: true, harness, sessionId, transcriptPath: p };
    }

    const home = resolveHome(options.homeDir);

    if (harness === "cursor") {
      // No stable on-disk transcript format is published for Cursor CLI.
      return { ...base, error: "unsupported" };
    }

    if (harness === "claude-code") {
      const p = locateClaudeCode(home, sessionId);
      return p ? { found: true, harness, sessionId, transcriptPath: p } : { ...base, error: "transcript not found" };
    }

    if (harness === "codex") {
      const p = locateCodex(home, sessionId);
      return p ? { found: true, harness, sessionId, transcriptPath: p } : { ...base, error: "transcript not found" };
    }

    if (harness === "antigravity") {
      const p = locateAntigravity(home, sessionId);
      return p ? { found: true, harness, sessionId, transcriptPath: p } : { ...base, error: "transcript not found" };
    }

    if (harness === "opencode") {
      const dataDir = opencodeDataDir(home);
      const dbPath = path.join(dataDir, "opencode.db");
      if (fs.existsSync(dbPath)) {
        return { found: true, harness, sessionId, transcriptPath: dbPath };
      }
      const storageDir = path.join(dataDir, "storage");
      if (fs.existsSync(storageDir)) {
        return { found: true, harness, sessionId, storageDir };
      }
      return { ...base, error: "transcript not found" };
    }

    return { ...base, error: "unsupported harness" };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================================
// opencode readers (SQLite + storage/ JSON fallback)
// ============================================================================

interface OpencodeRawMessage {
  id: string;
  role: string;
  text: string;
  thinking?: string;
  toolUse?: TranscriptToolUseItem[];
  toolResult?: TranscriptToolResultItem[];
  timestamp?: string;
}

interface OpencodePartAccumulator {
  texts: string[];
  thinkings: string[];
  toolUse: TranscriptToolUseItem[];
  toolResult: TranscriptToolResultItem[];
}

function accumulateOpencodePart(acc: OpencodePartAccumulator, data: Rec): void {
  const partType = (getStr(data, "type") ?? "text").toLowerCase();
  if (partType === "reasoning" || partType === "thinking") {
    const th = (getStr(data, "text") ?? getStr(data, "reasoning") ?? "").trim();
    if (th) acc.thinkings.push(th);
    return;
  }
  if (partType === "tool" || partType === "tool-invocation" || partType === "tool_use") {
    const name = getStr(data, "tool") ?? getStr(data, "name") ?? "tool";
    const id = getStr(data, "callID") ?? getStr(data, "call_id") ?? getStr(data, "id");
    const state = getRec(data, "state") ?? data;
    const inputVal = state.input ?? data.input ?? data.args;
    const outputVal = state.output ?? data.output ?? data.result;
    const inputStr = serializeToolInput(inputVal);
    acc.toolUse.push({
      name,
      ...(id ? { id } : {}),
      ...(inputStr !== undefined ? { input: inputStr } : {}),
    });
    if (outputVal !== undefined && outputVal !== null) {
      const outStr =
        typeof outputVal === "string"
          ? outputVal
          : contentToText(outputVal) || JSON.stringify(outputVal);
      acc.toolResult.push({
        output: outStr,
        ...(id ? { toolUseId: id } : {}),
        ...(name ? { name } : {}),
        ...(state.status === "error" || Boolean(state.error) ? { isError: true } : {}),
      });
    }
    return;
  }
  const text = getStr(data, "text");
  if (text) acc.texts.push(text);
}

function readOpencodeDbMessages(dbPath: string, sessionId: string): OpencodeRawMessage[] | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const msgRows = db
      .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY rowid")
      .all(sessionId) as Array<{ id: unknown; data: unknown }>;
    const partRows = db
      .prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY rowid")
      .all(sessionId) as Array<{ message_id: unknown; data: unknown }>;

    const partsByMessage = new Map<string, OpencodePartAccumulator>();
    for (const row of partRows) {
      if (typeof row.message_id !== "string") continue;
      const data = parseJsonObject(row.data);
      if (!data) continue;
      let acc = partsByMessage.get(row.message_id);
      if (!acc) {
        acc = { texts: [], thinkings: [], toolUse: [], toolResult: [] };
        partsByMessage.set(row.message_id, acc);
      }
      accumulateOpencodePart(acc, data);
    }

    const messages: OpencodeRawMessage[] = [];
    for (const row of msgRows) {
      if (typeof row.id !== "string") continue;
      const data = parseJsonObject(row.data);
      const role = normalizeRole((data && getStr(data, "role")) || "unknown");
      const timeRec = data ? getRec(data, "time") : undefined;
      const created = timeRec ? timeRec.created : undefined;
      const acc = partsByMessage.get(row.id);
      const text =
        acc && acc.texts.length > 0
          ? acc.texts.join("\n")
          : data
            ? contentToText(data.content)
            : "";
      const thinking = acc && acc.thinkings.length > 0 ? acc.thinkings.join("\n") : undefined;
      const toolUse = acc && acc.toolUse.length > 0 ? acc.toolUse : undefined;
      const toolResult = acc && acc.toolResult.length > 0 ? acc.toolResult : undefined;
      if (!text.trim() && !thinking && !toolUse && !toolResult) continue;
      const msg: OpencodeRawMessage = {
        id: row.id,
        role,
        text,
        ...(thinking ? { thinking } : {}),
        ...(toolUse ? { toolUse } : {}),
        ...(toolResult ? { toolResult } : {}),
      };
      const ts = epochToIso(created);
      if (ts) msg.timestamp = ts;
      messages.push(msg);
    }
    return messages;
  } catch {
    return null; // schema drift or corrupt db -> caller falls back to storage/
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

function walkJsonFiles(root: string): Array<{ file: string; data: Rec }> {
  const out: Array<{ file: string; data: Rec }> = [];
  for (const file of listFilesRecursive(root, (d) => d.isFile() && d.name.endsWith(".json"))) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseJsonObject(raw);
    if (parsed) out.push({ file, data: parsed });
  }
  return out;
}

function readOpencodeStorageMessages(storageDir: string, sessionId: string): OpencodeRawMessage[] | null {
  const messageFiles = walkJsonFiles(path.join(storageDir, "message"));
  const found: Array<{ id: string; data: Rec; mtime: number }> = [];
  for (const { file, data } of messageFiles) {
    // Accept both {data:{...}} wrapped (newer) and flat (older) record shapes.
    const record = getRec(data, "data") ?? data;
    const sid = getStr(record, "sessionID") ?? getStr(record, "session_id");
    if (sid !== sessionId) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      // keep 0
    }
    const id = getStr(record, "id") ?? path.basename(file, ".json");
    found.push({ id, data: record, mtime });
  }
  if (found.length === 0) return null;

  found.sort((a, b) => {
    const ta = (getRec(a.data, "time")?.created as number) ?? a.mtime;
    const tb = (getRec(b.data, "time")?.created as number) ?? b.mtime;
    return (typeof ta === "number" ? ta : 0) - (typeof tb === "number" ? tb : 0);
  });

  // Collect parts once, grouped by messageId (matched by field or path segment).
  const partFiles = walkJsonFiles(path.join(storageDir, "part"));
  const partsByMessage = new Map<string, Array<{ order: number; record: Rec }>>();
  for (const { file, data } of partFiles) {
    const record = getRec(data, "data") ?? data;
    let mid = getStr(record, "messageID") ?? getStr(record, "message_id");
    if (!mid) {
      const segments = file.split(/[\\/]/);
      for (const target of found) {
        if (segments.includes(target.id)) {
          mid = target.id;
          break;
        }
      }
    }
    if (!mid) continue;
    const idSuffix = /(\d+)\s*$/.exec(getStr(record, "id") ?? path.basename(file, ".json"));
    const order = idSuffix ? Number.parseInt(idSuffix[1] ?? "0", 10) : Number.MAX_SAFE_INTEGER;
    const list = partsByMessage.get(mid) ?? [];
    list.push({ order, record });
    partsByMessage.set(mid, list);
  }

  const messages: OpencodeRawMessage[] = [];
  for (const entry of found) {
    const parts = (partsByMessage.get(entry.id) ?? []).sort((a, b) => a.order - b.order);
    const acc: OpencodePartAccumulator = { texts: [], thinkings: [], toolUse: [], toolResult: [] };
    for (const p of parts) {
      accumulateOpencodePart(acc, p.record);
    }
    const text = acc.texts.length > 0 ? acc.texts.join("\n") : contentToText(entry.data.content);
    const thinking = acc.thinkings.length > 0 ? acc.thinkings.join("\n") : undefined;
    const toolUse = acc.toolUse.length > 0 ? acc.toolUse : undefined;
    const toolResult = acc.toolResult.length > 0 ? acc.toolResult : undefined;
    if (!text.trim() && !thinking && !toolUse && !toolResult) continue;
    const timeRec = getRec(entry.data, "time");
    const created = timeRec ? timeRec.created : undefined;
    const msg: OpencodeRawMessage = {
      id: entry.id,
      role: normalizeRole(getStr(entry.data, "role") ?? "unknown"),
      text,
      ...(thinking ? { thinking } : {}),
      ...(toolUse ? { toolUse } : {}),
      ...(toolResult ? { toolResult } : {}),
    };
    const ts = epochToIso(created);
    if (ts) msg.timestamp = ts;
    messages.push(msg);
  }
  return messages;
}

// ============================================================================
// Public read API
// ============================================================================

function toTranscriptMessages(raw: OpencodeRawMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item) continue;
    const text = redactSecrets(item.text);
    const thinking = item.thinking ? redactSecrets(item.thinking) : undefined;
    const toolUse = item.toolUse?.map((tu) => ({
      ...tu,
      ...(tu.input ? { input: redactSecrets(tu.input) } : {}),
    }));
    const toolResult = item.toolResult?.map((tr) => ({
      ...tr,
      output: redactSecrets(tr.output),
    }));
    const category = deriveCategory(item.role, text, thinking, toolUse, toolResult);
    const msg: TranscriptMessage = {
      index: i,
      role: item.role,
      category,
      text,
      ...(thinking ? { thinking } : {}),
      ...(toolUse && toolUse.length > 0 ? { toolUse } : {}),
      ...(toolResult && toolResult.length > 0 ? { toolResult } : {}),
    };
    if (item.timestamp) msg.timestamp = item.timestamp;
    out.push(msg);
  }
  return out;
}

/**
 * Read the latest window of a harness transcript. Never throws: every
 * failure path (missing session, corrupt data, unsupported harness) returns
 * found:false with an error string.
 */
export function readHarnessTranscript(
  harness: HarnessId,
  sessionId: string,
  options: ReadTranscriptOptions = {}
): HarnessTranscript {
  const limit = options.limit !== undefined && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const maxReadBytes = options.maxReadBytes !== undefined && options.maxReadBytes > 0
    ? options.maxReadBytes
    : DEFAULT_MAX_READ_BYTES;
  const base: HarnessTranscript = { found: false, harness, sessionId, messages: [], hasMore: false, truncated: false };

  try {
    // transcriptPath has top priority: read the file directly as JSONL.
    if (options.transcriptPath && options.transcriptPath.trim()) {
      const window = readJsonlWindow(options.transcriptPath.trim(), {
        limit,
        before: options.before,
        maxReadBytes,
      });
      if (!window) {
        return { ...base, error: "transcriptPath is not a readable file" };
      }
      return {
        ...base,
        found: true,
        transcriptPath: options.transcriptPath.trim(),
        messages: window.messages,
        hasMore: window.messages.length > 0 && (window.messages[0]?.index ?? 0) > 0,
        truncated: window.truncated,
      };
    }

    const location = locateHarnessTranscript(harness, sessionId, options);
    if (!location.found) {
      return { ...base, error: location.error ?? "transcript not found" };
    }

    // opencode: SQLite db first, storage/ JSON fallback second.
    if (harness === "opencode") {
      let raw: OpencodeRawMessage[] | null = null;
      let transcriptPath: string | undefined;
      if (location.transcriptPath && location.transcriptPath.endsWith(".db")) {
        raw = readOpencodeDbMessages(location.transcriptPath, sessionId);
        transcriptPath = location.transcriptPath;
      }
      if (!raw && location.storageDir) {
        raw = readOpencodeStorageMessages(location.storageDir, sessionId);
      }
      if (!raw) {
        return { ...base, error: "opencode transcript could not be read" };
      }
      const all = toTranscriptMessages(raw);
      const filtered = options.before !== undefined ? all.filter((m) => m.index < (options.before ?? 0)) : all;
      const messages = filtered.slice(Math.max(0, filtered.length - limit));
      return {
        found: true,
        harness,
        sessionId,
        transcriptPath,
        messages,
        hasMore: messages.length > 0 && (messages[0]?.index ?? 0) > 0,
        truncated: false,
      };
    }

    // JSONL-based harnesses (claude-code, codex, antigravity).
    if (!location.transcriptPath) {
      return { ...base, error: location.error ?? "transcript not found" };
    }
    const window = readJsonlWindow(location.transcriptPath, {
      limit,
      before: options.before,
      maxReadBytes,
    });
    if (!window) {
      return { ...base, transcriptPath: location.transcriptPath, error: "transcript could not be read" };
    }
    return {
      found: true,
      harness,
      sessionId,
      transcriptPath: location.transcriptPath,
      messages: window.messages,
      hasMore: window.messages.length > 0 && (window.messages[0]?.index ?? 0) > 0,
      truncated: window.truncated,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}
