/**
 * ASD v2.3 Unified Session Tracker & Multi-Project Indexer (src/core/session-tracker.ts)
 *
 * Implements:
 * 1. Native Harness Session ID extraction (`extractHarnessSessionIdFromOutput`) across
 *    Claude Code (`session_id`), Codex (`thread_id`), OpenCode (`sessionID`),
 *    Antigravity (`conversation_id` / `session_id`), and Cursor (`session_id` / `chat_id`).
 * 2. Zero-Token 0ms Hook Session & Summary Extractor (`extractHookSessionInfo`):
 *    - Extracts `harnessSessionId`, `transcriptPath`, and a 1-line summary (first 50 chars
 *      of user prompt or recent tool/file target) without any LLM calls.
 * 3. Two-Tier `.asd/sessions/` Storage:
 *    - ALL CLI/Harness sessions are recorded in `<projectRoot>/.asd/sessions/cli-recent.json`.
 *    - `/asd` orchestration & GUI main sessions are stored in `<projectRoot>/.asd/sessions/<asd-id>/`
 *      (`main.json` + `subagents/<sub-id>/meta.json`) and linked back to `cli-recent.json`.
 * 4. Multi-Project Discovery (`listKnownProjects`):
 *    - Scans `~/.asd/state/<project-hash>/core.db` to discover all projects and their latest sessions.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureGitExclude, resolveAsdPaths } from "./config.ts";
import { openProjectDb, SqliteDriver } from "./db.ts";
import { atomicWriteFileSync } from "./render.ts";
import type {
  CliRecentSessionEntry,
  HarnessId,
  KnownProjectSummary,
} from "./types.ts";

const MAX_RECENT_CLI_SESSIONS = 100;

export interface ResumeHarnessCommandOptions {
  harness: HarnessId;
  harnessSessionId: string;
  prompt: string;
  model?: string | null;
  thinkingEffort?: string | null;
  reasoningEffort?: string | null;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Builds headless resume commands (`--resume` / `exec resume` / `--session`)
 * for sending a follow-up prompt to an existing native harness session.
 * Supports both positional arguments and a single options object.
 */
export function buildResumeHarnessCommand(
  harnessOrOptions: HarnessId | ResumeHarnessCommandOptions,
  harnessSessionId?: string,
  prompt?: string,
  model?: string | null,
  thinkingEffort?: string | null
): { command: string; args: string[] } {
  const harness: HarnessId =
    typeof harnessOrOptions === "object" ? harnessOrOptions.harness : harnessOrOptions;
  const sid =
    typeof harnessOrOptions === "object"
      ? harnessOrOptions.harnessSessionId
      : (harnessSessionId ?? "");
  const textPrompt =
    typeof harnessOrOptions === "object" ? harnessOrOptions.prompt : (prompt ?? "");
  const resolvedModel =
    typeof harnessOrOptions === "object" ? harnessOrOptions.model : model;
  const resolvedEffort =
    typeof harnessOrOptions === "object"
      ? (harnessOrOptions.thinkingEffort ?? harnessOrOptions.reasoningEffort)
      : thinkingEffort;

  switch (harness) {
    case "claude-code": {
      const args = [
        "-p",
        textPrompt,
        "--resume",
        sid,
        "--output-format",
        "json",
      ];
      if (resolvedModel) args.push("--model", resolvedModel);
      return { command: "claude", args };
    }
    case "opencode": {
      const args = [
        "run",
        textPrompt,
        "--session",
        sid,
        "--format",
        "json",
      ];
      if (resolvedModel) args.push("--model", resolvedModel);
      return { command: "opencode", args };
    }
    case "codex": {
      const args = ["exec", "resume", sid, textPrompt, "--json"];
      if (resolvedModel) args.push("-m", resolvedModel);
      if (resolvedEffort) {
        args.push("-c", `model_reasoning_effort=${resolvedEffort}`);
      }
      return { command: "codex", args };
    }
    case "antigravity": {
      const args = [
        "-p",
        textPrompt,
        "--resume",
        sid,
        "--output-format",
        "json",
      ];
      if (resolvedModel) args.push("--model", resolvedModel);
      if (resolvedEffort) args.push("--effort", resolvedEffort);
      return { command: "agy", args };
    }
    case "cursor": {
      const args = [
        "-p",
        textPrompt,
        "--resume",
        sid,
        "--force",
        "--output-format",
        "json",
      ];
      if (resolvedModel) args.push("--model", resolvedModel);
      return { command: "agent", args };
    }
  }
}

