// The reader of workspace secrets and variables, with the database replaced by a map.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execute } from "./node";
import { NodeError, type NodeContext } from "./protocol";
import { createConfigReader, decryptSecretValue, importSecretKey, type ValueQuery } from "./secrets";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const RUN = { workspace: "00000000-0000-4000-8000-000000000001", env: "staging" };

/** Encrypts like the app (lib/secrets/utils/secret-cipher.ts) to prove both sides agree on the format. */
async function encryptLikeTheApp(plain: string): Promise<string> {
  const { id } = await importSecretKey(KEY);
  const raw = Uint8Array.from(atob(KEY), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  return `v1:${id}:${b64url(iv)}:${b64url(cipher)}`;
}

function store(values: Record<string, { kind: "secret" | "variable"; value: string }>): { query: ValueQuery; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    query: async (workspaceId, name, environment) => {
      calls.push(`${workspaceId}/${environment}/${name}`);
      return values[`${environment}/${name}`] ?? null;
    },
  };
}

test("reads a variable and decrypts a secret of the run's environment, once per call", async () => {
  const { query, calls } = store({ "staging/MODEL": { kind: "variable", value: "small" }, "staging/API_KEY": { kind: "secret", value: await encryptLikeTheApp("sk_test_1") } });
  const reader = createConfigReader({ env: { SECRETS_ENCRYPTION_KEY: KEY }, run: RUN, query });
  assert.equal(await reader.getVariable("MODEL"), "small");
  assert.equal(await reader.getSecret("API_KEY"), "sk_test_1");
  assert.equal(await reader.getSecret("API_KEY"), "sk_test_1");
  assert.deepEqual(calls, [`${RUN.workspace}/staging/MODEL`, `${RUN.workspace}/staging/API_KEY`]);
});

test("a missing value, or the wrong kind, fails without a retry", async () => {
  const { query } = store({ "staging/MODEL": { kind: "variable", value: "small" } });
  const reader = createConfigReader({ env: { SECRETS_ENCRYPTION_KEY: KEY }, run: RUN, query });
  await assert.rejects(reader.getSecret("NOPE"), (error: NodeError) => error.code === "SECRET_NOT_SET" && error.retryable === false && error.message.includes("staging"));
  await assert.rejects(reader.getSecret("MODEL"), (error: NodeError) => error.code === "SECRET_NOT_SET");
  await assert.rejects(reader.getVariable("NOPE"), (error: NodeError) => error.code === "VARIABLE_NOT_SET");
});

test("without the key or the run's workspace the node says what is missing, never the value", async () => {
  const stored = await encryptLikeTheApp("sk_test_2");
  const { query } = store({ "staging/API_KEY": { kind: "secret", value: stored } });
  const noKey = createConfigReader({ env: {}, run: RUN, query });
  await assert.rejects(noKey.getSecret("API_KEY"), (error: NodeError) => error.code === "CONFIG_UNAVAILABLE" && error.message.includes("SECRETS_ENCRYPTION_KEY"));
  const wrongKey = createConfigReader({ env: { SECRETS_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))) }, run: RUN, query });
  await assert.rejects(wrongKey.getSecret("API_KEY"), (error: NodeError) => error.code === "SECRET_UNREADABLE" && !error.message.includes(stored));
  const noRun = createConfigReader({ env: { SECRETS_ENCRYPTION_KEY: KEY }, run: {}, query });
  await assert.rejects(noRun.getVariable("MODEL"), (error: NodeError) => error.code === "CONFIG_UNAVAILABLE");
  await assert.rejects(decryptSecretValue("v0:x", [await importSecretKey(KEY)]), /Unknown secret format/);
});

test("echo returns the variables asked for and only whether each secret could be read", async () => {
  const { query } = store({ "staging/MODEL": { kind: "variable", value: "small" }, "staging/API_KEY": { kind: "secret", value: await encryptLikeTheApp("sk_test_3") } });
  const reader = createConfigReader({ env: { SECRETS_ENCRYPTION_KEY: KEY }, run: RUN, query });
  const ctx: NodeContext<Record<string, never>> = { env: {}, runId: "r", nodeRunId: "n", attempt: 1, idempotencyKey: "n", run: RUN, ...reader };
  const output = await execute({ read_variables: ["MODEL"], check_secrets: ["API_KEY"] }, ctx);
  assert.deepEqual(output.variables, { MODEL: "small" });
  assert.deepEqual(output.secrets, { API_KEY: true });
  assert.equal(output.env, "staging");
  assert.ok(!JSON.stringify(output).includes("sk_test_3"));
});
