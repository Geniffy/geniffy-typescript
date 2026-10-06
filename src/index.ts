/**
 * Geniffy for TypeScript and JavaScript: add notes, files and links to a memory, then search it and ask it.
 *
 *   import { Geniffy } from "geniffy";
 *   const g = new Geniffy();                       // reads GENIFFY_API_KEY
 *   await g.memories.add({ text: "Priya Nair signs the Lumen renewal, and it comes up in March." });
 *   const { answer } = await g.ask("Who signs the Lumen renewal?");
 *
 * No dependencies: the platform's fetch, FormData and Blob (Node 18+, Deno, Bun, edge runtimes).
 * Retries: reads, deletes and files.put (the same text twice is the same file) are retried on network errors,
 * 408, 429 and 5xx; adding is retried only on 429, so a retry never saves a note twice.
 */

export const VERSION = "0.3.0";
export const DEFAULT_BASE_URL = "https://api.geniffy.com";

export type Kind = "all" | "people" | "plan" | "pref" | "detail";

export interface SourceRef {
  id: string | null;
  kind: string;
  title: string;
  /** the labels on that source */
  labels?: Labels;
}

export interface Memory {
  id: number;
  text: string;
  /** people, plan, pref or detail */
  kind: string;
  about?: string | null;
  /** current, or clash when two memories disagree */
  status: string;
  learned_at?: string | null;
  said_at?: string | null;
  source?: SourceRef | null;
  /** the sentence it came from (on memories.get) */
  quote?: string | null;
}

export interface MemoryPage {
  memories: Memory[];
  counts: Record<string, number>;
  total: number;
  next: number | null;
}

export interface MemoryDetail {
  memory: Memory;
  history: Memory[];
}

export interface Source {
  id: string;
  kind: "note" | "file" | "link";
  title: string;
  status: "reading" | "learned" | "failed";
  /** why it failed, in plain words */
  error?: string | null;
  facts?: number | null;
  url?: string | null;
  file_name?: string | null;
  file_type?: string | null;
  size_bytes?: number | null;
  added_by?: string | null;
  added_at?: string | null;
  /** your own id for it, when you gave one */
  external_id?: string | null;
  /** your own name/value pairs on it */
  labels?: Labels;
}

/** A source's labels: your own name/value pairs, such as { channel: "email" }. */
export type Labels = Record<string, string>;
/** A filter by labels: every name must match, and a list of values is any one of them
 *  ({ channel: ["email", "chat"] }). */
export type LabelFilter = Record<string, string | string[]>;

