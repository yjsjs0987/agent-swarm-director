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
 *    - Queries the shared `~/.asd/state/core.db` to discover all projects and their latest sessions.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  computeProjectHash,
  ensureGitExclude,
  normalizePathForCompare,
  resolveAsdPaths,
  resolveHomeDir,
} from "./config.ts";
import {
  generateAsdSessionId,
  isValidAsdSessionId,
  openProjectDb,
  SqliteDriver,
  type SessionRow,
} from "./db.ts";
import { attachDriver, detachDriver, type DriverRow, type DriverSource } from "./drivers.ts";
import { atomicWriteFileSync, setForegroundSession } from "./render.ts";
import type {
  CliRecentSessionEntry,
  HarnessId,
  KnownProjectSummary,
} from "./types.ts";

export {
  generateAsdSessionId,
  isValidAsdSessionId,
} from "./db.ts";

const MAX_RECENT_CLI_SESSIONS = 100;

export interface HeadlessHarnessCommandOptions {
  harness: HarnessId;
  prompt: string;
  model?: string | null;
  thinkingEffort?: string | null;
  reasoningEffort?: string | null;
}

/**
 * Builds headless one-shot execution commands for each harness without importing `src/adapters/*`.
 */
export function buildHeadlessHarnessCommand(
  options: HeadlessHarnessCommandOptions
): { command: string; args: string[] } {
  const textPrompt = options.prompt ?? "";
  const resolvedModel = options.model ?? null;
  const resolvedEffort = options.thinkingEffort ?? options.reasoningEffort ?? null;

  switch (options.harness) {
    case "claude-code": {
      const args = ["-p", textPrompt, "--output-format", "json"];
      if (resolvedModel) args.push("--model", resolvedModel);
      return { command: "claude", args };
    }
    case "opencode": {
      const args = ["run", textPrompt, "--format", "json"];
      if (resolvedModel) args.push("--model", resolvedModel);
      return { command: "opencode", args };
    }
    case "codex": {
      const args = ["exec", textPrompt, "--json"];
      if (resolvedModel) args.push("-m", resolvedModel);
      if (resolvedEffort) {
        args.push("-c", `model_reasoning_effort=${resolvedEffort}`);
      }
      return { command: "codex", args };
    }
    case "antigravity": {
      const args = ["-p", textPrompt, "--output-format", "json"];
      if (resolvedModel) args.push("--model", resolvedModel);
      if (resolvedEffort) args.push("--effort", resolvedEffort);
      return { command: "agy", args };
    }
    case "cursor": {
      const args = ["-p", textPrompt, "--force", "--output-format", "json"];
      if (resolvedModel) args.push("--model", resolvedModel);
      return { command: "agent", args };
    }
  }
}

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

export interface SessionDemotionOptions {
  projectRoot: string;
  homeDir?: string;
  sessionId?: string;
  db?: SqliteDriver;
}

export interface SessionDemotionResult {
  sessionId: string;
  driverId: string;
  harness: HarnessId;
  harnessSessionId: string;
  model: string | null;
  command: string;
  args: string[];
  cliString: string;
}

function createDemotionError(code: string, message: string): Error & { code: string } {
  const err = new Error(`${code}: ${message}`) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * Resolves the active driver of an ASD session (or latest project session)
 * and builds the interactive CLI command to demote/resume that session directly in a terminal.
 */
export function buildSessionDemotion(
  options: SessionDemotionOptions
): SessionDemotionResult {
  const projectRoot = path.resolve(options.projectRoot);
  let db = options.db;
  let ownsDb = false;

  try {
    if (!db) {
      db = openProjectDb(projectRoot, options.homeDir);
      ownsDb = true;
    }

    const requestedSessionId = options.sessionId?.trim();
    const session = requestedSessionId
      ? db.getSession(requestedSessionId)
      : db.getLatestSession();

    if (!session) {
      throw createDemotionError(
        "NO_SESSION",
        requestedSessionId
          ? `Session '${requestedSessionId}' not found in project '${projectRoot}'`
          : `No ASD session found for project '${projectRoot}'`
      );
    }

    const activeDriver = db.getActiveDriver(session.session_id);
    const fallbackHarnessSid = (session.harness_session_id ?? "").trim();
    if (!activeDriver && !fallbackHarnessSid) {
      throw createDemotionError(
        "NO_ACTIVE_DRIVER",
        `Session '${session.session_id}' has no active driver`
      );
    }

    const harness = (activeDriver?.harness ||
      session.main_harness ||
      "claude-code") as HarnessId;
    const harnessSessionId = (
      activeDriver?.harness_session_id ??
      (!activeDriver || activeDriver.harness === session.main_harness
        ? session.harness_session_id
        : null) ??
      ""
    ).trim();

    if (!harnessSessionId) {
      throw createDemotionError(
        "NO_HARNESS_SESSION",
        `Active driver '${activeDriver?.driver_id ?? "session-fallback"}' (${harness}) for session '${session.session_id}' has no bound harness_session_id`
      );
    }

    const model =
      activeDriver?.model ??
      (!activeDriver || activeDriver.harness === session.main_harness
        ? (session.main_model ?? null)
        : null);

    const built = buildInteractiveResumeHarnessCommand({
      harness,
      harnessSessionId,
      model,
    });

    return {
      sessionId: session.session_id,
      driverId: activeDriver?.driver_id ?? "",
      harness,
      harnessSessionId,
      model: model ?? null,
      command: built.command,
      args: built.args,
      cliString: built.cliString,
    };
  } finally {
    if (ownsDb && db) {
      try {
        db.close();
      } catch {
        // Ignore close error
      }
    }
  }
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
  const userReqMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(raw);
  const baseText = userReqMatch ? userReqMatch[1]! : raw;
  const cleaned = baseText
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, " ")
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

function isCodexSystemBoilerplate(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith("<environment_context>") ||
    t.startsWith("<permissions instructions>") ||
    t.startsWith("# AGENTS.md instructions") ||
    t.startsWith("<INSTRUCTIONS>")
  );
}

/**
 * Reads up to 32KB from the beginning of a local transcript JSONL file to extract
 * the first user prompt with zero LLM overhead (<1ms).
 */
