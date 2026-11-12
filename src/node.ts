// Everything that is specific to this node. A new node copies the folder and rewrites this file;
// `index.ts` (the protocol plumbing) stays the same.

import { z } from "zod";
import { NodeError, type NodeContext } from "./protocol";
import type { ConfigEnv } from "./secrets";

/** Bindings and secrets of this Worker (wrangler.jsonc, `wrangler secret put`). Every node has `ConfigEnv` to read workspace secrets and variables. */
export type Env = ConfigEnv;

/**
 * Identity and execution settings of the node. `key` + `version` must match the Worker name in
 * wrangler.jsonc: `core.echo` 1.1.0 is `node-core-echo-v1-1-0`. A behaviour change that
 * workflows could notice needs a new version, deployed as a new Worker.
 */
export const manifest = {
  key: "core.echo",
  version: "1.1.0",
  name: "Echo",
  category: "Core",
  description: "Returns its input. A template for new nodes and a way to try the runner.",
  mode: "sync",
  /** Time the runner allows for one attempt. */
  timeout_ms: 30_000,
  retry: { max_attempts: 3, backoff: "exponential", base_delay_ms: 2_000 },
} as const;

/** Input after the workflow's templates were resolved. Unknown fields are allowed and echoed back. */
export const inputSchema = z.looseObject({
  fail_with: z
    .int()
    .min(400)
    .max(599)
    .optional()
    .describe("Answer with this HTTP status instead of echoing, to try the runner's retries."),
  read_variables: z.array(z.string()).max(20).optional().describe("Names of workspace variables to return, read in the environment of the run."),
  check_secrets: z.array(z.string()).max(20).optional().describe("Names of workspace secrets to check: the output says each one could be read, never its value."),
});

export const outputSchema = z.object({
  echo: z.record(z.string(), z.unknown()).describe("The input, as received."),
  attempt: z.int().describe("Which attempt of the node run produced this output (1 = first)."),
  env: z.string().optional().describe("The environment of the run."),
  variables: z.record(z.string(), z.string()).optional().describe("The variables asked for in `read_variables`, by name."),
  secrets: z.record(z.string(), z.literal(true)).optional().describe("The secrets asked for in `check_secrets` that could be read (always true; a missing one fails the node)."),
});

export type Input = z.infer<typeof inputSchema>;
export type Output = z.infer<typeof outputSchema>;

/**
 * The work of the node. Return the output, or throw `NodeError` for a failure the workflow
 * author should see. Any other exception is reported as a retryable `INTERNAL` error.
 *
 * A node with side effects must be idempotent: the runner sends the same `ctx.idempotencyKey`
 * on every attempt of one node run, so store it with the result (KV, D1, or the upstream API's
 * own idempotency key) and return the stored result when it comes again. Echo has no side
 * effects, so it needs none of that.
 */
export async function execute(input: Input, ctx: NodeContext<Env>): Promise<Output> {
  if (input.fail_with !== undefined) {
    throw new NodeError("SIMULATED_FAILURE", `Asked to fail with ${input.fail_with}.`, { status: input.fail_with });
  }
  const output: Output = { echo: input, attempt: ctx.attempt, ...(ctx.run.env ? { env: ctx.run.env } : {}) };
  if (input.read_variables?.length) {
    output.variables = Object.fromEntries(await Promise.all(input.read_variables.map(async (name) => [name, await ctx.getVariable(name)] as const)));
  }
  if (input.check_secrets?.length) {
    // Reading proves the secret is set and decrypts; the value itself never leaves the node.
    for (const name of input.check_secrets) await ctx.getSecret(name);
    output.secrets = Object.fromEntries(input.check_secrets.map((name) => [name, true as const]));
  }
  return output;
}

/**
 * Health of what the node depends on: a required secret is set, a bound resource answers.
 * Keep it cheap and never return secret values. Echo needs what reading secrets and variables needs.
 */
export async function checkHealth(env: Env): Promise<{ ok: boolean; detail?: string }> {
  const missing = (["DATABASE_URL", "SECRETS_ENCRYPTION_KEY"] as const).filter((name) => !env[name]);
  return missing.length ? { ok: false, detail: `Not set: ${missing.join(", ")} (needed to read secrets and variables).` } : { ok: true };
}
