/**
 * Geniffy for TypeScript and JavaScript: add notes, files and links to a memory, then search it and ask it.
 *
 *   import { Geniffy } from "geniffy";
 *   const g = new Geniffy();                       // reads GENIFFY_API_KEY
 *   await g.memories.add({ text: "Priya Nair signs the Lumen renewal, and it comes up in March." });
 *   const { answer } = await g.ask("Who signs the Lumen renewal?");
 *
 * No dependencies: the platform's fetch, FormData and Blob (Node 18+, Deno, Bun, edge runtimes).
 * Retries: reads and deletes are retried on network errors, 408, 429 and 5xx; adding is retried only on
 * 429, so a retry never saves a note twice.
 */

export const VERSION = "0.1.1";
export const DEFAULT_BASE_URL = "https://api.geniffy.com";

export type Kind = "all" | "people" | "plan" | "pref" | "detail";

export interface SourceRef {
  id: string | null;
  kind: string;
  title: string;
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
  space?: string;
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

type Body = { json?: unknown; form?: FormData; query?: Record<string, string | number | undefined> };

export class Geniffy {
  readonly memories: Memories;
  readonly sources: Sources;
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
    this.boundSpace = (opts.space ?? "").trim();
    this.memories = new Memories(this);
    this.sources = new Sources(this);
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
   * `space` is your own name for that user and nothing is read into it: an id, an email, whatever
   * you already call them. Up to 128 letters, digits, dots, dashes or underscores.
   */
  space(space: string): Geniffy {
    return new Geniffy({ ...this.#opts, apiKey: this.#key, space });
  }

  /** @internal */
  async request<T>(method: "GET" | "POST" | "DELETE" | "PATCH", path: string, body: Body = {}): Promise<T> {
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(body.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#key}`,
      Accept: "application/json",
      "X-Geniffy-Client": `geniffy-js/${VERSION}`,
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

  /** An answer from your memory only. `answer` is null when nothing you added supports one. */
  ask(question: string): Promise<Answer> {
    return this.request<Answer>("POST", "/v1/ask", { json: { question } });
  }

  /** The memories that best match `q`, best first. */
  async search(q: string, opts: { limit?: number; kind?: Kind } = {}): Promise<Memory[]> {
    const out = await this.request<MemoryPage>("POST", "/v1/search", { json: { q, limit: opts.limit ?? 10, kind: opts.kind } });
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
  async context(question: string, opts: { limit?: number; kind?: Kind; withSources?: boolean } = {}): Promise<string> {
    const out = await this.contextFull(question, opts);
    return out.context;
  }

  /** The same, with the memories behind it and whether anything was found. */
  contextFull(question: string, opts: { limit?: number; kind?: Kind; withSources?: boolean } = {}): Promise<ContextResult> {
    return this.request<ContextResult>("POST", "/v1/context", {
      json: { question, limit: opts.limit ?? 12, kind: opts.kind, with_sources: opts.withSources ?? true },
    });
  }

  /** What stays true about someone, and what is going on with them now. */
  profile(subject?: string): Promise<Profile> {
    return this.request<Profile>("GET", "/v1/profile", { query: { subject } });
  }

  /** What to read before dealing with someone. */
  brief(subject?: string, opts: { limit?: number } = {}): Promise<Brief> {
    return this.request<Brief>("GET", "/v1/brief", { query: { subject, limit: opts.limit } });
  }

  /** What the memory holds and what connects to what. Every line has a memory behind it. */
  graph(): Promise<Graph> {
    return this.request<Graph>("GET", "/v1/graph");
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
  async forgetSpace(space: string): Promise<void> {
    await this.request("DELETE", `/v1/spaces/${encodeURIComponent(space)}`);
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

export type AddInput =
  | string
  | ({ text: string; title?: string } & SaidAt)
  | { url: string; title?: string }
  /** A conversation as your framework already holds it. System and developer messages are skipped, and
   *  who said what is kept, so the user's words become facts about the user and not about your assistant. */
  | ({ messages: ChatMessage[]; title?: string } & SaidAt);

// The body the API takes: saidAt goes as said_at, a Date as its moment in UTC.
function addBody(input: AddInput): Record<string, unknown> {
  const given = typeof input === "string" ? { text: input } : input;
  const { saidAt, ...rest } = given as typeof given & SaidAt;
  if (saidAt === undefined) return rest;
  return { ...rest, said_at: saidAt instanceof Date ? saidAt.toISOString() : String(saidAt) };
}

export class Memories {
  constructor(private readonly client: Geniffy) {}

  /** Add a note (a string or { text }), or a web page ({ url }) that Geniffy reads once. */
  async add(input: AddInput): Promise<Source> {
    const json = addBody(input);
    const out = await this.client.request<{ source: Source }>("POST", "/v1/memories", { json });
    return out.source;
  }

  /** Add a PDF or Word (.docx) file. */
  async addFile(file: Blob | ArrayBuffer | Uint8Array, opts: { filename?: string; title?: string } = {}): Promise<Source> {
    const blob = file instanceof Blob ? file : new Blob([file as BlobPart]);
    const named = (file as unknown as { name?: unknown }).name;
    const name = opts.filename ?? (typeof named === "string" && named ? named : "file");
    const form = new FormData();
    form.append("file", blob, name);
    if (opts.title) form.append("title", opts.title);
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

  /** One page of memories, newest first. */
  list(opts: { kind?: Kind; limit?: number; cursor?: number } = {}): Promise<MemoryPage> {
    return this.client.request<MemoryPage>("GET", "/v1/memories", {
      query: { kind: opts.kind, limit: opts.limit ?? 50, cursor: opts.cursor ?? 0 },
    });
  }

  /** Every memory, newest first, a page at a time: for await (const m of g.memories.iterate()) */
  async *iterate(opts: { kind?: Kind; pageSize?: number } = {}): AsyncGenerator<Memory> {
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: MemoryPage = await this.list({ kind: opts.kind, limit: opts.pageSize ?? 100, cursor });
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

export class Sources {
  constructor(private readonly client: Geniffy) {}

  list(opts: { limit?: number; cursor?: number } = {}): Promise<SourcePage> {
    return this.client.request<SourcePage>("GET", "/v1/sources", { query: { limit: opts.limit ?? 100, cursor: opts.cursor ?? 0 } });
  }

  async get(id: string): Promise<Source> {
    return (await this.client.request<{ source: Source }>("GET", `/v1/sources/${encodeURIComponent(id)}`)).source;
  }

  /** Delete a source and every memory learned only from it. */
  async delete(id: string): Promise<void> {
    await this.client.request("DELETE", `/v1/sources/${encodeURIComponent(id)}`);
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

export default Geniffy;