/** A filter in a query string: label=name:value, once for each value. */
function labelQuery(labels?: LabelFilter): string[] | undefined {
  if (!labels) return undefined;
  return Object.entries(labels).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}:${x}`));
}

export interface SourcePage {
  sources: Source[];
  total: number;
  next: number | null;
}

export interface Answer {
  question: string;
  /** null when nothing you added supports an answer; `message` then says so */
  answer: string | null;
  message: string | null;
  memories: Memory[];
  clash: boolean;
}

export interface ClientOptions {
  /** Defaults to GENIFFY_API_KEY. */
  apiKey?: string;
  /** Defaults to GENIFFY_BASE_URL, then https://api.geniffy.com */
  baseURL?: string;
  /** Milliseconds per attempt. Default 60000. */
  timeout?: number;
  /** Default 2. */
  maxRetries?: number;
  /** Your own fetch (tests, proxies). */
  fetch?: typeof fetch;
  /**
   * One of YOUR users. Every call this client makes then reaches that user's memory alone, and no
   * other space can read it. Leave it out and the client reaches your own memory, the one the
   * Geniffy app shows you, which is what a personal script wants.
   *
   * You usually want `client.space(id)` instead: one client for the process, one bound client per
   * request, so a space can never be forgotten on a call.
   */
  space?: string | number;
  /** For a package built on this SDK: its own name and version ("geniffy-ai-sdk/0.1.0"), sent after the SDK's,
   *  so the Requests page shows which integration made each call. */
  integration?: string;
}

const INTEGRATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

// One of your users, by your own name for them: a string, or an integer id. A blank one is refused, not
// read as no space: a client with no space reads YOUR memory, so a user with no id would land in it.
function spaceName(space: unknown, what: string): string {
  const named = typeof space === "number" && Number.isSafeInteger(space) ? String(space) : space;
  if (typeof named !== "string") {
    throw new TypeError(`${what} takes your name for one of your users, a string or an integer id, not ` +
      `${named === null ? "null" : typeof named}.`);
  }
  const name = named.trim();
  if (!name) {
    throw new TypeError(`${what} got a blank space. A client with no space reads your own memory, so a user ` +
      "with no id would land in it. Pass the user's id, or use the client itself for your own memory.");
  }
  return name;
}

// ── errors ────────────────────────────────────────────────────────────────────
export class GeniffyError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly body?: Record<string, unknown>;
  /** The id Geniffy gave the call (its X-Request-ID): log it, and paste it into Requests in the Geniffy app
   *  to see exactly what was sent and what came back. Undefined when the call never arrived. */
  readonly requestId?: string;

  constructor(message: string, opts: { status?: number; code?: string; body?: Record<string, unknown>; cause?: unknown; requestId?: string } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
    this.requestId = opts.requestId;
  }
}
/** Geniffy could not be reached, after the retries. */
export class APIConnectionError extends GeniffyError {}
/** The key is missing, wrong or revoked. */
export class AuthenticationError extends GeniffyError {}
export class NotFoundError extends GeniffyError {}
export class BadRequestError extends GeniffyError {}
/** A file or link could not be read; `source` is the row it left, with the reason. */
export class UnreadableError extends BadRequestError {
  get source(): Source | undefined {
    const err = (this.body?.error ?? {}) as { source?: Source };
    return err.source;
  }
}
export class RateLimitError extends GeniffyError {}
export class InternalServerError extends GeniffyError {}

function errorFrom(status: number, body: Record<string, unknown>, requestId?: string): GeniffyError {
  const err = (typeof body.error === "object" && body.error !== null ? body.error : {}) as { code?: string; message?: string };
  const message = err.message ?? (typeof body.detail === "string" ? body.detail : `Geniffy answered ${status}.`);
  const opts = { status, code: err.code, body, requestId };
  if (status === 401 || status === 403) return new AuthenticationError(message, opts);
  if (status === 404) return new NotFoundError(message, opts);
  if (status === 422 && err.code === "unreadable") return new UnreadableError(message, opts);
  if ([400, 409, 413, 422].includes(status)) return new BadRequestError(message, opts);
  if (status === 429) return new RateLimitError(message, opts);
  if (status >= 500) return new InternalServerError(message, opts);
  return new GeniffyError(message, opts);
}

// ── the client ────────────────────────────────────────────────────────────────
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function env(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.[name];
}

function delay(attempt: number, response?: Response): number {
  const after = Number(response?.headers.get("retry-after"));
  if (response && Number.isFinite(after) && after >= 0 && after <= 60) return after * 1000;
  return Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() / 2);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Body = { json?: unknown; form?: FormData; query?: Record<string, string | number | string[] | undefined> };

export class Geniffy {
  readonly memories: Memories;
  readonly sources: Sources;
  /** Files kept with their exact text, such as the ones Claude's memory tool writes (see `geniffy/claude`) */
  readonly files: Files;
  /** Keys limited to one of your users, on a client bound to them: client.space(id).keys */
  readonly keys: Keys;
  /** The sections profiles are grouped into: every user's on the plain client, one user's on client.space(id) */
  readonly sections: Sections;
  readonly maxRetries: number;
  readonly timeout: number;
  /** The one of your users this client is bound to, or "" for your own memory. */
  readonly boundSpace: string;
  readonly #opts: ClientOptions;
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    const key = (opts.apiKey ?? env("GENIFFY_API_KEY") ?? "").trim();
    if (!key) {
      throw new GeniffyError("No API key. Pass { apiKey } or set GENIFFY_API_KEY. Make one in the Geniffy app under Connect, API keys.");
    }
    this.#opts = opts;
    this.#key = key;
    this.#base = (opts.baseURL ?? env("GENIFFY_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeout = opts.timeout ?? 60_000;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
    this.boundSpace = opts.space === undefined || opts.space === null ? "" : spaceName(opts.space, "space:");
    if (opts.integration !== undefined && !INTEGRATION.test(opts.integration)) {
      throw new TypeError('integration is a name and a version, such as "geniffy-ai-sdk/0.1.0".');
    }
    this.memories = new Memories(this);
    this.sources = new Sources(this);
    this.files = new Files(this);
    this.keys = new Keys(this);
    this.sections = new Sections(this);
  }

  /**
   * The same client, pointed at one of YOUR users. Everything it reads and writes is that user's
   * memory alone; nothing else can see it.
   *
   *     const client = new Geniffy({ apiKey });          // once, for the process
   *     const mem = client.space(req.user.id);           // per request
   *     await mem.memories.add("Prefers WhatsApp.");
   *     const answer = await mem.ask("How should we reach them?");
   *
   * `space` is your own name for that user and nothing is read into it: the id you already give them,
   * up to 128 letters, digits, dots, dashes or underscores, so an id rather than an email. A blank one
   * (or undefined, or null) throws rather than reading your own memory.
   */
  space(space: string | number): Geniffy {
    return new Geniffy({ ...this.#opts, apiKey: this.#key, space: spaceName(space, "space()") });
  }

  /** @internal */
  async request<T>(method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", path: string, body: Body = {}): Promise<T> {
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(body.query ?? {})) {
      if (Array.isArray(v)) for (const each of v) url.searchParams.append(k, each);
      else if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#key}`,
      Accept: "application/json",
      "X-Geniffy-Client": `geniffy-js/${VERSION}${this.#opts.integration ? ` ${this.#opts.integration}` : ""}`,
    };
    // One header carries the space, so every call a bound client makes is scoped without any
    // method having to take it, and a space can never be dropped by forgetting an argument.
    if (this.boundSpace) headers["X-Geniffy-Space"] = this.boundSpace;
    if (body.json !== undefined) headers["Content-Type"] = "application/json";
    const payload = body.form ?? (body.json !== undefined ? JSON.stringify(body.json) : undefined);

    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.maxRetries;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeout);
      let response: Response | undefined;
      try {
        response = await this.#fetch(url, { method, headers, body: payload, signal: ctrl.signal });
      } catch (cause) {
        clearTimeout(timer);
        // a POST that failed in flight may have arrived: never sent twice
        if (!last && method !== "POST" && method !== "PATCH") {
          await sleep(delay(attempt));
          continue;
        }
        throw new APIConnectionError(`Couldn't reach Geniffy: ${(cause as Error)?.name ?? "network error"}.`, { cause });
      }
      clearTimeout(timer);
      const retry = response.status === 429 || (method !== "POST" && method !== "PATCH" && RETRY_STATUS.has(response.status));
      if (!last && retry) {
        await sleep(delay(attempt, response));
        continue;
      }
      const text = await response.text();
      let data: Record<string, unknown> = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: { code: "bad_response", message: text.slice(0, 300) } };
        }
      }
      if (!response.ok) throw errorFrom(response.status, data, response.headers.get("x-request-id") ?? undefined);
      return data as T;
    }
  }

  /** An answer from your memory only. `answer` is null when nothing you added supports one. With labels, only
   *  from what the sources carrying them said. */
  ask(question: string, opts: { labels?: LabelFilter } = {}): Promise<Answer> {
    return this.request<Answer>("POST", "/v1/ask", { json: { question, labels: opts.labels } });
  }

  /** The memories that best match `q`, best first. `labels: { channel: "email" }` keeps to the sources
   *  carrying them: every name must match, and a list of values is any one of them. */
  async search(q: string, opts: { limit?: number; kind?: Kind; labels?: LabelFilter } = {}): Promise<Memory[]> {
    const out = await this.request<MemoryPage>("POST", "/v1/search", {
      json: { q, limit: opts.limit ?? 10, kind: opts.kind, labels: opts.labels },
    });
    return out.memories;
  }

  /**
   * The memories that bear on a question, already written out for YOUR prompt.
   *
   *     const prompt = `${await mem.context(question)}

User: ${question}`;
   *
   * This is the ten lines of formatting every integration writes after calling search, so it is
   * written here once. It is never empty: when nothing is held it says so in words, because an
   * empty block reads to a model as permission to invent.
   */
  async context(question: string,
                opts: { limit?: number; kind?: Kind; withSources?: boolean; labels?: LabelFilter } = {}): Promise<string> {
    const out = await this.contextFull(question, opts);
    return out.context;
  }

  /** The same, with the memories behind it and whether anything was found. */
  contextFull(question: string,
              opts: { limit?: number; kind?: Kind; withSources?: boolean; labels?: LabelFilter } = {}): Promise<ContextResult> {
    return this.request<ContextResult>("POST", "/v1/context", {
      json: { question, limit: opts.limit ?? 12, kind: opts.kind, with_sources: opts.withSources ?? true,
              labels: opts.labels },
    });
  }

  /** What stays true about someone, and what is going on with them now. */
  profile(subject?: string): Promise<Profile> {
    return this.request<Profile>("GET", "/v1/profile", { query: { subject } });
  }

  /** What to read before dealing with someone. */
  brief(subject?: string, opts: { limit?: number; labels?: LabelFilter } = {}): Promise<Brief> {
    return this.request<Brief>("GET", "/v1/brief", { query: { subject, limit: opts.limit, label: labelQuery(opts.labels) } });
  }

  /** What the memory holds and what connects to what. Every line has a memory behind it. */
  graph(): Promise<Graph> {
    return this.request<Graph>("GET", "/v1/graph");
  }

  /** Everything held, as the user's own copy: every memory, current or not, with its status and the sentence it
   *  came from, every source, and every file by its path (files.get(path) reads each one's text). On
   *  client.space(id), for a user who asks what you hold about them. */
  export(): Promise<Export> {
    return this.request<Export>("GET", "/v1/export");
  }

  /** Whose key this is, and which space this client is reading. */
  me(): Promise<{ name: string | null; memory: string; space: string | null }> {
    return this.request("GET", "/v1/me");
  }

  /** Which of your users have memory, busiest first. */
  async spaces(): Promise<SpaceRow[]> {
    const out = await this.request<{ spaces: SpaceRow[] }>("GET", "/v1/spaces");
    return out.spaces;
  }

  /**
   * Everything one of your users ever said, gone: facts, sources, all of it. This is the call to
   * make when they ask to be forgotten. It cannot be undone.
   */
  async forgetSpace(space: string | number): Promise<void> {
    await this.request("DELETE", `/v1/spaces/${encodeURIComponent(spaceName(space, "forgetSpace()"))}`);
  }
}

