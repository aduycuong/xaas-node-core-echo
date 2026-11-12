// Secrets and variables of the workspace, read by name in the environment of the run. Protocol
// plumbing: copy unchanged into a new node. The Worker needs two secrets (set by `npm run nodes:deploy`
// in the app repo): DATABASE_URL and SECRETS_ENCRYPTION_KEY, the same key as the app's.
//
// Values are never part of the request: the runner only sends `run.workspace` and `run.env`.
// Never put a secret in the output, an error message or a log line.

import { neon } from "@neondatabase/serverless";
import { NodeError } from "./protocol";

/** What every node Worker needs to read secrets and variables. */
export type ConfigEnv = {
  DATABASE_URL?: string;
  SECRETS_ENCRYPTION_KEY?: string;
  /** While the key is being rotated: the old key, still able to decrypt. */
  SECRETS_ENCRYPTION_KEY_PREVIOUS?: string;
};

type StoredValue = { kind: "secret" | "variable"; value: string };
/** Reads one stored value; replaced in tests. */
export type ValueQuery = (workspaceId: string, name: string, environment: string) => Promise<StoredValue | null>;

type StoredConnection = { provider: string; name: string; external_id: string; resources: ConnectionResource[]; credentials: string; status: string; access_expires_at: string | null };
/** Reads one connection of the workspace; replaced in tests. */
export type ConnectionQuery = (workspaceId: string, connectionId: string) => Promise<StoredConnection | null>;

export type ConnectionResource = { id: string; kind: string; label: string; sub?: string };

/** A connection of the workspace (a Facebook Page, a Google account, a Slack workspace, a Telegram bot) with its tokens. */
export type Connection = {
  provider: string;
  name: string;
  /** The account on the service: Page id, Google user id, Slack team id, bot id. */
  externalId: string;
  resources: ConnectionResource[];
  /** The provider's tokens: `page_access_token` (Facebook Page), `access_token` (Google), `bot_token` (Slack, Telegram). Never log or return them. */
  credentials: Record<string, string>;
};

export type ConfigReader = {
  /** The secret `name` in the environment of the run. Throws `SECRET_NOT_SET` (not retried) when it has no value there. */
  getSecret(name: string): Promise<string>;
  /** The variable `name` in the environment of the run. Throws `VARIABLE_NOT_SET` (not retried) when it has no value there. */
  getVariable(name: string): Promise<string>;
  /**
   * A connection of the workspace by id, with working tokens (the app renews them before they end). Throws
   * `CONNECTION_NOT_FOUND` / `CONNECTION_REVOKED` (not retried) or `CONNECTION_EXPIRED` (retried: a renewal is on its way).
   */
  getConnection(connectionId: string): Promise<Connection>;
};

function databaseQuery(databaseUrl: string): ValueQuery {
  const sql = neon(databaseUrl);
  return async (workspaceId, name, environment) => {
    const rows = (await sql`
      select v.kind, vv.value from variables v
      join variable_values vv on vv.variable_id = v.id and vv.environment = ${environment}
      where v.workspace_id = ${workspaceId}::uuid and v.name = ${name}
      limit 1`) as unknown as StoredValue[];
    return rows[0] ?? null;
  };
}

function databaseConnectionQuery(databaseUrl: string): ConnectionQuery {
  const sql = neon(databaseUrl);
  return async (workspaceId, connectionId) => {
    const rows = (await sql`
      select provider, name, external_id, resources, credentials, status, access_expires_at from connections
      where id = ${connectionId}::uuid and workspace_id = ${workspaceId}::uuid limit 1`) as unknown as StoredConnection[];
    return rows[0] ?? null;
  };
}

