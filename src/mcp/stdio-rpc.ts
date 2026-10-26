/**
 * Async JSON-RPC 2.0 stdio transport for the ASD MCP server.
 *
 * stdout is reserved exclusively for JSON-RPC frames. The raw writer is
 * captured first, then `console.log` is redirected to stderr so accidental
 * logging inside handlers can never corrupt the frame stream.
 */

const writeStdout = process.stdout.write.bind(process.stdout);
console.log = console.error;

export interface StdioRpcServerOptions {
  handleRequest: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class StdioRpcServer {
  private readonly options: StdioRpcServerOptions;
  private lineBuffer = "";
  private readonly pending = new Map<string | number, AbortController>();
  private readonly cleanupCallbacks: Array<() => void> = [];
  private started = false;
  private closed = false;

  constructor(options: StdioRpcServerOptions) {
    this.options = options;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.onData);
    process.stdin.on("end", this.onStdinClosed);
    process.stdin.on("close", this.onStdinClosed);
    process.stdin.resume();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    process.stdin.off("data", this.onData);
    process.stdin.off("end", this.onStdinClosed);
    process.stdin.off("close", this.onStdinClosed);
    this.shutdown();
  }

  /** Register a callback invoked once when stdin closes or stop() is called. */
  onCleanup(callback: () => void): void {
    this.cleanupCallbacks.push(callback);
  }

  /** Emit a `notifications/progress` frame to the host. */
  sendProgress(progressToken: string | number, progress: number, total: number, message?: string): void {
    const params: Record<string, unknown> = { progressToken, progress, total };
    if (message !== undefined) params.message = message;
    this.writeFrame({ jsonrpc: "2.0", method: "notifications/progress", params });
  }

  private onData = (chunk: string): void => {
    // CRLF-safe line framing: split on /\r?\n/, keep the trailing partial
    // line in the buffer so frames split across arbitrary chunk boundaries
    // (including a \r...\n split) reassemble correctly.
    this.lineBuffer += chunk;
    const parts = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = parts.pop() ?? "";
    for (const line of parts) this.handleLine(line);
  };

  private onStdinClosed = (): void => {
    this.shutdown();
  };

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.writeFrame({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      this.writeFrame({ jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "Invalid Request" } });
      return;
    }

    const msg = message as Record<string, unknown>;
    const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
    if (!hasId) {
      this.handleNotification(msg);
      return;
    }

    const rawId: unknown = msg["id"];
    if (rawId !== null && typeof rawId !== "string" && typeof rawId !== "number") {
      this.writeFrame({ jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "Invalid Request" } });
      return;
    }
    const id: string | number | null = rawId as string | number | null;

    const method: unknown = msg["method"];
    if (typeof method !== "string") {
      this.writeFrame({ jsonrpc: "2.0", id, error: { code: INVALID_REQUEST, message: "Invalid Request" } });
      return;
    }

    const controller = new AbortController();
    if (id !== null) this.pending.set(id, controller);

    let handled: Promise<unknown>;
    try {
      handled = this.options.handleRequest(method, msg["params"], controller.signal);
    } catch (err) {
      handled = Promise.reject(err);
    }
    void handled
      .then((result) => {
        this.writeFrame({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
      })
      .catch((err: unknown) => {
        this.writeFrame({ jsonrpc: "2.0", id, error: toJsonRpcError(err) });
      })
      .finally(() => {
        if (id !== null) this.pending.delete(id);
      });
  }

  private handleNotification(msg: Record<string, unknown>): void {
    if (msg["method"] !== "notifications/cancelled") return;
    const params: unknown = msg["params"];
    if (typeof params !== "object" || params === null) return;
    const requestId: unknown = (params as Record<string, unknown>)["requestId"];
    if (typeof requestId === "string" || typeof requestId === "number") {
      this.pending.get(requestId)?.abort();
    }
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
    for (const callback of this.cleanupCallbacks) {
      try {
        callback();
      } catch {
        // cleanup callbacks must never take the server down
      }
    }
  }

  private writeFrame(frame: unknown): void {
    writeStdout(JSON.stringify(frame) + "\n");
  }
}

function toJsonRpcError(err: unknown): JsonRpcError {
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e["code"] === "number" && typeof e["message"] === "string") {
      return { code: e["code"], message: e["message"], data: e["data"] };
    }
    if (typeof e["message"] === "string") {
      return { code: INTERNAL_ERROR, message: e["message"] };
    }
  }
  return { code: INTERNAL_ERROR, message: String(err) };
}