export interface InteractiveResumeHarnessCommandOptions {
  harness: HarnessId;
  harnessSessionId?: string | null;
  model?: string | null;
}

/**
 * Builds interactive terminal CLI arguments to attach/resume an existing
 * native harness session (or start a new interactive session if `harnessSessionId` is omitted)
 * in a terminal or xterm.js PTY tab.
 * Supports both positional arguments and a single options object.
 */
export function buildInteractiveResumeHarnessCommand(
  harnessOrOptions: HarnessId | InteractiveResumeHarnessCommandOptions,
  harnessSessionId?: string | null,
  model?: string | null
): { command: string; args: string[]; cliString: string } {
  const harness: HarnessId =
    typeof harnessOrOptions === "object" ? harnessOrOptions.harness : harnessOrOptions;
  const sid =
    typeof harnessOrOptions === "object"
      ? (harnessOrOptions.harnessSessionId ?? "")
      : (harnessSessionId ?? "");
  const resolvedModel =
    typeof harnessOrOptions === "object" ? harnessOrOptions.model : model;

  let command = "claude";
  let args: string[] = [];
  switch (harness) {
    case "claude-code": {
      command = "claude";
      args = sid ? ["--resume", sid] : [];
      if (resolvedModel) args.push("--model", resolvedModel);
      break;
    }
    case "opencode": {
      command = "opencode";
      args = sid ? ["--session", sid] : [];
      if (resolvedModel) args.push("--model", resolvedModel);
      break;
    }
    case "codex": {
      command = "codex";
      args = sid ? ["resume", sid] : [];
      if (resolvedModel) args.push("-m", resolvedModel);
      break;
    }
    case "antigravity": {
      command = "agy";
      args = sid ? ["--resume", sid] : ["chat"];
      if (resolvedModel) args.push("--model", resolvedModel);
      break;
    }
    case "cursor": {
      command = "agent";
      args = sid ? ["--resume", sid] : [];
      if (resolvedModel) args.push("--model", resolvedModel);
      break;
    }
  }
  return {
    command,
    args,
    cliString: [command, ...args].join(" "),
  };
}

/**
 * Extracts a native harness session ID from headless JSON or JSONL stdout/stderr output.
 */
export function extractHarnessSessionIdFromOutput(
  rawOutput: string,
  _harness?: HarnessId
): string | null {
  if (!rawOutput || typeof rawOutput !== "string") return null;

  // 1. Check line-by-line JSON objects (NDJSON from codex --json, opencode --format json, claudejson)
  const lines = rawOutput.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const directCandidate =
        obj.session_id ??
        obj.sessionID ??
        obj.sessionId ??
        obj.thread_id ??
        obj.threadId ??
        obj.conversation_id ??
        obj.conversationId ??
        obj.chat_id ??
        obj.chatId;
      if (typeof directCandidate === "string" && directCandidate.trim().length > 0) {
        return directCandidate.trim();
      }
      if (obj.part && typeof obj.part === "object") {
        const part = obj.part as Record<string, unknown>;
        const partSid = part.sessionID ?? part.session_id ?? part.sessionId;
        if (typeof partSid === "string" && partSid.trim().length > 0) {
          return partSid.trim();
        }
      }
    } catch {
      // Ignore non-JSON lines
    }
  }

  // 2. Fallback regex scan for embedded JSON keys
  const regexMatch = rawOutput.match(
    /"(?:session_id|sessionID|sessionId|thread_id|conversation_id|chat_id)"\s*:\s*"([^"\s]+)"/
  );
  if (regexMatch?.[1]?.trim()) {
    return regexMatch[1].trim();
  }

  return null;
}