export interface BatchResult {
  results: Array<{ index: number; source: Source | null; error: { code: string; message: string } | null }>;
  added: number;
  failed: number;
}

export interface ContextResult {
  question: string;
  /** Put this straight into your prompt. Never empty. */
  context: string;
  memories: Memory[];
  used: number;
  /** true when nothing stored bears on the question. */
  empty: boolean;
}

export interface Profile {
  subject: string | null;
  lasting: unknown[];
  current: unknown[];
  grouped: Record<string, unknown>;
  memories: number;
}

export interface Brief {
  subject: string | null;
  summary: string | null;
  memories: Memory[];
  total: number;
}

/** A user's own copy of what is held. */
export interface Export {
  exported_at: string;
  /** where the memory is kept */
  stored_in: string;
  memories: (Memory & { quote?: string | null })[];
  sources: Source[];
  /** every file kept, by path and without its text, which files.get(path) returns exactly as written (left out by
   *  an API from before files) */
  files?: FileEntry[];
}

export interface Graph {
  nodes: Array<{ id: string; label: string; type: string; memories: number }>;
  edges: Array<{ from: string; to: string; label: string; memory_ids: number[] }>;
}

export interface SpaceRow {
  /** Your own name for that user. */
  space: string;
  /** Notes, files and links added for them. */
  sources: number;
  /** Facts learned from those. */
  memories: number;
  last_added_at: string | null;
}

