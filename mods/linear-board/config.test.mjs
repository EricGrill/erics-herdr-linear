import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "./config.js";

test("public defaults need only a standard environment variable and generic attention rules", () => {
  const config = normalizeConfig();
  assert.deepEqual(config.enrichment, { enabled: true, envKey: "LINEAR_API_KEY", doppler: null });
  assert.ok(config.attention.labels.includes("needs-human"));
  assert.ok(!JSON.stringify(config).includes("erics-keys"));
  assert.ok(!JSON.stringify(config).includes("needs-eric"));
});

test("machine-local Doppler names and attention arrays are normalized without changing case-sensitive secret names", () => {
  const config = normalizeConfig({
    enrichment: { envKey: "TEAM_API_KEY", doppler: { project: "some project'", config: "production", keyNames: ["TEAM_KEY", "TEAM_KEY"] } },
    attention: { labels: [" NEEDS-REVIEW ", "needs-review"], states: ["Approval"] },
  });
  assert.deepEqual(config.enrichment.doppler, { project: "some project'", config: "production", keyNames: ["TEAM_KEY"] });
  assert.deepEqual(config.attention, { labels: ["needs-review"], states: ["approval"] });
});

test("empty attention categories and disabled enrichment are deliberate settings", () => {
  const config = normalizeConfig({ enrichment: { enabled: false }, attention: { labels: [], states: [] } });
  assert.equal(config.enrichment.enabled, false);
  assert.deepEqual(config.attention, { labels: [], states: [] });
});

test("invalid config values are rejected instead of quietly enabling personal defaults", () => {
  for (const input of [null, [], { enrichment: "yes" }, { enrichment: { enabled: "yes" } },
    { enrichment: { envKey: "BAD;NAME" } }, { enrichment: { doppler: {} } },
    { enrichment: { doppler: { project: "one", config: "dev", keyNames: [] } } },
    { enrichment: { doppler: { project: "one", config: "dev", keyNames: ["--bad"] } } },
    { attention: { labels: "needs-me" } }, { attention: { states: [""] } },
    { cleanup: "on" }, { cleanup: { autoClose: "yes" } }, { cleanup: { graceMinutes: -1 } }, { cleanup: { graceMinutes: "10" } }]) {
    assert.throws(() => normalizeConfig(input));
  }
});

test("auto-close is on with a ten-minute grace period unless the machine config says otherwise", () => {
  assert.deepEqual(normalizeConfig().cleanup, { autoClose: true, graceMinutes: 10 });
  assert.deepEqual(normalizeConfig({ cleanup: { autoClose: false } }).cleanup, { autoClose: false, graceMinutes: 10 });
  assert.deepEqual(normalizeConfig({ cleanup: { graceMinutes: 0 } }).cleanup, { autoClose: true, graceMinutes: 0 });
});
