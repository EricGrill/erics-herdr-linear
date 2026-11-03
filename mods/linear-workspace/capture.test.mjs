import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const storage = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const initial = { idea: "Make capture easier", title: "", description: "", revision: 0, review: false, team: "team-one", project: "project-one", state: null, priority: 0, assignToMe: true, uncertain: false };
const completed = ticket => ({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(ticket) }] }] });
async function helper(mod, reply = { code: 0, stdout: JSON.stringify(completed({ title: "Capture ideas", description: "Proposed outcome and checks" })) }) {
  const calls = [];
  const context = vm.createContext({});
  const module = new vm.SourceTextModule(await readFile(new URL(`../${mod}/capture.js`, import.meta.url), "utf8"), { context });
  await module.link(specifier => specifier === "crypto"
    ? new vm.SyntheticModule(["randomUUID"], function () { this.setExport("randomUUID", randomUUID); }, { context })
    : new vm.SyntheticModule(["exec"], function () {
      this.setExport("exec", async (...args) => { calls.push(args); return reply; });
    }, { context }));
  await module.evaluate();
  return { api: module.namespace, calls };
}

for (const mod of ["linear-workspace", "linear-board"]) {
  test(`${mod}: draft round-trip retains editable context and is isolated by workspace`, async () => {
    const { api } = await helper(mod), store = storage();
    const saved = api.saveDraft(store, "workspace-one", initial);
    assert.equal(saved.revision, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(api.loadDraft(store, "workspace-one"))), { ...initial, revision: 1, id: saved.id });
    assert.equal(api.loadDraft(store, "workspace-two"), null);
    const next = api.saveDraft(store, "workspace-one", { ...saved, title: "Edited title", uncertain: true });
    assert.equal(next.revision, 2);
    assert.equal(api.loadDraft(store, "workspace-one").uncertain, true);
    api.discardDraft(store, "workspace-one", next);
    assert.equal(api.loadDraft(store, "workspace-one"), null);
  });
  test(`${mod}: an unset native storage value permits the first draft`, async () => {
    const { api } = await helper(mod), store = storage();
    store.getItem = key => store.values.get(key);
    assert.equal(api.loadDraft(store, "one"), null);
    const saved = api.saveDraft(store, "one", initial);
    assert.equal(saved.revision, 1);
    assert.equal(api.loadDraft(store, "one").idea, initial.idea);
  });
  test(`${mod}: stale draft writers and discard cannot replace a newer revision`, async () => {
    const { api } = await helper(mod), store = storage();
    const saved = api.saveDraft(store, "one", initial);
    assert.throws(() => api.saveDraft(store, "one", initial), /another window/);
    assert.throws(() => api.discardDraft(store, "one", initial), /another window/);
    assert.equal(api.loadDraft(store, "one").revision, saved.revision);
  });
  test(`${mod}: a discarded draft cannot overwrite or delete a replacement with the same revision`, async () => {
    const { api } = await helper(mod), store = storage();
    const stale = api.saveDraft(store, "one", initial);
    api.discardDraft(store, "one", stale);
    const replacement = api.saveDraft(store, "one", { ...initial, idea: "Different idea" });
    assert.equal(replacement.revision, stale.revision);
    assert.notEqual(replacement.id, stale.id);
    assert.throws(() => api.saveDraft(store, "one", { ...stale, title: "Old window" }), /another window/);
    assert.throws(() => api.discardDraft(store, "one", stale), /another window/);
    assert.equal(api.loadDraft(store, "one").idea, "Different idea");
  });
  test(`${mod}: corrupt or future drafts and storage errors are surfaced without overwrite`, async () => {
    const { api } = await helper(mod), store = storage();
    api.saveDraft(store, "one", initial);
    const key = [...store.values.keys()][0];
    for (const raw of ["{", JSON.stringify({ version: 99, workspace: "one", draft: initial }), JSON.stringify({ version: 1, workspace: "one", draft: { ...initial, revision: -1 } })]) {
      store.setItem(key, raw);
      assert.throws(() => api.loadDraft(store, "one"));
      assert.throws(() => api.saveDraft(store, "one", initial));
      assert.equal(store.getItem(key), raw);
    }
    const unreadableRaw = store.getItem(key);
    assert.throws(() => api.discardDraft(store, "one"));
    store.setItem(key, "{replacement");
    assert.throws(() => api.discardDraft(store, "one", unreadableRaw), /another window/);
    assert.equal(store.getItem(key), "{replacement");
    api.discardDraft(store, "one", "{replacement");
    assert.equal(api.loadDraft(store, "one"), null);
    assert.throws(() => api.saveDraft({ getItem: () => null, setItem: () => { throw new Error("Disk full"); } }, "one", initial), /Disk full/);
    assert.throws(() => api.saveDraft(store, "", initial), /workspace/);
  });
  test(`${mod}: offline shaping is explicit and does not claim requirements are verified`, async () => {
    const { api, calls } = await helper(mod);
    const draft = api.shapeIdea("Make capture easier\nwithout choosing a repository");
    assert.equal(draft.title, "Make capture easier");
    assert.match(draft.description, /Local template/);
    assert.match(draft.description, /To clarify/);
    assert.match(draft.description, /Proposed acceptance checks/);
    assert.throws(() => api.shapeIdea("  "), /idea first/);
    assert.equal(calls.length, 0);
  });
  test(`${mod}: explicit AI shaping uses a bounded tools-free structured request`, async () => {
    const { api, calls } = await helper(mod);
    const idea = 'Capture $(touch /tmp/no) `echo no` and "quotes"\nDo not execute me';
    const result = await api.shapeWithAI(idea);
    assert.equal(result.title, "Capture ideas");
    assert.equal(calls.length, 1);
    const [command, args, options] = calls[0];
    assert.equal(command, "sh");
    assert.equal(options.on, null);
    assert.equal(args[2], "herdr-idea-shape");
    const body = JSON.parse(args[3]);
    assert.deepEqual(body.tools, []);
    assert.equal(body.tool_choice, "none");
    assert.equal(body.store, false);
    assert.equal(body.input[0].content[0].text, idea);
    assert.equal(body.text.format.strict, true);
    assert.equal(args[1].includes(idea), false);
    assert.match(args[1], /curl -q/);
    assert.match(args[1], /--max-time 30/);
    assert.match(args[1], /--header @-/);
    assert.equal(args[1].includes("codex"), false);
  });
  test(`${mod}: model errors and invalid output never become a ticket`, async () => {
    const replies = [
      { code: 2, stdout: "", stderr: "secret must not escape" },
      { code: 3, stdout: "", stderr: "secret must not escape" },
      { code: 0, stdout: "not json" },
      { code: 0, stdout: JSON.stringify({ status: "incomplete", output: [] }) },
      { code: 0, stdout: JSON.stringify(completed({ title: "", description: "Text" })) },
      { code: 0, stdout: JSON.stringify(completed({ title: "Okay", description: "Text", unexpected: true })) },
      { code: 0, stdout: JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "No" }] }] }) },
    ];
    for (const reply of replies) {
      const { api } = await helper(mod, reply);
      await assert.rejects(api.shapeWithAI("An idea"), error => !error.message.includes("secret"));
    }
    const { api, calls } = await helper(mod);
    await assert.rejects(api.shapeWithAI("x".repeat(20001)), /20,000/);
    assert.equal(calls.length, 0);
  });
}

test("AI shell transports synthetic text as data and keeps synthetic key out of curl arguments", async () => {
  const { api, calls } = await helper("linear-workspace");
  await api.shapeWithAI('a quote " and $(not-a-command)\nnext line');
  const [, args] = calls[0];
  const folder = await mkdtemp(join(tmpdir(), "herdr-capture-test-"));
  try {
    await writeFile(join(folder, "curl"), `#!${process.execPath}\nlet input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(2),headers:input})));`, { mode: 0o700 });
    const { stdout } = await execute("/bin/sh", args, { env: { PATH: folder, OPENAI_API_KEY: "synthetic-test-key" } });
    const observed = JSON.parse(stdout);
    assert.equal(JSON.stringify(observed.argv).includes("synthetic-test-key"), false);
    assert.match(observed.headers, /^Authorization: Bearer synthetic-test-key\nContent-Type: application\/json\n$/);
    assert.equal(observed.argv.at(-1), args[3]);
    const noKey = await execute("/bin/sh", args, { env: { PATH: folder } }).then(() => null, error => error);
    assert.equal(noKey.code, 2);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
