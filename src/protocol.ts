// XaaS node protocol, shared shape for every node. Copy unchanged into a new node.

import type { Connection } from "./resources";

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
  /** The secret mapped to `name` in the workflow (a name of `requires.secrets`), in the environment of the run. Never return or log it. */
  getSecret(name: string): Promise<string>;
  /** The variable mapped to `name` (a name of `requires.variables`), in the environment of the run. */
  getVariable(name: string): Promise<string>;
  /** The connection mapped to `name` (a name of `requires.connections`), with working tokens. Never return or log them. */
  getConnection(name: string): Promise<Connection>;
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
