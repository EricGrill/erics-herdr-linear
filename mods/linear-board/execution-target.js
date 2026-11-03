// Portable, non-secret task placement. Core IDs survive a different client's local/remote view.
import { exec, machines } from "herdr";
import { validateRepository } from "./repository.js";

const MARKER = "<!-- erics-herdr-linear:execution-target";
const BLOCK = /\\?<!-- erics-herdr-linear:execution-target\s*\n([\s\S]*?)\n\\?-->/g;
const JSON_KEY = "ericsHerdrLinearExecutionTarget";
const JSON_BLOCK = /```json[^\S\n]*\r?\n([\s\S]*?)\r?\n```/gi;
const CORE_COMMAND = 'PATH="$HOME/.local/bin:$PATH"\nexec hc "$@"';

async function coreCommand(args, machine) {
  return exec("sh", ["-c", CORE_COMMAND, "herdr-execution-target", ...args], { on: machine ?? null });
}

function checked(value) {
  if (!value || value.version !== 1 || typeof value.computerId !== "string" || !value.computerId.trim()
    || typeof value.computerName !== "string" || !value.computerName.trim()
    || typeof value.folder !== "string" || !value.folder.startsWith("/") || value.folder.includes("\0")) {
    throw new Error("The ticket's saved execution target is invalid. Choose its computer and repository explicitly.");
  }
  return { version: 1, computerId: value.computerId, computerName: value.computerName,
    folder: value.folder, name: typeof value.name === "string" ? value.name : value.folder.split("/").pop(),
    root: typeof value.root === "string" ? value.root : "" };
}

async function coreStatus(machine) {
  const result = await coreCommand(["server", "status"], machine);
  if (result.code !== 0) throw new Error(`Cannot identify ${machine ?? "this computer"}. Reconnect it before selecting a repository.`);
  let core;
  try { core = JSON.parse(result.stdout).core; } catch { /* invalid replies fail closed below */ }
  if (typeof core?.id !== "string" || !core.id || typeof core?.name !== "string" || !core.name) {
    throw new Error("Herdr did not return a stable computer identity.");
  }
  return core;
}

export async function identifyExecutionTarget(target) {
  const core = await coreStatus(target.machine);
  if (target.computerId && target.computerId !== core.id) {
    throw new Error("The selected computer no longer matches the ticket's saved target. Choose the computer explicitly.");
  }
  return { ...target, computerId: core.id, computerName: core.name };
}

function ownedBlocks(text) {
  const json = [...text.matchAll(JSON_BLOCK)].filter(match => match[1].includes(`"${JSON_KEY}"`));
  const legacy = [...text.matchAll(BLOCK)];
  if (json.length + legacy.length !== 1 || (legacy.length && text.split(MARKER).length !== 2)) {
    throw new Error("The ticket's saved execution target is malformed or ambiguous. Choose its computer and repository explicitly.");
  }
  const match = json[0] ?? legacy[0];
  let value;
  try { value = JSON.parse(match[1]); }
  catch { throw new Error("The ticket's saved execution target is invalid JSON. Choose its computer and repository explicitly."); }
  return { text: match[0], value: checked(json.length ? value[JSON_KEY] : value) };
}

export function readExecutionTarget(description) {
  const text = String(description ?? "");
  if (!text.includes(MARKER) && !text.includes(`"${JSON_KEY}"`)) return null;
  return ownedBlocks(text).value;
}

export function descriptionWithExecutionTarget(description, target) {
  const text = String(description ?? "");
  // Linear normalizes Markdown and escapes HTML comment terminators. Standard
  // fenced JSON survives the API roundtrip and is visible to the ticket owner.
  const hasTarget = text.includes(MARKER) || text.includes(`"${JSON_KEY}"`);
  const base = hasTarget ? text.replace(ownedBlocks(text).text, "") : text;
  const value = { [JSON_KEY]: checked({ version: 1, ...target }) };
  const body = JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/`/g, "\\u0060");
  const separator = !base || base.endsWith("\n\n") ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  return `${base}${separator}\`\`\`json\n${body}\n\`\`\``;
}

export async function resolveExecutionTarget(saved) {
  const target = checked(saved);
  const local = await coreStatus(null);
  let machine = null;
  if (local.id !== target.computerId) {
    const result = await coreCommand(["machine", "ls"], null);
    if (result.code !== 0) throw new Error(`Cannot resolve saved computer ${target.computerName}. Choose a computer explicitly.`);
    let configured;
    try { configured = JSON.parse(result.stdout).machines; } catch { /* fail closed */ }
    const remote = Array.isArray(configured) && configured.find(m => m.id === target.computerId && m.name && !m.temporary);
    if (!remote || !machines().some(m => m.name === remote.name && m.layout === "ready")) {
      throw new Error(`Saved computer ${target.computerName} is unavailable here. Reconnect it or choose another computer explicitly.`);
    }
    machine = remote.name;
    // Verify the actual peer, rather than trusting a name/alias after a machine was replaced.
    const peer = await coreStatus(machine);
    if (peer.id !== target.computerId) throw new Error(`Saved computer ${target.computerName} has a different identity. Choose a computer explicitly.`);
  }
  const resolved = { ...target, machine };
  await validateRepository(resolved);
  return resolved;
}
