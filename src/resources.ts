// Secrets, variables and connections of the workspace, read through xaas-resource-broker. Protocol plumbing: copy unchanged
// into a new node. The node gets only what the person mapped to it in the workflow (the `requires` of its manifest), in
// the environment of the run, during this attempt. Values never travel in the request; the node holds no database
// access and no key. The Worker needs the service binding RESOURCE_BROKER (wrangler.jsonc).
// Never put a secret or a token in the output, an error message or a log line.

import { NodeError } from "./protocol";

/** What every node Worker needs to read workspace resources. */
export type ResourceEnv = { RESOURCE_BROKER?: Fetcher };

export type ConnectionResource = { id: string; kind: string; label: string; sub?: string };

/** A connection of the workspace (Facebook Page, Google account, Slack workspace, Telegram bot) with its tokens. */
export type Connection = {
  provider: string;
  name: string;
  /** The account on the service: Page id, Google user id, Slack team id, bot id. */
  externalId: string;
  resources: ConnectionResource[];
  /** The provider's tokens: `page_access_token` (Facebook Page), `access_token` (Google), `bot_token` (Slack, Telegram). */
  credentials: Record<string, string>;
};

export type ResourceReader = {
  /** The secret mapped to `name` (a name of `requires.secrets`), in the environment of the run. */
  getSecret(name: string): Promise<string>;
  /** The variable mapped to `name` (a name of `requires.variables`). */
  getVariable(name: string): Promise<string>;
  /** The connection mapped to `name` (a name of `requires.connections`), with working tokens. */
  getConnection(name: string): Promise<Connection>;
};

type BrokerError = { error?: { code?: string; message?: string; retryable?: boolean } };

/** A reader for one call: `token` is the run token of the request (X-XAAS-Resource-Token). Answers are cached for the call. */
export function createResourceReader(params: { env: ResourceEnv; token: string | null }): ResourceReader {
  const cache = new Map<string, Promise<unknown>>();

  async function ask<T>(kind: "secrets" | "variables" | "connections", name: string): Promise<T> {
    const broker = params.env.RESOURCE_BROKER;
    if (!broker) throw new NodeError("CONFIG_UNAVAILABLE", "This node cannot read workspace resources: the RESOURCE_BROKER binding is missing.", { status: 500, retryable: false });
    if (!params.token) throw new NodeError("CONFIG_UNAVAILABLE", "The request has no run token, so workspace resources cannot be read.", { status: 500, retryable: false });
    const key = `${kind}/${name}`;
    let answer = cache.get(key) as Promise<T> | undefined;
    if (!answer) {
      answer = (async () => {
        let response: Response;
        try {
          response = await broker.fetch(`https://resource-broker/v1/${kind}/${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${params.token}` } });
        } catch {
          throw new NodeError("BROKER_UNAVAILABLE", "The resource broker did not answer.", { status: 503, retryable: true });
        }
        const body = (await response.json().catch(() => null)) as (T & BrokerError) | null;
        if (!response.ok || !body) {
          const error = body?.error;
          throw new NodeError(error?.code ?? "BROKER_ERROR", error?.message ?? `The resource broker answered ${response.status}.`, {
            status: response.status >= 500 ? response.status : 422,
            retryable: error?.retryable ?? response.status >= 500,
          });
        }
        return body;
      })();
      cache.set(key, answer);
    }
    return answer;
  }

  return {
    getSecret: async (name) => (await ask<{ value: string }>("secrets", name)).value,
    getVariable: async (name) => (await ask<{ value: string }>("variables", name)).value,
    getConnection: async (name) => (await ask<{ connection: Connection }>("connections", name)).connection,
  };
}
