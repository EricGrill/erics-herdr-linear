// A scrolled list of groups whose current group header stays pinned at the top.
// GPUI's scroll areas do not report where they are, so the sidebar owns its scroll
// offset and lays out fixed-height rows itself. Pure: no Herdr or GPUI APIs.

/** Where every header and row sits. `groups` is [{ rows: n }], heights in pixels.
 *  Returns { items: [{ group, row, y, h }], height } with row = -1 for a header. */
export function stackLayout(groups, { header, row, gap }) {
  const items = [];
  let y = 0;
  groups.forEach((g, group) => {
    if (items.length) y += gap;
    items.push({ group, row: -1, y, h: header });
    y += header;
    for (let i = 0; i < g.rows; i++) {
      y += gap;
      items.push({ group, row: i, y, h: row });
      y += row;
    }
  });
  return { items, height: y };
}

/** The offset clamped to what can be scrolled. An unknown viewport (no wheel event yet)
 *  allows nothing past the top. */
export function clampScroll(offset, height, viewport) {
  const max = viewport > 0 ? Math.max(0, height - viewport) : 0;
  return Math.min(Math.max(0, Number(offset) || 0), max);
}

/** Which header to pin at `offset`, and how far up it is pushed by the next header
 *  arriving under it, or by the end of its group when it is the last one. Null at the
 *  top, where the real header is already showing, and past the last group. */
export function pinnedHeader(layout, offset) {
  if (!(offset > 0)) return null;
  const headers = layout.items.filter(item => item.row === -1);
  let current = null, next = null;
  for (const h of headers) {
    if (h.y <= offset) current = h;
    else { next = h; break; }
  }
  if (!current) return null;
  const top = Math.min(0, (next ? next.y : layout.height) - offset - current.h);
  return top > -current.h ? { group: current.group, top } : null;
}

/** The scrollbar thumb, or null when everything fits. */
export function thumb(offset, height, viewport) {
  if (!(viewport > 0) || height <= viewport) return null;
  const h = Math.max(24, viewport * viewport / height);
  return { top: (viewport - h) * (offset / (height - viewport)), h };
}
