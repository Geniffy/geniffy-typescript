// The built client against a fake fetch: requests, results, errors and retries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Geniffy, AuthenticationError, NotFoundError, UnreadableError, InternalServerError, GeniffyError } from "../dist/index.js";

const KEY = "gnf_live_" + "k".repeat(43);
const SOURCE = { id: "a".repeat(32), kind: "note", title: "Priya Nair signs the Lumen renewal.", status: "reading" };
const MEM = { id: 7, text: "Priya Nair signs the Lumen renewal.", kind: "people", status: "current", source: { id: "a".repeat(32), kind: "note", title: "Call with Priya" } };

function fake(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: new URL(url), method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const out = await reply(call, calls.length);
    if (out instanceof Error) throw out;
    const [status, body, headers] = out;
    return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(headers ?? {}) } });
  };
  return { fetch, calls };
}

const make = (reply, opts = {}) => {
  const f = fake(reply);
  return { g: new Geniffy({ apiKey: KEY, baseURL: "https://api.test", fetch: f.fetch, ...opts }), calls: f.calls };
};

test("a key is required, and requests carry it", async () => {
  delete process.env.GENIFFY_API_KEY;
  assert.throws(() => new Geniffy({ fetch: async () => new Response("{}") }), /GENIFFY_API_KEY/);
  const { g, calls } = make(() => [200, { name: "Omkar", memory: "personal" }]);
  assert.equal((await g.me()).name, "Omkar");
  assert.equal(calls[0].url.href, "https://api.test/v1/me");
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
});

test("adding a note, a link and a file", async () => {
  const { g, calls } = make((c) => [201, { source: { ...SOURCE, kind: c.url.pathname.endsWith("/file") ? "file" : "note" } }]);
  assert.equal((await g.memories.add("Priya Nair signs the Lumen renewal.")).status, "reading");
  assert.deepEqual(JSON.parse(calls[0].body), { text: "Priya Nair signs the Lumen renewal." });
  await g.memories.add({ url: "https://acme.test/team", title: "Acme team" });
  assert.deepEqual(JSON.parse(calls[1].body), { url: "https://acme.test/team", title: "Acme team" });
  const src = await g.memories.addFile(new TextEncoder().encode("%PDF-1.7"), { filename: "Pricing.pdf", title: "Pricing" });
  assert.equal(src.kind, "file");
  assert.ok(calls[2].body instanceof FormData);
  assert.equal(calls[2].body.get("file").name, "Pricing.pdf");
  assert.equal(calls[2].body.get("title"), "Pricing");
});

test("something said in the past carries its date", async () => {
  const { g, calls } = make(() => [201, { source: SOURCE }]);
  await g.memories.add({ messages: [{ role: "user", content: "We moved the launch to May." }], saidAt: new Date("2025-03-04T09:30:00Z") });
  assert.equal(JSON.parse(calls[0].body).said_at, "2025-03-04T09:30:00.000Z");
  await g.memories.add({ text: "Priya signs the renewal.", saidAt: "2025-03-04" });
  assert.deepEqual(JSON.parse(calls[1].body), { text: "Priya signs the renewal.", said_at: "2025-03-04" });
  await g.memories.add("No date.");
  assert.deepEqual(JSON.parse(calls[2].body), { text: "No date." });
  await g.memories.addMany([{ text: "One.", saidAt: "2024-01-02" }, "Two."]);
  assert.deepEqual(JSON.parse(calls[3].body).items, [{ text: "One.", said_at: "2024-01-02" }, { text: "Two." }]);
});

