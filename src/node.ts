// Everything that is specific to this node. A new node copies the folder and rewrites this file;
// `index.ts` (the protocol plumbing) stays the same.

import { z } from "zod";
import { NodeError, type NodeContext } from "./protocol";
import type { ResourceEnv } from "./resources";

/** Bindings and secrets of this Worker (wrangler.jsonc). Every node has `ResourceEnv`: the binding to xaas-resource-broker. */
export type Env = ResourceEnv;

/**
 * Identity and execution settings of the node. `key` + `version` must match the Worker name in
 * wrangler.jsonc: `core.echo` 1.3.0 is `node-core-echo-v1-3-0`. A behaviour change that
 * workflows could notice needs a new version, deployed as a new Worker.
 */
export const manifest = {
  key: "core.echo",
  version: "1.3.0",
  name: "Echo",
  category: "Core",
  description: "Returns its input. A template for new nodes and a way to try the runner.",
  mode: "sync",
  /** Time the runner allows for one attempt. */
  timeout_ms: 30_000,
  retry: { max_attempts: 3, backoff: "exponential", base_delay_ms: 2_000 },
  /**
   * What the node may use from the workspace: the person chooses each one by hand in the workflow; the node reads it by
   * this name. Echo's are all optional, to try the resource broker.
   */
  resources: [
    { name: "ECHO_CONNECTION", kind: "connection", provider: "google", required: false, description: "A Google connection to check (its tokens are never returned)." },
    { name: "ECHO_FILE", kind: "google.file", mime_types: ["sheet"], required: false, description: "A Google Sheet to check (only its name is returned)." },
    { name: "ECHO_SECRET", kind: "secret", required: false, description: "A secret to check (its value is never returned)." },
    { name: "ECHO_VARIABLE", kind: "variable", required: false, description: "A variable to return." },
  ],
};

/** Input after the workflow's templates were resolved. Unknown fields are allowed and echoed back. */
export const inputSchema = z.looseObject({
  fail_with: z
    .int()
    .min(400)
    .max(599)
    .optional()
    .describe("Answer with this HTTP status instead of echoing, to try the runner's retries."),
  read_variable: z.boolean().optional().describe("If on, return the variable chosen for ECHO_VARIABLE, in the environment of the run."),
  check_secret: z.boolean().optional().describe("If on, read the secret chosen for ECHO_SECRET to test access; the output only says it worked, never the value."),
  check_connection: z.boolean().optional().describe("If on, read the connection chosen for ECHO_CONNECTION; the output says which one, never its tokens."),
  check_file: z.boolean().optional().describe("If on, read the sheet chosen for ECHO_FILE; the output gives its name, never the tokens."),
});

export const outputSchema = z.object({
  echo: z.record(z.string(), z.unknown()).describe("The input, as received."),
  attempt: z.int().describe("Which attempt of the node run produced this output (1 = first)."),
  env: z.string().optional().describe("The environment of the run."),
  variable: z.string().optional().describe("The value of ECHO_VARIABLE (with `read_variable`)."),
  secret: z.literal(true).optional().describe("ECHO_SECRET could be read (with `check_secret`)."),
  connection: z.object({ provider: z.string(), name: z.string(), external_id: z.string() }).optional().describe("ECHO_CONNECTION could be read (with `check_connection`): what it is, never its tokens."),
  file: z.object({ id: z.string(), kind: z.string(), label: z.string(), connection: z.string() }).optional().describe("ECHO_FILE could be read (with `check_file`): which sheet, in which connection."),
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
    const { connection } = await ctx.getResource("ECHO_CONNECTION");
    output.connection = { provider: connection.provider, name: connection.name, external_id: connection.externalId };
  }
  if (input.check_file) {
    const { item, connection } = await ctx.getResource("ECHO_FILE");
    if (!item) throw new NodeError("RESOURCE_GONE", "No sheet came with ECHO_FILE.", { status: 422 });
    output.file = { id: item.id, kind: item.kind, label: item.label, connection: connection.name };
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
