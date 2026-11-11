// Protocol plumbing: the same in every node. The node itself is in `node.ts`.
//
//   POST /                           run the node            (called by the runner)
//   GET  /health                     is the node able to work
//   GET  /.well-known/xaas-node.json manifest: identity, settings, input and output schemas
//
// A node has no public URL, routes or cron triggers of its own: it is reached only through the
// runner's service binding, so it can move to a dispatch namespace later without a change.

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { checkHealth, execute, inputSchema, manifest, outputSchema, type Env } from "./node";
import { NodeError, type NodeContext } from "./protocol";

const envelopeSchema = z.object({
  input: z.unknown().optional(),
  context: z.object({ vars: z.record(z.string(), z.unknown()).optional() }).optional(),
  run: z
    .object({ id: z.string(), workflow: z.string(), version: z.int(), env: z.string() })
    .partial()
    .optional(),
});

function errorBody(code: string, message: string, retryable: boolean) {
  return { error: { code, message, retryable } };
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  let health: { ok: boolean; detail?: string };
  try {
    health = await checkHealth(c.env);
  } catch (error) {
    health = { ok: false, detail: error instanceof Error ? error.message : "Health check threw." };
  }
  return c.json({ ...health, key: manifest.key, version: manifest.version }, health.ok ? 200 : 503);
});

app.get("/.well-known/xaas-node.json", (c) =>
  c.json({
    ...manifest,
    input_schema: z.toJSONSchema(inputSchema, { io: "input" }),
    output_schema: z.toJSONSchema(outputSchema),
  }),
);

app.post("/", async (c) => {
  const started = Date.now();
  const runId = c.req.header("X-XaaS-Run-Id") ?? "";
  const nodeRunId = c.req.header("X-XaaS-Node-Run-Id") ?? "";
  const attempt = Number(c.req.header("X-XaaS-Attempt") ?? "1") || 1;

  /** One JSON line per call, with the ids that tie it to a run. Never log secrets or whole inputs. */
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ node: manifest.key, version: manifest.version, runId, nodeRunId, attempt, outcome, ms: Date.now() - started, ...extra }));

  const fail = (status: number, code: string, message: string, retryable: boolean) => {
    log("failed", { code, status });
    return c.json(errorBody(code, message, retryable), status as ContentfulStatusCode);
  };

  const envelope = envelopeSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!envelope.success) return fail(400, "INVALID_REQUEST", "The request body is not a XaaS node request.", false);

  const input = inputSchema.safeParse(envelope.data.input ?? {});
  if (!input.success) {
    const issue = input.error.issues[0];
    const where = issue?.path.length ? `input.${issue.path.join(".")}: ` : "";
    return fail(400, "INVALID_INPUT", `${where}${issue?.message ?? "Invalid input."}`, false);
  }

  const ctx: NodeContext<Env> = {
    env: c.env,
    runId,
    nodeRunId,
    attempt,
    idempotencyKey: c.req.header("Idempotency-Key") ?? nodeRunId,
    vars: envelope.data.context?.vars ?? {},
    run: envelope.data.run ?? {},
  };

  try {
    const output = outputSchema.parse(await execute(input.data, ctx));
    log("succeeded");
    return c.json({ output });
  } catch (error) {
    if (error instanceof NodeError) return fail(error.status, error.code, error.message, error.retryable);
    if (error instanceof z.ZodError) {
      // The node returned something its own output schema rejects: a bug, not worth a retry.
      return fail(500, "INVALID_OUTPUT", "The node produced an output that does not match its schema.", false);
    }
    console.error(error);
    return fail(500, "INTERNAL", "The node failed unexpectedly.", true);
  }
});

app.notFound((c) => c.json(errorBody("NOT_FOUND", "Unknown route.", false), 404));

export default app;