/**
 * Normalizes a single-line summary string (max 60 chars, single line).
 * Strips Antigravity `<USER_REQUEST>` / `<ADDITIONAL_METADATA>` wrapper tags if present.
 */
export function normalizeOneLineSummary(raw: string, maxLen = 50): string {
  const cleaned = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, "")
    .replace(/<\/?USER_REQUEST>/gi, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}...` : cleaned;
}

function normalizePathOrFileUri(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("file://")) {
    try {
      return path.resolve(fileURLToPath(trimmed));
    } catch {
      return path.resolve(trimmed.replace(/^file:\/\/\/?/, ""));
    }
  }
  return path.resolve(trimmed);
}

/**
 * Reads up to 8KB from the beginning of a local transcript JSONL file to extract
 * the first user prompt with zero LLM overhead (<1ms).
 */
export function extractSummaryFromTranscriptFile(transcriptPath: string): string {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return "";
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size === 0) return "";

    const fd = fs.openSync(transcriptPath, "r");
    try {
      const bufSize = Math.min(stat.size, 8192);
      const buf = Buffer.alloc(bufSize);
      const bytesRead = fs.readSync(fd, buf, 0, bufSize, 0);
      const headText = buf.toString("utf8", 0, bytesRead);
      const lines = headText.split(/\r?\n/);

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("{")) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          // Claude / Cursor / Codex / AGY user message shapes
          const role =
            obj.role ??
            obj.type ??
            (obj.message && typeof obj.message === "object"
              ? (obj.message as Record<string, unknown>).role
              : undefined);
          if (role === "user" || role === "human" || obj.type === "USER_INPUT") {
            if (typeof obj.content === "string" && obj.content.trim()) {
              return normalizeOneLineSummary(obj.content);
            }
            if (obj.message && typeof obj.message === "object") {
              const msg = obj.message as Record<string, unknown>;
              if (typeof msg.content === "string" && msg.content.trim()) {
                return normalizeOneLineSummary(msg.content);
              }
              if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                  if (
                    part &&
                    typeof part === "object" &&
                    typeof (part as Record<string, unknown>).text === "string"
                  ) {
                    const txt = String((part as Record<string, unknown>).text).trim();
                    if (txt) return normalizeOneLineSummary(txt);
                  }
                }
              }
            }
          }
        } catch {
          // Ignore partial or non-JSON line
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Ignore file read errors
  }
  return "";
}

/**
 * Extracts the workspace/project root directory from a hook stdin payload
 * across Antigravity (`workspacePaths[0]`, `workspaceUris[0]`), Cursor (`workspace_roots[0]`),
 * Claude Code / Codex / OpenCode (`cwd`), or explicit `projectRoot`.
 */
export function extractHookProjectRoot(
  payload: Record<string, unknown>,
  fallbackRoot?: string
): string | null {
  if (typeof payload.projectRoot === "string" && payload.projectRoot.trim()) {
    return normalizePathOrFileUri(payload.projectRoot);
  }
  if (typeof payload.project_root === "string" && payload.project_root.trim()) {
    return normalizePathOrFileUri(payload.project_root);
  }
  if (
    Array.isArray(payload.workspacePaths) &&
    typeof payload.workspacePaths[0] === "string" &&
    payload.workspacePaths[0].trim()
  ) {
    return normalizePathOrFileUri(payload.workspacePaths[0]);
  }
  if (
    Array.isArray(payload.workspaceUris) &&
    typeof payload.workspaceUris[0] === "string" &&
    payload.workspaceUris[0].trim()
  ) {
    return normalizePathOrFileUri(payload.workspaceUris[0]);
  }
  if (
    Array.isArray(payload.workspace_roots) &&
    typeof payload.workspace_roots[0] === "string" &&
    payload.workspace_roots[0].trim()
  ) {
    return normalizePathOrFileUri(payload.workspace_roots[0]);
  }
  if (typeof payload.cwd === "string" && payload.cwd.trim()) {
    return normalizePathOrFileUri(payload.cwd);
  }
  if (
    payload.workspace &&
    typeof payload.workspace === "object" &&
    typeof (payload.workspace as Record<string, unknown>).current_dir === "string"
  ) {
    const dir = String((payload.workspace as Record<string, unknown>).current_dir).trim();
    if (dir) return normalizePathOrFileUri(dir);
  }
  return fallbackRoot ? normalizePathOrFileUri(fallbackRoot) : null;
}

/**
 * Extracts session metadata and a 0-token 1-line summary from a hook payload.
 */
export function extractHookSessionInfo(
  payload: Record<string, unknown>,
  defaultHarness: HarnessId = "claude-code"
): {
  harnessSessionId: string | null;
  harness: HarnessId;
  model: string | null;
  transcriptPath: string | null;
  projectRoot: string | null;
  summary: string;
} {
  const harness = ((payload.harness as string) || defaultHarness) as HarnessId;

  const rawTranscript = payload.transcript_path ?? payload.transcriptPath;
  const transcriptPath =
    typeof rawTranscript === "string" && rawTranscript.trim().length > 0
      ? rawTranscript.trim()
      : null;

  const rawSid =
    payload.session_id ??
    payload.sessionId ??
    payload.sessionID ??
    payload.conversation_id ??
    payload.conversationId ??
    payload.thread_id ??
    payload.threadId ??
    payload.chat_id ??
    payload.chatId;
  let harnessSessionId =
    typeof rawSid === "string" && rawSid.trim().length > 0 ? rawSid.trim() : null;

  // Fallback 1: Extract conversationId from Antigravity's artifactDirectoryPath (`.../brain/<conversation-id>`)
  if (
    !harnessSessionId &&
    typeof payload.artifactDirectoryPath === "string" &&
    payload.artifactDirectoryPath.trim().length > 0
  ) {
    const base = path.basename(payload.artifactDirectoryPath.trim().replace(/[\\/]+$/, ""));
    if (base && base !== "artifacts" && base !== "brain") {
      harnessSessionId = base;
    }
  }

  // Fallback 2: Extract conversationId from transcriptPath (`.../brain/<conversation-id>/.system_generated/logs/transcript.jsonl`)
  if (!harnessSessionId && transcriptPath) {
    const brainMatch = transcriptPath.match(/brain[\\/]([0-9a-fA-F-]{8,})[\\/]/);
    if (brainMatch?.[1]) {
      harnessSessionId = brainMatch[1];
    }
  }

  const rawModel =
    payload.model ?? payload.model_id ?? payload.modelId ?? payload.modelName;
  const model =
    typeof rawModel === "string" && rawModel.trim().length > 0
      ? rawModel.trim()
      : null;

  const projectRoot = extractHookProjectRoot(payload);

  // Priority 1: Direct prompt fields in hook payload (including Antigravity's lastUserInput)
  const rawPrompt =
    payload.prompt ??
    payload.user_prompt ??
    payload.userPrompt ??
    payload.lastUserInput ??
    payload.last_user_message ??
    payload.query;
  let summary =
    typeof rawPrompt === "string" && rawPrompt.trim().length > 0
      ? normalizeOneLineSummary(rawPrompt)
      : "";

  // Priority 2: Extract from transcript file head (if provided)
  if (!summary && transcriptPath) {
    summary = extractSummaryFromTranscriptFile(transcriptPath);
  }

  // Priority 3: Tool name + target file path (including Antigravity's toolCall.{name,args})
  if (!summary) {
    const toolCallObj =
      payload.toolCall && typeof payload.toolCall === "object"
        ? (payload.toolCall as Record<string, unknown>)
        : undefined;
    const toolName = String(
      payload.tool_name ??
        payload.toolName ??
        payload.tool ??
        payload.name ??
        toolCallObj?.name ??
        ""
    ).trim();
    const toolInput =
      payload.tool_input && typeof payload.tool_input === "object"
        ? (payload.tool_input as Record<string, unknown>)
        : toolCallObj?.args && typeof toolCallObj.args === "object"
          ? (toolCallObj.args as Record<string, unknown>)
          : {};
    const fileTarget = String(
      payload.file_path ??
        payload.filePath ??
        payload.path ??
        toolInput.file_path ??
        toolInput.filePath ??
        toolInput.path ??
        toolInput.Path ??
        toolInput.PathToCurrentFile ??
        toolInput.fileName ??
        ""
    ).trim();
    if (toolName && fileTarget) {
      summary = normalizeOneLineSummary(`${toolName}: ${path.basename(fileTarget)}`);
    } else if (toolName) {
      summary = normalizeOneLineSummary(`Tool: ${toolName}`);
    }
  }

  return {
    harnessSessionId,
    harness,
    model,
    transcriptPath,
    projectRoot,
    summary,
  };
}

/**
 * Returns the path to `<projectRoot>/.asd/sessions/cli-recent.json`.
 */
export function getCliRecentSessionsPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".asd", "sessions", "cli-recent.json");
}

/**
 * Scans local Antigravity brain transcripts (`~/.gemini/antigravity-cli/brain/*`)
 * for main sessions matching `projectRoot` and syncs any missing entries into
 * `<projectRoot>/.asd/sessions/cli-recent.json`.
 */
