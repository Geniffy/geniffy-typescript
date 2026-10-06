// geniffy/claude: Claude's memory tool on a fake /v1/files that keeps files in memory, as the API's contract describes
// it. Every command goes in as the SDK's betaMemoryTool runs it, and every answer is checked to the character: the
// same commands and the same sentences as geniffy.claude's tests in Python.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { betaMemoryTool } from "@anthropic-ai/sdk/helpers/beta/memory";
import { ToolError } from "@anthropic-ai/sdk/resources/beta/messages";
import { Geniffy, AuthenticationError } from "../dist/index.js";
import { geniffyMemoryHandlers, clearAllMemory, LABELS, ROOT } from "../dist/claude.js";

const KEY = "gnf_live_" + "k".repeat(43);
const ANTHROPIC_KEY = "not-a-real-key";
const HEADER = (path) => `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:`;
const chars = (s) => [...s].length;

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (status, code, message) => reply(status, { error: { code, message } });

// The API's rule: starts with "/", at most 255 characters, no empty, "." or ".." parts, no backslash or control
// characters; only a prefix may end with "/".
function badPath(path, prefix = false) {
  if (typeof path !== "string" || !path.startsWith("/") || chars(path) > 255) return true;
  if (path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return true;
  const parts = path.slice(1).split("/");
  if (prefix && parts.at(-1) === "") parts.pop();
  return parts.some((p) => p === "" || p === "." || p === "..");
}

// /v1/files kept in memory: each path's exact text and labels.
class FakeFiles {
  held = new Map();
  calls = [];
  limit = 200_000;
  ticks = 0;
  move = (from, to) => {
    if (badPath(from) || badPath(to)) return refused(422, "bad_path", "That is not a file path.");
    const moves = this.held.has(from) ? [[from, to]]
      : [...this.held.keys()].filter((p) => p.startsWith(`${from}/`)).map((p) => [p, to + p.slice(from.length)]);
    if (!moves.length) return refused(404, "not_found", "No file or folder has that path.");
    if (moves.some(([, dest]) => this.held.has(dest))) return refused(409, "conflict", "Something is already at the destination.");
    for (const [src, dest] of moves) {
      this.held.set(dest, this.held.get(src));
      this.held.delete(src);
    }
    return reply(200, { moved: moves.length });
  };

  fetch = async (url, init) => {
    const u = new URL(url);
    const params = Object.fromEntries(u.searchParams);
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method: init.method, path: u.pathname, params, body, space: init.headers["X-Geniffy-Space"] });
    if (init.method === "POST" && u.pathname === "/v1/files/move") return this.move(body.from, body.to);
    if (init.method === "PUT") return this.put(body);
    if (("path" in params) === ("prefix" in params)) return refused(422, "invalid_request", "Name a path or a prefix, one of them.");
    if ("prefix" in params) {
      if (badPath(params.prefix, true)) return refused(422, "bad_path", "That prefix is not a path.");
      return init.method === "GET" ? this.list(params) : this.deletePrefix(params.prefix);
    }
    if (badPath(params.path)) return refused(422, "bad_path", "That is not a file path.");
    const held = this.held.get(params.path);
    if (!held) return refused(404, "not_found", "No file has that path.");
    if (init.method === "GET") return reply(200, { path: params.path, text: held.text, size: chars(held.text), updated_at: held.updated_at });
    this.held.delete(params.path);
    return reply(200, { deleted: 1, path: params.path });
  };

  put({ path, text, labels }) {
    if (badPath(path)) return refused(422, "bad_path", "That is not a file path.");
    if (chars(text) > this.limit) return refused(413, "too_long", `A file holds up to ${this.limit.toLocaleString("en-US")} characters.`);
    const created = !this.held.has(path);
    const kept = labels ?? (created ? {} : this.held.get(path).labels);
    this.ticks++;
    this.held.set(path, { text, labels: { ...kept }, updated_at: `2026-10-06T09:00:${String(this.ticks).padStart(2, "0")}Z` });
    return reply(200, { path, size: chars(text), updated_at: this.held.get(path).updated_at, created,
      source: { id: "s".repeat(32), kind: "note", title: path, labels: kept } });
  }

  list(params) {
    const paths = [...this.held.keys()].filter((p) => p.startsWith(params.prefix)).sort();
    const start = Number(params.cursor ?? 0);
    const limit = Math.min(Number(params.limit ?? 100), 200);
    return reply(200, {
      files: paths.slice(start, start + limit).map((p) => ({ path: p, size: chars(this.held.get(p).text), updated_at: this.held.get(p).updated_at })),
      total: paths.length, next: start + limit < paths.length ? start + limit : null });
  }

  deletePrefix(prefix) {
    const gone = [...this.held.keys()].filter((p) => p.startsWith(prefix)).sort().slice(0, 100);
    for (const p of gone) this.held.delete(p);
    return reply(200, { deleted: gone.length, more: [...this.held.keys()].some((p) => p.startsWith(prefix)) });
  }

  text(path) {
    return this.held.get(path)?.text;
  }
}

