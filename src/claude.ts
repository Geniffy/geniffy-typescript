/**
 * Claude's memory tool, stored in Geniffy.
 *
 *   import Anthropic from "@anthropic-ai/sdk";
 *   import { betaMemoryTool } from "@anthropic-ai/sdk/helpers/beta/memory";
 *   import { Geniffy } from "geniffy";
 *   import { geniffyMemoryHandlers } from "geniffy/claude";
 *
 *   const mem = new Geniffy().space("customer_1042");      // one of your users
 *   const message = await new Anthropic().beta.messages.toolRunner({
 *     model: "claude-opus-5-5",
 *     max_tokens: 16000,
 *     tools: [betaMemoryTool(geniffyMemoryHandlers(mem))],
 *     messages: [{ role: "user", content: "Remember that I prefer email follow-ups." }],
 *   });
 *
 * Claude's memory tool (type memory_20250818) keeps notes as files under /memories and needs each one back exactly as
 * it wrote it. These handlers keep them as files in a Geniffy memory: the text comes back character for character,
 * and Geniffy also learns from it like a note, so context() and ask() recall what Claude wrote anywhere else in your
 * app. Deleting a file takes back what only it taught.
 *
 * Needs @anthropic-ai/sdk 0.72 or later (npm install @anthropic-ai/sdk); `geniffy` itself does not. Every file the
 * tool writes carries LABELS. A directory is every file whose path starts with it, and its size is what they hold;
 * sizes are in characters. Each command answers with the sentences Anthropic's memory tool documentation gives, the
 * same as geniffy.claude in Python; a command that cannot be done throws the SDK's ToolError with that sentence, so
 * the tool runner sends it back to Claude as an error result.
 */

import { ToolError } from "@anthropic-ai/sdk/resources/beta/messages";
import { BadRequestError, NotFoundError } from "./index.js";
import type { FileEntry, Files, Geniffy, Labels, MemoryFile } from "./index.js";

/** The memory tool's commands, as Claude sends them. */
export interface MemoryViewCommand {
  command: "view";
  path: string;
  /** [start_line, end_line], 1-indexed; [start_line, -1] is the rest of the file */
  view_range?: number[];
}
export interface MemoryCreateCommand {
  command: "create";
  path: string;
  file_text: string;
}
export interface MemoryStrReplaceCommand {
  command: "str_replace";
  path: string;
  old_str: string;
  /** left out, old_str is deleted */
  new_str?: string;
}
export interface MemoryInsertCommand {
  command: "insert";
  path: string;
  /** the line to insert after; 0 is before the first */
  insert_line: number;
  insert_text: string;
}
export interface MemoryDeleteCommand {
  command: "delete";
  path: string;
}
export interface MemoryRenameCommand {
  command: "rename";
  old_path: string;
  new_path: string;
}
export type MemoryCommand = MemoryViewCommand | MemoryCreateCommand | MemoryStrReplaceCommand | MemoryInsertCommand
  | MemoryDeleteCommand | MemoryRenameCommand;

/** A handler for each command: what `betaMemoryTool` takes. Each resolves to the tool result's text. A command that
 *  cannot be done rejects with the SDK's ToolError, whose `content` is the sentence for Claude; a failure of Geniffy
 *  itself (a revoked key, no connection) rejects with its GeniffyError. */
export interface GeniffyMemoryHandlers {
  view(command: MemoryViewCommand): Promise<string>;
  create(command: MemoryCreateCommand): Promise<string>;
  str_replace(command: MemoryStrReplaceCommand): Promise<string>;
  insert(command: MemoryInsertCommand): Promise<string>;
  delete(command: MemoryDeleteCommand): Promise<string>;
  rename(command: MemoryRenameCommand): Promise<string>;
}

