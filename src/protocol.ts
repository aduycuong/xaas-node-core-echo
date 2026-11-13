// XaaS node protocol, shared shape for every node. Copy unchanged into a new node.

import type { FileBody, Resource, WorkspaceFile } from "./resources";

/** What the runner tells the node about the call, besides the input. */
export type NodeContext<Env> = {
  env: Env;
  runId: string;
  nodeRunId: string;
  /** 1 for the first attempt of this node run, 2 for the first retry… */
  attempt: number;
  /** The same on every attempt of one node run. Use it to avoid repeating side effects. */
  idempotencyKey: string;
  /** The run: its environment decides which values `getSecret` / `getVariable` return. */
  run: { id?: string; workspace?: string; workflow?: string; version?: number; env?: string };
  /** The secret chosen for `name` in the workflow (a `secret` of the manifest's `resources`), in the environment of the run. Never return or log it. */
  getSecret(name: string): Promise<string>;
  /** The variable chosen for `name` (a `variable` of `resources`), in the environment of the run. */
  getVariable(name: string): Promise<string>;
  /** The connection, or the file / folder / channel / chat / Page of a connection, chosen for `name`, with working tokens. Never return or log them. */
  getResource(name: string): Promise<Resource>;
  /** Streams a workspace file: the chosen `r2.file`, or `path` inside the chosen `r2.folder`. */
  readFile(name: string, path?: string): Promise<{ file: WorkspaceFile; body: ReadableStream<Uint8Array> }>;
  /** Files inside the chosen `r2.folder` (and its subfolders), newest first. */
  listFiles(name: string, options?: { prefix?: string }): Promise<WorkspaceFile[]>;
  /** Writes `path` inside the chosen `r2.folder`; the file shows "Created by run" on the Files page. */
  writeFile(name: string, path: string, body: FileBody, options?: { contentType?: string; size?: number }): Promise<WorkspaceFile & { replaced: boolean }>;
};

/**
 * A failure to report to the runner as `{ error: { code, message, retryable } }`.
 * The runner retries 5xx and 429 by itself; set `retryable` to override that for other statuses.
 */
export class NodeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "NodeError";
    this.code = code;
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? (this.status >= 500 || this.status === 429);
  }
}