// Claude's side of the tool: a command goes in as betaMemoryTool runs it, and what comes back is the text of the tool
// result, or the content of the ToolError the tool runner sends back with is_error.
function claude() {
  const fake = new FakeFiles();
  const mem = new Geniffy({ apiKey: KEY, baseURL: "https://api.test", fetch: fake.fetch, maxRetries: 0 }).space("customer_1042");
  const tool = betaMemoryTool(geniffyMemoryHandlers(mem));
  return {
    fake,
    mem,
    ok: (command) => tool.run(command),
    error: async (command) => {
      try {
        await tool.run(command);
      } catch (e) {
        assert.ok(e instanceof ToolError, `a ToolError, not ${e}`);
        return e.content;
      }
      assert.fail(`${JSON.stringify(command)} was done`);
    },
    put: (files) => {
      for (const [path, text] of Object.entries(files)) fake.held.set(path, { text, labels: {}, updated_at: "2026-10-06T08:00:00Z" });
    },
  };
}

// ── view ──────────────────────────────────────────────────────────────────────
test("an empty memory is a directory with nothing in it", async () => {
  const c = claude();
  assert.equal(await c.ok({ command: "view", path: "/memories" }), `${HEADER("/memories")}\n0B\t/memories`);
  assert.equal(await c.ok({ command: "view", path: "/memories/" }), `${HEADER("/memories")}\n0B\t/memories`);
});

test("a file comes back exactly as Claude wrote it", async () => {
  const c = claude();
  const text = "# Lumen\n- Priya Nair signs the renewal.\n\n  Indented, trailing spaces  \r\n";
  assert.equal(await c.ok({ command: "create", path: "/memories/lumen.md", file_text: text }), "File created successfully at: /memories/lumen.md");
  assert.equal(c.fake.text("/memories/lumen.md"), text, "kept character for character");
  assert.deepEqual(c.fake.held.get("/memories/lumen.md").labels, { channel: "claude-memory" });
  assert.deepEqual(LABELS, { channel: "claude-memory" });
  assert.equal(await c.ok({ command: "view", path: "/memories/lumen.md" }),
    "Here's the content of /memories/lumen.md with line numbers:\n" +
    "     1\t# Lumen\n" +
    "     2\t- Priya Nair signs the renewal.\n" +
    "     3\t\n" +
    "     4\t  Indented, trailing spaces  \r");
});

test("create overwrites, and an empty file is a file", async () => {
  const c = claude();
  await c.ok({ command: "create", path: "/memories/prefs.md", file_text: "Tea.\n" });
  assert.equal(await c.ok({ command: "create", path: "/memories/prefs.md", file_text: "Coffee, black.\n" }),
    "File created successfully at: /memories/prefs.md");
  assert.equal(c.fake.text("/memories/prefs.md"), "Coffee, black.\n");
  assert.equal(await c.ok({ command: "create", path: "/memories/empty.md", file_text: "" }), "File created successfully at: /memories/empty.md");
  assert.equal(c.fake.text("/memories/empty.md"), "");
  assert.equal(await c.ok({ command: "view", path: "/memories/empty.md" }), "Here's the content of /memories/empty.md with line numbers:");
  assert.equal(await c.error({ command: "create", path: "/memories", file_text: "x" }),
    "Error: /memories is the memory directory itself. Create files inside it, such as /memories/notes.md.");
  assert.equal(await c.error({ command: "create", path: "/memories/x.md" }), "Error: create needs file_text, the whole text of the file.");
});

test("view_range shows only those lines", async () => {
  const c = claude();
  await c.ok({ command: "create", path: "/memories/n.md", file_text: "one\ntwo\nthree\nfour\n" });
  const head = "Here's the content of /memories/n.md with line numbers:";
  assert.equal(await c.ok({ command: "view", path: "/memories/n.md", view_range: [2, 3] }), `${head}\n     2\ttwo\n     3\tthree`);
  assert.equal(await c.ok({ command: "view", path: "/memories/n.md", view_range: [3, -1] }), `${head}\n     3\tthree\n     4\tfour`);
  assert.equal(await c.ok({ command: "view", path: "/memories/n.md", view_range: [0, 1] }), `${head}\n     1\tone`);
  assert.equal(await c.ok({ command: "view", path: "/memories/n.md", view_range: [9, -1] }), head);
  assert.match(await c.error({ command: "view", path: "/memories/n.md", view_range: ["a", "b"] }), /^Error: view_range is/);
});

test("viewing what is not there", async () => {
  const c = claude();
  assert.equal(await c.error({ command: "view", path: "/memories/nope.md" }), "The path /memories/nope.md does not exist. Please provide a valid path.");
  assert.equal(await c.error({ command: "view", path: "/memories/nope/" }), "The path /memories/nope does not exist. Please provide a valid path.");
});

