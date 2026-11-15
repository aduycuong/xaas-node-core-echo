// Protocol plumbing: the same in every node. The node itself is in `node.ts`.
//
//   POST /                           run the node            (called by the runner)
//   GET  /status/:job                state of a job          (polling nodes: `status` in node.ts)
//   POST /callback                   read a callback body    (callback nodes with `callback_handler`: `readCallback` in node.ts)
//   GET  /health                     is the node able to work
//   GET  /.well-known/xaas-node.json manifest: identity, settings, input and output schemas
//
// A node has no public URL, routes or cron triggers of its own: it is reached only through the
// runner's service binding, so it can move to a dispatch namespace later without a change.

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import * as node from "./node";
import { isAccepted, NodeError, type JobStatus, type NodeContext } from "./protocol";
import { createResourceReader } from "./resources";

type Env = node.Env;
const { checkHealth, execute, inputSchema, manifest, outputSchema } = node;

/** Optional parts of `node.ts` for async nodes. */
type AsyncHooks = {
  /** Polling nodes: the state of the job `jobId` (from the `status_url` the node gave with its 202). */
  status(jobId: string, ctx: NodeContext<Env>): Promise<JobStatus<unknown>>;
  /** Callback nodes with `callback_handler`: turns what the service posted into the output, or throws `NodeError`. */
  readCallback(callback: { job_id: string | null; payload: unknown; headers: Record<string, string>; input: unknown }, ctx: NodeContext<Env>): Promise<unknown>;
};
const hooks = node as unknown as Partial<AsyncHooks>;

const envelopeSchema = z.object({
  input: z.unknown().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  run: z
    .object({ id: z.string(), workspace: z.string(), workflow: z.string(), version: z.int(), env: z.string() })
    .partial()
    .optional(),
  callback_url: z.string().optional(),
});

function errorBody(code: string, message: string, retryable: boolean) {
  return { error: { code, message, retryable } };
}

type AppContext = Context<{ Bindings: Env }>;

/** One JSON line per call, with the ids that tie it to a run. Never log secrets or whole inputs. */
function logger(c: AppContext, route: string) {
  const started = Date.now();
  const runId = c.req.header("X-XaaS-Run-Id") ?? "";
  const nodeRunId = c.req.header("X-XaaS-Node-Run-Id") ?? "";
  const attempt = Number(c.req.header("X-XaaS-Attempt") ?? "1") || 1;
  return (outcome: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ node: manifest.key, version: manifest.version, route, runId, nodeRunId, attempt, outcome, ms: Date.now() - started, ...extra }));
}

/** The context `execute`, `status` and `readCallback` get: the ids of the call and the readers of workspace resources. */
function contextOf(c: AppContext, run: NodeContext<Env>["run"], callbackUrl?: string): NodeContext<Env> {
  const nodeRunId = c.req.header("X-XaaS-Node-Run-Id") ?? "";
  // The run token of this attempt: only the resource reader uses it, nothing logs or returns it.
  const config = createResourceReader({ env: c.env, token: c.req.header("X-XAAS-Resource-Token") ?? null });
  return {
    env: c.env,
    runId: c.req.header("X-XaaS-Run-Id") ?? "",
    nodeRunId,
    attempt: Number(c.req.header("X-XaaS-Attempt") ?? "1") || 1,
    idempotencyKey: c.req.header("Idempotency-Key") ?? nodeRunId,
    ...(callbackUrl ? { callbackUrl } : {}),
    run,
    getSecret: config.getSecret,
    getVariable: config.getVariable,
    getResource: config.getResource,
    readFile: config.readFile,
    listFiles: config.listFiles,
    writeFile: config.writeFile,
  };
}

/** Turns what the node threw into the protocol's error answer. */
function failure(c: AppContext, log: ReturnType<typeof logger>, error: unknown) {
  const fail = (status: number, code: string, message: string, retryable: boolean) => {
    log("failed", { code, status });
    return c.json(errorBody(code, message, retryable), status as ContentfulStatusCode);
  };
  if (error instanceof NodeError) return fail(error.status, error.code, error.message, error.retryable);
  if (error instanceof z.ZodError) {
    // The node returned something its own output schema rejects: a bug, not worth a retry.
    return fail(500, "INVALID_OUTPUT", "The node produced an output that does not match its schema.", false);
  }
  console.error(error);
  return fail(500, "INTERNAL", "The node failed unexpectedly.", true);
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
  const log = logger(c, "run");
  const envelope = envelopeSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!envelope.success) {
    log("failed", { code: "INVALID_REQUEST", status: 400 });
    return c.json(errorBody("INVALID_REQUEST", "The request body is not a XaaS node request.", false), 400);
  }
  const input = inputSchema.safeParse(envelope.data.input ?? {});
  if (!input.success) {
    const issue = input.error.issues[0];
    const where = issue?.path.length ? `input.${issue.path.join(".")}: ` : "";
    log("failed", { code: "INVALID_INPUT", status: 400 });
    return c.json(errorBody("INVALID_INPUT", `${where}${issue?.message ?? "Invalid input."}`, false), 400);
  }

  try {
    const result: unknown = await execute(input.data as never, contextOf(c, envelope.data.run ?? {}, envelope.data.callback_url));
    if (isAccepted(result)) {
      // An async node took the job: the result comes by callback or through the status route.
      log("accepted", { job: result.job_id });
      return c.json({ job_id: result.job_id, ...(result.status_url ? { status_url: result.status_url } : {}) }, 202);
    }
    const output = outputSchema.parse(result);
    log("succeeded");
    return c.json({ output });
  } catch (error) {
    return failure(c, log, error);
  }
});

app.get("/status/:job", async (c) => {
  if (!hooks.status) return c.json(errorBody("NOT_FOUND", "This node is not polled.", false), 404);
  const log = logger(c, "status");
  try {
    const state = await hooks.status(c.req.param("job"), contextOf(c, {}));
    if (state.status === "succeeded") return c.json({ status: "succeeded", output: outputSchema.parse(state.output) });
    log(state.status);
    return c.json(state);
  } catch (error) {
    return failure(c, log, error);
  }
});

app.post("/callback", async (c) => {
  if (!hooks.readCallback) return c.json(errorBody("NOT_FOUND", "This node does not read callbacks.", false), 404);
  const log = logger(c, "callback");
  const body = (await c.req.json().catch(() => null)) as { job_id?: string | null; payload?: unknown; headers?: Record<string, string>; input?: unknown } | null;
  if (!body) return c.json(errorBody("INVALID_REQUEST", "The request body is not a XaaS callback.", false), 400);
  try {
    const output = outputSchema.parse(
      await hooks.readCallback({ job_id: body.job_id ?? null, payload: body.payload ?? null, headers: body.headers ?? {}, input: body.input ?? {} }, contextOf(c, {})),
    );
    log("succeeded");
    return c.json({ output });
  } catch (error) {
    return failure(c, log, error);
  }
});

app.notFound((c) => c.json(errorBody("NOT_FOUND", "Unknown route.", false), 404));

export default app;
