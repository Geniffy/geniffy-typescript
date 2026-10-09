# Changelog

## 0.4.0

- Briefings. `briefing({ project, cue })` is what a session opens with, written out for your prompt: where the
  project stands (goal, focus, open items, decisions, next steps), what is due or was promised, the rules and
  lessons that apply, what happened, then the memories, each dated. `briefingFull()` has its parts. `now()`,
  `episodes()`, `lessons()` and `intentions()` read each part on its own, and `setIntention(id, "done")` marks a
  promise kept. `memoryHealth()`: how well the memory answers about its own work, from the questions it asks itself
  each night. Needs the API with briefings (October 2026).
- `memories.add({ messages })` takes a whole session: the assistant's tool calls and what came back go in too, in
  the shapes OpenAI, Anthropic, the Vercel AI SDK, Gemini and LangChain hold them (`tool_calls`, `tool_call_id` and
  `time` are typed now). Facts come only from what was said; the tool turns tell Geniffy what happened.
- Sessions saved as they go. `session(id).save(messages)`, after every turn, sends only the messages after the last
  one it sent, 500 a call, into one memory for the whole session however long it gets; if the agent rewrites its
  history, what it holds now is saved again rather than lost. `memories.add({ messages: newTurns, session: id })`
  does the same for turns you track yourself. Needs the API with sessions (October 2026).
- `usage()`: this month's use for the whole account, what it comes to in dollars, what your plan includes, the most
  the month can come to, and when it resets. `UsageLimitError` (402, code `allowance_used`): this month's use is up
  and what waits to be learned has reached its limit; search and recall keep working; not retried. `Source.status`
  may be `"waiting"`: saved past this month's use, kept, and learned once there is room.

## 0.3.0

- `files`: files kept exactly as they were written, each under a path such as `/memories/notes.md`.
  `files.put(path, text, { labels })` creates or replaces one (an empty file too), `get(path)` returns its exact
  text, `list({ prefix, limit, cursor })` lists them by path, `delete(path)` and `deletePrefix(prefix)` delete
  them, and `move(from, to)` moves a file, or a folder and everything in it. Geniffy also learns from each file
  like a note titled by its path, so `context()` and `ask()` recall what it says: a replace learns only what
  changed, a move learns nothing again, and deleting a file takes back what only it taught. Putting a file is
  retried like a read, since the same text twice is the same file. `export()` lists every file by path
  (`Export.files`), without its text: `files.get(path)` reads each one. Needs the API with `/v1/files` (October 2026).
- `geniffy/claude`: Claude's memory tool (memory_20250818) with Geniffy as its storage.
  `betaMemoryTool(geniffyMemoryHandlers(client.space(userId)))` from `@anthropic-ai/sdk/helpers/beta/memory` keeps
  the files Claude writes under `/memories` in that user's memory, returns each one exactly as Claude wrote it, and
  lets `context()` and `ask()` recall what it says. Every command answers with the sentences Anthropic's memory tool
  documentation gives, the same as `geniffy.claude` in Python; a path outside `/memories` is refused however it is
  encoded, and a command that cannot be done throws the SDK's `ToolError`, so the tool runner sends it back to Claude
  as an error result. Every file carries the labels `LABELS` (`{ channel: "claude-memory" }`), and
  `clearAllMemory(mem)` deletes everything under `/memories`. The handlers run one command at a time, in the order
  they are called: the tool runner runs a reply's tool calls at once, and two edits to one file side by side would
  each read the old text, losing one edit while both said done. Needs `@anthropic-ai/sdk` 0.72 or later, an
  optional peer dependency: `geniffy` itself still has no dependencies.

## 0.2.0

- `memories.add({ ..., saidAt })` and the same in `addMany`: when a note or conversation from the past was
  said (a `Date` or an ISO 8601 string), so what it teaches is dated by it. Needs the API with `said_at` (October 2026).
- `externalId` on `memories.add`, `addMany` and `addFile`: your own id for a source. Sent again under the
  same id, the source is updated rather than added twice, and only what changed is learned.
  `sources.get({ externalId })` and `sources.delete({ externalId })` find and delete it by that id, and
  `Source.external_id` says which id a source was added under.
- `labels` on `memories.add`, `addMany` and `addFile`: up to 20 of your own name/value pairs on a source
  (`{ channel: "email" }`), and as a filter on `search`, `context`, `ask`, `memories.list`, `memories.iterate`
  and `brief`: every name must match, and a list of values is any one of them. `Source.labels` shows a
  source's. `sources.list({ labels })` lists the sources carrying them, and `sources.deleteLabelled(labels)`
  deletes them all, with what only they taught; with `{ keep }` (the external ids a sync still has) it deletes
  only the rest, such as what is gone from the source. Needs the API with labels (October 2026).
- `export()`: everything held, as the user's own copy (on `client.space(id)`, for a user who asks what you hold).
- `sections`: the sections profiles are grouped into. `client.sections.create({ name, keywords })` adds one
  for every one of your users; on `client.space(id)`, for that user only. `list()` and `delete(id)` too.
- `keys` on a client bound to one of your users: `client.space(id).keys.create({ name, rpm })` makes a key
  limited to that user (it reads and writes their memory and nothing else), and `keys.list()` and
  `keys.revoke(id)` manage them. `expiresAt` makes one that stops by itself. Needs the API with `/v1/keys`
  (October 2026).
- `space()`, `forgetSpace()` and the `space` option throw a `TypeError` for a blank space and for anything
  that isn't a string or an integer. A blank space used to mean your own memory, so a user with a missing id
  landed in it, and `forgetSpace(undefined)` erased a space named "undefined". Your own memory is still the
  client with no space. An integer id is taken as its digits.

## 0.1.1

- The package page links to the source on GitHub, the docs and the issue tracker.
- The example in the module comment uses the same sample note as the docs.

## 0.1.0 (5 October 2026)

The first release.

- `Geniffy`, reading `GENIFFY_API_KEY` and, to point at another server, `GENIFFY_BASE_URL`. No dependencies:
  it uses the platform's `fetch` (Node 18+, Deno, Bun and edge runtimes).
- Spaces: `space()` binds a client to one of your users; `spaces()` lists them; `forgetSpace()` erases one.
- Memories: add a note, a web page, a conversation, a PDF or Word file, or up to a hundred at once; list,
  iterate, get with the sentence each came from, correct and delete.
- Sources: list, get, wait until learned, and delete with everything only they taught.
- Recall: `context()` for your prompt, `ask()` for an answer or an honest "nothing stored", and `search()`.
- `profile()`, `brief()`, `graph()` and `me()`.
- Typed errors that carry the API's own sentence and the request id. Reads are retried; adding is retried
  only on 429, so it never saves a note twice.
