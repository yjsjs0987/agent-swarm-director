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

/** One normalized transcript message. `index` is the stable pagination cursor. */
export interface TranscriptMessage {
  /** 0-based position in the source transcript (JSONL line number or source order). */
  index: number;
  /** "user" | "assistant" | "system" | ... (lowercased source role). */
  role: string;
  /** Concatenated text content, already run through redactSecrets. */
  text: string;
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
  if (r === "user_message") return "user";
  if (r === "agent_message") return "assistant";
  return r || "unknown";
}

/**
 * Extract { role, text, timestamp } from one parsed JSONL line, tolerating
 * claude-code, codex, antigravity and generic shapes. Returns null when the
 * line carries no readable message text (meta events, malformed lines, ...).
 */
function extractLineMessage(line: Rec): { role: string; text: string; timestamp?: string } | null {
  // codex rollout: {"type":"response_item","payload":{"type":"message","role":...,"content":[...]}}
  if (getStr(line, "type") === "response_item") {
    const payload = getRec(line, "payload");
    if (payload && getStr(payload, "type") === "message") {
      const text = contentToText(payload.content);
      if (text.trim()) {
        return { role: normalizeRole(getStr(payload, "role") ?? "unknown"), text };
      }
    }
    return null;
  }

  // codex event stream: {"type":"event_msg","payload":{"type":"user_message"|"agent_message","message":"..."}}
  if (getStr(line, "type") === "event_msg") {
    const payload = getRec(line, "payload");
    const kind = payload ? getStr(payload, "type") : undefined;
    if (kind === "user_message" || kind === "agent_message") {
      const text = getStr(payload, "message") ?? "";
      if (text.trim()) {
        return { role: normalizeRole(kind), text, timestamp: getStr(line, "timestamp") };
      }
    }
    return null;
  }

  // claude-code: {"type":"user","message":{"role":"user","content":"..."},"timestamp":"..."}
  const message = getRec(line, "message");
  if (message) {
    const text = contentToText(message.content);
    if (text.trim()) {
      return {
        role: normalizeRole(getStr(message, "role") ?? getStr(line, "type") ?? "unknown"),
        text,
        timestamp: getStr(line, "timestamp") ?? getStr(message, "timestamp"),
      };
    }
    return null;
  }

  // antigravity / generic: {"role":"user","content":"..."} or {"text":"..."}
  const text = contentToText(line.content) || getStr(line, "text") || "";
  if (text.trim()) {
    return {
      role: normalizeRole(getStr(line, "role") ?? getStr(line, "type") ?? "unknown"),
      text,
      timestamp:
        getStr(line, "timestamp") ??
        getStr(line, "ts") ??
        epochToIso(line.time),
    };
  }
  return null;
}

function parseJsonlLine(raw: string): { role: string; text: string; timestamp?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // malformed line: skipped gracefully
  }
  if (!isRec(parsed)) return null;
  const extracted = extractLineMessage(parsed);
  if (!extracted) return null;
  return { role: extracted.role, text: redactSecrets(extracted.text), timestamp: extracted.timestamp };
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
  const messages: TranscriptMessage[] = [];
  for (let i = 0; i < lines.length; i++) {
    const index = baseIndex + i;
    if (options.before !== undefined && index >= options.before) continue;
    const parsed = parseJsonlLine(lines[i] ?? "");
    if (!parsed) continue;
    const msg: TranscriptMessage = { index, role: parsed.role, text: parsed.text };
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
  timestamp?: string;
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

    const partsByMessage = new Map<string, string[]>();
    for (const row of partRows) {
      if (typeof row.message_id !== "string") continue;
      const data = parseJsonObject(row.data);
      if (!data) continue;
      const text = getStr(data, "text");
      if (!text) continue;
      const list = partsByMessage.get(row.message_id) ?? [];
      list.push(text);
      partsByMessage.set(row.message_id, list);
    }

    const messages: OpencodeRawMessage[] = [];
    for (const row of msgRows) {
      if (typeof row.id !== "string") continue;
      const data = parseJsonObject(row.data);
      const role = normalizeRole((data && getStr(data, "role")) || "unknown");
      const timeRec = data ? getRec(data, "time") : undefined;
      const created = timeRec ? timeRec.created : undefined;
      const parts = partsByMessage.get(row.id);
      const text = parts && parts.length > 0 ? parts.join("\n") : data ? contentToText(data.content) : "";
      if (!text.trim()) continue;
      const msg: OpencodeRawMessage = { id: row.id, role, text: text };
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
  const partsByMessage = new Map<string, Array<{ order: number; text: string }>>();
  for (const { file, data } of partFiles) {
    const record = getRec(data, "data") ?? data;
    const text = getStr(record, "text");
    if (!text) continue;
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
    list.push({ order, text });
    partsByMessage.set(mid, list);
  }

  const messages: OpencodeRawMessage[] = [];
  for (const entry of found) {
    const parts = (partsByMessage.get(entry.id) ?? []).sort((a, b) => a.order - b.order);
    const text = parts.length > 0 ? parts.map((p) => p.text).join("\n") : contentToText(entry.data.content);
    if (!text.trim()) continue;
    const timeRec = getRec(entry.data, "time");
    const created = timeRec ? timeRec.created : undefined;
    const msg: OpencodeRawMessage = {
      id: entry.id,
      role: normalizeRole(getStr(entry.data, "role") ?? "unknown"),
      text,
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
    const msg: TranscriptMessage = { index: i, role: item.role, text: redactSecrets(item.text) };
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
