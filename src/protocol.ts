// XaaS node protocol, shared shape for every node. Copy unchanged into a new node.

import type { FileBody, Resource, WorkspaceFile } from "./resources";

/** Execution settings of a node, the same for every kind; ranges: xaas-workflows/lib/nodes/constants.ts. */
type ManifestBase = {
  key: string;
  version: string;
  name: string;
  category?: string;
  description?: string;
  /** Sync: time to answer with the output. Async: time of each HTTP call (the 202, `POST /callback`, the status route). 1 500 – 30 000. */
  timeout_ms: number;
  retry: { max_attempts: number; backoff: "none" | "linear" | "exponential"; base_delay_ms: number };
  resources?: Array<{ name: string; kind: string; required?: boolean; description?: string; provider?: string; mime_types?: Array<"sheet" | "doc" | "slides"> }>;
};

/**
 * The manifest a node serves at `GET /.well-known/xaas-node.json` (without the schemas, which `index.ts` adds): a sync
 * node, an async node that calls back, or an async node the runner polls. `nodes:deploy` checks it again.
 */
export type NodeManifest =
  | (ManifestBase & { mode: "sync" })
  | (ManifestBase & { mode: "async"; async: { completion: "callback"; max_wait_ms: number; callback_handler?: boolean } })
  | (ManifestBase & {
      mode: "async";
      async: { completion: "polling"; max_wait_ms: number; poll?: { interval_ms?: number; max_interval_ms?: number; max_polls?: number } };
    });

/** What `execute` of an async node returns: the job was taken (202). `status_url` (polling) is a path of this node. */
export type Accepted = { accepted: true; job_id: string; status_url?: string };

export function accept(jobId: string, statusUrl?: string): Accepted {
  return { accepted: true, job_id: jobId, ...(statusUrl ? { status_url: statusUrl } : {}) };
}

export function isAccepted(value: unknown): value is Accepted {
  return typeof value === "object" && value !== null && (value as { accepted?: unknown }).accepted === true;
}

/** What the status route of a polling node answers. `retry_after_ms` asks the runner to wait that long before the next poll. */
export type JobStatus<Output> =
  | { status: "running"; retry_after_ms?: number }
  | { status: "succeeded"; output: Output }
  | { status: "failed"; error: { code: string; message: string; retryable?: boolean } };

/** The body an async node posts to `callback_url` (without `callback_handler`). */
export type CallbackBody<Output> = { output: Output } | { error: { code: string; message: string; retryable?: boolean } };

/** What the runner tells the node about the call, besides the input. */
export type NodeContext<Env> = {
  env: Env;
  runId: string;
  nodeRunId: string;
  /** 1 for the first attempt of this node run, 2 for the first retry… */
  attempt: number;
  /** The same on every attempt of one node run. Use it to avoid repeating side effects. */
  idempotencyKey: string;
  /** Async callback nodes: where to post the result (`CallbackBody`), once. Absent for sync and polling nodes. */
  callbackUrl?: string;
  /** The run: its environment decides which values `getSecret` / `getVariable` return. */
  run: { id?: string; workspace?: string; workflow?: string; version?: number; env?: string };
  /** The secret chosen for `name` in the workflow (a `secret` of the manifest's `resources`), in the environment of the run. Never return or log it. */
  getSecret(name: string): Promise<string>;
  /** The variable chosen for `name` (a `variable` of `resources`), in the environment of the run (else its default), as text. */
  getVariable(name: string): Promise<string>;
  /** The same variable with its type: `parsed` is a number, a boolean, parsed JSON or the text, as set on the Secrets & variables page. */
  getTypedVariable(name: string): Promise<{ value: string; type: "string" | "number" | "boolean" | "json"; parsed: unknown }>;
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
