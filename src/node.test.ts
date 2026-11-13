// Tests call the Worker the way the runner does, without a network or wrangler.

import assert from "node:assert/strict";
import { test } from "node:test";
import app from "./index";
import { manifest } from "./node";

const HEADERS = {
  "Content-Type": "application/json",
  "X-XaaS-Run-Id": "run-1",
  "X-XaaS-Node-Run-Id": "node-run-1",
  "X-XaaS-Attempt": "2",
  "Idempotency-Key": "node-run-1",
};

function call(body: unknown) {
  return app.request("/", { method: "POST", headers: HEADERS, body: JSON.stringify(body) }, {});
}

test("POST / returns the input and the attempt number", async () => {
  const response = await call({ input: { text: "hello", nested: { a: 1 } } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { output: { echo: { text: "hello", nested: { a: 1 } }, attempt: 2 } });
});

test("POST / without input treats it as an empty object", async () => {
  const response = await call({});
  assert.deepEqual(await response.json(), { output: { echo: {}, attempt: 2 } });
});

test("POST / rejects an input that breaks the schema, without asking for a retry", async () => {
  const response = await call({ input: { fail_with: "soon" } });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string; message: string; retryable: boolean } };
  assert.equal(body.error.code, "INVALID_INPUT");
  assert.equal(body.error.retryable, false);
  assert.match(body.error.message, /^input\.fail_with: /);
});

test("POST / rejects a body that is not a node request", async () => {
  const response = await app.request("/", { method: "POST", headers: HEADERS, body: "not json" }, {});
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "INVALID_REQUEST");
});

test("a NodeError becomes an error body; 5xx is retryable, 4xx is not", async () => {
  const unavailable = await call({ input: { fail_with: 503 } });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    error: { code: "SIMULATED_FAILURE", message: "Asked to fail with 503.", retryable: true },
  });

  const badRequest = await call({ input: { fail_with: 400 } });
  assert.equal(badRequest.status, 400);
  assert.equal(((await badRequest.json()) as { error: { retryable: boolean } }).error.retryable, false);
});

test("GET /health reports the node and its version, and what it needs to read secrets", async () => {
  const response = await app.request("/health", {}, { RESOURCE_BROKER: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, key: manifest.key, version: manifest.version });

  const missing = await app.request("/health", {}, {});
  assert.equal(missing.status, 503);
  assert.match(((await missing.json()) as { detail: string }).detail, /RESOURCE_BROKER/);
});

test("GET /.well-known/xaas-node.json describes the node with JSON Schemas", async () => {
  const response = await app.request("/.well-known/xaas-node.json", {}, {});
  const body = (await response.json()) as Record<string, any>;
  assert.equal(body.key, "core.echo");
  assert.equal(body.version, "1.3.0");
  assert.equal(body.resources.find((resource: { kind: string }) => resource.kind === "secret").name, "ECHO_SECRET");
  assert.equal(body.retry.max_attempts, 3);
  assert.equal(body.input_schema.type, "object");
  assert.equal(body.input_schema.properties.fail_with.type, "integer");
  assert.deepEqual(body.output_schema.required, ["echo", "attempt"]);
});

test("the Worker name in wrangler.jsonc matches the manifest", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { resolve } = await import("node:path");
  const config = await readFile(resolve(fileURLToPath(import.meta.url), "../../wrangler.jsonc"), "utf8");
  const expected = `node-${manifest.key.replace(/[^a-z0-9]+/g, "-")}-v${manifest.version.replace(/\./g, "-")}`;
  assert.ok(config.includes(`"name": "${expected}"`), `wrangler.jsonc should name the Worker ${expected}`);
});

test("unknown routes answer 404 in the protocol's error shape", async () => {
  const response = await app.request("/nope", {}, {});
  assert.equal(response.status, 404);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "NOT_FOUND");
});