export function syncLocalHarnessTranscripts(
  projectRoot: string,
  options?: { homeDir?: string; forceCreateDir?: boolean }
): CliRecentSessionEntry[] {
  const resolvedRoot = path.resolve(projectRoot);
  if (!fs.existsSync(resolvedRoot)) return [];

  const homeDir = options?.homeDir ? path.resolve(options.homeDir) : os.homedir();
  const brainDirs = [
    path.join(homeDir, ".gemini", "antigravity-cli", "brain"),
    path.join(homeDir, ".gemini", "antigravity", "brain"),
  ];

  const normSlash = resolvedRoot.replaceAll("\\", "/").toLowerCase();
  const normBackslash = resolvedRoot.replaceAll("/", "\\").toLowerCase();
  const normEscapedBackslash = normBackslash.replaceAll("\\", "\\\\");

  const discovered: Array<{
    harnessSessionId: string;
    harness: HarnessId;
    summary: string;
    transcriptPath: string;
    startedAt: number;
    updatedAt: number;
  }> = [];

  for (const brainDir of brainDirs) {
    if (!fs.existsSync(brainDir)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convId = entry.name;
      const transcriptPath = path.join(
        brainDir,
        convId,
        ".system_generated",
        "logs",
        "transcript.jsonl"
      );
      if (!fs.existsSync(transcriptPath)) continue;

      try {
        const stat = fs.statSync(transcriptPath);
        if (!stat.isFile() || stat.size === 0) continue;

        const fd = fs.openSync(transcriptPath, "r");
        let headText = "";
        try {
          const readLen = Math.min(stat.size, 32768);
          const buf = Buffer.alloc(readLen);
          const bytesRead = fs.readSync(fd, buf, 0, readLen, 0);
          headText = buf.toString("utf8", 0, bytesRead);
        } finally {
          fs.closeSync(fd);
        }

        // Skip subagent conversations (whose step 0 is a SYSTEM_MESSAGE from a parent agent)
        const firstNewline = headText.indexOf("\n");
        const firstLine = (firstNewline >= 0 ? headText.slice(0, firstNewline) : headText).trim();
        if (firstLine.includes('"type":"SYSTEM_MESSAGE"') && firstLine.includes("sender=")) {
          continue;
        }

        const lowerHead = headText.toLowerCase();
        if (
          !lowerHead.includes(normSlash) &&
          !lowerHead.includes(normBackslash) &&
          !lowerHead.includes(normEscapedBackslash)
        ) {
          continue;
        }

        const summary = extractSummaryFromTranscriptFile(transcriptPath);
        discovered.push({
          harnessSessionId: convId,
          harness: "antigravity",
          summary: summary || `Antigravity session (${convId.slice(0, 8)})`,
          transcriptPath,
          startedAt: Math.round(stat.birthtimeMs || stat.mtimeMs),
          updatedAt: Math.round(stat.mtimeMs),
        });
      } catch {
        // Ignore unreadable transcript
      }
    }
  }

  if (discovered.length === 0) return [];

  const asdDir = path.join(resolvedRoot, ".asd");
  if (!options?.forceCreateDir && !fs.existsSync(asdDir)) {
    return [];
  }

  const filePath = getCliRecentSessionsPath(resolvedRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  ensureGitExclude(resolvedRoot, ".asd/");

  const existingList = readCliRecentSessionsRaw(resolvedRoot);
  let changed = false;

  for (const item of discovered) {
    const idx = existingList.findIndex(
      (s) => s.harnessSessionId === item.harnessSessionId && s.harness === item.harness
    );
    if (idx >= 0) {
      const prev = existingList[idx]!;
      if (!prev.summary && item.summary) {
        prev.summary = item.summary;
        changed = true;
      }
      if (!prev.transcriptPath && item.transcriptPath) {
        prev.transcriptPath = item.transcriptPath;
        changed = true;
      }
      if (item.updatedAt > prev.updatedAt) {
        prev.updatedAt = item.updatedAt;
        changed = true;
      }
    } else {
      existingList.push({
        harnessSessionId: item.harnessSessionId,
        harness: item.harness,
        model: null,
        summary: item.summary,
        transcriptPath: item.transcriptPath,
        asdSessionId: null,
        projectRoot: resolvedRoot,
        startedAt: item.startedAt,
        updatedAt: item.updatedAt,
      });
      changed = true;
    }
  }

  if (changed) {
    existingList.sort((a, b) => b.updatedAt - a.updatedAt);
    const nextList = existingList.slice(0, MAX_RECENT_CLI_SESSIONS);
    atomicWriteFileSync(
      filePath,
      JSON.stringify({ sessions: nextList }, null, 2) + "\n"
    );
    return nextList;
  }

  return existingList;
}

function readCliRecentSessionsRaw(projectRoot: string): CliRecentSessionEntry[] {
  const filePath = getCliRecentSessionsPath(projectRoot);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      sessions?: CliRecentSessionEntry[];
    };
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.sessions)) {
      return parsed.sessions;
    }
  } catch {
    // Ignore malformed file
  }
  return [];
}

