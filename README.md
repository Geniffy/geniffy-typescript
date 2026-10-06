# Geniffy for TypeScript and JavaScript

[![CI](https://github.com/Geniffy/geniffy-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/Geniffy/geniffy-typescript/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/geniffy)](https://www.npmjs.com/package/geniffy) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-docs.geniffy.com-1A1814)](https://docs.geniffy.com/sdks/typescript)

Give your app a memory. Write what each of your users tells you, and put what is known about them
in front of your model, with where every line came from. When nothing is known, it says so instead
of guessing. No dependencies: it uses the platform's `fetch` (Node 18+, Deno, Bun, edge runtimes).

```bash
npm install geniffy
```

Make a key in the Geniffy app under **API keys** and set it as `GENIFFY_API_KEY`.

```ts
import { Geniffy } from "geniffy";

const client = new Geniffy();                  // reads GENIFFY_API_KEY
const mem = client.space("customer_1042");     // one of your users; nothing else can read it

const source = await mem.memories.add("Priya Nair signs the Lumen renewal, and it comes up in March.");
await mem.sources.wait(source.id);             // learning usually takes a few seconds

const context = await mem.context("Who signs the Lumen renewal?");
const prompt = `${context}\n\nUser: Who signs the Lumen renewal?`;
```

`context()` returns the memories that bear on the question, one per line, each with where it came from.
Ask about something that was never stored and it returns one sentence, `There is nothing stored about
this yet. Say so rather than guessing.`, never an empty string: a model reads silence as permission to
invent.

## Three ways to recall

```ts
await mem.context("Who signs the renewal?");          // a block for your own prompt; the one most apps want
await mem.ask("Who signs the renewal?");              // { answer, memories }, or answer: null and a message
await mem.search("renewal", { limit: 5 });            // the raw memories, ranked, to do with as you like
```

`context()` and `ask()` judge whether anything bears on the question. `search()` ranks and does not
judge: it returns its best matches for any question at all.

## Spaces: one memory per user

A space is your own name for one of your users. Bind a client to it and every call stays inside it.
A space exists from the first time you write to it; there is nothing to create.

```ts
const mem = client.space(`user_${user.id}`);          // per request
await client.memories.add("...");                     // no space: your own memory, the one the Geniffy app shows
await client.spaces();                                // which spaces hold anything, most recently written first
await client.space("user_8841").export();             // everything held for that user, as their own copy
await client.forgetSpace("user_8841");                // everything held for that user, gone, when they ask
```

To let a user's own app or device reach their memory, and nothing else, give it a key limited to them:

```ts
const key = await client.space(`user_${user.id}`).keys.create({ name: "Asha's phone" });   // key.key is shown once
await client.space(`user_${user.id}`).keys.revoke(key.id);
```

Group your users' profiles your way with sections: `client.sections.create({ name: "billing", keywords: ["invoice"] })`
for every user, or on `client.space(id)` for one.

## Add

```ts
await mem.memories.add({ text: "Pilots run for 6 weeks.", title: "GTM plan" });
await mem.memories.add({ url: "https://example.com" });        // a web page, read once
await mem.memories.add({ messages: chatHistory });                  // a conversation, as your framework holds it
await mem.memories.add({ text: "We moved the launch to March.", saidAt: "2026-09-12" }); // dated by when it was said
await mem.memories.addFile(fileOrBlob, { filename: "Pricing.pdf" }); // PDF, .docx, .pptx, .xlsx or text
await mem.memories.addMany([{ text: "..." }, { url: "https://..." }]);
```

A file or page that can't be read rejects with `UnreadableError`; `error.source` is the row it left, with the reason.

Syncing your own records? Give each its id. Sent again under the same `externalId`, the source is updated
rather than added twice: only what changed is learned, and what was removed is taken back.

```ts
await mem.memories.add({ text: ticket.body, title: ticket.subject, externalId: `ticket-${ticket.id}` });
await mem.sources.get({ externalId: `ticket-${ticket.id}` });
await mem.sources.delete({ externalId: `ticket-${ticket.id}` });   // when the ticket is deleted in your app
```

Label what you add with your own name/value pairs, then keep any read to them. Every name must match, and a
list of values is any one of them.

```ts
await mem.memories.add({ text: email.body, title: email.subject, labels: { channel: "email", account: "lumen" } });
await mem.context("When does the renewal come up?", { labels: { account: "lumen" } });
await mem.search("pricing", { labels: { channel: ["email", "chat"] } });
await mem.memories.list({ labels: { account: "lumen" } });
await mem.sources.deleteLabelled({ channel: "email" });                   // the user disconnected it: all it brought goes
await mem.sources.deleteLabelled({ channel: "email" }, { keep: seen });   // the end of a full sync: all but what is still there
```

To keep a whole data source in step, such as a user's Gmail, Drive or Notion, see
[Sync a data source](https://docs.geniffy.com/add-memories/sync-a-data-source).

## Read and correct

```ts
const page = await mem.memories.list({ kind: "people" }); // all, people, plan, pref or detail; newest first
for await (const m of mem.memories.iterate()) { /* every memory */ }
const { memory, history } = await mem.memories.get(42);  // memory.quote is the sentence it came from
await mem.memories.delete(42);                           // forget it for good
await mem.profile("Priya Nair");                         // what is lastingly true about someone, and what is going on now
await mem.brief("Priya Nair");                           // what to read before talking to them
await mem.sources.list();
await mem.sources.delete(source.id);                     // a source, and what only it taught
```

## Files, and Claude's memory tool

Keep files by path with their text exactly as written, whitespace and line endings included. Geniffy also learns
from each one like a note titled by its path, so `context()` and `ask()` recall what it says: a replace learns only
what changed, and deleting a file takes back what only it taught.

```ts
await mem.files.put("/notes/plan.md", "# Plan\n- Pilots run for 6 weeks.\n");  // creates or replaces it
const { text } = await mem.files.get("/notes/plan.md");                        // exactly as it was put
await mem.files.list({ prefix: "/notes/" });                                    // by path, without the text
await mem.files.move("/notes", "/archive/notes");                               // a file, or a folder and all in it
await mem.files.delete("/archive/notes/plan.md");
await mem.files.deletePrefix("/archive/");                                      // everything in that folder
```

That makes Geniffy the storage for Claude's memory tool, which keeps Claude's own notes as files under `/memories`.
With `geniffy/claude` those files live in that user's memory: each comes back to Claude exactly as it wrote it, and
what Claude wrote is recalled by `context()` and `ask()` like anything else the user told you.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { betaMemoryTool } from "@anthropic-ai/sdk/helpers/beta/memory";
import { geniffyMemoryHandlers } from "geniffy/claude";

const message = await new Anthropic().beta.messages.toolRunner({
  model: "claude-opus-5-5",
  max_tokens: 16000,
  tools: [betaMemoryTool(geniffyMemoryHandlers(client.space(`user_${user.id}`)))],
  messages: [{ role: "user", content: "Remember that I prefer email follow-ups." }],
});
```

Every command answers with the sentences Anthropic's memory tool documentation gives, a path outside `/memories` is
refused, and every file carries the labels `{ channel: "claude-memory" }`: `{ labels: LABELS }` keeps a read to what
Claude wrote, and `clearAllMemory(mem)` deletes it all (both from `geniffy/claude`). The tool runner runs the tool
calls of one reply at the same time, so the handlers take them one after another: two edits to one file both land.
`geniffy/claude` needs `@anthropic-ai/sdk` 0.72 or later, an optional peer dependency; `geniffy` itself still has none.

## Errors, retries and request ids

Every error carries the API's own sentence: `AuthenticationError` (a wrong or revoked key),
`NotFoundError`, `BadRequestError`, `UnreadableError`, `RateLimitError`, `InternalServerError`,
`APIConnectionError`; all extend `GeniffyError`. Reads, and putting a file (the same text twice is the same
file), are retried twice on network errors, 408, 429 and 5xx; adding is retried only on 429, so a retry never
saves a note twice. Pass `{ maxRetries, timeout }` to the constructor to change that.

Every response carries an `X-Request-ID`, and every error carries it as `error.requestId`. Paste it into
**Requests** in the Geniffy app to see that exact call: what was asked, what came back, and how long it took.

A key reaches its owner's memory and every space beneath it. Keep it on your server: anyone with it can
read that memory. Docs: https://docs.geniffy.com