test("your own id goes with every add, and finds and deletes the source", async () => {
  // Sending again under the same externalId updates that source on Geniffy's side; the client's part is to
  // send the id with a note, a conversation, a link and a file, and to find and delete by it.
  const held = { ...SOURCE, external_id: "ticket-42" };
  const { g, calls } = make((c) => {
    if (c.method === "GET" && c.url.pathname === "/v1/sources") {
      const found = c.url.searchParams.get("external_id") === "ticket-42" ? [held] : [];
      return [200, { sources: found, total: found.length, next: null }];
    }
    if (c.method === "DELETE") return [200, { id: held.id, external_id: "ticket-42", deleted: true }];
    return [201, { source: held }];
  });
  const src = await g.memories.add({ text: "Customer asked about invoice 7.", title: "Ticket 42", externalId: "ticket-42" });
  assert.equal(src.external_id, "ticket-42");
  assert.deepEqual(JSON.parse(calls[0].body), { text: "Customer asked about invoice 7.", title: "Ticket 42", external_id: "ticket-42" });
  await g.memories.add({ messages: [{ role: "user", content: "I moved to Pune." }], externalId: "chat-7", saidAt: "2025-03-04" });
  assert.deepEqual(JSON.parse(calls[1].body), { messages: [{ role: "user", content: "I moved to Pune." }], said_at: "2025-03-04", external_id: "chat-7" });
  await g.memories.add({ url: "https://acme.test/pricing", externalId: "pricing" });
  assert.equal(JSON.parse(calls[2].body).external_id, "pricing");
  await g.memories.addMany([{ text: "One.", externalId: "one" }, "Two."]);
  assert.deepEqual(JSON.parse(calls[3].body).items, [{ text: "One.", external_id: "one" }, { text: "Two." }]);
  await g.memories.addFile(new TextEncoder().encode("%PDF-1.7"), { filename: "plan.pdf", externalId: "plan-pdf" });
  assert.equal(calls[4].body.get("external_id"), "plan-pdf");

  assert.equal((await g.sources.get({ externalId: "ticket-42" })).id, SOURCE.id);
  assert.equal(calls[5].url.pathname, "/v1/sources");
  assert.equal(calls[5].url.searchParams.get("external_id"), "ticket-42");
  await assert.rejects(g.sources.get({ externalId: "ticket-43" }), NotFoundError);
  await g.sources.delete({ externalId: "ticket-42" });
  assert.equal(calls.at(-1).method, "DELETE");
  assert.equal(calls.at(-1).url.pathname, "/v1/sources");
  assert.equal(calls.at(-1).url.searchParams.get("external_id"), "ticket-42");
  await g.sources.delete(SOURCE.id);
  assert.equal(calls.at(-1).url.pathname, `/v1/sources/${SOURCE.id}`);
  for (const wrong of [undefined, null, {}, { externalId: 42 }]) {
    await assert.rejects(g.sources.get(wrong), { name: "TypeError" });
    await assert.rejects(g.sources.delete(wrong), { name: "TypeError" });
  }
});

test("a key limited to one user is made, listed and revoked on that user's client", async () => {
  const made = { id: 21, name: "Asha's phone", space: "customer_42", key: "gnf_live_" + "l".repeat(43) };
  const { g, calls } = make((c) => {
    if (c.method === "POST") return [201, made];
    if (c.method === "GET") return [200, { keys: [{ ...made, key: null, starts_with: "gnf_live_ll" }] }];
    return [200, { id: 21, space: "customer_42", revoked: true }];
  });
  const mem = g.space("customer_42");
  const key = await mem.keys.create({ name: "Asha's phone", rpm: 60 });
  assert.equal(key.key, made.key);
  assert.equal(calls[0].url.pathname, "/v1/keys");
  assert.equal(calls[0].headers["X-Geniffy-Space"], "customer_42");
  assert.deepEqual(JSON.parse(calls[0].body), { name: "Asha's phone", rpm: 60 });
  assert.deepEqual((await mem.keys.list()).map((k) => [k.id, k.key]), [[21, null]]);
  await mem.keys.revoke(21);
  assert.equal(calls[2].method, "DELETE");
  assert.equal(calls[2].url.pathname, "/v1/keys/21");
  await mem.keys.create();
  assert.deepEqual(JSON.parse(calls[3].body), {});
  await mem.keys.create({ name: "A week", expiresAt: "2026-10-13" });
  assert.deepEqual(JSON.parse(calls[4].body), { name: "A week", expires_at: "2026-10-13" });
  await mem.keys.create({ expiresAt: new Date("2026-10-13T18:00:00Z") });
  assert.equal(JSON.parse(calls[5].body).expires_at, "2026-10-13T18:00:00.000Z");
});

