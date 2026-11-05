import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { machineColors, machineColor, machineState, machineLabel, stateWord } from "./machines.js";

const dark = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`ansi${i}`, `#${String(i).padStart(2, "0")}aa00`]));
const light = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`ansi${i}`, `#${String(i).padStart(2, "0")}00bb`]));
const fleet = [null, "snoke", "darth", "maul", "ventress"];

test("each machine gets its own theme color, never the red that means needs-you or offline", () => {
  const colors = machineColors(dark, fleet);
  assert.equal(colors.size, 5);
  assert.equal(new Set(colors.values()).size, 5, "no two machines share a color");
  for (const color of colors.values()) assert.ok(![dark.ansi1, dark.ansi9].includes(color));
  assert.equal(colors.get("local"), machineColor(dark, null, fleet));
});

test("a machine's color does not depend on list order, load order or restarts", () => {
  const once = machineColors(dark, fleet);
  const shuffled = machineColors(dark, [...fleet].reverse());
  assert.deepEqual([...shuffled.entries()].sort(), [...once.entries()].sort());
  // A fresh evaluation stands for a restart: the result is a pure function of the names.
  assert.equal(machineColor(dark, "snoke", fleet), once.get("snoke"));
  assert.equal(machineColor(dark, "snoke", ["snoke", "maul", null, "ventress", "darth"]), once.get("snoke"));
});

test("light and dark themes give the same slot, in each theme's own color", () => {
  const slot = (t, name) => Object.keys(t).find(k => t[k] === machineColor(t, name, fleet));
  for (const name of fleet) assert.equal(slot(dark, name), slot(light, name));
});

test("a theme without ansi colors still draws every machine", () => {
  assert.equal(machineColor({ muted: "#777777" }, "snoke", fleet), "#777777");
});

test("connection state comes from Herdr's machine list", () => {
  const known = [{ name: null, layout: "ready" }, { name: "snoke", layout: "ready" },
    { name: "darth", layout: "unavailable" }, { name: "maul", layout: "loading" }];
  assert.equal(machineState(null, known), "online");
  assert.equal(machineState("snoke", known), "online");
  assert.equal(machineState("darth", known), "offline");
  assert.equal(machineState("maul", known), "connecting");
  assert.equal(machineState("ventress", known), "offline", "a machine Herdr no longer lists cannot be reached");
  assert.equal(stateWord("online"), "");
  assert.equal(stateWord("offline"), "offline");
  assert.equal(stateWord("connecting"), "connecting…");
  assert.equal(machineLabel(null), "local");
});

test("the window header's copy of the machine helpers is the same file", () => {
  const here = readFileSync(new URL("./machines.js", import.meta.url), "utf8");
  const chrome = readFileSync(new URL("../erics-linear-chrome/machines.js", import.meta.url), "utf8");
  assert.equal(chrome, here, "copy mods/linear-board/machines.js to mods/erics-linear-chrome/machines.js");
});