export interface ChatMessage {
  role: string;
  /** The words: a string, or the blocks or parts your framework holds (Anthropic, OpenAI). Only text is
   *  kept; null is a turn that said nothing in words, such as one that only called a tool. */
  content?: string | unknown[] | null;
  /** Or the parts, as the Vercel AI SDK and Gemini hold a message. */
  parts?: unknown[];
  /** Who, when the role does not say: a tool name, a participant. */
  name?: string;
}

/** When a note or conversation from the past was said: a Date, or an ISO 8601 string (2026-03-04,
 *  2026-03-04T09:30:00Z). What it teaches is dated by it. Left out, now. */
export interface SaidAt {
  saidAt?: Date | string;
}

/** Your own id for what you add: a ticket's, a document's, a conversation's. Sent again under the same id,
 *  the source is updated rather than added twice: only what changed is learned, and what was removed is
 *  taken back. Find or delete it by the same id with `sources.get({ externalId })` and `sources.delete`.
 *  An id that starts with "file:" is refused: those name the files kept with `files.put`. */
export interface ExternalId {
  externalId?: string;
}

/** Up to 20 of your own name/value pairs ({ channel: "email", project: "apollo" }) to filter search, context,
 *  ask, list and brief by. Sent again under the same externalId they replace the old ones, with nothing learned
 *  again; left out, they are kept; {} clears them. */