test("a directory lists two levels by name, without hidden items", async () => {
  const c = claude();
  c.put({
    "/memories/notes.md": "x".repeat(1536),                   // 1.5K
    "/memories/projects/lumen.md": "y".repeat(100),           // 100B
    "/memories/projects/2026/q4.md": "z".repeat(2048),        // 2K
    "/memories/projects/2026/deep/plan.md": "w".repeat(10),   // three levels down: counted, not listed
    "/memories/.scratch.md": "h".repeat(5),                   // hidden
    "/memories/node_modules/pkg.md": "n".repeat(7),           // left out
    "/memories/projects/.cache/tmp.md": "c".repeat(3),        // hidden, two levels down
    "/elsewhere/other.md": "o".repeat(9),                     // not under /memories at all
  });
  assert.equal(await c.ok({ command: "view", path: "/memories" }), [
    HEADER("/memories"),
    "3.6K\t/memories",                                        // 3709: everything it holds
    "1.5K\t/memories/notes.md",
    "2.1K\t/memories/projects/",                              // 2161
    "2.0K\t/memories/projects/2026/",                         // 2058
    "100B\t/memories/projects/lumen.md",
  ].join("\n"));
  const projects = [
    HEADER("/memories/projects"),
    "2.1K\t/memories/projects",
    "2.0K\t/memories/projects/2026/",
    "10B\t/memories/projects/2026/deep/",
    "2K\t/memories/projects/2026/q4.md",
    "100B\t/memories/projects/lumen.md",
  ].join("\n");
  assert.equal(await c.ok({ command: "view", path: "/memories/projects" }), projects);
  assert.equal(await c.ok({ command: "view", path: "/memories/projects/" }), projects);
});

test("names are listed in code point order, as Python lists them", async () => {
  // An emoji is past U+FFFF, so in UTF-16 it starts with a unit below U+FF5E (the fullwidth tilde), and a plain
  // string sort would put it first; by code point it comes after.
  const c = claude();
  c.put({ "/memories/z.md": "x", "/memories/～.md": "x", "/memories/～/y.md": "x",
    "/memories/\u{1F600}.md": "x", "/memories/\u{1F600}/x.md": "x", "/memories/\u{1F601}.md": "x" });
  assert.equal(await c.ok({ command: "view", path: "/memories" }), [
    HEADER("/memories"),
    "6B\t/memories",
    "1B\t/memories/z.md",
    "1B\t/memories/～/",
    "1B\t/memories/～/y.md",
    "1B\t/memories/～.md",
    "1B\t/memories/\u{1F600}/",
    "1B\t/memories/\u{1F600}/x.md",
    "1B\t/memories/\u{1F600}.md",
    "1B\t/memories/\u{1F601}.md",
  ].join("\n"));
});

test("a big directory is read a page at a time", async () => {
  const c = claude();
  c.put(Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`/memories/log/${String(i).padStart(3, "0")}.md`, "x"])));
  const out = await c.ok({ command: "view", path: "/memories" });
  assert.deepEqual(out.split("\n").slice(1), ["450B\t/memories", "450B\t/memories/log/",
    ...Array.from({ length: 450 }, (_, i) => `1B\t/memories/log/${String(i).padStart(3, "0")}.md`)]);
  const listings = c.fake.calls.filter((call) => call.method === "GET" && "prefix" in call.params);
  assert.deepEqual(listings.map((call) => call.params.cursor), ["0", "200", "400"]);
  assert.ok(listings.every((call) => call.params.limit === "200"));
});

test("sizes read like the memory tool's own", async () => {
  const sizes = [0, 1, 1023, 1024, 1536, 5632, 2058, 1048576, 1258291, 3 * 1024 ** 3, 1280, 1792];
  const fake = { files: sizes.map((n, i) => ({ path: `/memories/s${String(i).padStart(2, "0")}`, size: n, updated_at: "x" })), total: sizes.length, next: null };
  const mem = new Geniffy({ apiKey: KEY, baseURL: "https://api.test", maxRetries: 0, fetch: async (url) =>
    new URL(url).searchParams.has("prefix") ? reply(200, fake) : refused(404, "not_found", "No file has that path.") });
  const lines = (await betaMemoryTool(geniffyMemoryHandlers(mem)).run({ command: "view", path: "/memories" })).split("\n").slice(2);
  assert.deepEqual(lines.map((line) => line.split("\t")[0]),
    ["0B", "1B", "1023B", "1K", "1.5K", "5.5K", "2.0K", "1M", "1.2M", "3G", "1.2K", "1.8K"], "1.25K rounds to even, as Python's format does");
});

// ── str_replace ───────────────────────────────────────────────────────────────
const PREFS = "Prefers email.\nTimezone: IST\nPrefers email follow-ups on Fridays.\n";

test("str_replace edits one exact occurrence and shows the change", async () => {
  const c = claude();
  await c.ok({ command: "create", path: "/memories/prefs.md", file_text: PREFS });
  assert.equal(await c.ok({ command: "str_replace", path: "/memories/prefs.md", old_str: "Timezone: IST", new_str: "Timezone: GMT" }),
    "The memory file has been edited. Here is the snippet showing the change (with line numbers):\n" +
    "     1\tPrefers email.\n" +
    "     2\tTimezone: GMT\n" +
    "     3\tPrefers email follow-ups on Fridays.");
  assert.equal(c.fake.text("/memories/prefs.md"), PREFS.replace("IST", "GMT"));
  assert.deepEqual(c.fake.held.get("/memories/prefs.md").labels, LABELS);
  await c.ok({ command: "str_replace", path: "/memories/prefs.md", old_str: "GMT", new_str: "$& and $1, kept as written" });
  assert.equal(c.fake.text("/memories/prefs.md"), "Prefers email.\nTimezone: $& and $1, kept as written\nPrefers email follow-ups on Fridays.\n");
});