export const ROOT = "/memories";
/** On every file the tool writes, so a read can keep to what Claude wrote: `{ labels: LABELS }`. */
export const LABELS: Readonly<Labels> = Object.freeze({ channel: "claude-memory" });
const PAGE = 200;            // the most files one listing returns
const PAGES = 1000;          // the most pages one view reads, so a listing that keeps going cannot loop for ever
const MAX_PATH = 255;        // the longest path Geniffy keeps
const MAX_LINES = 999_999;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function filesOf(memory: Geniffy): Files {
  const files = (memory as { files?: Files } | null | undefined)?.files;
  if (!files || typeof files.get !== "function") {
    throw new TypeError("Pass a Geniffy client: client.space(userId) for one of your users, or the client itself for your own memory.");
  }
  return files;
}

/**
 * Claude's memory tool, kept in a Geniffy memory: `betaMemoryTool(geniffyMemoryHandlers(client.space(userId)))` in
 * the tools of `client.beta.messages.toolRunner`.
 *
 * `memory` is a Geniffy client bound to one of your users with client.space(userId), so each user's Claude keeps its
 * own notes, or the client itself for your own memory. Claude's files are that memory's files under /memories, each
 * labelled { channel: "claude-memory" }: mem.files.list({ prefix: "/memories/" }) lists them, and context() and ask()
 * recall what they say.
 *
 * The handlers run one command at a time, in the order they are called, so the edits of one reply all land. Use one
 * set of handlers for each conversation: two sets editing the same user's files at once can still overwrite each
 * other's edits, as two editors of one file would.
 */
export function geniffyMemoryHandlers(memory: Geniffy): GeniffyMemoryHandlers {
  const files = filesOf(memory);

  async function read(path: string): Promise<MemoryFile | null> {
    if (path === ROOT) return null;
    try {
      return await files.get(path);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  }

  async function under(path: string): Promise<FileEntry[]> {
    const found: FileEntry[] = [];
    let cursor = 0;
    for (let page = 0; page < (holdsFiles(path) ? PAGES : 0); page++) {
      const listed = await files.list({ prefix: `${path}/`, limit: PAGE, cursor });
      found.push(...listed.files);
      if (listed.next === null || listed.next === undefined) break;
      cursor = listed.next;
    }
    return found;
  }

  // A file at path, or a directory: files under it.
  async function exists(path: string): Promise<boolean> {
    if (path === ROOT || (await read(path)) !== null) return true;
    return holdsFiles(path) && (await files.list({ prefix: `${path}/`, limit: 1 })).files.length > 0;
  }

  const put = (path: string, text: string) => files.put(path, text, { labels: { ...LABELS } });

  async function view(c: MemoryViewCommand): Promise<string> {
    const path = memoryPath(c?.path);
    const found = await read(path);
    if (found) return showFile(path, found.text, c.view_range);
    const held = await under(path);
    if (!held.length && path !== ROOT) throw new ToolError(`The path ${path} does not exist. Please provide a valid path.`);
    return showDirectory(path, held);
  }

  async function create(c: MemoryCreateCommand): Promise<string> {
    const path = memoryPath(c?.path);
    if (path === ROOT) {
      throw new ToolError(`Error: ${ROOT} is the memory directory itself. Create files inside it, such as ${ROOT}/notes.md.`);
    }
    if (typeof c.file_text !== "string") throw new ToolError("Error: create needs file_text, the whole text of the file.");
    await put(path, c.file_text);
    return `File created successfully at: ${path}`;
  }

  async function strReplace(c: MemoryStrReplaceCommand): Promise<string> {
    const path = memoryPath(c?.path);
    const found = await read(path);
    if (!found) throw new ToolError(`Error: The path ${path} does not exist. Please provide a valid path.`);
    const [text, said] = replaced(path, found.text, c.old_str, c.new_str);
    await put(path, text);
    return said;
  }

  async function insert(c: MemoryInsertCommand): Promise<string> {
    const path = memoryPath(c?.path);
    const found = await read(path);
    if (!found) throw noFile(path);
    await put(path, inserted(found.text, c.insert_line, c.insert_text));
    return `The file ${path} has been edited.`;
  }

  async function remove(c: MemoryDeleteCommand): Promise<string> {
    const path = memoryPath(c?.path);
    if (path === ROOT) throw new ToolError(`Error: Cannot delete the ${ROOT} directory itself`);
    let found = true;
    try {
      await files.delete(path);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      found = false;
    }
    if (holdsFiles(path)) found = (await files.deletePrefix(`${path}/`)) > 0 || found;   // a directory too: nothing is left at that path
    if (!found) throw noFile(path);
    return `Successfully deleted ${path}`;
  }

  async function rename(c: MemoryRenameCommand): Promise<string> {
    const old = memoryPath(c?.old_path);
    const to = memoryPath(c?.new_path);
    if (old === ROOT) throw new ToolError(`Error: Cannot rename the ${ROOT} directory itself`);
    if (to.startsWith(`${old}/`)) throw new ToolError(`Error: Cannot rename ${old} to ${to}, a path inside it`);
    if (await exists(to)) throw taken(to);
    try {
      await files.move(old, to);            // the text and what was learned go with it; nothing is learned again
    } catch (e) {
      if (e instanceof NotFoundError) throw noFile(old);
      if (e instanceof BadRequestError && e.status === 409) throw taken(to);   // taken meanwhile
      throw e;
    }
    return `Successfully renamed ${old} to ${to}`;
  }

  // One command at a time, in the order they came. The tool runner runs every tool call of a reply at once
  // (Promise.all), and an edit is a read and then a write: two edits to one file side by side would both read the
  // old text, the second write would drop the first edit, and both would tell Claude it was done. A command that
  // fails does not hold up the next.
  let queue: Promise<unknown> = Promise.resolve();
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const done = queue.then(work);
    queue = done.catch(() => undefined);
    return done;
  }

  // betaMemoryTool looks a handler up by the command's name, so the object has no prototype: nothing but these six
  // answers to a name Claude sends.
  return Object.assign(Object.create(null) as object, {
    view: (c: MemoryViewCommand) => inTurn(() => refusing(() => view(c))),
    create: (c: MemoryCreateCommand) => inTurn(() => refusing(() => create(c))),
    str_replace: (c: MemoryStrReplaceCommand) => inTurn(() => refusing(() => strReplace(c))),
    insert: (c: MemoryInsertCommand) => inTurn(() => refusing(() => insert(c))),
    delete: (c: MemoryDeleteCommand) => inTurn(() => refusing(() => remove(c))),
    rename: (c: MemoryRenameCommand) => inTurn(() => refusing(() => rename(c))),
  });
}