export interface WithLabels {
  labels?: Labels;
}

export type AddInput =
  | string
  | ({ text: string; title?: string } & SaidAt & ExternalId & WithLabels)
  | ({ url: string; title?: string } & ExternalId & WithLabels)
  /** A conversation as your framework already holds it. System and developer messages are skipped, and
   *  who said what is kept, so the user's words become facts about the user and not about your assistant. */
  | ({ messages: ChatMessage[]; title?: string } & SaidAt & ExternalId & WithLabels);

// The body the API takes: saidAt goes as said_at, a Date as its moment in UTC; externalId as external_id.
function addBody(input: AddInput): Record<string, unknown> {
  const given = typeof input === "string" ? { text: input } : input;
  const { saidAt, externalId, ...rest } = given as typeof given & SaidAt & ExternalId;
  const body: Record<string, unknown> = { ...rest };
  if (saidAt !== undefined) body.said_at = saidAt instanceof Date ? saidAt.toISOString() : String(saidAt);
  if (externalId !== undefined) body.external_id = String(externalId);
  return body;
}

/** A source named by Geniffy's id, or by the external id you added it under. */
export type SourceLookup = string | { externalId: string };

function lookup(ref: SourceLookup): { id?: string; externalId?: string } {
  if (typeof ref === "string") return { id: ref };
  if (ref && typeof ref.externalId === "string") return { externalId: ref.externalId };
  throw new TypeError("Name the source by its id, or as { externalId }.");
}

export class Memories {
  constructor(private readonly client: Geniffy) {}

  /** Add a note (a string or { text }), or a web page ({ url }) that Geniffy reads once. */
  async add(input: AddInput): Promise<Source> {
    const json = addBody(input);
    const out = await this.client.request<{ source: Source }>("POST", "/v1/memories", { json });
    return out.source;
  }

  /** Add a file: PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), or text (.txt, .md, .csv, .html). Under an
   *  externalId, a new version updates the source that id names. */
  async addFile(file: Blob | ArrayBuffer | Uint8Array,
                opts: { filename?: string; title?: string } & ExternalId & WithLabels = {}): Promise<Source> {
    const blob = file instanceof Blob ? file : new Blob([file as BlobPart]);
    const named = (file as unknown as { name?: unknown }).name;
    const name = opts.filename ?? (typeof named === "string" && named ? named : "file");
    const form = new FormData();
    form.append("file", blob, name);
    if (opts.title) form.append("title", opts.title);
    if (opts.externalId !== undefined) form.append("external_id", String(opts.externalId));
    if (opts.labels !== undefined) form.append("labels", JSON.stringify(opts.labels));
    const out = await this.client.request<{ source: Source }>("POST", "/v1/memories/file", { form });
    return out.source;
  }

  /**
   * Up to a hundred at once. One bad item does not take the rest down: every item comes back in
   * the order you sent it, with either its source or why it was refused.
   */
  async addMany(items: AddInput[]): Promise<BatchResult> {
    const json = { items: items.map(addBody) };
    return this.client.request<BatchResult>("POST", "/v1/memories/batch", { json });
  }

