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

export type ConfigReader = {
  /** The secret `name` in the environment of the run. Throws `SECRET_NOT_SET` (not retried) when it has no value there. */
  getSecret(name: string): Promise<string>;
  /** The variable `name` in the environment of the run. Throws `VARIABLE_NOT_SET` (not retried) when it has no value there. */
  getVariable(name: string): Promise<string>;
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

/** A reader for one call. Values are cached for the call only. */
export function createConfigReader(params: { env: ConfigEnv; run: { workspace?: string; env?: string }; query?: ValueQuery }): ConfigReader {
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

  return {
    async getVariable(name) {
      const stored = await load(name);
      if (!stored || stored.kind !== "variable") throw new NodeError("VARIABLE_NOT_SET", `Variable ${name} has no value in ${run.env}.`, { status: 422, retryable: false });
      return stored.value;
    },
    async getSecret(name) {
      const stored = await load(name);
      if (!stored || stored.kind !== "secret") throw new NodeError("SECRET_NOT_SET", `Secret ${name} has no value in ${run.env}.`, { status: 422, retryable: false });
      if (!env.SECRETS_ENCRYPTION_KEY) throw new NodeError("CONFIG_UNAVAILABLE", "This node cannot decrypt secrets: SECRETS_ENCRYPTION_KEY is not set on its Worker.", { status: 500, retryable: false });
      keys ??= Promise.all([env.SECRETS_ENCRYPTION_KEY, env.SECRETS_ENCRYPTION_KEY_PREVIOUS].filter((key): key is string => Boolean(key)).map(importSecretKey));
      try {
        return await decryptSecretValue(stored.value, await keys);
      } catch {
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
