// The briefing doors from TypeScript: the briefing and its parts, where things stand, episodes, lessons and
// intentions, each asking for exactly what the API takes, on a bound space too; and a whole session with its tool
// calls going in as the framework holds it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Geniffy, NotFoundError } from "../dist/index.js";

const KEY = "gnf_live_" + "k".repeat(43);
const STATE = { project: "checkout", goal: "Ship the new checkout", focus: "Payments", open: [{ text: "Refunds", since: null }],
                decisions: [], next_steps: ["Test refunds"], blockers: [], done: [], updated_at: null };
const EPISODE = { id: 5, project: "checkout", title: "Refund test", what_happened: "Refunds failed.", outcome: "Fixed",
                  led_to: null, people: [], decisions: [], started_at: null, ended_at: null,
                  source: { id: "a".repeat(32), kind: "note", title: "Session" } };

function make() {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body,
                 space: new Headers(init.headers).get("x-geniffy-space") });
    const reply = (status, b) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v1/briefing") {
      return reply(200, { project: body.project ?? null, briefing: "Where things stand (checkout):", now: [STATE], due: [],
                          lessons: [], episodes: [EPISODE], memories: [] });
    }
    if (u.pathname === "/v1/now") return reply(200, { now: [STATE] });
    if (u.pathname === "/v1/episodes") return reply(200, { episodes: [EPISODE] });
    if (u.pathname === "/v1/lessons") return reply(200, { lessons: [{ id: 3, statement: "Test refunds before release" }] });
    if (u.pathname === "/v1/intentions") return reply(200, { intentions: [{ id: 7, what: "Revoke the test key", status: "open" }] });
    if (u.pathname === "/v1/memory-health") return reply(200, { health: 0.75, tested_at: null, asked: 2, score: 1.5, items: [] });
    if (u.pathname === "/v1/intentions/7") return reply(200, { intention: { id: 7, what: "Revoke the test key", status: body.status } });
    if (u.pathname === "/v1/memories") return reply(201, { source: { id: "a".repeat(32), kind: "note", title: "Session", status: "reading" } });
    return reply(404, { error: { code: "not_switched_on", message: "Briefings aren't switched on." } });
  };
  return { g: new Geniffy({ apiKey: KEY, baseURL: "https://api.test", fetch }), calls };
}

test("the briefing and every part ask for what the API takes", async () => {
  const { g, calls } = make();
  assert.equal(await g.briefing({ project: "checkout", cue: "refunds fail" }), "Where things stand (checkout):");
  assert.deepEqual(calls.at(-1).body, { project: "checkout", cue: "refunds fail", budget_chars: 6000 });
  const full = await g.briefingFull({ budgetChars: 2000 });
  assert.equal(full.episodes[0].title, "Refund test");
  assert.deepEqual(calls.at(-1).body, { cue: "", budget_chars: 2000 });
  assert.equal((await g.now("checkout"))[0].goal, "Ship the new checkout");
  assert.deepEqual(calls.at(-1).query, { project: "checkout" });
  assert.equal((await g.episodes({ limit: 5 }))[0].outcome, "Fixed");
  assert.deepEqual(calls.at(-1).query, { limit: "5" });
  assert.equal((await g.lessons({ project: "checkout" }))[0].statement, "Test refunds before release");
  assert.equal((await g.intentions())[0].what, "Revoke the test key");
  assert.deepEqual(calls.at(-1).query, { status: "open", limit: "50" });
  assert.equal((await g.setIntention(7)).status, "done");
  assert.deepEqual(calls.at(-1).body, { status: "done" });
  assert.equal((await g.memoryHealth()).health, 0.75);
  await g.space("customer_1042").now();
  assert.equal(calls.at(-1).space, "customer_1042", "a bound client reads its user's own");
  await assert.rejects(g.setIntention(8), NotFoundError);
});

test("a whole session goes in as the framework holds it, tool calls and results included", async () => {
  const { g, calls } = make();
  const messages = [
    { role: "user", content: "Refund order 42." },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "refund", arguments: "{\"order\":42}" } }] },
    { role: "tool", tool_call_id: "c1", content: "refunded" },
    { role: "assistant", content: "Order 42 is refunded." },
  ];
  await g.memories.add({ messages, labels: { project: "checkout" } });
  assert.deepEqual(calls.at(-1).body.messages, messages);
  assert.deepEqual(calls.at(-1).body.labels, { project: "checkout" });
});