  /** Say what we got wrong and what is right. The wrong one is marked and never used again; what
   *  is right is learned as a new memory with its own source. Nothing is quietly overwritten. */
  async correct(id: number, text: string): Promise<{ id: number; corrected: boolean; source: Source }> {
    return this.client.request("PATCH", `/v1/memories/${id}`, { json: { text } });
  }

  /** One page of memories, newest first; with labels, only what the sources carrying them said. */
  list(opts: { kind?: Kind; limit?: number; cursor?: number; labels?: LabelFilter } = {}): Promise<MemoryPage> {
    return this.client.request<MemoryPage>("GET", "/v1/memories", {
      query: { kind: opts.kind, limit: opts.limit ?? 50, cursor: opts.cursor ?? 0, label: labelQuery(opts.labels) },
    });
  }

  /** Every memory, newest first, a page at a time: for await (const m of g.memories.iterate()) */
  async *iterate(opts: { kind?: Kind; pageSize?: number; labels?: LabelFilter } = {}): AsyncGenerator<Memory> {
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: MemoryPage = await this.list({ kind: opts.kind, limit: opts.pageSize ?? 100, cursor, labels: opts.labels });
      yield* page.memories;
      cursor = page.next;
    }
  }

  /** A memory, the sentence it came from, and the values it held before. */
  get(id: number): Promise<MemoryDetail> {
    return this.client.request<MemoryDetail>("GET", `/v1/memories/${Math.trunc(id)}`);
  }

  /** Forget a memory for good. */
  async delete(id: number): Promise<void> {
    await this.client.request("DELETE", `/v1/memories/${Math.trunc(id)}`);
  }
}

/** A key limited to one of your users: it reads and writes their memory and nothing else. */
export interface Key {
  id: number;
  name: string;
  /** the user it is limited to */
  space: string;
  /** the key itself: only when it is made, never again */
  key?: string | null;
  starts_with?: string | null;
  created_at?: string | null;
  last_used_at?: string | null;
  /** when it stops working by itself; null: when it is revoked */
  expires_at?: string | null;
}

/** Keys limited to one of your users, on a client bound to that user: `client.space(id).keys`. Such a key is
 *  safe to hand to that user's own app or device, since it reaches their memory and nothing else. */
export class Keys {
  constructor(private readonly client: Geniffy) {}

  /** A new key limited to this client's user. `key` is shown once. rpm: requests a minute (up to 600, the default).
   *  expiresAt: when it stops working by itself (a Date, or an ISO date it works through); left out, never. */
  create(opts: { name?: string; rpm?: number; expiresAt?: Date | string } = {}): Promise<Key> {
    const json: Record<string, unknown> = {};
    if (opts.name) json.name = opts.name;
    if (opts.rpm !== undefined) json.rpm = opts.rpm;
    if (opts.expiresAt !== undefined) {
      json.expires_at = opts.expiresAt instanceof Date ? opts.expiresAt.toISOString() : String(opts.expiresAt);
    }
    return this.client.request<Key>("POST", "/v1/keys", { json });
  }

  /** The keys limited to this client's user that still work. */
  async list(): Promise<Key[]> {
    return (await this.client.request<{ keys: Key[] }>("GET", "/v1/keys")).keys;
  }

  /** One of this user's keys stops at once. */
  async revoke(id: number): Promise<void> {
    await this.client.request("DELETE", `/v1/keys/${Math.trunc(id)}`);
  }
}

/** A section a profile is grouped into. */
export interface Section {
  id?: number | null;
  name: string;
  description?: string;
  keywords?: string[];
  topics?: string[];
  /** "every user", "this user" or "built in" */
  applies_to?: string;
}

/** The sections profiles are grouped into. On the plain client, for every one of your users; on a client bound
 *  to one user (`client.space(id).sections`), for that user only. A memory goes in a section when one of its
 *  keywords appears in it, or its topic is one of the section's. */
export class Sections {
  constructor(private readonly client: Geniffy) {}

  /** The sections, the app's own first, then the built-in ones. */
  async list(): Promise<Section[]> {
    return (await this.client.request<{ sections: Section[] }>("GET", "/v1/profile/sections")).sections;
  }

