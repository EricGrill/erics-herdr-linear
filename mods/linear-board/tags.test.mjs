import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

// CHA-4318: pins, tags and row colors are Linear labels. The real tags.js runs; only
// Herdr's exec is synthetic, answering with canned GraphQL. No process starts, no network
// connection opens, no credential is read and no Linear label or issue is changed.
const plain = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected, message) => assert.deepStrictEqual(plain(actual), expected, message);
const config = { enrichment: { enabled: true } };

async function load(answer) {
  const calls = [];
  const exec = async (command, args, options) => {
    // The GraphQL body sits in the shell script's heredoc.
    const body = JSON.parse(String(args[1]).split("<<'HERDR_BOARD_QUERY'\n")[1].split("\nHERDR_BOARD_QUERY")[0]);
    calls.push(body);
    const reply = await answer(body, calls.length);
    return { code: 0, stdout: typeof reply === "string" ? reply : JSON.stringify(reply), stderr: "" };
  };
  const context = vm.createContext({ console });
  const cache = new Map();
  const link = async specifier => {
    if (specifier === "herdr") {
      const stub = new vm.SyntheticModule(["exec"], function () { this.setExport("exec", exec); }, { context });
      await stub.link(() => { throw new Error("unreachable"); });
      return stub;
    }
    if (cache.has(specifier)) return cache.get(specifier);
    const mod = new vm.SourceTextModule(await readFile(new URL(specifier, import.meta.url), "utf8"), { context, identifier: specifier });
    cache.set(specifier, mod);
    await mod.link(link);
    return mod;
  };
  const module = await link("./tags.js");
  await module.evaluate();
  return { api: module.namespace, calls };
}

const { api } = await load(() => ({ data: {} }));
const labelsAnswer = labels => ({ data: { issue: { id: "u1", identifier: "DEMO-1", labels: { nodes: labels } } } });
const pin = { id: "pin", name: "Pinned", color: "#F2C94C" };
const bug = { id: "bug", name: "Bug", color: "#EB5757" };

test("CHA-4318: a row's tags are its own Linear labels in Linear's order, without routing labels or the pin", () => {
  const issue = { labels: ["agent:claude", "Pinned", "Bug", "repo:demo", "Frontend"], labelColors: { Bug: "#EB5757", Pinned: "#F2C94C", Frontend: "bad" } };
  same(api.rowTags(issue), [{ name: "Bug", color: "#EB5757" }, { name: "Frontend", color: null }]);
  assert.equal(api.rowColor(issue), "#EB5757", "the row takes its first tag's Linear color");
  assert.equal(api.rowColor({ labels: ["Frontend"], labelColors: {} }), null);
  assert.equal(api.isPinned(issue), true);
  assert.equal(api.isPinned({ labels: ["pinned "] }), true, "the pin label matches like Linear names do");
  assert.equal(api.isPinned({ labels: ["Bug"] }), false);
  same(api.rowTags(null), []);
});

test("CHA-4318: right-click offers Pin or Unpin and Tags only for an issue Linear can identify", () => {
  same(api.tagMenuItems({ id: "u1" }, false).map(i => i.label), ["Pin to top", "Tags…"]);
  same(api.tagMenuItems({ id: "u1" }, true).map(i => i.label), ["Unpin", "Tags…"]);
  same(api.tagMenuItems({ identifier: "DEMO-1" }), []);
});

test("CHA-4318: the picker lists choosable labels, the issue's own first, and narrows by typed words", () => {
  const catalog = [
    { id: "1", name: "Zeta", color: null, team: null, group: null },
    { id: "2", name: "agent:spock", color: null, team: null, group: null },
    { id: "3", name: "Pinned", color: null, team: null, group: null },
    { id: "4", name: "alpha", color: null, team: "DEMO", group: null },
    { id: "5", name: "how-to", color: null, team: null, group: "support" },
    { id: "6", name: "Zeta", color: null, team: "DEMO", group: null },
  ];
  same(api.pickable(catalog, ["zeta"]).map(l => [l.name, l.checked]), [["Zeta", true], ["alpha", false], ["how-to", false]],
    "routing labels, the pin and a same-named duplicate are left out");
  same(api.pickable(catalog, [], "supp").map(l => l.name), ["how-to"], "a group name finds its labels");
  assert.equal(api.canCreate(catalog, "zeta"), false);
  assert.equal(api.canCreate(catalog, "  New   tag "), true);
  assert.equal(api.canCreate(catalog, "repo:x"), false, "routing prefixes are not made from the picker");
  same(api.tagName("  New   tag "), { name: "New tag", error: null });
  assert.match(api.tagName("").error, /needs a name/);
  assert.match(api.tagName("x".repeat(81)).error, /at most 80/);
  assert.ok(api.TAG_COLORS.includes(api.tagColor("New tag")));
  assert.equal(api.tagColor("New tag"), api.tagColor("New tag"), "a name always gets the same color");
});