/** Delete every file under /memories, and what only they taught: for your app to call, such as when a user resets
 *  their assistant. It is not one of the tool's commands, so Claude cannot call it. */
export async function clearAllMemory(memory: Geniffy): Promise<string> {
  const files = filesOf(memory);
  await refusing(() => files.deletePrefix(`${ROOT}/`));
  return "All memory cleared";
}

// A request Geniffy refused as sent (a path or a text too long, say) goes back to Claude in Geniffy's words.
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof BadRequestError) throw new ToolError(`Error: ${e.message}`);
    throw e;
  }
}

const noFile = (path: string) => new ToolError(`Error: The path ${path} does not exist`);
const taken = (path: string) => new ToolError(`Error: The destination ${path} already exists`);

// ── paths ─────────────────────────────────────────────────────────────────────
const outside = (path: unknown) =>
  new ToolError(`Error: The path ${path} is outside /memories. Use a path under it, such as /memories/notes.md.`);

// The path as Geniffy keeps it: /memories or a path under it, with doubled and trailing slashes dropped. Anything that
// could lead out of /memories is refused, typed plainly or URL-encoded, however often.
function memoryPath(path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("/")) throw outside(path);
  for (let form = path; ; ) {
    if (form.includes("\\") || CONTROL.test(form) || form.split("/").some((part) => part === "." || part === "..")) {
      throw new ToolError(`Error: The path ${path} is not allowed: a memory path has no '.' or '..' parts, ` +
        "backslashes or control characters. Use a plain path such as /memories/notes.md.");
    }
    const decoded = unquote(form);         // %2e%2e, and %252e%252e encoded again; each decoding is shorter
    if (decoded === form) break;
    form = decoded;
  }
  const clean = `/${path.split("/").filter(Boolean).join("/")}`;
  if (clean !== ROOT && !clean.startsWith(`${ROOT}/`)) throw outside(path);
  return clean;
}