export function extractSummaryFromTranscriptFile(transcriptPath: string): string {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return "";
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size === 0) return "";

    const fd = fs.openSync(transcriptPath, "r");
    try {
      const bufSize = Math.min(stat.size, 32768);
      const buf = Buffer.alloc(bufSize);
      const bytesRead = fs.readSync(fd, buf, 0, bufSize, 0);
      const headText = buf.toString("utf8", 0, bytesRead);
      const lines = headText.split(/\r?\n/);

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("{")) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          // Codex event_msg user_message or response_item user message
          if (obj.type === "event_msg" && obj.payload && typeof obj.payload === "object") {
            const p = obj.payload as Record<string, unknown>;
            if (p.type === "user_message" && typeof p.message === "string" && p.message.trim()) {
              return normalizeOneLineSummary(p.message);
            }
          }
          if (obj.type === "response_item" && obj.payload && typeof obj.payload === "object") {
            const p = obj.payload as Record<string, unknown>;
            if (p.role === "user" && Array.isArray(p.content)) {
              for (const part of p.content) {
                if (part && typeof part === "object") {
                  const txt = String((part as Record<string, unknown>).text ?? "").trim();
                  if (txt && !isCodexSystemBoilerplate(txt)) {
                    return normalizeOneLineSummary(txt);
                  }
                }
              }
            }
          }

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

  const rawTranscript =
    payload.transcript_path ??
    payload["transcript-path"] ??
    payload.transcriptPath;
  const transcriptPath =
    typeof rawTranscript === "string" && rawTranscript.trim().length > 0
      ? rawTranscript.trim()
      : null;

  const nestedSession =
    payload.session && typeof payload.session === "object"
      ? (payload.session as Record<string, unknown>)
      : undefined;
  const nestedConv =
    payload.conversation && typeof payload.conversation === "object"
      ? (payload.conversation as Record<string, unknown>)
      : undefined;

  const rawSid =
    payload.session_id ??
    payload["session-id"] ??
    payload.sessionId ??
    payload.sessionID ??
    payload.conversation_id ??
    payload["conversation-id"] ??
    payload.conversationId ??
    payload.thread_id ??
    payload["thread-id"] ??
    payload.threadId ??
    payload.chat_id ??
    payload["chat-id"] ??
    payload.chatId ??
    payload.composer_id ??
    payload["composer-id"] ??
    payload.composerId ??
    nestedSession?.id ??
    nestedSession?.session_id ??
    nestedConv?.id ??
    nestedConv?.conversation_id;
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

  // Fallback 3: Cursor transcript path or workspace/composer metadata fallback
  if (!harnessSessionId && harness === "cursor" && transcriptPath) {
    const baseName = path.basename(transcriptPath, path.extname(transcriptPath)).trim();
    if (baseName && baseName !== "transcript" && baseName !== "chat") {
      harnessSessionId = baseName;
    }
  }

  const rawModel =
    payload.model ??
    payload.model_id ??
    payload["model-id"] ??
    payload.modelId ??
    payload.modelName;
  const model =
    typeof rawModel === "string" && rawModel.trim().length > 0
      ? rawModel.trim()
      : null;

  const projectRoot = extractHookProjectRoot(payload);

  // Priority 1: Direct prompt fields in hook payload (including Antigravity's lastUserInput and Codex input-messages)
  const inputMsgs =
    payload["input-messages"] ??
    payload.input_messages ??
    payload.inputMessages;
  let firstInputMsg: string | undefined;
  if (Array.isArray(inputMsgs) && inputMsgs.length > 0) {
    for (const item of inputMsgs) {
      if (typeof item === "string" && item.trim()) {
        firstInputMsg = item;
        break;
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const txt = obj.text ?? obj.content ?? obj.message;
        if (typeof txt === "string" && txt.trim()) {
          firstInputMsg = txt;
          break;
        }
      }
    }
  }

  const rawPrompt =
    payload.prompt ??
    payload.user_prompt ??
    payload["user-prompt"] ??
    payload.userPrompt ??
    payload.lastUserInput ??
    payload.last_user_message ??
    payload["last-user-message"] ??
    firstInputMsg ??
    payload["last-assistant-message"] ??
    payload.last_assistant_message ??
    payload.query;
  let summary =
    typeof rawPrompt === "string" && rawPrompt.trim().length > 0
      ? normalizeOneLineSummary(rawPrompt)
      : "";

  // Priority 2: Extract from transcript file head (if provided)
  if (!summary && transcriptPath) {
    summary = extractSummaryFromTranscriptFile(transcriptPath);
  }

  // Priority 3: Tool name + target file path (including Antigravity's toolCall.{name,args} & Cursor beforeShellExecution command)
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
    } else if (typeof payload.command === "string" && payload.command.trim()) {
      summary = normalizeOneLineSummary(`Shell: ${payload.command.trim()}`);
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

interface DiscoveredLocalTranscript {
  harnessSessionId: string;
  harness: HarnessId;
  model: string | null;
  summary: string;
  transcriptPath: string;
  startedAt: number;
  updatedAt: number;
}

function readFileHeadUtf8(filePath: string, maxBytes = 32768): { headText: string; stat: fs.Stats } | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    const fd = fs.openSync(filePath, "r");
    try {
      const readLen = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(readLen);
      const bytesRead = fs.readSync(fd, buf, 0, readLen, 0);
      return { headText: buf.toString("utf8", 0, bytesRead), stat };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

interface CachedTranscriptDiscoveryEntry {
  mtimeMs: number;
  isSubagent?: boolean;
  normCwd?: string;
  lowerHead?: string;
  harnessSessionId?: string;
  model: string | null;
  summary: string;
  startedAt: number;
  updatedAt: number;
}

const transcriptDiscoveryCache = new Map<string, CachedTranscriptDiscoveryEntry>();

function scanAntigravityLocalSessions(
  resolvedRoot: string,
  homeDir: string,
  discovered: DiscoveredLocalTranscript[]
): void {
  const brainDirs = [
    path.join(homeDir, ".gemini", "antigravity-cli", "brain"),
    path.join(homeDir, ".gemini", "antigravity", "brain"),
  ];
  const normSlash = resolvedRoot.replaceAll("\\", "/").toLowerCase();
  const normBackslash = resolvedRoot.replaceAll("/", "\\").toLowerCase();
  const normEscapedBackslash = normBackslash.replaceAll("\\", "\\\\");

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
      let stat: fs.Stats;
      try {
        stat = fs.statSync(transcriptPath);
        if (stat.size <= 0) continue;
      } catch {
        continue;
      }

      let cached = transcriptDiscoveryCache.get(transcriptPath);
      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        const headInfo = readFileHeadUtf8(transcriptPath, 32768);
        if (!headInfo) continue;
        const { headText } = headInfo;
        const firstNewline = headText.indexOf("\n");
        const firstLine = (firstNewline >= 0 ? headText.slice(0, firstNewline) : headText).trim();
        const isSubagent =
          firstLine.includes('"type":"SYSTEM_MESSAGE"') && firstLine.includes("sender=");
        const summary = isSubagent
          ? ""
          : extractSummaryFromTranscriptFile(transcriptPath) ||
            `Antigravity session (${convId.slice(0, 8)})`;
        cached = {
          mtimeMs: stat.mtimeMs,
          isSubagent,
          lowerHead: isSubagent ? "" : headText.toLowerCase(),
          harnessSessionId: convId,
          model: null,
          summary,
          startedAt: Math.round(stat.birthtimeMs || stat.mtimeMs),
          updatedAt: Math.round(stat.mtimeMs),
        };
        transcriptDiscoveryCache.set(transcriptPath, cached);
      }

      if (cached.isSubagent) continue;
      const lowerHead = cached.lowerHead ?? "";
      if (
        !lowerHead.includes(normSlash) &&
        !lowerHead.includes(normBackslash) &&
        !lowerHead.includes(normEscapedBackslash)
      ) {
        continue;
      }

      discovered.push({
        harnessSessionId: convId,
        harness: "antigravity",
        model: cached.model,
        summary: cached.summary,
        transcriptPath,
        startedAt: cached.startedAt,
        updatedAt: cached.updatedAt,
      });
    }
  }
}