test("profile sections for every user, or one", async () => {
  const { g, calls } = make((c) => c.method === "GET" ? [200, { sections: [{ id: 300, name: "billing", applies_to: "every user" }] }]
    : c.method === "POST" ? [201, { id: 300, name: "billing", applies_to: "every user" }] : [200, { id: 300, deleted: true }]);
  await g.sections.create({ name: "Billing", keywords: ["invoice"] });
  assert.equal(calls[0].headers["X-Geniffy-Space"], undefined, "the plain client: every user");
  assert.deepEqual(JSON.parse(calls[0].body), { name: "Billing", description: "", keywords: ["invoice"], topics: [] });
  await g.space("customer_42").sections.create({ name: "Allergies", topics: ["diet"] });
  assert.equal(calls[1].headers["X-Geniffy-Space"], "customer_42");
  assert.equal((await g.sections.list())[0].name, "billing");
  await g.sections.delete(300);
  assert.equal(calls[3].method, "DELETE");
  assert.equal(calls[3].url.pathname, "/v1/profile/sections/300");
});

test("listing pages through every memory, and asking", async () => {
  const { g } = make((c) => {
    if (c.url.pathname === "/v1/memories") {
      const cursor = Number(c.url.searchParams.get("cursor"));
      return [200, { memories: [{ ...MEM, id: cursor + 1 }, { ...MEM, id: cursor + 2 }], counts: { all: 4 }, total: 4, next: cursor === 0 ? 2 : null }];
    }
    return [200, { question: "Who signs the Lumen renewal?", answer: "Priya Nair.", message: null, memories: [MEM], clash: false }];
  });
  const ids = [];
  for await (const m of g.memories.iterate({ pageSize: 2 })) ids.push(m.id);
  assert.deepEqual(ids, [1, 2, 3, 4]);
  const { answer, memories } = await g.ask("Who signs the Lumen renewal?");
  assert.equal(answer, "Priya Nair.");
  assert.equal(memories[0].source.title, "Call with Priya");
});

test("errors carry the API's own sentence", async () => {
  const replies = [
    [401, { error: { code: "bad_key", message: "This key doesn't work. It may have been revoked." } }],
    [404, { error: { code: "not_found", message: "That memory wasn't found." } }],
    [422, { error: { code: "unreadable", message: "This PDF is a scan with no text in it.", source: { ...SOURCE, status: "failed" } } }],
  ];
  const { g } = make((_, n) => replies[n - 1]);
  await assert.rejects(g.me(), (e) => e instanceof AuthenticationError && /revoked/.test(e.message));
  await assert.rejects(g.memories.get(1), NotFoundError);
  await assert.rejects(g.memories.addFile(new Uint8Array([1]), { filename: "scan.pdf" }),
    (e) => e instanceof UnreadableError && e.source.status === "failed" && e instanceof GeniffyError);
});

test("reads are retried, but a failed add is not sent twice", async () => {
  const { g, calls } = make((c, n) => {
    if (c.method === "GET" && n === 1) return [503, { error: { code: "memory_unavailable", message: "busy" } }, { "retry-after": "0" }];
    if (c.method === "POST") return [502, { error: { code: "memory_unavailable", message: "Your memory didn't answer." } }];
    return [200, { sources: [], total: 0, next: null }];
  });
  assert.equal((await g.sources.list()).total, 0);
  await assert.rejects(g.memories.add("once only"), InternalServerError);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "GET", "POST"]);
});

test("a rate-limited add is retried, and waiting ends when learning does", async () => {
  const { g, calls } = make((c, n) => (n === 1 ? [429, { error: { code: "busy", message: "slow" } }, { "retry-after": "0" }] : [201, { source: SOURCE }]));
  assert.equal((await g.memories.add("hello")).id, SOURCE.id);
  assert.equal(calls.length, 2);
  const stages = ["reading", "learned"];
  const w = make((_, n) => [200, { source: { ...SOURCE, status: stages[Math.min(n - 1, 1)], facts: 6 } }]);
  const src = await w.g.sources.wait(SOURCE.id, { intervalMs: 0 });
  assert.equal(src.status, "learned");
  assert.equal(src.facts, 6);
});