test("str_replace without new_str deletes old_str", async () => {
  const c = claude();
  await c.ok({ command: "create", path: "/memories/prefs.md", file_text: PREFS });
  assert.equal(await c.ok({ command: "str_replace", path: "/memories/prefs.md", old_str: "\nTimezone: IST" }),
    "The memory file has been edited. Here is the snippet showing the change (with line numbers):\n" +
    "     1\tPrefers email.\n" +
    "     2\tPrefers email follow-ups on Fridays.");
  assert.equal(c.fake.text("/memories/prefs.md"), "Prefers email.\nPrefers email follow-ups on Fridays.\n");
});

test("the snippet is two lines either side", async () => {
  const c = claude();
  await c.ok({ command: "create", path: "/memories/n.md", file_text: Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join("") });
  assert.equal(await c.ok({ command: "str_replace", path: "/memories/n.md", old_str: "line 6", new_str: "line six" }),
    "The memory file has been edited. Here is the snippet showing the change (with line numbers):\n" +
    "     4\tline 4\n     5\tline 5\n     6\tline six\n     7\tline 7\n     8\tline 8");
});

test("str_replace refuses what is missing, absent or repeated", async () => {
  const c = claude();
  await c.ok({ command: "create", path: "/memories/prefs.md", file_text: PREFS });
  c.put({ "/memories/projects/a.md": "a" });
  assert.equal(await c.error({ command: "str_replace", path: "/memories/nope.md", old_str: "x", new_str: "y" }),
    "Error: The path /memories/nope.md does not exist. Please provide a valid path.");
  assert.equal(await c.error({ command: "str_replace", path: "/memories/projects", old_str: "x", new_str: "y" }),
    "Error: The path /memories/projects does not exist. Please provide a valid path.", "a directory is no file");
  assert.equal(await c.error({ command: "str_replace", path: "/memories", old_str: "x", new_str: "y" }),
    "Error: The path /memories does not exist. Please provide a valid path.");
  assert.equal(await c.error({ command: "str_replace", path: "/memories/prefs.md", old_str: "Timezone: PST", new_str: "y" }),
    "No replacement was performed, old_str `Timezone: PST` did not appear verbatim in /memories/prefs.md.");
  assert.equal(await c.error({ command: "str_replace", path: "/memories/prefs.md", old_str: "Prefers email", new_str: "y" }),
    "No replacement was performed. Multiple occurrences of old_str `Prefers email` in lines: 1, 3. Please ensure it is unique");
  assert.match(await c.error({ command: "str_replace", path: "/memories/prefs.md", old_str: "", new_str: "y" }), /^Error: old_str is missing or empty\./);
  assert.equal(c.fake.text("/memories/prefs.md"), PREFS, "nothing refused was written");
});

// ── insert ────────────────────────────────────────────────────────────────────
test("insert puts lines after the line named", async () => {
  const c = claude();
  await c.ok({ command: "create", path: "/memories/todo.md", file_text: "- Call Priya\n- Send the deck\n" });
  assert.equal(await c.ok({ command: "insert", path: "/memories/todo.md", insert_line: 0, insert_text: "# To do\n" }), "The file /memories/todo.md has been edited.");
  assert.equal(await c.ok({ command: "insert", path: "/memories/todo.md", insert_line: 3, insert_text: "- Book the room" }), "The file /memories/todo.md has been edited.");
  assert.equal(await c.ok({ command: "insert", path: "/memories/todo.md", insert_line: 2, insert_text: "- Draft terms\n\n" }), "The file /memories/todo.md has been edited.");
  assert.equal(c.fake.text("/memories/todo.md"), "# To do\n- Call Priya\n- Draft terms\n\n- Send the deck\n- Book the room\n");
  assert.deepEqual(c.fake.held.get("/memories/todo.md").labels, LABELS);
});

test("insert into a file with no last newline, or nothing at all", async () => {
  const c = claude();
  await c.ok({ command: "create", path: "/memories/a.md", file_text: "a" });
  await c.ok({ command: "insert", path: "/memories/a.md", insert_line: 1, insert_text: "b" });
  assert.equal(c.fake.text("/memories/a.md"), "a\nb\n");
  await c.ok({ command: "create", path: "/memories/empty.md", file_text: "" });
  await c.ok({ command: "insert", path: "/memories/empty.md", insert_line: 0, insert_text: "first" });
  assert.equal(c.fake.text("/memories/empty.md"), "first\n");
});