  /** Add a section (or, under a name it already has, update it). Profiles regroup within a minute or so. */
  create(section: { name: string; keywords?: string[]; topics?: string[]; description?: string }): Promise<Section> {
    const json = { name: section.name, description: section.description ?? "", keywords: section.keywords ?? [],
                   topics: section.topics ?? [] };
    return this.client.request<Section>("POST", "/v1/profile/sections", { json });
  }

  async delete(id: number): Promise<void> {
    await this.client.request("DELETE", `/v1/profile/sections/${Math.trunc(id)}`);
  }
}

// Each call deletes up to 100 sources (or files) and says whether more are left; this many calls is the most one
// deleteLabelled() or files.deletePrefix() makes, so a filter that somehow keeps matching cannot loop for ever.
const DELETE_CALLS = 1000;

export class Sources {
  constructor(private readonly client: Geniffy) {}

  /** What was added, newest first; with labels, only the sources carrying them. */
  list(opts: { limit?: number; cursor?: number; labels?: LabelFilter } = {}): Promise<SourcePage> {
    return this.client.request<SourcePage>("GET", "/v1/sources", {
      query: { limit: opts.limit ?? 100, cursor: opts.cursor ?? 0, label: labelQuery(opts.labels) },
    });
  }

  /** Delete every source carrying these labels, and every memory learned only from them: the call when your
   *  user disconnects a data source whose things you added under its label. Resolves to how many.
   *
   *  `keep`: the external ids to leave, for the end of a sync that read everything: every other source with
   *  these labels, such as what is gone from the data source, is deleted. */
  async deleteLabelled(labels: LabelFilter, opts: { keep?: Iterable<string> } = {}): Promise<number> {
    if (!labels || !Object.keys(labels).length) {
      throw new TypeError('Name the labels whose sources to delete, such as { channel: "gmail" }.');
    }
    if (opts.keep !== undefined) return this.deleteAllBut(labels, opts.keep);
    let total = 0;
    for (let i = 0; i < DELETE_CALLS; i++) {
      const out = await this.client.request<{ sources_deleted: number; more: boolean }>("DELETE", "/v1/sources", {
        query: { label: labelQuery(labels) },
      });
      total += out.sources_deleted ?? 0;
      if (!out.more) break;
    }
    return total;
  }

  private async deleteAllBut(labels: LabelFilter, keep: Iterable<string>): Promise<number> {
    // one id on its own would read as its letters, and keep nothing
    if (typeof keep === "string") throw new TypeError("keep is a list or set of external ids, not one id.");
    const kept = new Set(Array.from(keep, String));
    const gone: string[] = [];
    for (let cursor: number | null = 0; cursor !== null; ) {   // the whole list first: deleting moves the pages
      const page: SourcePage = await this.list({ labels, cursor });
      for (const s of page.sources) if (!(s.external_id != null && kept.has(s.external_id))) gone.push(s.id);
      cursor = page.next;
    }
    let deleted = 0;
    for (const id of gone) {
      try {
        await this.delete(id);
        deleted++;
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;            // deleted meanwhile: gone either way
      }
    }
    return deleted;
  }

  /** A source, by its id or as { externalId } (a NotFoundError when no source has that external id). */
  async get(ref: SourceLookup): Promise<Source> {
    const { id, externalId } = lookup(ref);
    if (id !== undefined) {
      return (await this.client.request<{ source: Source }>("GET", `/v1/sources/${encodeURIComponent(id)}`)).source;
    }
    const { sources } = await this.client.request<SourcePage>("GET", "/v1/sources", { query: { external_id: externalId } });
    if (!sources.length) {
      throw new NotFoundError("No source in this space has that external_id.", { status: 404, code: "not_found" });
    }
    return sources[0];
  }

  /** Delete a source and every memory learned only from it, by its id or as { externalId }: the call for a
   *  record your app deleted. */
  async delete(ref: SourceLookup): Promise<void> {
    const { id, externalId } = lookup(ref);
    if (id !== undefined) await this.client.request("DELETE", `/v1/sources/${encodeURIComponent(id)}`);
    else await this.client.request("DELETE", "/v1/sources", { query: { external_id: externalId } });
  }