// %XX escapes decoded as UTF-8, a byte that is not one left as U+FFFD, and anything else kept: Python's unquote, so a
// path is refused or kept here exactly as geniffy.claude does it.
function unquote(text: string): string {
  if (!text.includes("%")) return text;
  return text.replace(/[\u0000-\u007f]+/g, (ascii) => {
    if (!ascii.includes("%")) return ascii;
    const bytes: number[] = [];
    for (let i = 0; i < ascii.length; i++) {
      const hex = ascii.slice(i + 1, i + 3);
      if (ascii[i] === "%" && /^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(ascii.charCodeAt(i));
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  });
}

// Whether any file can be under path: one under it is longer by "/" and a name, at least two characters.
const holdsFiles = (path: string) => [...path].length + 2 <= MAX_PATH;

// ── what each command says ────────────────────────────────────────────────────
// A size as the memory tool shows one: 0B, 512B, 1.5K, 2M. One decimal rounds a tie to even (1.25K is 1.2K), as
// Python's format does.
function size(chars: number): string {
  if (!(chars > 0)) return "0B";
  let unit = 0;
  while (unit < 3 && chars >= 1024 ** (unit + 1)) unit++;
  const n = chars / 1024 ** unit;
  if (Number.isInteger(n)) return `${n}${"BKMG"[unit]}`;
  const tenths = n * 10;                   // exact: a whole number of characters over a power of 2
  let rounded = Math.round(tenths);
  if (tenths - Math.floor(tenths) === 0.5 && rounded % 2) rounded--;
  return `${(rounded / 10).toFixed(1)}${"BKMG"[unit]}`;
}

// A text's lines, split at each newline. The newline that ends the last line starts no new one, so view and insert
// count lines the same way.
function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const numbered = (n: number, line: string) => `${String(n).padStart(6, " ")}\t${line}`;
const hidden = (name: string) => name.startsWith(".") || name === "node_modules";

interface Listed {
  names: string[];
  directory: boolean;
  size: number;
}

// Names first (each in turn, a shorter list before a longer one that starts the same), then a file before a
// directory: how Python sorts the (names, is a directory) pairs geniffy.claude lists.
function byPath(a: Listed, b: Listed): number {
  for (let i = 0; i < Math.min(a.names.length, b.names.length); i++) {
    if (a.names[i] !== b.names[i]) return byCodePoint(a.names[i], b.names[i]);
  }
  return a.names.length - b.names.length || Number(a.directory) - Number(b.directory);
}

// Two names in code point order, as Python compares them and Geniffy lists paths. JavaScript's < compares UTF-16
// units, which puts a name with an emoji (or anything else past U+FFFF) before one with a character from U+E000 to
// U+FFFF. Up to the first unit that differs the two are the same, so the code points there decide; inside a
// surrogate pair the first halves match, and the second halves are in code point order too.
function byCodePoint(a: string, b: string): number {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  if (at === a.length || at === b.length) return a.length - b.length;
  return (a.codePointAt(at) ?? 0) - (b.codePointAt(at) ?? 0);
}

// A directory as view shows one: its own size and path, then everything in it two levels deep, by name, directories
// ending in "/", hidden items and node_modules left out. A directory's size is all it holds.
function showDirectory(path: string, held: FileEntry[]): string {
  const inside = `${path}/`;
  let total = 0;
  const listed = new Map<string, Listed>();
  for (const f of held) {
    if (!f.path.startsWith(inside)) continue;
    total += f.size;
    const names = f.path.slice(inside.length).split("/");
    for (let depth = 0; depth < Math.min(2, names.length); depth++) {
      if (hidden(names[depth])) break;
      const entry: Listed = { names: names.slice(0, depth + 1), directory: depth + 1 < names.length, size: 0 };
      const key = JSON.stringify([entry.names, entry.directory]);
      let known = listed.get(key);
      if (!known) listed.set(key, (known = entry));
      known.size += f.size;
    }
  }
  return [
    `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:`,
    `${size(total)}\t${path}`,
    ...[...listed.values()].sort(byPath).map((e) => `${size(e.size)}\t${inside}${e.names.join("/")}${e.directory ? "/" : ""}`),
  ].join("\n");
}

// A file as view shows one: each line numbered from 1, or only the lines view_range names ([start, -1] for the rest
// of the file).
function showFile(path: string, text: string, range: unknown): string {
  let lines = linesOf(text);
  if (lines.length > MAX_LINES) throw new ToolError(`File ${path} exceeds maximum line limit of 999,999 lines.`);
  let first = 1;
  if (Array.isArray(range) && range.length === 2) {
    if (!range.every((n) => Number.isInteger(n))) {
      throw new ToolError("Error: view_range is [start_line, end_line], such as [1, 20], or [start_line, -1] for the rest of the file.");
    }
    const [start, end] = range as number[];
    first = Math.max(1, start);
    lines = lines.slice(first - 1, end === -1 ? lines.length : end);
  }
  return [`Here's the content of ${path} with line numbers:`, ...lines.map((line, i) => numbered(first + i, line))].join("\n");
}

// str_replace on a file's text: the text after it, and what to tell Claude. new_str left out deletes old_str.
function replaced(path: string, text: string, old: unknown, replacement: unknown): [string, string] {
  if (typeof old !== "string" || !old) {
    throw new ToolError("Error: old_str is missing or empty. Give the exact text to replace, as it appears in the file.");
  }
  let count = 0;
  for (let at = text.indexOf(old); at !== -1; at = text.indexOf(old, at + old.length)) count++;
  if (count === 0) throw new ToolError(`No replacement was performed, old_str \`${old}\` did not appear verbatim in ${path}.`);
  if (count > 1) {
    const starts: number[] = [];
    for (let at = text.indexOf(old); at !== -1; at = text.indexOf(old, at + 1)) starts.push(at);
    throw new ToolError(`No replacement was performed. Multiple occurrences of old_str \`${old}\` in lines: ` +
      `${lineNumbers(text, starts).join(", ")}. Please ensure it is unique`);
  }
  const at = text.indexOf(old);
  // spliced in, not String.replace, which would read $& and $1 in new_str as patterns
  const edited = text.slice(0, at) + (typeof replacement === "string" ? replacement : "") + text.slice(at + old.length);
  const changed = lineNumbers(text, [at])[0] - 1;
  const lines = linesOf(edited);
  const shown: string[] = [];
  for (let n = Math.max(0, changed - 2); n < Math.min(lines.length, changed + 3); n++) shown.push(numbered(n + 1, lines[n]));
  return [edited, ["The memory file has been edited. Here is the snippet showing the change (with line numbers):", ...shown].join("\n")];
}

// insert on a file's text: insert_text as lines of its own after line `line` (0: before the first).
function inserted(text: string, line: unknown, insertText: unknown): string {
  const lines = linesOf(text);
  if (typeof line !== "number" || !Number.isInteger(line) || line < 0 || line > lines.length) {
    throw new ToolError(`Error: Invalid \`insert_line\` parameter: ${line}. It should be within the range of lines of ` +
      `the file: [0, ${lines.length}]`);
  }
  if (typeof insertText !== "string") throw new ToolError("Error: insert needs insert_text, the text to insert.");
  lines.splice(line, 0, insertText.endsWith("\n") ? insertText.slice(0, -1) : insertText);
  const edited = lines.join("\n");
  return edited.endsWith("\n") ? edited : `${edited}\n`;
}

// The 1-indexed line each of these offsets is on; the offsets go up.
function lineNumbers(text: string, offsets: number[]): number[] {
  let line = 1;
  let from = 0;
  return offsets.map((offset) => {
    for (let nl = text.indexOf("\n", from); nl !== -1 && nl < offset; nl = text.indexOf("\n", nl + 1)) line++;
    from = offset;
    return line;
  });
}