function encodeClaudeProjectDirCandidates(resolvedRoot: string): Set<string> {
  const candidates = new Set<string>();
  const slashNorm = resolvedRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const backNorm = resolvedRoot.replaceAll("/", "\\").replace(/\\+$/, "");
  for (const variant of [resolvedRoot, slashNorm, backNorm]) {
    candidates.add(variant.replace(/[:\\/]/g, "-").toLowerCase());
    candidates.add(variant.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase());
  }
  return candidates;
}

function scanClaudeCodeLocalSessions(
  resolvedRoot: string,
  homeDir: string,
  discovered: DiscoveredLocalTranscript[],
  maxFilesPerDir = 30
): void {
  const projectsDir = path.join(homeDir, ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return;

  const targetNorm = normalizePathForCompare(resolvedRoot);
  const encodedCandidates = encodeClaudeProjectDirCandidates(resolvedRoot);

  let dirEntries: fs.Dirent[] = [];
  try {
    dirEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const d of dirEntries) {
    if (!d.isDirectory()) continue;
    const projFolder = path.join(projectsDir, d.name);
    const dirNameMatch = encodedCandidates.has(d.name.toLowerCase());

    let files: Array<{ name: string; fullPath: string; mtimeMs: number; birthtimeMs: number }> = [];
    try {
      for (const f of fs.readdirSync(projFolder, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
        const fullPath = path.join(projFolder, f.name);
        try {
          const st = fs.statSync(fullPath);
          if (st.size > 0) {
            files.push({
              name: f.name,
              fullPath,
              mtimeMs: st.mtimeMs,
              birthtimeMs: st.birthtimeMs || st.mtimeMs,
            });
          }
        } catch {
          // ignore
        }
      }
    } catch {
      continue;
    }

    if (files.length === 0) continue;
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    files = files.slice(0, maxFilesPerDir);

    for (const fileInfo of files) {
      const sessionId = path.basename(fileInfo.name, ".jsonl");
      let cached = transcriptDiscoveryCache.get(fileInfo.fullPath);
      if (!cached || cached.mtimeMs !== fileInfo.mtimeMs) {
        const head = readFileHeadUtf8(fileInfo.fullPath, 16384);
        if (!head) continue;

        let detectedCwd = "";
        let detectedModel: string | null = null;
        const lines = head.headText.split(/\r?\n/);
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("{")) continue;
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            if (!detectedCwd && typeof obj.cwd === "string" && obj.cwd.trim()) {
              detectedCwd = normalizePathForCompare(obj.cwd);
            }
            if (!detectedModel && obj.message && typeof obj.message === "object") {
              const msgModel = (obj.message as Record<string, unknown>).model;
              if (typeof msgModel === "string" && msgModel.trim()) {
                detectedModel = msgModel.trim();
              }
            }
          } catch {
            // ignore
          }
        }

        const summary =
          extractSummaryFromTranscriptFile(fileInfo.fullPath) ||
          `Claude session (${sessionId.slice(0, 8)})`;
        cached = {
          mtimeMs: fileInfo.mtimeMs,
          normCwd: detectedCwd,
          harnessSessionId: sessionId,
          model: detectedModel,
          summary,
          startedAt: Math.round(fileInfo.birthtimeMs),
          updatedAt: Math.round(fileInfo.mtimeMs),
        };
        transcriptDiscoveryCache.set(fileInfo.fullPath, cached);
      }

      const matchesProject = cached.normCwd
        ? cached.normCwd === targetNorm
        : dirNameMatch;
      if (!matchesProject) continue;

      discovered.push({
        harnessSessionId: sessionId,
        harness: "claude-code",
        model: cached.model,
        summary: cached.summary,
        transcriptPath: fileInfo.fullPath,
        startedAt: cached.startedAt,
        updatedAt: cached.updatedAt,
      });
    }
  }
}

