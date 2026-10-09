// An agent's session saved as it goes, and this month's use: sessions send only what is new, into one memory for
// the whole session; usage reads the month, and a used-up month is its own error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Geniffy, GeniffyError, UsageLimitError } from "../dist/index.js";

const KEY = "gnf_live_" + "k".repeat(43);
const SOURCE = { id: "a".repeat(32), kind: "note", title: "Refund agent", status: "reading" };
const MONTH = { plan: "pro", period_start: "2026-10-07T00:00:00+00:00", period_end: "2026-11-07T00:00:00+00:00",
                trial: false, learned_tokens: 600_000, included_tokens: 2_000_000, waiting_tokens: 3_000,
                answers: 120, included_answers: 1_000, extra_on: true, extra_cap_usd: 20, extra_used_usd: 0,
                state: "ok" };

function make(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : {} });
    const [status, body] = answer ? answer(u.pathname) : [201, { source: SOURCE }];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { g: new Geniffy({ apiKey: KEY, baseURL: "https://api.test", fetch, maxRetries: 2 }), calls };
}

const turn = (i) => [{ role: "user", content: `Question ${i}` }, { role: "assistant", content: `Answer ${i}` }];

test("a session's turn goes to one memory for the whole session", async () => {
  const { g, calls } = make();
  const src = await g.memories.add({ messages: turn(1), session: "run-42", title: "Refund agent" });
  assert.equal(src.id, "a".repeat(32));
  assert.deepEqual(calls, [{ method: "POST", path: "/v1/memories",
                             body: { messages: turn(1), session: "run-42", title: "Refund agent" } }]);
});

test("what does not go with a session is refused before anything is sent", async () => {
  const { g, calls } = make();
  await assert.rejects(g.memories.add({ text: "hi", session: "s" }), /goes with messages/);
  await assert.rejects(g.memories.add({ messages: turn(1), session: "s", externalId: "e" }), /not both/);
  await assert.rejects(g.memories.add({ messages: turn(1), session: "s", saidAt: "2026-10-01" }), /dated as it arrives/);
  assert.equal(calls.length, 0);
});

test("save sends only what is new since the last save", async () => {
  const { g, calls } = make();
  const run = g.session("run-42", { title: "Refund agent", labels: { project: "refunds" } });
  const history = turn(1);
  await run.save(history);
  history.push(...turn(2));
  await run.save(history);
  assert.equal(await run.save(history), null, "nothing new: nothing sent");
  assert.deepEqual(calls.map((c) => c.body.messages), [turn(1), turn(2)]);
  assert.ok(calls.every((c) => c.body.session === "run-42" && c.body.labels.project === "refunds"));
});

test("the same message built another way is still the same message", async () => {
  const { g, calls } = make();
  const run = g.session("run-3");
  await run.save([{ role: "user", content: "Hi" }]);
  await run.save([{ content: "Hi", role: "user" }, { role: "assistant", content: "Hello" }]);
  assert.deepEqual(calls.map((c) => c.body.messages.length), [1, 1]);
});

test("a rewritten conversation is saved again rather than lost", async () => {
  const { g, calls } = make();
  const run = g.session("run-7");
  await run.save([...turn(1), ...turn(2)]);
  const compacted = [{ role: "user", content: "Summary of turns 1 and 2" }, ...turn(3)];
  await run.save(compacted);
  assert.deepEqual(calls[1].body.messages, compacted);
});

test("a long session goes five hundred messages a call", async () => {
  const { g, calls } = make();
  const run = g.session("big");
  const history = Array.from({ length: 400 }, (_, i) => turn(i)).flat();   // 800 messages
  await run.save(history);
  assert.deepEqual(calls.map((c) => c.body.messages.length), [500, 300]);
  history.push(...turn(400));
  await run.save(history);
  assert.equal(calls.at(-1).body.messages.length, 2);
});

test("usage says what the month comes to, and a used-up month is its own error, not retried", async () => {
  const { g, calls } = make((path) => path === "/v1/usage" ? [200, MONTH]
    : [402, { error: { code: "allowance_used", message: "This month's free credit is used." } }]);
  assert.deepEqual(await g.usage(), MONTH);
  await assert.rejects(g.memories.add("One more thing to remember."), (e) =>
    e instanceof UsageLimitError && e instanceof GeniffyError && e.status === 402 && e.code === "allowance_used");
  assert.equal(calls.filter((c) => c.path === "/v1/memories").length, 1);
});
