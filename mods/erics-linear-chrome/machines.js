// Which machine is which, at a glance: a stable color per machine and what its
// connection is doing. Pure: callers pass theme() and machines().
//
// This file is copied byte-for-byte into mods/erics-linear-chrome/machines.js, because
// mods cannot import from each other. machines.test.mjs fails if the two drift.

// Theme slots a machine may take, in preference order. Red (ansi1/ansi9) is left out:
// it already means "needs you" and "offline". Every theme names ansi0..ansi15 for both
// light and dark, so the dots follow the theme.
const SLOTS = ["ansi4", "ansi5", "ansi6", "ansi2", "ansi3", "ansi12", "ansi13", "ansi14", "ansi10", "ansi11"];

/** The name a machine goes by in the UI: null is this computer. */
export const machineLabel = name => name ?? "local";

// FNV-1a: small, stable across runs and engines, unlike anything keyed on load order.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** A color for every machine, by name ("local" for this computer). Each machine takes the
 *  slot its name hashes to, or the next free one if another machine already holds it.
 *  Machines claim slots in name order, so the result depends only on which machines exist
 *  and never on restart, list order or which machine answered first. */
export function machineColors(t, names = []) {
  const palette = [...new Set(SLOTS.map(k => t?.[k]).filter(Boolean))];
  const fallback = t?.muted ?? t?.foreground ?? "#888888";
  const all = [...new Set(["local", ...names.map(machineLabel)])].sort();
  const taken = new Set(), colors = new Map();
  for (const name of all) {
    if (!palette.length) { colors.set(name, fallback); continue; }
    let slot = hash(name) % palette.length;
    if (taken.size < palette.length) while (taken.has(slot)) slot = (slot + 1) % palette.length;
    taken.add(slot);
    colors.set(name, palette[slot]);
  }
  return colors;
}

/** One machine's color, among every machine Herdr knows. */
export function machineColor(t, name, known = []) {
  return machineColors(t, [...known, name]).get(machineLabel(name));
}

/** What a machine's connection is doing: "online", "connecting" (first read or a reconnect
 *  in progress) or "offline". This computer is always online. A machine a space names that
 *  Herdr no longer lists is offline: nothing can reach it. */
export function machineState(name, known = []) {
  if (name == null) return "online";
  const m = known.find(x => (x.name ?? null) === name);
  if (!m) return "offline";
  return m.layout === "ready" ? "online" : m.layout === "loading" ? "connecting" : "offline";
}

/** Words for a state, or "" when there is nothing to say. */
export const stateWord = state => state === "offline" ? "offline" : state === "connecting" ? "connecting…" : "";
