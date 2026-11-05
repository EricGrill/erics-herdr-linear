import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

// The real enrich.js runs; only Herdr's exec is synthetic. No process starts, no network
// connection opens, no credential is read, and nothing is written to disk.
const source = await readFile(new URL("./enrich.js", import.meta.url), "utf8");
const configSource = await readFile(new URL("./config.js", import.meta.url), "utf8");

// Values created inside the vm realm carry that realm's prototypes, which
// deepStrictEqual treats as a difference. Compare them as plain JSON.
const plain = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected, message) => assert.deepStrictEqual(plain(actual), expected, message);

async function load(exec) {
  const calls = [];
  const wrapped = async (command, args, options) => {
    calls.push({ command, args, options });
    return exec(command, args, options);
  };
  const context = vm.createContext({ console });
  const module = new vm.SourceTextModule(source, { context, identifier: "enrich.js" });
  const link = async specifier => {
    if (specifier === "./auth.js") {
      const auth = new vm.SourceTextModule(await readFile(new URL(specifier, import.meta.url), "utf8"), { context });
      await auth.link(link);
      return auth;
    }
    if (specifier === "./config.js") {
      const config = new vm.SourceTextModule(configSource, { context, identifier: "config.js" });
      await config.link(() => { throw new Error("config is pure"); });
      return config;
    }
    assert.equal(specifier, "herdr");
    const stub = new vm.SyntheticModule(["exec"], function () {
      this.setExport("exec", wrapped);
    }, { context });
    await stub.link(() => { throw new Error("unreachable"); });
    return stub;
  };
  await module.link(link);
  await module.evaluate();
  return { api: module.namespace, calls };
}

const answer = (nodes, pageInfo = { hasNextPage: false, endCursor: null }) =>
  JSON.stringify({ data: { issues: { pageInfo, nodes } } });

const node = (identifier, over = {}) => ({
  id: `uuid-${identifier}`, identifier, updatedAt: "2026-11-01T12:00:00.000Z",
  delegate: null, assignee: { displayName: "sample-user" },
  state: { name: "Todo", type: "unstarted" },
  project: { id: "p1", name: "Helper Project" }, team: { key: "DEMO" },
  labels: { nodes: [] }, ...over,
});