/** A reader for one call. Values are cached for the call only. */
export function createConfigReader(params: { env: ConfigEnv; run: { workspace?: string; env?: string }; query?: ValueQuery; connectionQuery?: ConnectionQuery }): ConfigReader {
  const { env, run } = params;
  const cache = new Map<string, Promise<StoredValue | null>>();
  let keys: Promise<SecretKey[]> | null = null;

  function load(name: string): Promise<StoredValue | null> {
    if (!run.workspace || !run.env) throw new NodeError("CONFIG_UNAVAILABLE", "The request has no workspace or environment, so secrets and variables cannot be read.", { status: 500, retryable: false });
    const query = params.query ?? (env.DATABASE_URL ? databaseQuery(env.DATABASE_URL) : null);
    if (!query) throw new NodeError("CONFIG_UNAVAILABLE", "This node cannot read secrets and variables: DATABASE_URL is not set on its Worker.", { status: 500, retryable: false });
    let found = cache.get(name);
    if (!found) {
      found = query(run.workspace, name, run.env);
      cache.set(name, found);
    }
    return found;
  }

  async function decrypt(stored: string): Promise<string> {
    if (!env.SECRETS_ENCRYPTION_KEY) throw new NodeError("CONFIG_UNAVAILABLE", "This node cannot decrypt secrets: SECRETS_ENCRYPTION_KEY is not set on its Worker.", { status: 500, retryable: false });
    keys ??= Promise.all([env.SECRETS_ENCRYPTION_KEY, env.SECRETS_ENCRYPTION_KEY_PREVIOUS].filter((key): key is string => Boolean(key)).map(importSecretKey));
    return decryptSecretValue(stored, await keys);
  }

  return {
    async getConnection(connectionId) {
      if (!run.workspace) throw new NodeError("CONFIG_UNAVAILABLE", "The request has no workspace, so connections cannot be read.", { status: 500, retryable: false });
      if (!/^[0-9a-f-]{36}$/i.test(connectionId)) throw new NodeError("CONNECTION_NOT_FOUND", "Choose a connection for this node.", { status: 422, retryable: false });
      const query = params.connectionQuery ?? (env.DATABASE_URL ? databaseConnectionQuery(env.DATABASE_URL) : null);
      if (!query) throw new NodeError("CONFIG_UNAVAILABLE", "This node cannot read connections: DATABASE_URL is not set on its Worker.", { status: 500, retryable: false });
      const row = await query(run.workspace, connectionId);
      if (!row) throw new NodeError("CONNECTION_NOT_FOUND", "The connection of this node was disconnected. Choose another one.", { status: 422, retryable: false });
      if (row.status === "error") throw new NodeError("CONNECTION_REVOKED", `Connection "${row.name}" no longer works. Reconnect it on the Connections page.`, { status: 422, retryable: false });
      // The app renews tokens ahead of time; one that already ended means a renewal is late, so the runner tries again.
      if (row.access_expires_at && Date.parse(row.access_expires_at) <= Date.now() + 60_000) {
        throw new NodeError("CONNECTION_EXPIRED", `The token of connection "${row.name}" ended and is being renewed.`, { status: 503, retryable: true });
      }
      let credentials: Record<string, string>;
      try {
        credentials = JSON.parse(await decrypt(row.credentials)) as Record<string, string>;
      } catch (error) {
        if (error instanceof NodeError) throw error;
        throw new NodeError("CONNECTION_UNREADABLE", `Connection "${row.name}" cannot be decrypted with this Worker's key.`, { status: 500, retryable: false });
      }
      return { provider: row.provider, name: row.name, externalId: row.external_id, resources: row.resources ?? [], credentials };
    },
    async getVariable(name) {
      const stored = await load(name);
      if (!stored || stored.kind !== "variable") throw new NodeError("VARIABLE_NOT_SET", `Variable ${name} has no value in ${run.env}.`, { status: 422, retryable: false });
      return stored.value;
    },
    async getSecret(name) {
      const stored = await load(name);
      if (!stored || stored.kind !== "secret") throw new NodeError("SECRET_NOT_SET", `Secret ${name} has no value in ${run.env}.`, { status: 422, retryable: false });
      try {
        return await decrypt(stored.value);
      } catch (error) {
        if (error instanceof NodeError) throw error;
        // Never include the stored value or the cause.
        throw new NodeError("SECRET_UNREADABLE", `Secret ${name} cannot be decrypted with this Worker's key.`, { status: 500, retryable: false });
      }
    },
  };
}

// --- Decryption. Same format as the app (lib/secrets/utils/secret-cipher.ts): `v1:<key id>:<iv>:<ciphertext>`. ---

type SecretKey = { id: string; key: CryptoKey };

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
const fromBase64Url = (text: string) => fromBase64(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A key given as 32 random bytes in base64; its id is the first 8 characters of its SHA-256 in base64url. */
export async function importSecretKey(keyBase64: string): Promise<SecretKey> {
  const raw = fromBase64(keyBase64.trim());
  if (raw.length !== 32) throw new Error("A secrets encryption key must be 32 bytes, base64 encoded.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  return { id: toBase64Url(digest).slice(0, 8), key };
}

export async function decryptSecretValue(stored: string, keys: SecretKey[]): Promise<string> {
  const [format, keyId, iv, cipher] = stored.split(":");
  if (format !== "v1" || !keyId || !iv || !cipher) throw new Error("Unknown secret format.");
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) throw new Error("No configured key made this value.");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, key.key, fromBase64Url(cipher));
  return new TextDecoder().decode(plain);
}