test("insert refuses a missing file and a line out of range", async () => {
  const c = claude();
  await c.ok({ command: "create", path: "/memories/todo.md", file_text: "- Call Priya\n- Send the deck\n" });
  c.put({ "/memories/projects/a.md": "a" });
  assert.equal(await c.error({ command: "insert", path: "/memories/nope.md", insert_line: 0, insert_text: "x" }), "Error: The path /memories/nope.md does not exist");
  assert.equal(await c.error({ command: "insert", path: "/memories/projects", insert_line: 0, insert_text: "x" }), "Error: The path /memories/projects does not exist");
  for (const line of [3, -1, 1.5]) {
    assert.equal(await c.error({ command: "insert", path: "/memories/todo.md", insert_line: line, insert_text: "x" }),
      `Error: Invalid \`insert_line\` parameter: ${line}. It should be within the range of lines of the file: [0, 2]`);
  }
  assert.equal(await c.error({ command: "insert", path: "/memories/todo.md", insert_line: 1 }), "Error: insert needs insert_text, the text to insert.");
  assert.equal(c.fake.text("/memories/todo.md"), "- Call Priya\n- Send the deck\n");
});

// ── delete ────────────────────────────────────────────────────────────────────
test("delete takes a file or a whole directory", async () => {
  const c = claude();
  c.put({ "/memories/notes.md": "n", "/memories/projects/a.md": "a", "/memories/projects/sub/b.md": "b", "/memories/projects-2.md": "p" });
  c.put(Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`/memories/log/${i}.md`, "x"])));
  assert.equal(await c.ok({ command: "delete", path: "/memories/notes.md" }), "Successfully deleted /memories/notes.md");
  assert.equal(await c.ok({ command: "delete", path: "/memories/projects" }), "Successfully deleted /memories/projects");
  assert.equal(await c.ok({ command: "delete", path: "/memories/log/" }), "Successfully deleted /memories/log");
  assert.deepEqual([...c.fake.held.keys()], ["/memories/projects-2.md"], "a sibling that only starts the same stays");
  assert.equal(await c.error({ command: "delete", path: "/memories/nope" }), "Error: The path /memories/nope does not exist");
});

test("the memory directory itself cannot be deleted or renamed", async () => {
  const c = claude();
  c.put({ "/memories/notes.md": "n" });
  for (const root of ["/memories", "/memories/", "//memories//"]) {
    assert.equal(await c.error({ command: "delete", path: root }), "Error: Cannot delete the /memories directory itself");
    assert.equal(await c.error({ command: "rename", old_path: root, new_path: "/memories/x" }), "Error: Cannot rename the /memories directory itself");
  }
  assert.equal(c.fake.text("/memories/notes.md"), "n");
});

// ── rename ────────────────────────────────────────────────────────────────────
test("rename moves a file without learning it again", async () => {
  const c = claude();
  await c.ok({ command: "create", path: "/memories/draft.md", file_text: "Lumen renews in March.\n" });
  const puts = () => c.fake.calls.filter((call) => call.method === "PUT").length;
  const before = puts();
  assert.equal(await c.ok({ command: "rename", old_path: "/memories/draft.md", new_path: "/memories/final.md" }),
    "Successfully renamed /memories/draft.md to /memories/final.md");
  assert.equal(c.fake.text("/memories/final.md"), "Lumen renews in March.\n");
  assert.equal(c.fake.held.has("/memories/draft.md"), false);
  assert.equal(puts(), before, "moved, not written again");
  assert.deepEqual(c.fake.calls.filter((call) => call.method === "POST").map((call) => call.body), [{ from: "/memories/draft.md", to: "/memories/final.md" }]);
});

test("rename moves a whole directory", async () => {
  const c = claude();
  c.put({ "/memories/drafts/x.md": "x", "/memories/drafts/y/z.md": "z", "/memories/keep.md": "k" });
  assert.equal(await c.ok({ command: "rename", old_path: "/memories/drafts", new_path: "/memories/archive/2026" }),
    "Successfully renamed /memories/drafts to /memories/archive/2026");
  assert.deepEqual([...c.fake.held.keys()].sort(), ["/memories/archive/2026/x.md", "/memories/archive/2026/y/z.md", "/memories/keep.md"]);
});

test("rename refuses a missing source and a taken destination", async () => {
  const c = claude();
  c.put({ "/memories/a.md": "a", "/memories/b.md": "b", "/memories/dir/c.md": "c" });
  const rename = (old_path, new_path) => c.error({ command: "rename", old_path, new_path });
  assert.equal(await rename("/memories/nope.md", "/memories/new.md"), "Error: The path /memories/nope.md does not exist");
  assert.equal(await rename("/memories/a.md", "/memories/b.md"), "Error: The destination /memories/b.md already exists");
  assert.equal(await rename("/memories/a.md", "/memories/dir"), "Error: The destination /memories/dir already exists", "a directory is taken too");
  assert.equal(await rename("/memories/dir", "/memories/a.md"), "Error: The destination /memories/a.md already exists");
  assert.equal(await rename("/memories/a.md", "/memories"), "Error: The destination /memories already exists");
  assert.equal(await rename("/memories/dir", "/memories/dir/inner"), "Error: Cannot rename /memories/dir to /memories/dir/inner, a path inside it");
  assert.deepEqual([...c.fake.held.keys()].sort(), ["/memories/a.md", "/memories/b.md", "/memories/dir/c.md"], "nothing moved");
});