function scanCodexLocalSessions(
  resolvedRoot: string,
  homeDir: string,
  discovered: DiscoveredLocalTranscript[],
  maxFiles = 40
): void {
  const sessionsRoot = path.join(homeDir, ".codex", "sessions");
  if (!fs.existsSync(sessionsRoot)) return;

  const targetNorm = normalizePathForCompare(resolvedRoot);
  const rolloutFiles: Array<{ fullPath: string; mtimeMs: number; birthtimeMs: number }> = [];

  function walkCodexDir(dir: string, depth: number): void {
    if (depth > 4) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkCodexDir(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          const st = fs.statSync(fullPath);
          if (st.size > 0) {
            rolloutFiles.push({
              fullPath,
              mtimeMs: st.mtimeMs,
              birthtimeMs: st.birthtimeMs || st.mtimeMs,
            });
          }
        } catch {
          // ignore
        }
      }
    }
  }

  walkCodexDir(sessionsRoot, 0);
  if (rolloutFiles.length === 0) return;

  rolloutFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const candidates = rolloutFiles.slice(0, maxFiles);

  for (const fileInfo of candidates) {
    let cached = transcriptDiscoveryCache.get(fileInfo.fullPath);
    if (!cached || cached.mtimeMs !== fileInfo.mtimeMs) {
      const head = readFileHeadUtf8(fileInfo.fullPath, 32768);
      if (!head) continue;

      let threadId = "";
      let sessionCwd = "";
      let detectedModel: string | null = null;
      const lines = head.headText.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("{")) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          const payload =
            obj.payload && typeof obj.payload === "object"
              ? (obj.payload as Record<string, unknown>)
              : undefined;
          if (obj.type === "session_meta" && payload) {
            if (typeof payload.id === "string" && payload.id.trim()) {
              threadId = payload.id.trim();
            }
            if (typeof payload.cwd === "string" && payload.cwd.trim()) {
              sessionCwd = payload.cwd.trim();
            }
            if (typeof payload.model === "string" && payload.model.trim()) {
              detectedModel = payload.model.trim();
            }
          } else if (obj.type === "turn_context" && payload) {
            if (!sessionCwd && typeof payload.cwd === "string" && payload.cwd.trim()) {
              sessionCwd = payload.cwd.trim();
            }
            if (!detectedModel && typeof payload.model === "string" && payload.model.trim()) {
              detectedModel = payload.model.trim();
            }
          }
          if (threadId && sessionCwd) break;
        } catch {
          // ignore
        }
      }

      if (!threadId) {
        const base = path.basename(fileInfo.fullPath, ".jsonl");
        const m = base.match(/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/);
        threadId = m?.[1] || base;
      }

      const normCwd = sessionCwd ? normalizePathForCompare(sessionCwd) : "";
      const summary = normCwd
        ? extractSummaryFromTranscriptFile(fileInfo.fullPath) ||
          `Codex session (${threadId.slice(0, 8)})`
        : "";

      cached = {
        mtimeMs: fileInfo.mtimeMs,
        normCwd,
        harnessSessionId: threadId,
        model: detectedModel,
        summary,
        startedAt: Math.round(fileInfo.birthtimeMs),
        updatedAt: Math.round(fileInfo.mtimeMs),
      };
      transcriptDiscoveryCache.set(fileInfo.fullPath, cached);
    }

    if (!cached.normCwd || cached.normCwd !== targetNorm) {
      continue;
    }

    discovered.push({
      harnessSessionId: cached.harnessSessionId || path.basename(fileInfo.fullPath, ".jsonl"),
      harness: "codex",
      model: cached.model,
      summary: cached.summary,
      transcriptPath: fileInfo.fullPath,
      startedAt: cached.startedAt,
      updatedAt: cached.updatedAt,
    });
  }
}

function scanOpenCodeLocalSessions(
  resolvedRoot: string,
  homeDir: string,
  discovered: DiscoveredLocalTranscript[],
  maxRows = 50
): void {
  const dbCandidates = [
    path.join(homeDir, ".local", "share", "opencode", "opencode.db"),
    path.join(homeDir, ".opencode", "opencode.db"),
  ];
  if (process.env.LOCALAPPDATA) {
    dbCandidates.push(path.join(process.env.LOCALAPPDATA, "opencode", "opencode.db"));
  }

  const targetNorm = normalizePathForCompare(resolvedRoot);

  for (const dbPath of dbCandidates) {
    if (!fs.existsSync(dbPath)) continue;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((t) => t.name));
      if (!tableNames.has("session")) continue;

      const sessionColsInfo = db.prepare("PRAGMA table_info(session)").all() as Array<{ name: string }>;
      const sessionCols = new Set(sessionColsInfo.map((c) => c.name));
      if (!sessionCols.has("id")) continue;

      const hasProjectTable = tableNames.has("project") && sessionCols.has("project_id");
      let projectWorktreeCol: string | null = null;
      if (hasProjectTable) {
        const projCols = new Set(
          (db.prepare("PRAGMA table_info(project)").all() as Array<{ name: string }>).map((c) => c.name)
        );
        for (const cand of ["worktree", "directory", "path", "project_root"]) {
          if (projCols.has(cand)) {
            projectWorktreeCol = cand;
            break;
          }
        }
      }

      const dirCol = ["directory", "cwd", "project_root", "worktree"].find((c) => sessionCols.has(c)) ?? null;
      const titleCol = ["title", "summary", "name"].find((c) => sessionCols.has(c)) ?? null;
      const createdCol = ["time_created", "created_at", "started_at"].find((c) => sessionCols.has(c)) ?? null;
      const updatedCol = ["time_updated", "updated_at"].find((c) => sessionCols.has(c)) ?? null;
      const parentIdCol = sessionCols.has("parent_id") ? "parent_id" : sessionCols.has("parentID") ? "parentID" : null;

      let sql = `SELECT s.id AS id`;
      sql += titleCol ? `, s.${titleCol} AS title` : `, NULL AS title`;
      sql += dirCol ? `, s.${dirCol} AS dir` : `, NULL AS dir`;
      sql += createdCol ? `, s.${createdCol} AS created_at` : `, NULL AS created_at`;
      sql += updatedCol ? `, s.${updatedCol} AS updated_at` : `, NULL AS updated_at`;
      sql += parentIdCol ? `, s.${parentIdCol} AS parent_id` : `, NULL AS parent_id`;
      if (hasProjectTable && projectWorktreeCol) {
        sql += `, p.${projectWorktreeCol} AS proj_dir FROM session s LEFT JOIN project p ON s.project_id = p.id`;
      } else {
        sql += `, NULL AS proj_dir FROM session s`;
      }
      if (updatedCol) {
        sql += ` ORDER BY s.${updatedCol} DESC`;
      }
      sql += ` LIMIT ${maxRows}`;

      const rows = db.prepare(sql).all() as Array<{
        id: string;
        title?: string | null;
        dir?: string | null;
        proj_dir?: string | null;
        created_at?: number | string | null;
        updated_at?: number | string | null;
        parent_id?: string | null;
      }>;

      const fileMtime = Math.round(fs.statSync(dbPath).mtimeMs);
      for (const row of rows) {
        if (!row.id || row.parent_id) continue; // skip subagent sessions
        const rawDir = (row.dir || row.proj_dir || "").trim();
        if (!rawDir || normalizePathForCompare(rawDir) !== targetNorm) continue;

        const parseTs = (v: number | string | null | undefined, fallback: number): number => {
          if (typeof v === "number" && Number.isFinite(v)) {
            return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
          }
          if (typeof v === "string" && v.trim()) {
            const n = Number(v);
            if (Number.isFinite(n)) return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
            const parsed = Date.parse(v);
            if (!Number.isNaN(parsed)) return parsed;
          }
          return fallback;
        };

        const updatedAt = parseTs(row.updated_at, fileMtime);
        const startedAt = parseTs(row.created_at, updatedAt);
        const summary = row.title ? normalizeOneLineSummary(String(row.title)) : `OpenCode session (${row.id.slice(0, 8)})`;

        discovered.push({
          harnessSessionId: String(row.id),
          harness: "opencode",
          model: null,
          summary,
          transcriptPath: dbPath,
          startedAt,
          updatedAt,
        });
      }
    } catch {
      // Ignore locked or incompatible SQLite DB
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }
}