test("CHA-4318: the workspace Pinned label is preferred over a team's", () => {
  const ws = { id: "w", name: "Pinned", team: null, group: null };
  const team = { id: "t", name: "pinned", team: "DEMO", group: null };
  assert.equal(api.pinLabelOf([team, ws], "DEMO").id, "w");
  assert.equal(api.pinLabelOf([team], "DEMO").id, "t");
  assert.equal(api.pinLabelOf([team], "OTHER"), null);
  assert.equal(api.pinLabelOf([{ ...ws, group: "x" }]), null, "a grouped label is not the pin");
});

test("CHA-4318: labels for the issues in spaces come from one bounded query in any workflow state", async () => {
  const { api: live, calls } = await load(() => ({ data: { issues: { nodes: [
    { identifier: "demo-1", labels: { nodes: [pin, bug] } },
    { identifier: "DEMO-2", labels: { nodes: [] } },
  ] } } }));
  same(await live.fetchIssueTags({ config, ids: [] }), { tags: {}, error: null });
  assert.equal(calls.length, 0, "no issues, no request");
  const ids = Array.from({ length: 60 }, (_, i) => `u${i}`);
  const result = await live.fetchIssueTags({ config, ids: [...ids, "u1", null] });
  same(result, { tags: { "DEMO-1": { labels: ["Pinned", "Bug"], colors: { Pinned: "#F2C94C", Bug: "#EB5757" } },
    "DEMO-2": { labels: [], colors: {} } }, error: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].variables.ids.length, live.TAG_ISSUE_CAP);
  assert.doesNotMatch(calls[0].query, /state:/, "not limited to open issues, so a Done ticket keeps its pin");
  same(api.parseIssueTags(JSON.stringify({ errors: [{ message: "nope" }] })), { tags: {}, error: "nope" });
});

test("CHA-4318: the catalog reads workspace and team labels, drops groups and reports a partial read", async () => {
  const page = (nodes, hasNextPage, endCursor) => ({ data: { issueLabels: { pageInfo: { hasNextPage, endCursor }, nodes } } });
  const { api: live, calls } = await load((_body, n) => n === 1
    ? page([{ id: "g", name: "support", isGroup: true }, { id: "a", name: "how-to", color: "#4CB782", parent: { name: "support" } }], true, "c1")
    : page([{ id: "b", name: "Bug", color: "#EB5757", team: { key: "DEMO" } }], false, null));
  const result = await live.fetchCatalog({ config, team: "DEMO" });
  same(result, { labels: [
    { id: "a", name: "how-to", color: "#4CB782", team: null, group: "support" },
    { id: "b", name: "Bug", color: "#EB5757", team: "DEMO", group: null },
  ], complete: true, error: null });
  assert.equal(calls[0].variables.team, "DEMO");
  assert.equal(calls[1].variables.after, "c1");
  const capped = await (await load(() => page([{ id: "x", name: "X" }], true, "same"))).api.fetchCatalog({ config, pages: 1 });
  assert.equal(capped.complete, false);
  assert.equal(capped.error, null);
  const disabled = await api.fetchCatalog({ config: { enrichment: { enabled: false } } });
  assert.match(disabled.error, /disabled/);
});

