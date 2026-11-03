import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./execution-target.js", import.meta.url), "utf8");
const origin = { id: "origin-core", name: "origin-computer" };
const saved = { version: 1, computerId: origin.id, computerName: origin.name,
  folder: "/home/origin/code/repo with 空間", name: "repo with 空間", root: "/home/origin/code" };

async function harness(options = {}) {
  const calls = [], validations = [];
  const context = vm.createContext({ console });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => {
    const exports = specifier === "herdr" ? {
      machines: () => options.computers ?? [{ name: null, layout: "ready" }, { name: "origin-alias", layout: "ready" }],
      exec: async (command, args, { on }) => {
        calls.push({ command, args, on });
        assert.equal(command, "sh");
        assert.equal(args[0], "-c");
        assert.match(args[1], /HOME\/\.local\/bin/);
        args = args.slice(3);
        if (options.execError) return { code: 1, stdout: "" };
        if (args.join(" ") === "machine ls") return { code: 0, stdout: JSON.stringify({ machines: options.registry ?? [{ id: origin.id, name: "origin-alias" }] }) };
        const core = on === null ? options.local ?? origin : options.peer ?? origin;
        return { code: 0, stdout: options.invalidReply ? "{}" : JSON.stringify({ core }) };
      },
    } : {
      validateRepository: async target => {
        validations.push(target);
        if (options.repositoryError) throw new Error("Repository does not exist");
        return target.folder;
      },
    };
    assert.ok(specifier === "herdr" || specifier === "./repository.js");
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return { ...module.namespace, calls, validations };
}

test("description metadata preserves authored text and carries only canonical non-secret placement", async () => {
  const h = await harness();
  const description = "# Work\n\nKeep this exact text.\n";
  const result = h.descriptionWithExecutionTarget(description, saved);
  assert.ok(result.startsWith(description));
  assert.deepEqual(JSON.parse(JSON.stringify(h.readExecutionTarget(result))), saved);
  assert.equal(h.readExecutionTarget("A normal ticket without placement"), null);
  const replaced = h.descriptionWithExecutionTarget(result, { ...saved, folder: "/another/repo" });
  assert.equal(replaced.split('"ericsHerdrLinearExecutionTarget"').length, 2);
  assert.ok(replaced.startsWith(description));
  assert.equal(h.readExecutionTarget(replaced).folder, "/another/repo");
});

test("target metadata cannot terminate its owned code fence through a path", async () => {
  const h = await harness(), target = { ...saved, folder: "/repo/``` literal" };
  const description = h.descriptionWithExecutionTarget("User text", target);
  assert.equal(description.split("```").length, 3);
  assert.equal(h.readExecutionTarget(description).folder, target.folder);
});

test("malformed, ambiguous, relative or unknown-version placement is rejected", async () => {
  const h = await harness();
  for (const description of [
    "<!-- erics-herdr-linear:execution-target broken",
    "<!-- erics-herdr-linear:execution-target\nnot JSON\n-->",
    h.descriptionWithExecutionTarget("", saved).repeat(2),
    `<!-- erics-herdr-linear:execution-target\n${JSON.stringify({ ...saved, version: 99 })}\n-->`,
    `<!-- erics-herdr-linear:execution-target\n${JSON.stringify({ ...saved, folder: "relative/repo" })}\n-->`,
  ]) assert.throws(() => h.readExecutionTarget(description), /invalid|malformed|ambiguous/);
});

test("identify captures physical core identity for explicitly local and remote targets", async () => {
  const h = await harness();
  for (const machine of [null, "origin-alias"]) {
    const target = await h.identifyExecutionTarget({ machine, folder: saved.folder });
    assert.equal(target.computerId, origin.id);
    assert.equal(target.computerName, origin.name);
    assert.equal(h.calls.at(-1).on, machine);
  }
});

test("opening on the original host resolves to explicit local rather than a focused remote", async () => {
  const h = await harness();
  const result = await h.resolveExecutionTarget(saved);
  assert.equal(result.machine, null);
  assert.equal(result.folder, saved.folder);
  assert.equal(h.validations[0].machine, null);
  assert.equal(h.calls.length, 1);
});

test("opening on another host resolves original local placement by core ID and its current alias", async () => {
  const h = await harness({ local: { id: "another-core", name: "another-computer" } });
  const result = await h.resolveExecutionTarget(saved);
  assert.equal(result.machine, "origin-alias");
  assert.equal(result.computerId, origin.id);
  assert.equal(h.validations[0].machine, "origin-alias");
  assert.deepEqual(h.calls.map(c => c.on), [null, null, "origin-alias"]);
});

test("unconfigured or offline canonical computer never falls back to the new local machine", async () => {
  for (const options of [{ registry: [] }, { computers: [{ name: null, layout: "ready" }, { name: "origin-alias", layout: "unavailable" }] }]) {
    const h = await harness({ local: { id: "other-core", name: "other" }, ...options });
    await assert.rejects(h.resolveExecutionTarget(saved), /unavailable/);
    assert.equal(h.validations.length, 0);
  }
});

test("replaced computer identity and missing repo fail closed", async () => {
  const replaced = await harness({ local: { id: "other-core", name: "other" }, peer: { id: "replacement-core", name: origin.name } });
  await assert.rejects(replaced.resolveExecutionTarget(saved), /different identity/);
  assert.equal(replaced.validations.length, 0);
  const missing = await harness({ repositoryError: true });
  await assert.rejects(missing.resolveExecutionTarget(saved), /does not exist/);
  await assert.rejects(replaced.identifyExecutionTarget({ ...saved, machine: "origin-alias" }), /no longer matches/);
});

test("missing or failed identity replies do not create a usable target", async () => {
  for (const options of [{ invalidReply: true }, { execError: true }]) {
    const h = await harness(options);
    await assert.rejects(h.identifyExecutionTarget({ folder: saved.folder, machine: null }), /identity|Cannot identify/);
    assert.equal(h.validations.length, 0);
  }
});


test("Linear Markdown roundtrip supports standard fenced JSON and legacy escaped HTML closing", async () => {
  const h = await harness();
  const fenced = h.descriptionWithExecutionTarget("User Markdown stays intact", saved);
  const roundtrip = fenced.replaceAll("\n", "\r\n");
  assert.equal(h.readExecutionTarget(roundtrip).computerId, saved.computerId);
  const legacy = '<!-- erics-herdr-linear:execution-target\n' + JSON.stringify(saved) + '\n\\-->';
  assert.equal(h.readExecutionTarget(legacy).computerId, saved.computerId);
  const migrated = h.descriptionWithExecutionTarget("User Markdown\n\n" + legacy, saved);
  assert.ok(migrated.includes('```json\n{"ericsHerdrLinearExecutionTarget":'));
  assert.ok(!migrated.includes('<!--'));
});