test("a destination taken meanwhile is still reported as taken", async () => {
  // Between the check and the move another writer can take the path: the API's conflict says the same.
  const c = claude();
  c.put({ "/memories/a.md": "a" });
  const real = c.fake.move;
  c.fake.move = (from, to) => {
    c.put({ [to]: "theirs" });
    return real(from, to);
  };
  assert.equal(await c.error({ command: "rename", old_path: "/memories/a.md", new_path: "/memories/b.md" }), "Error: The destination /memories/b.md already exists");
  assert.equal(c.fake.text("/memories/b.md"), "theirs");
  assert.equal(c.fake.text("/memories/a.md"), "a");
});

// ── clearAllMemory, paths, and the rest ───────────────────────────────────────
test("clearing all memory leaves files outside it", async () => {
  const c = claude();
  c.put(Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`/memories/n${i}.md`, "x"])));
  c.put({ "/docs/readme.md": "Your own file.", "/memories-old/x.md": "y" });
  assert.equal(await clearAllMemory(c.mem), "All memory cleared");
  assert.deepEqual([...c.fake.held.keys()].sort(), ["/docs/readme.md", "/memories-old/x.md"]);
  assert.equal(await c.ok({ command: "view", path: "/memories" }), `${HEADER("/memories")}\n0B\t/memories`);
});

const TRAVERSAL = ["/memories/../secrets.env", "/memories/notes/../../etc/passwd", "/memories/../memories/notes.md",
  "/memories/%2e%2e/secrets.env", "/memories/%2E%2E%2Fsecrets.env", "/memories/%252e%252e/secrets.env",
  "/memories/..%5csecrets.env", "/memories\\..\\secrets.env", "/memories/./notes.md",
  "/memories/notes\u0000.md", "/memories/notes%00.md", "/memories/a\nb.md"];
const OUTSIDE = ["/etc/passwd", "/memoriesX/notes.md", "memories/notes.md", "", "/", "/memorie", null, undefined, 42];

test("no command reaches outside /memories", async () => {
  for (const path of [...TRAVERSAL, ...OUTSIDE]) {
    const c = claude();
    const commands = [{ command: "view", path }, { command: "create", path, file_text: "x" },
      { command: "str_replace", path, old_str: "a", new_str: "b" }, { command: "insert", path, insert_line: 0, insert_text: "x" },
      { command: "delete", path }, { command: "rename", old_path: path, new_path: "/memories/x.md" },
      { command: "rename", old_path: "/memories/x.md", new_path: path }];
    for (const command of commands) {
      const said = await c.error(command);
      assert.ok(said.startsWith(`Error: The path ${path} `), said);
      assert.ok(OUTSIDE.includes(path) ? said.includes("outside /memories") : said.includes("is not allowed"), said);
    }
    assert.deepEqual(c.fake.calls, [], `refused before anything was asked of Geniffy: ${JSON.stringify(path)}`);
  }
});

test("the refusal messages say what to do", async () => {
  const c = claude();
  assert.equal(await c.error({ command: "view", path: "/memories/../secrets.env" }),
    "Error: The path /memories/../secrets.env is not allowed: a memory path has no '.' or '..' parts, backslashes or " +
    "control characters. Use a plain path such as /memories/notes.md.");
  assert.equal(await c.error({ command: "view", path: "/etc/passwd" }),
    "Error: The path /etc/passwd is outside /memories. Use a path under it, such as /memories/notes.md.");
});

test("a path as long as paths go works like any other", async () => {
  // Nothing can be under a 255-character path, so it is never asked for as a prefix one character too long.
  const c = claude();
  const longest = `/memories/${"a".repeat(245)}`;
  assert.equal(await c.ok({ command: "create", path: longest, file_text: "x" }), `File created successfully at: ${longest}`);
  assert.match(await c.ok({ command: "rename", old_path: longest, new_path: "/memories/b.md" }), /^Successfully renamed/);
  assert.match(await c.ok({ command: "rename", old_path: "/memories/b.md", new_path: longest }), /^Successfully renamed/);
  assert.equal(await c.ok({ command: "delete", path: longest }), `Successfully deleted ${longest}`);
  assert.equal(await c.error({ command: "view", path: longest }), `The path ${longest} does not exist. Please provide a valid path.`);
  assert.ok(c.fake.calls.every((call) => chars(call.params.prefix ?? "") <= 255));
});

test("what Geniffy refuses goes back to Claude in its words", async () => {
  const c = claude();
  c.fake.limit = 20;
  assert.equal(await c.error({ command: "create", path: "/memories/long.md", file_text: "x".repeat(21) }), "Error: A file holds up to 20 characters.");
  assert.equal(await c.error({ command: "create", path: `/memories/${"a".repeat(250)}`, file_text: "x" }), "Error: That is not a file path.");
  assert.equal(c.fake.held.has("/memories/long.md"), false);
});

test("a failure of Geniffy itself is not Claude's to read: it rejects with the Geniffy error", async () => {
  const mem = new Geniffy({ apiKey: KEY, baseURL: "https://api.test", maxRetries: 0,
    fetch: async () => refused(401, "bad_key", "This key doesn't work. It may have been revoked.") });
  await assert.rejects(betaMemoryTool(geniffyMemoryHandlers(mem)).run({ command: "view", path: "/memories" }), AuthenticationError);
});

