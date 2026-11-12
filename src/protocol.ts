// XaaS node protocol, shared shape for every node. Copy unchanged into a new node.

import type { Connection } from "./secrets";

/** What the runner tells the node about the call, besides the input. */
export type NodeContext<Env> = {
  env: Env;
  runId: string;
  nodeRunId: string;
  /** 1 for the first attempt of this node run, 2 for the first retry… */
  attempt: number;
  /** The same on every attempt of one node run. Use it to avoid repeating side effects. */
  idempotencyKey: string;
  /** The run: `workspace` and `env` decide which secrets and variables `getSecret` / `getVariable` read. */
  run: { id?: string; workspace?: string; workflow?: string; version?: number; env?: string };
  /** A secret of the workspace by name, in the environment of the run (`secrets.ts`). Never return or log it. */
  getSecret(name: string): Promise<string>;
  /** A variable of the workspace by name, in the environment of the run. */
  getVariable(name: string): Promise<string>;
  /** A connection of the workspace by id (the one chosen in the node), with working tokens (`secrets.ts`). Never return or log them. */
  getConnection(connectionId: string): Promise<Connection>;
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
