import test from "node:test";
import assert from "node:assert/strict";
import { stackLayout, clampScroll, pinnedHeader, thumb } from "./sticky.js";

const sizes = { header: 28, row: 49, gap: 3 };
// Needs you (2 rows), Working (3 rows).
const stack = stackLayout([{ rows: 2 }, { rows: 3 }], sizes);

test("rows and headers are laid out in order with the column's gap between them", () => {
  assert.deepEqual(stack.items.map(i => [i.group, i.row, i.y]),
    [[0, -1, 0], [0, 0, 31], [0, 1, 83], [1, -1, 135], [1, 0, 166], [1, 1, 218], [1, 2, 270]]);
  assert.equal(stack.height, 319);
});

test("no header is pinned at the top, where the real one shows", () => {
  assert.equal(pinnedHeader(stack, 0), null);
});

test("the current group's header stays pinned while its rows scroll under it", () => {
  assert.deepEqual(pinnedHeader(stack, 40), { group: 0, top: 0 });
  // CHA-4292's row under "Working" keeps "Working" on screen above it.
  assert.deepEqual(pinnedHeader(stack, 200), { group: 1, top: 0 });
});

test("the next header pushes the pinned one up instead of overlapping it", () => {
  assert.deepEqual(pinnedHeader(stack, 120), { group: 0, top: -13 });
  assert.deepEqual(pinnedHeader(stack, 135), { group: 1, top: 0 });
});

test("the last header leaves with its group, so it never covers what follows", () => {
  // Linear search results can follow the last group.
  assert.deepEqual(pinnedHeader(stack, 300), { group: 1, top: -9 });
  assert.equal(pinnedHeader(stack, 319), null);
  assert.equal(pinnedHeader(stack, 400), null);
});

test("scrolling stops at either end, and an unmeasured list does not scroll", () => {
  assert.equal(clampScroll(-50, 319, 200), 0);
  assert.equal(clampScroll(500, 319, 200), 119);
  assert.equal(clampScroll(80, 319, 400), 0);
  assert.equal(clampScroll(80, 319, 0), 0);
  assert.equal(clampScroll(undefined, 319, 200), 0);
});

test("the scrollbar thumb tracks the offset and hides when everything fits", () => {
  assert.equal(thumb(0, 319, 400), null);
  assert.deepEqual(thumb(0, 319, 200).top, 0);
  const end = thumb(119, 319, 200);
  assert.equal(Math.round(end.top + end.h), 200);
});