// ── spaces: one of YOUR users ─────────────────────────────────────────────────
test("a bound client carries its space on every call, and a plain one carries none", async () => {
  // The space rides a header, not an argument, so no method can lose it by forgetting to pass it on.
  const { g, calls } = make(() => [200, { name: "Omkar", memory: "personal", space: null }]);
  const mem = g.space("customer_1042");

  assert.equal(g.boundSpace, "");
  assert.equal(mem.boundSpace, "customer_1042");

  await g.me();
  await mem.me();
  await mem.search("renewal");
  await mem.memories.list();

  assert.equal(calls[0].headers["X-Geniffy-Space"], undefined, "a plain client reaches your own memory");
  assert.deepEqual(calls.slice(1).map((c) => c.headers["X-Geniffy-Space"]),
    ["customer_1042", "customer_1042", "customer_1042"], "every call a bound client makes is scoped");
});

test("two bound clients do not share a space, and binding keeps the key", async () => {
  const { g, calls } = make(() => [200, { memories: [], counts: {}, total: 0 }]);
  await g.space("customer_1042").search("x");
  await g.space("customer_1043").search("x");
  assert.deepEqual(calls.map((c) => c.headers["X-Geniffy-Space"]), ["customer_1042", "customer_1043"]);
  assert.deepEqual(calls.map((c) => c.headers.Authorization), [`Bearer ${KEY}`, `Bearer ${KEY}`]);
});

test("a blank space throws, never reading your own memory", async () => {
  // A blank space is what a missing user id looks like by the time it reaches space(): read as no space,
  // that user's words would land in your own memory, with every other user missing an id.
  const { g, calls } = make(() => [200, {}]);
  for (const blank of ["", "   ", "	"]) {
    assert.throws(() => g.space(blank), { name: "TypeError", message: /blank/ });
    await assert.rejects(g.forgetSpace(blank), { name: "TypeError", message: /blank/ });
    assert.throws(() => make(() => [200, {}], { space: blank }), { name: "TypeError", message: /blank/ });
  }
  for (const wrong of [undefined, null, true, 3.5, NaN, ["customer_1042"], {}]) {
    assert.throws(() => g.space(wrong), { name: "TypeError", message: /a string or an integer id/ });
    await assert.rejects(g.forgetSpace(wrong), { name: "TypeError" });
  }
  assert.equal(calls.length, 0, "nothing was asked of the API");

  assert.equal(g.space(1042).boundSpace, "1042", "an integer id is the same user as its digits");
  assert.equal(g.space(" customer_1042 ").boundSpace, "customer_1042");
  for (const none of [undefined, null]) {
    assert.equal(make(() => [200, {}], { space: none }).g.boundSpace, "", "no space in the options is your own memory");
  }
});

test("listing your users, and forgetting one", async () => {
  const rows = [{ space: "customer_1042", sources: 3, memories: 11, last_added_at: "2026-10-04T06:00:00+00:00" }];
  const { g, calls } = make((c) => (c.method === "DELETE" ? [200, { erased: true }] : [200, { spaces: rows, total: 1 }]));
  assert.equal((await g.spaces())[0].memories, 11);
  await g.forgetSpace("customer 1042/../x");
  assert.equal(calls[1].url.pathname, "/v1/spaces/customer%201042%2F..%2Fx", "the name is escaped, never pasted into the path");
});

test("a failed call's error carries the id Geniffy gave it", async () => {
  const { g } = make(() => [404, { error: { code: "not_found", message: "No memory with that id." } },
    { "x-request-id": "e15cf212-341b-4e36-859e-fed587b87eca" }]);
  await assert.rejects(g.memories.get(1), (e) => {
    assert.ok(e instanceof NotFoundError);
    assert.equal(e.requestId, "e15cf212-341b-4e36-859e-fed587b87eca");
    return true;
  });
});

test("waiting asks Geniffy to hold the call, so one call is enough", async () => {
  const { g, calls } = make(() => [200, { source: { ...SOURCE, status: "learned", facts: 6 } }]);
  assert.equal((await g.sources.wait(SOURCE.id)).status, "learned");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get("wait"), "30.0", "held up to 30 seconds, not asked again every two");
  await g.sources.wait(SOURCE.id, { timeoutMs: 3_000 });
  assert.equal(calls[1].url.searchParams.get("wait"), "3.0", "and never past the caller's own deadline");
});