test("the key is read inside the shell and never passed as an argument", async () => {
  const { api, calls } = await load(async () => ({ code: 0, stdout: answer([node("DEMO-1")]), stderr: "" }));
  await api.fetchEnrichment();

  assert.equal(calls.length, 1);
  const { command, args } = calls[0];
  assert.equal(command, "sh");
  assert.equal(args[0], "-c");
  // Positional arguments are key *names* only.
  same(args.slice(2), ["sh", "LINEAR_API_KEY", "", ""]);
  const script = args[1];
  assert.match(script, /doppler secrets get "\$name"/);
  assert.match(script, /umask 077/);
  // The header goes through a curl config file, so no key can land in any argv.
  assert.match(script, /--config "\$dir\/curlrc"/);
  assert.doesNotMatch(script, /-H ['"]Authorization/);
  // A single %s, so printf actually substitutes the key.
  assert.match(script, /printf 'header = "Authorization: %s"\\n' "\$escaped_key"/);
  assert.match(script, /trap 'rm -rf "\$dir"' EXIT/);
  assert.doesNotMatch(script, /exec curl/, "exec would bypass the shell's EXIT cleanup trap");
});

test("the query body survives a $ sequence intact", async () => {
  const { api, calls } = await load(async () => ({ code: 0, stdout: answer([]), stderr: "" }));
  await api.fetchEnrichment();
  const script = calls[0].args[1];
  const body = script.split("HERDR_BOARD_QUERY")[1].replace(/^'/, "");
  const parsed = JSON.parse(body.trim());
  assert.match(parsed.query, /query BoardEnrichment\(\$after: String\)/);
  assert.match(parsed.query, /delegate \{ id name displayName avatarUrl active app isAssignable \}/);
  assert.match(parsed.query, /nin: \["completed", "canceled"\]/);
  same(parsed.variables, { after: null });
});

test("a delegated issue parses into usable rows", async () => {
  const { api } = await load(async () => ({ code: 0, stdout: "", stderr: "" }));
  const parsed = api.parseEnrichment(answer([
    node("DEMO-3589", {
      delegate: { id: "agent-spock", name: "Spock", displayName: "spock", avatarUrl: "https://public.linear.app/a.png" },
      state: { name: "Needs Human", type: "started" },
      labels: { nodes: [{ name: "agent:stalled" }, { name: "needs-eric" }] },
    }),
  ]));
  assert.equal(parsed.error, null);
  assert.equal(parsed.done, true);
  same(parsed.rows, [{
    id: "uuid-DEMO-3589",
    identifier: "DEMO-3589",
    updatedAt: "2026-11-01T12:00:00.000Z",
    delegate: { id: "agent-spock", name: "Spock", avatarUrl: "https://public.linear.app/a.png", eligible: false },
    contextIncomplete: ["labels"],
    assignee: "sample-user",
    state: { name: "Needs Human", type: "started" },
    project: { id: "p1", name: "Helper Project" },
    teamKey: "DEMO",
    labels: ["agent:stalled", "needs-eric"],
  }]);
});

test("malformed answers yield no rows rather than throwing", async () => {
  const { api } = await load(async () => ({ code: 0, stdout: "", stderr: "" }));
  for (const bad of ["", "not json", "{}", '{"data":{}}', '{"data":{"issues":{}}}']) {
    const parsed = api.parseEnrichment(bad);
    same(parsed.rows, []);
    assert.equal(parsed.done, true);
    assert.ok(parsed.error, `expected an error for ${JSON.stringify(bad)}`);
  }
});

test("a GraphQL error becomes a readable message, not a crash", async () => {
  const { api } = await load(async () => ({ code: 0, stdout: "", stderr: "" }));
  const parsed = api.parseEnrichment(JSON.stringify({ errors: [{ message: "Authentication required, not authenticated" }] }));
  same(parsed.rows, []);
  assert.equal(parsed.error, "Authentication required, not authenticated");
});

test("an issue with no identifier is dropped", async () => {
  const { api } = await load(async () => ({ code: 0, stdout: "", stderr: "" }));
  const parsed = api.parseEnrichment(answer([node("DEMO-1"), { id: "x" }]));
  same(parsed.rows.map(r => r.identifier), ["DEMO-1"]);
});

test("paging follows the cursor and stops when Linear says it is done", async () => {
  let page = 0;
  const { api, calls } = await load(async () => {
    page += 1;
    if (page === 1) return { code: 0, stdout: answer([node("DEMO-1")], { hasNextPage: true, endCursor: "cur1" }), stderr: "" };
    return { code: 0, stdout: answer([node("DEMO-2")]), stderr: "" };
  });
  const result = await api.fetchEnrichment();
  assert.equal(calls.length, 2);
  assert.match(calls[1].args[1], /"after":"cur1"/);
  same(result.rows.map(r => r.identifier), ["DEMO-1", "DEMO-2"]);
  assert.equal(result.partial, false);
  assert.ok(result.fetchedAt);
});

test("a page cap reports a partial read instead of looping", async () => {
  let n = 0;
  const { api } = await load(async () => ({
    code: 0, stdout: answer([node(`DEMO-${++n}`)], { hasNextPage: true, endCursor: `c${n}` }), stderr: "",
  }));
  const result = await api.fetchEnrichment({ pages: 2 });
  assert.equal(result.partial, true);
  assert.equal(result.error, null);
  assert.equal(result.rows.length, 2);
});

test("a missing key surfaces the shell's own message and keeps earlier rows", async () => {
  const { api } = await load(async () => ({ code: 4, stdout: "", stderr: "no Linear API key in Doppler (tried: A B)\n" }));
  const result = await api.fetchEnrichment();
  assert.equal(result.error, "no Linear API key in Doppler (tried: A B)");
  same(result.rows, []);
  assert.equal(result.fetchedAt, null);
  assert.equal(result.partial, true);
});

test("a rejected exec is reported, never thrown at the renderer", async () => {
  const { api } = await load(async () => { throw new Error("snoke is unreachable"); });
  const result = await api.fetchEnrichment({ on: "snoke" });
  assert.equal(result.error, "snoke is unreachable");
  assert.equal(result.partial, true);
});

test("the machine selection is passed through to exec", async () => {
  const { api, calls } = await load(async () => ({ code: 0, stdout: answer([]), stderr: "" }));
  await api.fetchEnrichment({ on: "snoke" });
  same(calls[0].options, { on: "snoke" });
});

test("indexEnrichment looks rows up by identifier or uuid", async () => {
  const { api } = await load(async () => ({ code: 0, stdout: "", stderr: "" }));
  const rows = api.parseEnrichment(answer([node("DEMO-7")])).rows;
  const { byIdentifier, byId } = api.indexEnrichment(rows);
  assert.equal(byIdentifier.get("DEMO-7").identifier, "DEMO-7");
  assert.equal(byId.get("uuid-DEMO-7").identifier, "DEMO-7");
});

test("delegateCounts ranks busiest agents first and ignores undelegated work", async () => {
  const { api } = await load(async () => ({ code: 0, stdout: "", stderr: "" }));
  const rows = api.parseEnrichment(answer([
    node("DEMO-1", { delegate: { name: "Seven" } }),
    node("DEMO-2", { delegate: { name: "Spock" } }),
    node("DEMO-3", { delegate: { name: "Seven" } }),
    node("DEMO-4"),
  ])).rows;
  const counts = api.delegateCounts(rows);
  same(counts.map(c => [c.name, c.issues.length]), [["Seven", 2], ["Spock", 1]]);
});

test("optional Doppler names stay positional data rather than becoming shell source", async () => {
  const { api, calls } = await load(async () => ({ code: 0, stdout: answer([]), stderr: "" }));
  const project = "a'$(exit 97)", config = 'config"; exit 96';
  await api.fetchEnrichment({ config: { enrichment: { envKey: "CUSTOM_LINEAR_KEY", doppler: { project, config, keyNames: ["TEAM_LINEAR_KEY"] } } } });
  same(calls[0].args.slice(2), ["sh", "CUSTOM_LINEAR_KEY", project, config, "TEAM_LINEAR_KEY"]);
  assert.ok(!calls[0].args[1].includes(project));
  assert.ok(!calls[0].args[1].includes(config));
});

test("disabled enrichment performs no credential or network work", async () => {
  const { api, calls } = await load(async () => { throw new Error("must not execute"); });
  const result = await api.fetchEnrichment({ config: { enrichment: { enabled: false } } });
  same(result.rows, []);
  assert.equal(result.partial, false);
  assert.equal(result.error, null);
  assert.equal(calls.length, 0);
});

test("invalid environment names fail before starting a process", async () => {
  const { api, calls } = await load(async () => { throw new Error("must not execute"); });
  const result = await api.fetchEnrichment({ config: { enrichment: { envKey: "$(exit 99)" } } });
  assert.match(result.error, /environment variable name/);
  assert.equal(calls.length, 0);
});

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

test("the real shell keeps env credentials out of argv, escapes the header, and removes its temporary files", async () => {
  const { api, calls } = await load(async () => ({ code: 0, stdout: answer([]), stderr: "" }));
  await api.fetchEnrichment();
  const dir = mkdtempSync(join(tmpdir(), "herdr-enrich-test-"));
  const fakeCurl = join(dir, "curl.mjs");
  const fakeKey = 'test-token-with-"quotes"-and-\\slashes';
  writeFileSync(fakeCurl, `import fs from 'node:fs';\nconst args=process.argv.slice(2); const file=args[args.indexOf('--config')+1]; console.log(JSON.stringify({args,file,mode:fs.statSync(file).mode & 0o777,header:fs.readFileSync(file,'utf8')}));\n`);
  try {
    const script = `curl() { ${quote(process.execPath)} ${quote(fakeCurl)} "$@"; }\n${calls[0].args[1]}`;
    const result = spawnSync("sh", ["-c", script, ...calls[0].args.slice(2)], { env: { ...process.env, LINEAR_API_KEY: fakeKey }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 0o600);
    assert.ok(!report.args.join(" ").includes(fakeKey));
    assert.equal(report.header, 'header = "Authorization: test-token-with-\\"quotes\\"-and-\\\\slashes"\n');
    assert.equal(existsSync(report.file), false);
    assert.equal(existsSync(dirname(report.file)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a key containing a newline cannot inject a curl option", async () => {
  const { api, calls } = await load(async () => ({ code: 0, stdout: answer([]), stderr: "" }));
  await api.fetchEnrichment();
  const result = spawnSync("sh", ["-c", `curl() { exit 95; }\n${calls[0].args[1]}`, ...calls[0].args.slice(2)], {
    env: { ...process.env, LINEAR_API_KEY: 'test\nurl = "https://invalid.example"' }, encoding: "utf8",
  });
  assert.equal(result.status, 5);
  assert.match(result.stderr, /must not contain a newline/);
});

test("Doppler fallback receives literal configured names and an environment key takes precedence", async () => {
  const { api, calls } = await load(async () => ({ code: 0, stdout: answer([]), stderr: "" }));
  const config = { enrichment: { envKey: "HERDR_TEST_LINEAR_KEY", doppler: {
    project: "project'$(exit 94)", config: 'configuration"; exit 93', keyNames: ["FALLBACK_ONE", "FALLBACK_TWO"],
  } } };
  await api.fetchEnrichment({ config });
  const dir = mkdtempSync(join(tmpdir(), "herdr-doppler-test-"));
  const report = join(dir, "doppler-args.json");
  const fakeDoppler = join(dir, "doppler.mjs");
  writeFileSync(fakeDoppler, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('fake-fallback-token');`);
  const definitions = `doppler() { ${quote(process.execPath)} ${quote(fakeDoppler)} "$@"; }\ncurl() { printf '%s' '{}'; }\n`;
  try {
    const result = spawnSync("sh", ["-c", definitions + calls[0].args[1], ...calls[0].args.slice(2)], {
      env: { ...process.env, HERDR_TEST_LINEAR_KEY: "" }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), ["secrets", "get", "FALLBACK_ONE", "--project", config.enrichment.doppler.project,
      "--config", config.enrichment.doppler.config, "--plain"]);
    rmSync(report);
    const envResult = spawnSync("sh", ["-c", definitions + calls[0].args[1], ...calls[0].args.slice(2)], {
      env: { ...process.env, HERDR_TEST_LINEAR_KEY: "fake-environment-token" }, encoding: "utf8",
    });
    assert.equal(envResult.status, 0, envResult.stderr);
    assert.equal(existsSync(report), false, "Doppler must not run when the environment key is present");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