test("every call stays in the user's space, and every write is labelled", async () => {
  const c = claude();
  await c.ok({ command: "create", path: "/memories/a.md", file_text: "a\n" });
  await c.ok({ command: "str_replace", path: "/memories/a.md", old_str: "a", new_str: "b" });
  await c.ok({ command: "insert", path: "/memories/a.md", insert_line: 1, insert_text: "c" });
  await c.ok({ command: "view", path: "/memories" });
  await c.ok({ command: "rename", old_path: "/memories/a.md", new_path: "/memories/b.md" });
  await c.ok({ command: "delete", path: "/memories/b.md" });
  assert.ok(c.fake.calls.length && c.fake.calls.every((call) => call.space === "customer_1042"));
  const puts = c.fake.calls.filter((call) => call.method === "PUT").map((call) => call.body);
  assert.equal(puts.length, 3);
  assert.ok(puts.every((body) => JSON.stringify(body.labels) === '{"channel":"claude-memory"}'));
});

test("a file past the line limit is not shown", async () => {
  const c = claude();
  c.put({ "/memories/huge.md": "\n".repeat(1_000_000) });
  assert.equal(await c.error({ command: "view", path: "/memories/huge.md" }), "File /memories/huge.md exceeds maximum line limit of 999,999 lines.");
});

// ── one command at a time ─────────────────────────────────────────────────────
// Each call to Geniffy takes a round trip, as it does over the network: what two commands side by side need to lose
// an edit.
function slowClaude(ms = 10) {
  const fake = new FakeFiles();
  const fetch = async (url, init) => {
    await new Promise((done) => setTimeout(done, ms));
    return fake.fetch(url, init);
  };
  const mem = new Geniffy({ apiKey: KEY, baseURL: "https://api.test", fetch, maxRetries: 0 }).space("customer_1042");
  return { fake, mem, tool: betaMemoryTool(geniffyMemoryHandlers(mem)) };
}

test("the edits of one reply all land, one after another", async () => {
  // The tool runner runs every tool call of a reply at once. Side by side, two edits to one file each read the old
  // text, and the second write dropped the first edit while both told Claude it was done (review, 6 Oct 2026).
  const { fake, tool } = slowClaude();
  fake.held.set("/memories/progress.md", { text: "- step 1: todo\n- step 2: todo\n", labels: {}, updated_at: "2026-10-06T08:00:00Z" });
  const said = await Promise.all([
    tool.run({ command: "str_replace", path: "/memories/progress.md", old_str: "step 1: todo", new_str: "step 1: done" }),
    tool.run({ command: "str_replace", path: "/memories/progress.md", old_str: "step 2: todo", new_str: "step 2: done" }),
    tool.run({ command: "insert", path: "/memories/progress.md", insert_line: 2, insert_text: "- step 3: todo" }),
  ]);
  assert.ok(said.slice(0, 2).every((s) => s.startsWith("The memory file has been edited.")), said.join("\n"));
  assert.equal(said[2], "The file /memories/progress.md has been edited.");
  assert.equal(fake.text("/memories/progress.md"), "- step 1: done\n- step 2: done\n- step 3: todo\n");
  assert.deepEqual(fake.calls.map((call) => call.method), ["GET", "PUT", "GET", "PUT", "GET", "PUT"],
    "each command reads what the one before it wrote");
});

test("a command that fails does not hold up the next", async () => {
  const { fake, tool } = slowClaude();
  fake.held.set("/memories/a.md", { text: "a\n", labels: {}, updated_at: "2026-10-06T08:00:00Z" });
  const [missing, renamed, viewed] = await Promise.allSettled([
    tool.run({ command: "str_replace", path: "/memories/a.md", old_str: "zzz", new_str: "y" }),
    tool.run({ command: "rename", old_path: "/memories/a.md", new_path: "/memories/b.md" }),
    tool.run({ command: "view", path: "/memories/b.md" }),
  ]);
  assert.ok(missing.reason instanceof ToolError);
  assert.equal(missing.reason.content, "No replacement was performed, old_str `zzz` did not appear verbatim in /memories/a.md.");
  assert.equal(renamed.value, "Successfully renamed /memories/a.md to /memories/b.md");
  assert.equal(viewed.value, "Here's the content of /memories/b.md with line numbers:\n     1\ta");
});

test("each set of handlers keeps its own order, and does not wait on another's", async () => {
  const one = slowClaude(30);
  const two = slowClaude(1);
  one.fake.held.set("/memories/a.md", { text: "a\n", labels: {}, updated_at: "2026-10-06T08:00:00Z" });
  two.fake.held.set("/memories/a.md", { text: "a\n", labels: {}, updated_at: "2026-10-06T08:00:00Z" });
  const finished = [];
  await Promise.all([
    one.tool.run({ command: "view", path: "/memories/a.md" }).then(() => finished.push("slow")),
    two.tool.run({ command: "view", path: "/memories/a.md" }).then(() => finished.push("quick")),
  ]);
  assert.deepEqual(finished, ["quick", "slow"]);
});

