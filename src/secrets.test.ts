// The reader of workspace secrets and variables, with the database replaced by a map.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execute } from "./node";
import { NodeError, type NodeContext } from "./protocol";
import { createConfigReader, decryptSecretValue, importSecretKey, type ConnectionQuery, type ValueQuery } from "./secrets";

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

test("reads a connection of the run's workspace with its decrypted tokens", async () => {
  const sealed = await encryptLikeTheApp(JSON.stringify({ page_access_token: "EAAB-page" }));
  const rows: Record<string, NonNullable<Awaited<ReturnType<ConnectionQuery>>>> = {
    "11111111-1111-4111-8111-111111111111": { provider: "facebook-page", name: "ACME Page", external_id: "123", resources: [{ id: "123", kind: "page", label: "ACME Page" }], credentials: sealed, status: "healthy", access_expires_at: null },
    "22222222-2222-4222-8222-222222222222": { provider: "google", name: "Google", external_id: "u1", resources: [], credentials: sealed, status: "error", access_expires_at: null },
    "33333333-3333-4333-8333-333333333333": { provider: "google", name: "Google 2", external_id: "u2", resources: [], credentials: sealed, status: "healthy", access_expires_at: new Date(Date.now() - 1000).toISOString() },
  };
  const seen: string[] = [];
  const connectionQuery: ConnectionQuery = async (workspaceId, id) => {
    seen.push(workspaceId);
    return rows[id] ?? null;
  };
  const reader = createConfigReader({ env: { SECRETS_ENCRYPTION_KEY: KEY }, run: RUN, connectionQuery });
  const connection = await reader.getConnection("11111111-1111-4111-8111-111111111111");
  assert.deepEqual(connection.credentials, { page_access_token: "EAAB-page" });
  assert.equal(connection.externalId, "123");
  assert.ok(seen.every((id) => id === RUN.workspace), "always scoped to the run's workspace");
  await assert.rejects(reader.getConnection("22222222-2222-4222-8222-222222222222"), (error: NodeError) => error.code === "CONNECTION_REVOKED" && !error.retryable);
  await assert.rejects(reader.getConnection("33333333-3333-4333-8333-333333333333"), (error: NodeError) => error.code === "CONNECTION_EXPIRED" && error.retryable);
  await assert.rejects(reader.getConnection("44444444-4444-4444-8444-444444444444"), (error: NodeError) => error.code === "CONNECTION_NOT_FOUND");
  await assert.rejects(reader.getConnection("not-an-id"), (error: NodeError) => error.code === "CONNECTION_NOT_FOUND");
});
