// The reader of workspace resources, with the broker replaced by a function.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execute } from "./node";
import { NodeError, type NodeContext } from "./protocol";
import { createResourceReader, type ResourceEnv } from "./resources";

const TOKEN = `xrb_${"A".repeat(43)}`;

function broker(answers: Record<string, { status: number; body: unknown }>): { env: ResourceEnv; calls: string[] } {
  const calls: string[] = [];
  const fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${path} ${new Headers(init?.headers).get("authorization")}`);
      const answer = answers[path] ?? { status: 403, body: { error: { code: "NOT_MAPPED", message: "Not mapped.", retryable: false } } };
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } });
    },
  } as unknown as Fetcher;
  return { env: { RESOURCE_BROKER: fetcher }, calls };
}

test("asks the broker with the run token and caches each answer for the call", async () => {
  const { env, calls } = broker({ "/v1/secrets/ECHO_SECRET": { status: 200, body: { value: "s3cr3t" } }, "/v1/variables/ECHO_VARIABLE": { status: 200, body: { value: "small" } } });
  const reader = createResourceReader({ env, token: TOKEN });
  assert.equal(await reader.getSecret("ECHO_SECRET"), "s3cr3t");
  assert.equal(await reader.getSecret("ECHO_SECRET"), "s3cr3t");
  assert.equal(await reader.getVariable("ECHO_VARIABLE"), "small");
  assert.deepEqual(calls, [`/v1/secrets/ECHO_SECRET Bearer ${TOKEN}`, `/v1/variables/ECHO_VARIABLE Bearer ${TOKEN}`]);
});

test("refusals of the broker become node errors; only a retryable one is retried", async () => {
  const { env } = broker({
    "/v1/secrets/MISSING": { status: 422, body: { error: { code: "SECRET_NOT_SET", message: "No value in staging.", retryable: false } } },
    "/v1/resources/sheet": { status: 503, body: { error: { code: "CONNECTION_EXPIRED", message: "Being renewed.", retryable: true } } },
  });
  const reader = createResourceReader({ env, token: TOKEN });
  await assert.rejects(reader.getSecret("MISSING"), (error: NodeError) => error.code === "SECRET_NOT_SET" && !error.retryable);
  await assert.rejects(reader.getSecret("OTHER"), (error: NodeError) => error.code === "NOT_MAPPED" && !error.retryable);
  await assert.rejects(reader.getResource("sheet"), (error: NodeError) => error.code === "CONNECTION_EXPIRED" && error.retryable);
  await assert.rejects(createResourceReader({ env: {}, token: TOKEN }).getSecret("X"), (error: NodeError) => error.code === "CONFIG_UNAVAILABLE");
  await assert.rejects(createResourceReader({ env, token: null }).getSecret("X"), (error: NodeError) => error.code === "CONFIG_UNAVAILABLE");
});

test("echo returns the chosen variable, the sheet's name, and only whether the secret and the connection could be read", async () => {
  const { env } = broker({
    "/v1/variables/ECHO_VARIABLE": { status: 200, body: { value: "small" } },
    "/v1/secrets/ECHO_SECRET": { status: 200, body: { value: "s3cr3t" } },
    "/v1/resources/ECHO_CONNECTION": { status: 200, body: { resource: { kind: "connection", connection: { id: "c", provider: "google", name: "Google – Marketing", account: "a@x", externalId: "u1", credentials: { access_token: "ya29" } } } } },
    "/v1/resources/ECHO_FILE": { status: 200, body: { resource: { kind: "google.file", connection: { id: "c", provider: "google", name: "Google – Marketing", account: "a@x", externalId: "u1", credentials: { access_token: "ya29" } }, item: { id: "f", kind: "sheet", label: "Leads" } } } },
  });
  const reader = createResourceReader({ env, token: TOKEN });
  const ctx: NodeContext<ResourceEnv> = { env, runId: "r", nodeRunId: "n", attempt: 1, idempotencyKey: "n", run: { env: "staging" }, ...reader };
  const output = await execute({ read_variable: true, check_secret: true, check_connection: true, check_file: true }, ctx);
  assert.equal(output.variable, "small");
  assert.equal(output.secret, true);
  assert.deepEqual(output.connection, { provider: "google", name: "Google – Marketing", external_id: "u1" });
  assert.deepEqual(output.file, { id: "f", kind: "sheet", label: "Leads", connection: "Google – Marketing" });
  assert.ok(!JSON.stringify(output).includes("s3cr3t") && !JSON.stringify(output).includes("ya29"));
});

test("echo writes a file into its folder, reads it back and lists it, through the broker", async () => {
  const stored = new Map<string, string>();
  const fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.searchParams.get("path") ?? "";
      if (url.pathname === "/v1/files/ECHO_FOLDER" && init?.method === "PUT") {
        const text = await new Response(init.body).text();
        const replaced = stored.has(path);
        stored.set(path, text);
        return Response.json({ file: { path, workspace_path: `out/${path}`, name: path, size: text.length, mime_type: "application/json", replaced } });
      }
      if (url.pathname === "/v1/files/ECHO_FOLDER/list") return Response.json({ files: [...stored.keys()].map((key) => ({ path: key })) });
      if (url.pathname === "/v1/files/ECHO_FOLDER") {
        const text = stored.get(path);
        return text === undefined ? Response.json({ error: { code: "FILE_NOT_FOUND", message: "No file.", retryable: false } }, { status: 404 }) : new Response(text, { headers: { "X-XAAS-File": JSON.stringify({ path, size: text.length }) } });
      }
      return Response.json({ error: { code: "NOT_MAPPED" } }, { status: 403 });
    },
  } as unknown as Fetcher;
  const env = { RESOURCE_BROKER: fetcher };
  const ctx: NodeContext<ResourceEnv> = { env, runId: "r", nodeRunId: "n", attempt: 1, idempotencyKey: "n", run: { env: "staging" }, ...createResourceReader({ env, token: TOKEN }) };
  const output = await execute({ write_file: "a.json", read_file: "a.json", list_files: true, note: "hi" }, ctx);
  assert.equal(output.written?.replaced, false);
  assert.equal(output.read?.path, "a.json");
  assert.ok(output.read?.text.includes('"note": "hi"'));
  assert.deepEqual(output.listed, ["a.json"]);
  await assert.rejects(ctx.readFile("ECHO_FOLDER", "missing.json"), (error: NodeError) => error.code === "FILE_NOT_FOUND" && !error.retryable);
});