// ── with the SDK's own tool runner ────────────────────────────────────────────
test("the tool runner sends each answer back to Claude, and what cannot be done as an error", async () => {
  const c = claude();
  const sent = [];
  const turns = [
    [{ type: "tool_use", id: "toolu_1", name: "memory", input: { command: "view", path: "/memories" } }],
    [{ type: "tool_use", id: "toolu_2", name: "memory", input: { command: "create", path: "/memories/prefs.md", file_text: "Prefers email follow-ups.\n" } },
      { type: "tool_use", id: "toolu_3", name: "memory", input: { command: "view", path: "/memories/../.env" } }],
    [{ type: "text", text: "Noted." }],
  ];
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY, maxRetries: 0, fetch: async (url, init) => {
    sent.push(JSON.parse(init.body));
    const content = turns[sent.length - 1];
    return reply(200, { id: `msg_${sent.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", content,
      stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const final = await anthropic.beta.messages.toolRunner({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    tools: [betaMemoryTool(geniffyMemoryHandlers(c.mem))],
    messages: [{ role: "user", content: "Remember that I prefer email follow-ups." }],
  });
  assert.equal(final.content[0].text, "Noted.");
  assert.deepEqual(sent[0].tools, [{ type: "memory_20250818", name: "memory" }], "declared as Claude's memory tool");
  const results = (i) => sent[i].messages.at(-1).content.map(({ tool_use_id, content, is_error }) => ({ tool_use_id, content, is_error }));
  assert.deepEqual(results(1), [{ tool_use_id: "toolu_1", content: `${HEADER("/memories")}\n0B\t/memories`, is_error: undefined }]);
  assert.deepEqual(results(2), [
    { tool_use_id: "toolu_2", content: "File created successfully at: /memories/prefs.md", is_error: undefined },
    { tool_use_id: "toolu_3", is_error: true, content: "Error: The path /memories/../.env is not allowed: a memory path has no '.' or " +
      "'..' parts, backslashes or control characters. Use a plain path such as /memories/notes.md." },
  ]);
  assert.equal(c.fake.text("/memories/prefs.md"), "Prefers email follow-ups.\n");
});

test("two edits to one file in one reply both land through the tool runner", async () => {
  const { fake, mem } = slowClaude();
  fake.held.set("/memories/progress.md", { text: "- step 1: todo\n- step 2: todo\n", labels: {}, updated_at: "2026-10-06T08:00:00Z" });
  const sent = [];
  const edit = (id, step) => ({ type: "tool_use", id, name: "memory",
    input: { command: "str_replace", path: "/memories/progress.md", old_str: `step ${step}: todo`, new_str: `step ${step}: done` } });
  const turns = [[edit("toolu_1", 1), edit("toolu_2", 2)], [{ type: "text", text: "Both recorded." }]];
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY, maxRetries: 0, fetch: async (url, init) => {
    sent.push(JSON.parse(init.body));
    const content = turns[sent.length - 1];
    return reply(200, { id: `msg_${sent.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", content,
      stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const final = await anthropic.beta.messages.toolRunner({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    tools: [betaMemoryTool(geniffyMemoryHandlers(mem))],
    messages: [{ role: "user", content: "Steps 1 and 2 are done." }],
  });
  assert.equal(final.content[0].text, "Both recorded.");
  const results = sent[1].messages.at(-1).content;
  assert.deepEqual(results.map((r) => [r.tool_use_id, r.is_error, r.content.split("\n")[0]]), [
    ["toolu_1", undefined, "The memory file has been edited. Here is the snippet showing the change (with line numbers):"],
    ["toolu_2", undefined, "The memory file has been edited. Here is the snippet showing the change (with line numbers):"]]);
  assert.equal(fake.text("/memories/progress.md"), "- step 1: done\n- step 2: done\n", "what Claude was told is what is kept");
});

test("the handlers are the six commands and nothing else, and need a Geniffy client", () => {
  const handlers = geniffyMemoryHandlers(claude().mem);
  assert.deepEqual(Object.keys(handlers), ["view", "create", "str_replace", "insert", "delete", "rename"]);
  assert.equal(Object.getPrototypeOf(handlers), null, "a command named constructor or toString finds nothing");
  assert.equal("clear_all_memory" in handlers, false, "Claude cannot clear the memory");
  assert.equal(ROOT, "/memories");
  assert.throws(() => { LABELS.channel = "other"; }, TypeError);
  for (const wrong of [undefined, null, {}, { files: {} }]) {
    assert.throws(() => geniffyMemoryHandlers(wrong), { name: "TypeError", message: /Geniffy client/ });
  }
});

test("geniffy loads nothing from @anthropic-ai/sdk, and geniffy/claude only ToolError", () => {
  const imports = (file) => [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[0]);
  assert.deepEqual(imports("../dist/index.js"), []);
  assert.deepEqual(imports("../dist/claude.js"), ['import { ToolError } from "@anthropic-ai/sdk/resources/beta/messages";',
    'import { BadRequestError, NotFoundError } from "./index.js";']);
});