test("CHA-4318: tagging adds only that label and reads it back from Linear", async () => {
  let labels = [];
  const { api: live, calls } = await load(body => {
    if (/issueAddLabel/.test(body.query)) { labels = [...labels, bug]; return { data: { issueAddLabel: { success: true } } }; }
    if (/issueRemoveLabel/.test(body.query)) { labels = labels.filter(l => l.id !== body.variables.label); return { data: { issueRemoveLabel: { success: true } } }; }
    return labelsAnswer(labels);
  });
  const added = await live.setTag({ config, id: "u1", labelId: "bug", wanted: true });
  same(added, { ok: true, error: null, labels: [bug] });
  same(calls.map(c => c.query.match(/(issueAddLabel|issueRemoveLabel|issue\()/)[1]), ["issue(", "issueAddLabel", "issue("]);
  same(calls[1].variables, { id: "u1", label: "bug" }, "only the one label is sent; no full label set is replaced");
  assert.doesNotMatch(calls[1].query, /labelIds/);

  calls.length = 0;
  const again = await live.setTag({ config, id: "u1", labelId: "bug", wanted: true });
  assert.equal(again.ok, true);
  assert.equal(calls.length, 2, "already tagged: read, no write, read back");

  const removed = await live.setTag({ config, id: "u1", labelId: "bug", wanted: false });
  same(removed, { ok: true, error: null, labels: [] });
});

test("CHA-4318: a write Linear accepts but does not show is reported, never claimed as done", async () => {
  const { api: live } = await load(body => /issueAddLabel/.test(body.query)
    ? { data: { issueAddLabel: { success: true } } } : labelsAnswer([]));
  const result = await live.setTag({ config, id: "u1", labelId: "bug", wanted: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not show the tag/);

  const { api: refused } = await load(body => /issueAddLabel/.test(body.query)
    ? { errors: [{ message: "Entity not found" }] } : labelsAnswer([]));
  same(await refused.setTag({ config, id: "u1", labelId: "bug", wanted: true }), { ok: false, error: "Entity not found", labels: [] });
  assert.match((await api.setTag({ config, id: "", labelId: "bug", wanted: true })).error, /required/);
});

test("CHA-4318: the first pin makes a workspace Pinned label, later pins reuse it", async () => {
  let labels = [], catalog = [];
  const { api: live, calls } = await load(body => {
    if (/issueLabels\(/.test(body.query)) return { data: { issueLabels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: catalog } } };
    if (/issueLabelCreate/.test(body.query)) {
      catalog = [{ id: "pin", name: body.variables.input.name, color: body.variables.input.color }];
      return { data: { issueLabelCreate: { success: true, issueLabel: catalog[0] } } };
    }
    if (/issueAddLabel/.test(body.query)) { labels = [pin]; return { data: { issueAddLabel: { success: true } } }; }
    if (/issueRemoveLabel/.test(body.query)) { labels = []; return { data: { issueRemoveLabel: { success: true } } }; }
    return labelsAnswer(labels);
  });
  const first = await live.setPinned({ config, id: "u1", team: "DEMO", pinned: true });
  same(first, { ok: true, error: null, labels: [pin] });
  const create = calls.find(c => /issueLabelCreate/.test(c.query));
  same(create.variables.input, { name: "Pinned", color: live.PIN_COLOR }, "a workspace label: no team id");

  calls.length = 0; labels = [];
  await live.setPinned({ config, id: "u2", team: "DEMO", pinned: true });
  assert.ok(!calls.some(c => /issueLabelCreate/.test(c.query)), "an existing Pinned label is reused");

  calls.length = 0; labels = [pin];
  same(await live.setPinned({ config, id: "u1", pinned: false }), { ok: true, error: null, labels: [] });
  assert.ok(!calls.some(c => /issueLabels\(|issueLabelCreate/.test(c.query)), "unpinning never makes a label");
});

test("CHA-4318: Linear's answer replaces only that issue's labels in the shared enrichment", () => {
  const published = { rows: [{ identifier: "DEMO-1", labels: ["Old"] }, { identifier: "DEMO-2", labels: ["Keep"] }], fetchedAt: 5 };
  same(api.withLabels(published, "demo-1", [pin, bug]), { rows: [
    { identifier: "DEMO-1", labels: ["Pinned", "Bug"], labelColors: { Pinned: "#F2C94C", Bug: "#EB5757" } },
    { identifier: "DEMO-2", labels: ["Keep"] },
  ], fetchedAt: 5 });
  assert.equal(api.withLabels(null, "DEMO-1", []), null);
});
