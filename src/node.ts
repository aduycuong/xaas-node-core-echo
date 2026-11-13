// Everything that is specific to this node. A new node copies the folder and rewrites this file;
// `index.ts` (the protocol plumbing) stays the same.

import { z } from "zod";
import { NodeError, type NodeContext } from "./protocol";
import type { ResourceEnv } from "./resources";

/** Bindings and secrets of this Worker (wrangler.jsonc). Every node has `ResourceEnv`: the binding to xaas-resource-broker. */
export type Env = ResourceEnv;

/**
 * Identity and execution settings of the node. `key` + `version` must match the Worker name in
 * wrangler.jsonc: `core.echo` 1.2.0 is `node-core-echo-v1-2-0`. A behaviour change that
 * workflows could notice needs a new version, deployed as a new Worker.
 */
export const manifest = {
  key: "core.echo",
  version: "1.2.0",
  name: "Echo",
  category: "Core",
  description: "Returns its input. A template for new nodes and a way to try the runner.",
  mode: "sync",
  /** Time the runner allows for one attempt. */
  timeout_ms: 30_000,
  retry: { max_attempts: 3, backoff: "exponential", base_delay_ms: 2_000 },
  /**
   * What the node may read from the workspace: the person maps each item by hand in the workflow; the node reads it by
   * this name. Echo's are all optional, to try the resource broker.
   */
  requires: {
    connections: [{ name: "ECHO_CONNECTION", provider: "google", required: false, description: "A connection to check (its tokens are never returned)." }],
    secrets: [{ name: "ECHO_SECRET", required: false, description: "A secret to check (its value is never returned)." }],
    variables: [{ name: "ECHO_VARIABLE", required: false, description: "A variable to return." }],
  },
};

/** Input after the workflow's templates were resolved. Unknown fields are allowed and echoed back. */
export const inputSchema = z.looseObject({
  fail_with: z
    .int()
    .min(400)
    .max(599)
    .optional()
    .describe("Answer with this HTTP status instead of echoing, to try the runner's retries."),
  read_variable: z.boolean().optional().describe("Return the variable mapped to ECHO_VARIABLE, in the environment of the run."),
  check_secret: z.boolean().optional().describe("Check the secret mapped to ECHO_SECRET can be read; its value is never returned."),
  check_connection: z.boolean().optional().describe("Check the connection mapped to ECHO_CONNECTION can be read; its tokens are never returned."),
});

export const outputSchema = z.object({
  echo: z.record(z.string(), z.unknown()).describe("The input, as received."),
  attempt: z.int().describe("Which attempt of the node run produced this output (1 = first)."),
  env: z.string().optional().describe("The environment of the run."),
  variable: z.string().optional().describe("The value of ECHO_VARIABLE (with `read_variable`)."),
  secret: z.literal(true).optional().describe("ECHO_SECRET could be read (with `check_secret`)."),
  connection: z.object({ provider: z.string(), name: z.string(), external_id: z.string(), resources: z.int() }).optional().describe("ECHO_CONNECTION could be read (with `check_connection`): what it is, never its tokens."),
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
  if (input.read_variable) output.variable = await ctx.getVariable("ECHO_VARIABLE");
  // Reading proves the secret and the connection are mapped and usable; their values never leave the node.
  if (input.check_secret) {
    await ctx.getSecret("ECHO_SECRET");
    output.secret = true;
  }
  if (input.check_connection) {
    const connection = await ctx.getConnection("ECHO_CONNECTION");
    output.connection = { provider: connection.provider, name: connection.name, external_id: connection.externalId, resources: connection.resources.length };
  }
  return output;
}

/**
 * Health of what the node depends on: a required secret is set, a bound resource answers.
 * Keep it cheap and never return secret values. Echo needs what reading secrets and variables needs.
 */
export async function checkHealth(env: Env): Promise<{ ok: boolean; detail?: string }> {
  return env.RESOURCE_BROKER ? { ok: true } : { ok: false, detail: "The RESOURCE_BROKER binding is missing (needed to read workspace resources)." };
}
