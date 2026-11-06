// Original performance shim for Eric's Herdr Linear. MIT; see ../../LICENSE.
//
// Herdr's data calls (shared, spaces, agents, theme, ...) copy their whole value into the
// script every time. One sidebar render used to make ~580 of them and copy ~3 MB, mostly
// the 140 KB Linear enrichment read once per row. On a slower Linux laptop that ran past
// Herdr's script time limit, and the sidebar showed "This view could not be re-rendered
// ... interrupted" with no spaces.
//
// Inside a frame (one render), each call is answered once and reused. Outside a frame,
// calls go straight to Herdr. setShared drops that key so the next read is fresh.
// Callers must not mutate what these return: within a frame it is one shared copy.
import * as herdr from "herdr";

let frame = null;
let depth = 0;

/** Run fn with the cache on; nested frames share the outer one. */
export function inFrame(fn) {
  if (depth++ === 0) frame = new Map();
  try { return fn(); } finally { if (--depth === 0) frame = null; }
}

function cached(name, call) {
  return (...args) => {
    if (!frame) return call(...args);
    const key = args.length ? `${name}\u0000${JSON.stringify(args)}` : name;
    if (frame.has(key)) return frame.get(key);
    const value = call(...args);
    frame.set(key, value);
    return value;
  };
}

export const spaces = cached("spaces", () => herdr.spaces());
export const agents = cached("agents", () => herdr.agents());
export const panes = cached("panes", () => herdr.panes());
export const machines = cached("machines", () => herdr.machines());
export const theme = cached("theme", () => herdr.theme());
export const settings = cached("settings", () => herdr.settings());
export const window = cached("window", () => herdr.window());
export const keys = cached("keys", () => herdr.keys());
export const props = cached("props", () => herdr.props());
export const shared = cached("shared", key => herdr.shared(key));

export function setShared(key, value) {
  frame?.delete(`shared\u0000${JSON.stringify([key])}`);
  return herdr.setShared(key, value);
}
