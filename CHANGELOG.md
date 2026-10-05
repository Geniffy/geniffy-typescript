# Changelog

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
