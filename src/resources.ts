// Secrets, variables, connections and their items (files, folders, channels, chats, Pages) of the workspace, read through
// xaas-resource-broker. Protocol plumbing: copy unchanged into a new node. The node gets only what the person chose for it
// in the workflow (the `resources` of its manifest), in the environment of the run, during this attempt. Values never
// travel in the request; the node holds no database access and no key. The Worker needs the service binding
// RESOURCE_BROKER (wrangler.jsonc).
// Never put a secret or a token in the output, an error message or a log line.

import { NodeError } from "./protocol";

/** What every node Worker needs to read workspace resources. */
export type ResourceEnv = { RESOURCE_BROKER?: Fetcher };

/** A connection of the workspace (Facebook Page, Google account, Slack workspace, Telegram bot) with its tokens. */
export type Connection = {
  id: string;
  provider: string;
  name: string;
  /** Who or what is connected, as shown to people (email, Page name, bot name). */
  account: string | null;
  /** The account on the service: Page id, Google user id, Slack team id, bot id. */
  externalId: string;
  /** The provider's tokens: `page_access_token` (Facebook Page), `access_token` (Google), `bot_token` (Slack, Telegram). */
  credentials: Record<string, string>;
};

/** The file, folder, channel, chat or Page chosen in a connection. `kind`: sheet, doc, slides, file, folder, channel, chat, page. */
export type ResourceItem = { id: string; kind: string; label: string; sub?: string };

/** A resource of kind `connection` (no item) or an item of a connection (`google.file`, `slack.channel`…). */
export type Resource = { kind: string; connection: Connection; item?: ResourceItem };

/** A workspace file as the broker describes it: `path` is inside the chosen folder (the name, for a chosen file). */
export type WorkspaceFile = { path: string; workspace_path: string; name: string; size: number; mime_type: string };

/** What `writeFile` accepts: a stream (pass `size` when known, else it is written in parts), bytes or text. */
export type FileBody = ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string;

export type ResourceReader = {
  /** The secret chosen for `name` (a `secret` of the manifest's `resources`), in the environment of the run. */
  getSecret(name: string): Promise<string>;
  /** The variable chosen for `name` (a `variable` of `resources`). */
  getVariable(name: string): Promise<string>;
  /** The connection or item chosen for `name` (any other kind of `resources`), with working tokens. */
  getResource(name: string): Promise<Resource>;
  /** Streams a workspace file: the one chosen for an `r2.file` resource, or `path` inside the folder chosen for an `r2.folder` one. */
  readFile(name: string, path?: string): Promise<{ file: WorkspaceFile; body: ReadableStream<Uint8Array> }>;
  /** Files inside the folder chosen for an `r2.folder` resource (and its subfolders), newest first. */
  listFiles(name: string, options?: { prefix?: string }): Promise<WorkspaceFile[]>;
  /** Writes `path` inside the folder chosen for an `r2.folder` resource; a file of that name gets new content. */
  writeFile(name: string, path: string, body: FileBody, options?: { contentType?: string; size?: number }): Promise<WorkspaceFile & { replaced: boolean }>;
};

type BrokerError = { error?: { code?: string; message?: string; retryable?: boolean } };

/** A reader for one call: `token` is the run token of the request (X-XAAS-Resource-Token). Answers are cached for the call. */
export function createResourceReader(params: { env: ResourceEnv; token: string | null }): ResourceReader {
  const cache = new Map<string, Promise<unknown>>();

  async function ask<T>(kind: "secrets" | "variables" | "resources", name: string): Promise<T> {
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

  /** One call to the broker for files (no cache: contents are streams, and writes change what a read returns). */
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const broker = params.env.RESOURCE_BROKER;
    if (!broker) throw new NodeError("CONFIG_UNAVAILABLE", "This node cannot read workspace resources: the RESOURCE_BROKER binding is missing.", { status: 500, retryable: false });
    if (!params.token) throw new NodeError("CONFIG_UNAVAILABLE", "The request has no run token, so workspace resources cannot be read.", { status: 500, retryable: false });
    let response: Response;
    try {
      response = await broker.fetch(`https://resource-broker${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${params.token}` } });
    } catch {
      throw new NodeError("BROKER_UNAVAILABLE", "The resource broker did not answer.", { status: 503, retryable: true });
    }
    if (!response.ok) {
      const error = ((await response.json().catch(() => null)) as BrokerError | null)?.error;
      throw new NodeError(error?.code ?? "BROKER_ERROR", error?.message ?? `The resource broker answered ${response.status}.`, { status: response.status >= 500 ? response.status : 422, retryable: error?.retryable ?? response.status >= 500 });
    }
    return response;
  }
  const query = (values: Record<string, string | undefined>) => {
    const search = new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
    return search.size ? `?${search}` : "";
  };

  return {
    readFile: async (name, path) => {
      const response = await call(`/v1/files/${encodeURIComponent(name)}${query({ path })}`);
      if (!response.body) throw new NodeError("FILE_NOT_FOUND", `The broker sent no content for "${path ?? name}".`, { status: 422 });
      return { file: JSON.parse(response.headers.get("X-XAAS-File") ?? "{}") as WorkspaceFile, body: response.body };
    },
    listFiles: async (name, options) => ((await (await call(`/v1/files/${encodeURIComponent(name)}/list${query({ prefix: options?.prefix })}`)).json()) as { files: WorkspaceFile[] }).files,
    writeFile: async (name, path, body, options) => {
      const headers: Record<string, string> = { "Content-Type": options?.contentType ?? (typeof body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream") };
      let payload: BodyInit;
      if (body instanceof ReadableStream) {
        // A stream with a known size goes in one put; without, the broker writes it in parts.
        if (options?.size !== undefined) {
          const fixed = new FixedLengthStream(options.size);
          void body.pipeTo(fixed.writable);
          payload = fixed.readable;
          headers["Content-Length"] = String(options.size);
        } else payload = body;
      } else {
        const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body instanceof ArrayBuffer ? new Uint8Array(body) : body;
        payload = bytes;
        headers["Content-Length"] = String(bytes.byteLength);
      }
      const response = await call(`/v1/files/${encodeURIComponent(name)}${query({ path })}`, { method: "PUT", headers, body: payload });
      return ((await response.json()) as { file: WorkspaceFile & { replaced: boolean } }).file;
    },
    getSecret: async (name) => (await ask<{ value: string }>("secrets", name)).value,
    getVariable: async (name) => (await ask<{ value: string }>("variables", name)).value,
    getResource: async (name) => (await ask<{ resource: Resource }>("resources", name)).resource,
  };
}