/**
 * Reads all recorded CLI/harness sessions from `<projectRoot>/.asd/sessions/cli-recent.json`.
 */
export function readCliRecentSessions(
  projectRoot: string,
  options?: { syncLocalTranscripts?: boolean; homeDir?: string; forceCreateDir?: boolean }
): CliRecentSessionEntry[] {
  if (options?.syncLocalTranscripts) {
    syncLocalHarnessTranscripts(projectRoot, {
      homeDir: options.homeDir,
      forceCreateDir: options.forceCreateDir,
    });
  }
  return readCliRecentSessionsRaw(projectRoot);
}

/**
 * Records or updates a CLI/harness session entry in `<projectRoot>/.asd/sessions/cli-recent.json`.
 * Only writes to `.asd/sessions/cli-recent.json` if `.asd` directory already exists in the project
 * OR when `forceCreateDir` is true, so non-ASD temporary test directories are never polluted by hooks.
 */
export function recordCliRecentSession(
  projectRoot: string,
  input: {
    harnessSessionId: string;
    harness: HarnessId;
    model?: string | null;
    summary?: string;
    transcriptPath?: string | null;
    asdSessionId?: string | null;
  },
  options?: { forceCreateDir?: boolean }
): CliRecentSessionEntry | null {
  const resolvedRoot = path.resolve(projectRoot);
  const asdDir = path.join(resolvedRoot, ".asd");
  if (!options?.forceCreateDir && !fs.existsSync(asdDir)) {
    return null;
  }

  const filePath = getCliRecentSessionsPath(resolvedRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  ensureGitExclude(resolvedRoot, ".asd/");

  const existingList = readCliRecentSessionsRaw(resolvedRoot);
  const now = Date.now();
  const idx = existingList.findIndex(
    (s) => s.harnessSessionId === input.harnessSessionId && s.harness === input.harness
  );

  let updatedEntry: CliRecentSessionEntry;
  if (idx >= 0) {
    const prev = existingList[idx]!;
    updatedEntry = {
      ...prev,
      model: input.model ?? prev.model ?? null,
      summary:
        input.summary && input.summary.trim() && (!prev.summary || prev.summary.startsWith("Tool:"))
          ? input.summary.trim()
          : prev.summary || input.summary || "",
      transcriptPath: input.transcriptPath ?? prev.transcriptPath ?? null,
      asdSessionId: input.asdSessionId ?? prev.asdSessionId ?? null,
      updatedAt: now,
    };
    existingList.splice(idx, 1);
  } else {
    updatedEntry = {
      harnessSessionId: input.harnessSessionId,
      harness: input.harness,
      model: input.model ?? null,
      summary: (input.summary || "").trim(),
      transcriptPath: input.transcriptPath ?? null,
      asdSessionId: input.asdSessionId ?? null,
      projectRoot: resolvedRoot,
      startedAt: now,
      updatedAt: now,
    };
  }

  const nextList = [updatedEntry, ...existingList].slice(0, MAX_RECENT_CLI_SESSIONS);
  atomicWriteFileSync(
    filePath,
    JSON.stringify({ sessions: nextList }, null, 2) + "\n"
  );
  return updatedEntry;
}

/**
 * Links a native `harnessSessionId` (either explicitly provided or auto-matched from
 * `cli-recent.json` / environment variables) to an ASD orchestration session (`<asd-id>`),
 * updating `core.db`, `<projectRoot>/.asd/sessions/<asd-id>/main.json`, and `cli-recent.json`.
 */
export function linkHarnessSessionToAsdSession(options: {
  projectRoot: string;
  homeDir?: string;
  asdSessionId: string;
  harness?: HarnessId;
  harnessSessionId?: string | null;
  mainModel?: string | null;
  model?: string | null;
  autoApprove?: boolean;
  db?: SqliteDriver;
}): { harnessSessionId: string | null; mainModel: string | null } {
  const projectRoot = path.resolve(options.projectRoot);
  const asdSessionId = options.asdSessionId.trim();
  let recentList = readCliRecentSessionsRaw(projectRoot);
  if (recentList.length === 0 && !options.harnessSessionId?.trim()) {
    recentList = syncLocalHarnessTranscripts(projectRoot, {
      homeDir: options.homeDir,
    });
  }

  // Determine effective harnessSessionId: explicit -> env -> recent entry for same harness
  let effectiveHarnessSessionId =
    options.harnessSessionId?.trim() ||
    process.env.ASD_HARNESS_SESSION_ID?.trim() ||
    process.env.CLAUDE_SESSION_ID?.trim() ||
    null;

  let matchedRecent = effectiveHarnessSessionId
    ? recentList.find((r) => r.harnessSessionId === effectiveHarnessSessionId)
    : undefined;

  if (!effectiveHarnessSessionId && recentList.length > 0) {
    matchedRecent = options.harness
      ? recentList.find((r) => r.harness === options.harness)
      : recentList[0];
    if (matchedRecent) {
      effectiveHarnessSessionId = matchedRecent.harnessSessionId;
    }
  }

  const effectiveModel =
    options.mainModel?.trim() ||
    options.model?.trim() ||
    matchedRecent?.model ||
    null;

  // 1. Update SQLite core.db
  let db = options.db;
  let ownsDb = false;
  try {
    if (!db) {
      const paths = resolveAsdPaths(projectRoot, options.homeDir);
      if (fs.existsSync(paths.dbPath)) {
        db = openProjectDb(projectRoot, options.homeDir);
        ownsDb = true;
      }
    }
    if (db) {
      db.updateSessionHarnessInfo(asdSessionId, {
        ...(effectiveHarnessSessionId !== null
          ? { harnessSessionId: effectiveHarnessSessionId }
          : {}),
        ...(effectiveModel !== null ? { mainModel: effectiveModel } : {}),
        ...(options.harness ? { mainHarness: options.harness } : {}),
        ...(options.autoApprove !== undefined
          ? { autoApprove: options.autoApprove }
          : {}),
      });
    }
  } catch {
    // Ignore DB errors
  } finally {
    if (ownsDb && db) {
      try {
        db.close();
      } catch {}
    }
  }

  // 2. Update `<projectRoot>/.asd/sessions/<asdSessionId>/main.json` if directory exists
  try {
    const mainJsonPath = path.join(
      projectRoot,
      ".asd",
      "sessions",
      asdSessionId,
      "main.json"
    );
    if (fs.existsSync(mainJsonPath)) {
      const current = JSON.parse(fs.readFileSync(mainJsonPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (effectiveHarnessSessionId) {
        current.harnessSessionId = effectiveHarnessSessionId;
      }
      if (effectiveModel) {
        current.model = effectiveModel;
      }
      if (options.autoApprove !== undefined) {
        current.autoApprove = options.autoApprove;
      }
      atomicWriteFileSync(mainJsonPath, JSON.stringify(current, null, 2) + "\n");
    }
  } catch {
    // Ignore main.json update errors
  }

  // 3. Link `asdSessionId` back into `cli-recent.json`
  if (effectiveHarnessSessionId) {
    try {
      recordCliRecentSession(
        projectRoot,
        {
          harnessSessionId: effectiveHarnessSessionId,
          harness: options.harness || matchedRecent?.harness || "claude-code",
          model: effectiveModel,
          summary: matchedRecent?.summary || "",
          transcriptPath: matchedRecent?.transcriptPath ?? null,
          asdSessionId,
        },
        { forceCreateDir: true }
      );
    } catch {
      // Ignore cli-recent update errors
    }
  }

  return {
    harnessSessionId: effectiveHarnessSessionId,
    mainModel: effectiveModel,
  };
}

/**
 * Scans `<homeDir>/.asd/state/<projectHash>/core.db` to discover all projects
 * that have used ASD, without requiring a separate GUI database.
 */
export function listKnownProjects(options?: {
  homeDir?: string;
  extraProjectRoots?: string[];
}): KnownProjectSummary[] {
  const home = options?.homeDir ?? os.homedir();
  const stateRoot = path.join(home, ".asd", "state");
  const byHash = new Map<string, KnownProjectSummary>();

  if (fs.existsSync(stateRoot)) {
    try {
      const entries = fs.readdirSync(stateRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dbPath = path.join(stateRoot, entry.name, "core.db");
        if (!fs.existsSync(dbPath)) continue;

        let db: SqliteDriver | undefined;
        try {
          db = new SqliteDriver(dbPath);
          const sessions = db.listSessions();
          if (sessions.length === 0) continue;
          const latest = sessions[0]!;
          const projectRoot = latest.project_root;
          byHash.set(entry.name, {
            projectHash: entry.name,
            projectRoot,
            dbPath,
            existsOnDisk: fs.existsSync(projectRoot),
            sessionCount: sessions.length,
            latestSessionId: latest.session_id,
            latestHarness: latest.main_harness,
            latestMemo: latest.memo ?? null,
            updatedAt: latest.updated_at || latest.created_at,
          });
        } catch {
          // Ignore unreadable DB
        } finally {
          try {
            db?.close();
          } catch {}
        }
      }
    } catch {
      // Ignore state dir scan error
    }
  }

  for (const extraRoot of options?.extraProjectRoots ?? []) {
    if (!extraRoot || !extraRoot.trim()) continue;
    const paths = resolveAsdPaths(extraRoot, home);
    if (!byHash.has(paths.projectHash)) {
      byHash.set(paths.projectHash, {
        projectHash: paths.projectHash,
        projectRoot: path.resolve(extraRoot),
        dbPath: paths.dbPath,
        existsOnDisk: fs.existsSync(extraRoot),
        sessionCount: 0,
        latestSessionId: null,
        latestHarness: null,
        latestMemo: null,
        updatedAt: 0,
      });
    }
  }

  return [...byHash.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