  /** Wait until Geniffy has learned from a source (or could not), then return it. Geniffy holds the
   *  call open until the source is done, so this returns the moment it is, usually in one call. */
  async wait(id: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Source> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    for (;;) {
      const asked = Date.now();
      // held up to 30 s, never past the deadline, and never so long that this client's own timeout fires first
      const hold = Math.max(0, Math.min(deadline - asked, this.client.timeout - 5_000, 30_000));
      const { source } = await this.client.request<{ source: Source }>(
        "GET", `/v1/sources/${encodeURIComponent(id)}`, { query: { wait: (hold / 1000).toFixed(1) } });
      const now = Date.now();
      if (source.status !== "reading" || now >= deadline) return source;
      if (now - asked < 1_000) await sleep(Math.min(opts.intervalMs ?? 2000, deadline - now));   // answered at once: don't spin
    }
  }
}

/** A file kept in a memory, without its text. */
export interface FileEntry {
  /** such as /memories/notes.md */
  path: string;
  /** how long its text is, in characters */
  size: number;
  updated_at: string;
}

/** A file and its text, exactly as it was put. */
export interface MemoryFile extends FileEntry {
  text: string;
}

/** What files.put did. */
export interface FileInfo extends FileEntry {
  /** true when no file had that path before */
  created: boolean;
  /** the source it is learned from, titled by its path */
  source: SourceRef;
}

export interface FilePage {
  files: FileEntry[];
  total: number;
  next: number | null;
}

/**
 * Files kept exactly as they were written, each under a path such as /memories/notes.md: what an agent keeps for
 * itself, like the notes Claude's memory tool writes (see `geniffy/claude`). Geniffy also learns from each file like
 * a note titled by its path, so context() and ask() recall what it says, and deleting it takes back what only it
 * taught.
 *
 * A path starts with "/" and has at most 255 characters, with no empty, "." or ".." parts and no backslash.
 */
export class Files {
  constructor(private readonly client: Geniffy) {}

  /** Create a file, or replace its text. The text is kept exactly as sent, whitespace and line endings included,
   *  and learned like a note; a replace learns only what changed. An empty file is kept too, with nothing learned
   *  from it. labels: as on memories.add. */
  put(path: string, text: string, opts: WithLabels = {}): Promise<FileInfo> {
    return this.client.request<FileInfo>("PUT", "/v1/files", { json: { path, text, labels: opts.labels } });
  }

  /** A file and its exact text (a NotFoundError when no file has that path). */
  get(path: string): Promise<MemoryFile> {
    return this.client.request<MemoryFile>("GET", "/v1/files", { query: { path } });
  }

  /** The files whose paths start with `prefix`, by path, without their text ("/", the default, for all of them).
   *  Up to 200 a page; `next` is the cursor of the page after, null at the end. */
  list(opts: { prefix?: string; limit?: number; cursor?: number } = {}): Promise<FilePage> {
    return this.client.request<FilePage>("GET", "/v1/files", {
      query: { prefix: opts.prefix ?? "/", limit: opts.limit ?? 100, cursor: opts.cursor ?? 0 },
    });
  }

  /** Delete a file, its text and what only it taught (a NotFoundError when no file has that path). */
  async delete(path: string): Promise<void> {
    await this.client.request("DELETE", "/v1/files", { query: { path } });
  }

  /** Delete every file whose path starts with `prefix` ("/memories/" for everything in that folder), with what
   *  only they taught. Resolves to how many. */
  async deletePrefix(prefix: string): Promise<number> {
    let total = 0;
    for (let i = 0; i < DELETE_CALLS; i++) {
      const out = await this.client.request<{ deleted: number; more: boolean }>("DELETE", "/v1/files", { query: { prefix } });
      total += out.deleted ?? 0;
      if (!out.more) break;
    }
    return total;
  }

  /** Move a file, or, when `from` is a folder, every file in it, keeping the text and what was learned. A
   *  NotFoundError when there is nothing to move; a BadRequestError with code "conflict" when a destination is
   *  already taken, and then nothing moves. Resolves to how many files moved. */
  async move(from: string, to: string): Promise<number> {
    const out = await this.client.request<{ moved: number }>("POST", "/v1/files/move", { json: { from, to } });
    return out.moved ?? 0;
  }
}

export default Geniffy;