/**
 * Scans local harness transcripts across Antigravity (`~/.gemini/antigravity-cli/brain/*`),
 * Claude Code (`~/.claude/projects/<dir>/*.jsonl`), Codex (`~/.codex/sessions/** /rollout-*.jsonl`),
 * and OpenCode (`~/.local/share/opencode/opencode.db`) for main sessions matching `projectRoot`
 * and syncs any missing entries into `<projectRoot>/.asd/sessions/cli-recent.json`.
 */
export function syncLocalHarnessTranscripts(
  projectRoot: string,
  options?: { homeDir?: string; forceCreateDir?: boolean; harnesses?: HarnessId[] }
): CliRecentSessionEntry[] {
  const resolvedRoot = path.resolve(projectRoot);
  if (!fs.existsSync(resolvedRoot)) return [];

  const homeDir = options?.homeDir ? path.resolve(options.homeDir) : os.homedir();
  const harnessFilter = options?.harnesses ? new Set(options.harnesses) : null;
  const discovered: DiscoveredLocalTranscript[] = [];

  if (!harnessFilter || harnessFilter.has("antigravity")) {
    scanAntigravityLocalSessions(resolvedRoot, homeDir, discovered);
  }
  if (!harnessFilter || harnessFilter.has("claude-code")) {
    scanClaudeCodeLocalSessions(resolvedRoot, homeDir, discovered);
  }
  if (!harnessFilter || harnessFilter.has("codex")) {
    scanCodexLocalSessions(resolvedRoot, homeDir, discovered);
  }
  if (!harnessFilter || harnessFilter.has("opencode")) {
    scanOpenCodeLocalSessions(resolvedRoot, homeDir, discovered);
  }

  if (discovered.length === 0) return readCliRecentSessionsRaw(resolvedRoot);

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
      if (!prev.model && item.model) {
        prev.model = item.model;
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
        model: item.model ?? null,
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
    const incomingSummary = (input.summary || "").trim();
    const isGenericIncoming =
      incomingSummary.startsWith("Tool:") || incomingSummary.startsWith("Shell:");
    const hasMeaningfulPrev = Boolean(
      prev.summary &&
        !prev.summary.startsWith("Tool:") &&
        !prev.summary.startsWith("Shell:")
    );
    const resolvedSummary =
      incomingSummary && (!hasMeaningfulPrev || !isGenericIncoming)
        ? incomingSummary
        : prev.summary || incomingSummary || "";
    updatedEntry = {
      ...prev,
      model: (input.model && input.model.trim()) || prev.model || null,
      summary: resolvedSummary,
      transcriptPath:
        (input.transcriptPath && input.transcriptPath.trim()) ||
        prev.transcriptPath ||
        null,
      asdSessionId:
        (input.asdSessionId && input.asdSessionId.trim()) ||
        prev.asdSessionId ||
        null,
      updatedAt: now,
    };
    existingList.splice(idx, 1);
  } else {
    updatedEntry = {
      harnessSessionId: input.harnessSessionId,
      harness: input.harness,
      model: (input.model && input.model.trim()) || null,
      summary: (input.summary || "").trim(),
      transcriptPath: (input.transcriptPath && input.transcriptPath.trim()) || null,
      asdSessionId: (input.asdSessionId && input.asdSessionId.trim()) || null,
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
  source?: DriverSource;
  now?: number;
  db?: SqliteDriver;
}): { harnessSessionId: string | null; mainModel: string | null } {
  const projectRoot = path.resolve(options.projectRoot);
  const asdSessionId = options.asdSessionId.trim();
  const now = options.now ?? Date.now();
  const tenMinutesMs = 10 * 60 * 1000;

  let recentList = readCliRecentSessionsRaw(projectRoot);
  const hasFreshCandidate = recentList.some(
    (r) =>
      (!options.harness || r.harness === options.harness) &&
      typeof r.updatedAt === "number" &&
      now - r.updatedAt <= tenMinutesMs
  );
  if (!hasFreshCandidate && !options.harnessSessionId?.trim()) {
    recentList = syncLocalHarnessTranscripts(projectRoot, {
      homeDir: options.homeDir,
      harnesses: options.harness ? [options.harness] : undefined,
    });
  }

  const isSubagentEnv = process.env.ASD_SESSION_ROLE === "subagent";

  // Determine effective harnessSessionId: explicit -> env (if not subagent) -> recent entry within 10 minutes
  let effectiveHarnessSessionId =
    options.harnessSessionId !== undefined
      ? options.harnessSessionId?.trim() || null
      : (!isSubagentEnv
          ? process.env.ASD_HARNESS_SESSION_ID?.trim() ||
            process.env.CLAUDE_SESSION_ID?.trim() ||
            null
          : null);

  let matchedRecent = effectiveHarnessSessionId
    ? recentList.find((r) => r.harnessSessionId === effectiveHarnessSessionId)
    : undefined;

  if (
    options.harnessSessionId === undefined &&
    !effectiveHarnessSessionId &&
    recentList.length > 0
  ) {
    const recentCandidate = options.harness
      ? recentList.find((r) => r.harness === options.harness)
      : recentList[0];
    if (
      recentCandidate &&
      typeof recentCandidate.updatedAt === "number" &&
      now - recentCandidate.updatedAt <= tenMinutesMs
    ) {
      matchedRecent = recentCandidate;
      effectiveHarnessSessionId = recentCandidate.harnessSessionId;
    } else {
      effectiveHarnessSessionId = null;
    }
  }

  const effectiveModel =
    options.mainModel?.trim() ||
    options.model?.trim() ||
    matchedRecent?.model ||
    null;

  // 1. Delegate to attachDriver in SQLite DB when session exists
  let db = options.db;
  let ownsDb = false;
  let attachedViaDriver = false;
  try {
    if (!db) {
      const paths = resolveAsdPaths(projectRoot, options.homeDir);
      if (fs.existsSync(paths.dbPath)) {
        db = openProjectDb(projectRoot, options.homeDir);
        ownsDb = true;
      }
    }
    if (db) {
      const existingSession = db.getSession(asdSessionId);
      if (existingSession) {
        const effectiveHarness = (options.harness ||
          matchedRecent?.harness ||
          existingSession.main_harness ||
          "claude-code") as HarnessId;
        attachDriver(db, {
          projectRoot,
          sessionId: asdSessionId,
          harness: effectiveHarness,
          model: effectiveModel ?? existingSession.main_model ?? null,
          harnessSessionId: effectiveHarnessSessionId,
          source: options.source ?? "cli-asd",
          now,
        });
        if (options.autoApprove !== undefined) {
          db.updateSessionHarnessInfo(asdSessionId, {
            autoApprove: options.autoApprove,
          });
        }
        attachedViaDriver = true;
      }
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

  // 2. Fallback update for <projectRoot>/.asd/sessions/<asdSessionId>/main.json (or autoApprove sync)
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
      if (!attachedViaDriver) {
        if (effectiveHarnessSessionId) {
          current.harnessSessionId = effectiveHarnessSessionId;
        }
        if (effectiveModel) {
          current.model = effectiveModel;
        }
      }
      if (options.autoApprove !== undefined) {
        current.autoApprove = options.autoApprove;
      }
      atomicWriteFileSync(mainJsonPath, JSON.stringify(current, null, 2) + "\n");
    }
  } catch {
    // Ignore main.json update errors
  }

  // 3. Link asdSessionId back into cli-recent.json
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
 * Unlinks a harness CLI session from its ASD session (the inverse of `promoteCliSessionToAsd` /
 * `linkHarnessSessionToAsdSession`):
 * 1. Detaches any active driver on the ASD session (and clears `sessions.harness_session_id`
 *    or deletes the ASD session when `deleteAsdSession: true`).
 * 2. Resets `asdSessionId: null` for the matching CLI session entry in `cli-recent.json`
 *    so the session returns to a plain CLI session state.
 */
export function unlinkHarnessSessionFromAsdSession(options: {
  projectRoot: string;
  homeDir?: string;
  asdSessionId?: string;
  harnessSessionId?: string;
  harness?: HarnessId;
  deleteAsdSession?: boolean;
  db?: SqliteDriver;
}): {
  unlinked: boolean;
  asdSessionId: string | null;
  harnessSessionId: string | null;
} {
  const projectRoot = path.resolve(options.projectRoot);
  let targetAsdSessionId = options.asdSessionId?.trim() || null;
  let targetHarnessSessionId = options.harnessSessionId?.trim() || null;
  let unlinked = false;

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
      if (!targetAsdSessionId && targetHarnessSessionId) {
        const found = db.findSessionByHarnessSessionId(
          targetHarnessSessionId,
          options.harness
        );
        if (found) {
          targetAsdSessionId = found.session_id;
        }
      }

      if (targetAsdSessionId) {
        const sess = db.getSession(targetAsdSessionId);
        if (sess) {
          if (!targetHarnessSessionId && sess.harness_session_id) {
            targetHarnessSessionId = sess.harness_session_id;
          }
          const activeDrv = db.getActiveDriver(targetAsdSessionId);
          if (!targetHarnessSessionId && activeDrv?.harness_session_id) {
            targetHarnessSessionId = activeDrv.harness_session_id;
          }

          if (options.deleteAsdSession) {
            db.deleteSession(targetAsdSessionId);
          } else {
            detachDriver(db, {
              projectRoot,
              sessionId: targetAsdSessionId,
              reason: "manual",
            });
            db.updateSessionHarnessInfo(targetAsdSessionId, {
              harnessSessionId: null,
            });
          }
          unlinked = true;
        }
      }
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

  // Clear asdSessionId in <projectRoot>/.asd/sessions/cli-recent.json
  try {
    const filePath = getCliRecentSessionsPath(projectRoot);
    if (fs.existsSync(filePath)) {
      const recentList = readCliRecentSessionsRaw(projectRoot);
      let fileChanged = false;
      for (const entry of recentList) {
        const matchesAsd =
          targetAsdSessionId && entry.asdSessionId === targetAsdSessionId;
        const matchesHarness =
          targetHarnessSessionId &&
          entry.harnessSessionId === targetHarnessSessionId &&
          (!options.harness || entry.harness === options.harness);
        if (matchesAsd || matchesHarness) {
          if (!targetHarnessSessionId) {
            targetHarnessSessionId = entry.harnessSessionId;
          }
          if (!targetAsdSessionId && entry.asdSessionId) {
            targetAsdSessionId = entry.asdSessionId;
          }
          if (entry.asdSessionId !== null) {
            entry.asdSessionId = null;
            fileChanged = true;
          }
          unlinked = true;
        }
      }
      if (fileChanged) {
        atomicWriteFileSync(
          filePath,
          JSON.stringify({ sessions: recentList }, null, 2) + "\n"
        );
      }
    }
  } catch {
    // Ignore cli-recent update errors
  }

  return {
    unlinked,
    asdSessionId: targetAsdSessionId,
    harnessSessionId: targetHarnessSessionId,
  };
}

export interface PromoteCliSessionOptions {
  projectRoot: string;
  homeDir?: string;
  harness: HarnessId;
  harnessSessionId: string;
  model?: string | null;
  title?: string | null;
  memo?: string | null;
  transcriptPath?: string | null;
  asdSessionId?: string;
  sessionId?: string;
  autoApprove?: boolean;
  makeForeground?: boolean;
  source?: DriverSource;
  db?: SqliteDriver;
}

export interface PromoteCliSessionResult {
  sessionId: string;
  asdSessionId: string;
  created: boolean;
  driverId: string;
  driver: DriverRow;
  session: SessionRow;
  harness: HarnessId;
  harnessSessionId: string;
  model: string | null;
  mainJsonPath: string;
}

/**
 * Explicitly promotes a plain CLI/harness session (`harness` + `harnessSessionId`)
 * into a full ASD orchestration session (`asd-...`), creating or updating the
 * session row in `core.db`, attaching the active driver in `session_drivers`,
 * writing `<projectRoot>/.asd/sessions/<asdSessionId>/main.json`, and linking
 * `asdSessionId` back into `<projectRoot>/.asd/sessions/cli-recent.json`.
 */
export function promoteCliSessionToAsd(
  options: PromoteCliSessionOptions
): PromoteCliSessionResult {
  const projectRoot = path.resolve(options.projectRoot);
  const harnessSessionId = (options.harnessSessionId || "").trim();
  if (!harnessSessionId) {
    throw new Error("MISSING_HARNESS_SESSION_ID");
  }

  let db = options.db;
  let ownsDb = false;
  try {
    if (!db) {
      db = openProjectDb(projectRoot, options.homeDir);
      ownsDb = true;
    }

    const recentList = readCliRecentSessionsRaw(projectRoot);
    const matchedRecent = recentList.find(
      (r) => r.harness === options.harness && r.harnessSessionId === harnessSessionId
    );

    const existingMappedSession = db.findSessionByHarnessSessionId(
      harnessSessionId,
      options.harness
    );
    const explicitId = (options.asdSessionId || options.sessionId || "").trim();
    const asdSessionId =
      explicitId ||
      existingMappedSession?.session_id ||
      (matchedRecent?.asdSessionId && matchedRecent.asdSessionId.trim()) ||
      generateAsdSessionId();
    if (!isValidAsdSessionId(asdSessionId)) {
      throw new Error("INVALID_SESSION_ID");
    }

    const effectiveModel =
      (options.model && options.model.trim()) ||
      matchedRecent?.model ||
      null;
    const effectiveMemo =
      (options.memo && options.memo.trim()) ||
      (options.title && options.title.trim()) ||
      matchedRecent?.summary ||
      null;

    const existedBefore = Boolean(db.getSession(asdSessionId));
    db.createOrGetSession({
      sessionId: asdSessionId,
      projectRoot,
      mainHarness: options.harness,
      mainModel: effectiveModel,
      harnessSessionId,
      memo: effectiveMemo,
      autoApprove: options.autoApprove,
    });

    if (effectiveMemo) {
      db.updateSessionMemo(asdSessionId, effectiveMemo);
    }

    const driverRow = attachDriver(db, {
      projectRoot,
      sessionId: asdSessionId,
      harness: options.harness,
      model: effectiveModel,
      harnessSessionId,
      source: options.source ?? "cli-asd",
    });

    if (options.makeForeground) {
      try {
        setForegroundSession({
          db,
          projectRoot,
          sessionId: asdSessionId,
        });
      } catch {
        // Ignore foreground switch errors
      }
    }

    const mainJsonPath = path.join(
      projectRoot,
      ".asd",
      "sessions",
      asdSessionId,
      "main.json"
    );
    if (fs.existsSync(mainJsonPath)) {
      try {
        const current = JSON.parse(fs.readFileSync(mainJsonPath, "utf8")) as Record<
          string,
          unknown
        >;
        if (effectiveMemo && !current.memo) {
          current.memo = effectiveMemo;
        }
        if (options.autoApprove !== undefined) {
          current.autoApprove = options.autoApprove;
        }
        atomicWriteFileSync(mainJsonPath, JSON.stringify(current, null, 2) + "\n");
      } catch {
        // Ignore main.json enrichment error
      }
    }

    recordCliRecentSession(
      projectRoot,
      {
        harnessSessionId,
        harness: options.harness,
        model: effectiveModel,
        summary: effectiveMemo || "",
        transcriptPath:
          options.transcriptPath ?? matchedRecent?.transcriptPath ?? null,
        asdSessionId,
      },
      { forceCreateDir: true }
    );

    const sessionRow = db.getSession(asdSessionId)!;
    return {
      sessionId: asdSessionId,
      asdSessionId,
      created: !existedBefore,
      driverId: driverRow.driver.driver_id,
      driver: driverRow.driver,
      session: sessionRow,
      harness: options.harness,
      harnessSessionId,
      model: effectiveModel,
      mainJsonPath,
    };
  } finally {
    if (ownsDb && db) {
      try {
        db.close();
      } catch {}
    }
  }
}

const projectFsCache = new Map<
  string,
  { hash: string; existsOnDisk: boolean; checkedAt: number }
>();
const PROJECT_FS_CACHE_TTL_MS = 15_000;

function getCachedProjectFsInfo(
  projectRoot: string,
  skipDiskCheck = false
): { hash: string; existsOnDisk: boolean } {
  if (skipDiskCheck) {
    const cached = projectFsCache.get(projectRoot);
    if (cached) return { hash: cached.hash, existsOnDisk: cached.existsOnDisk };
    return { hash: computeProjectHash(projectRoot), existsOnDisk: true };
  }
  const now = Date.now();
  const cached = projectFsCache.get(projectRoot);
  if (cached && now - cached.checkedAt <= PROJECT_FS_CACHE_TTL_MS) {
    return { hash: cached.hash, existsOnDisk: cached.existsOnDisk };
  }
  const existsOnDisk = fs.existsSync(projectRoot);
  const hash = computeProjectHash(projectRoot);
  projectFsCache.set(projectRoot, { hash, existsOnDisk, checkedAt: now });
  return { hash, existsOnDisk };
}

/**
 * Discovers all plain CLI/harness sessions executed in `projectRoot` across
 * Claude Code, Codex, OpenCode, Antigravity, and Cursor, even when `<projectRoot>/.asd`
 * does not exist yet. Merges local transcript discovery, `cli-recent.json`, and
 * `core.db` driver bindings, sorted by `updatedAt DESC`.
 */
export function discoverProjectCliSessions(
  projectRoot: string,
  options?: {
    homeDir?: string;
    harnesses?: HarnessId[];
    limit?: number;
    persist?: boolean;
    db?: SqliteDriver;
  }
): CliRecentSessionEntry[] {
  const resolvedRoot = path.resolve(projectRoot);
  if (!fs.existsSync(resolvedRoot)) return [];

  const homeDir = options?.homeDir ? path.resolve(options.homeDir) : os.homedir();
  const harnessFilter = options?.harnesses ? new Set(options.harnesses) : null;
  const maxItems = options?.limit && options.limit > 0 ? options.limit : MAX_RECENT_CLI_SESSIONS;

  const discovered: DiscoveredLocalTranscript[] = [];
  if (!harnessFilter || harnessFilter.has("antigravity")) {
    scanAntigravityLocalSessions(resolvedRoot, homeDir, discovered);
  }
  if (!harnessFilter || harnessFilter.has("claude-code")) {
    scanClaudeCodeLocalSessions(resolvedRoot, homeDir, discovered);
  }
  if (!harnessFilter || harnessFilter.has("codex")) {
    scanCodexLocalSessions(resolvedRoot, homeDir, discovered);
  }
  if (!harnessFilter || harnessFilter.has("opencode")) {
    scanOpenCodeLocalSessions(resolvedRoot, homeDir, discovered);
  }

  const byKey = new Map<string, CliRecentSessionEntry>();
  for (const existing of readCliRecentSessionsRaw(resolvedRoot)) {
    if (harnessFilter && !harnessFilter.has(existing.harness)) continue;
    byKey.set(`${existing.harness}::${existing.harnessSessionId}`, { ...existing });
  }

  for (const item of discovered) {
    const key = `${item.harness}::${item.harnessSessionId}`;
    const prev = byKey.get(key);
    if (prev) {
      if (!prev.summary && item.summary) prev.summary = item.summary;
      if (!prev.model && item.model) prev.model = item.model;
      if (!prev.transcriptPath && item.transcriptPath) prev.transcriptPath = item.transcriptPath;
      if (item.updatedAt > prev.updatedAt) prev.updatedAt = item.updatedAt;
    } else {
      byKey.set(key, {
        harnessSessionId: item.harnessSessionId,
        harness: item.harness,
        model: item.model ?? null,
        summary: item.summary,
        transcriptPath: item.transcriptPath,
        asdSessionId: null,
        projectRoot: resolvedRoot,
        startedAt: item.startedAt,
        updatedAt: item.updatedAt,
      });
    }
  }

  // Enrich with linked ASD sessions from core.db if available
  let db = options?.db;
  let ownsDb = false;
  try {
    if (!db) {
      const paths = resolveAsdPaths(resolvedRoot, homeDir);
      if (fs.existsSync(paths.dbPath)) {
        db = openProjectDb(resolvedRoot, homeDir);
        ownsDb = true;
      }
    }
    if (db) {
      const sessions = db.listSessions();
      for (const s of sessions) {
        if (s.main_harness_session_id && (!harnessFilter || harnessFilter.has(s.main_harness))) {
          const key = `${s.main_harness}::${s.main_harness_session_id}`;
          const existing = byKey.get(key);
          if (existing) {
            if (!existing.asdSessionId) existing.asdSessionId = s.session_id;
            if (!existing.model && s.main_model) existing.model = s.main_model;
            if (!existing.summary && s.memo) existing.summary = s.memo;
          } else {
            byKey.set(key, {
              harnessSessionId: s.main_harness_session_id,
              harness: s.main_harness,
              model: s.main_model ?? null,
              summary: s.memo || `${s.main_harness} session (${s.main_harness_session_id.slice(0, 8)})`,
              transcriptPath: null,
              asdSessionId: s.session_id,
              projectRoot: resolvedRoot,
              startedAt: s.created_at || Date.now(),
              updatedAt: s.updated_at || s.created_at || Date.now(),
            });
          }
        }
      }
    }
  } catch {
    // Ignore DB enrichment errors
  } finally {
    if (ownsDb && db) {
      try {
        db.close();
      } catch {}
    }
  }

  const merged = [...byKey.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxItems);

  const asdDir = path.join(resolvedRoot, ".asd");
  if ((options?.persist || fs.existsSync(asdDir)) && merged.length > 0 && !harnessFilter) {
    try {
      const filePath = getCliRecentSessionsPath(resolvedRoot);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      ensureGitExclude(resolvedRoot, ".asd/");
      atomicWriteFileSync(
        filePath,
        JSON.stringify({ sessions: merged }, null, 2) + "\n"
      );
    } catch {
      // Best-effort cache write
    }
  }

  return merged;
}

/**
 * Discovers all projects that have used ASD by querying the shared state DB
 * (one entry per distinct sessions.project_root) — no directory scanning.
 */
export function listKnownProjects(options?: {
  homeDir?: string;
  extraProjectRoots?: string[];
  skipDiskCheck?: boolean;
  db?: SqliteDriver;
}): KnownProjectSummary[] {
  const home = resolveHomeDir(options?.homeDir);
  const stateRoot = path.join(home, ".asd", "state");
  const dbPath = path.join(stateRoot, "core.db");
  const byHash = new Map<string, KnownProjectSummary>();
  const skipDiskCheck = Boolean(options?.skipDiskCheck);

  if (options?.db || fs.existsSync(dbPath)) {
    // Unscoped on purpose: discovery is inherently cross-project.
    let db = options?.db;
    let ownsDb = false;
    try {
      if (!db) {
        db = new SqliteDriver(dbPath); // unscoped: cross-project discovery
        ownsDb = true;
      }
      const sessions = db.listSessions();
      const perProject = new Map<string, SessionRow[]>();
      for (const s of sessions) {
        const list = perProject.get(s.project_root);
        if (list) list.push(s);
        else perProject.set(s.project_root, [s]);
      }
      for (const [projectRoot, projectSessions] of perProject) {
        const latest = projectSessions[0]!;
        const { hash, existsOnDisk } = getCachedProjectFsInfo(projectRoot, skipDiskCheck);
        byHash.set(hash, {
          projectHash: hash,
          projectRoot,
          dbPath,
          existsOnDisk,
          sessionCount: projectSessions.length,
          latestSessionId: latest.session_id,
          latestHarness: latest.main_harness,
          latestMemo: latest.memo ?? null,
          updatedAt: latest.updated_at || latest.created_at,
        });
      }
    } catch {
      // Ignore unreadable DB
    } finally {
      if (ownsDb && db) {
        try {
          db.close();
        } catch {}
      }
    }
  }

  for (const extraRoot of options?.extraProjectRoots ?? []) {
    if (!extraRoot || !extraRoot.trim()) continue;
    const resolvedExtra = path.resolve(extraRoot);
    const { hash, existsOnDisk } = getCachedProjectFsInfo(resolvedExtra, skipDiskCheck);
    if (!byHash.has(hash)) {
      byHash.set(hash, {
        projectHash: hash,
        projectRoot: resolvedExtra,
        dbPath,
        existsOnDisk,
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
