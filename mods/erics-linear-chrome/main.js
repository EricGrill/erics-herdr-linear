// Adapted from Herdr v0.1.12 defaults/mods/workspace-chrome (Apache-2.0).
// Modified for Eric's Herdr Linear: personal layout integration and popup/branding behavior.
// See THIRD_PARTY_NOTICES.md and licenses/herdr-app-Apache-2.0.txt.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, machines } from "herdr";
import { machineColor, machineLabel, machineState, stateWord } from "./machines.js";

// Published by the Linear sidebar: how many open spaces need you.
const NEEDS = "erics-linear.needs-you";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  /** "Needs you" as a count, or nothing at zero. Shown on the rail too. */
  needsBadge(small = false) {
    const t = theme(), n = Number(shared(NEEDS) ?? 0);
    if (!(n > 0)) return null;
    const words = `${n} space${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you`;
    const size = small ? 14 : 18;
    return div().id("needs-you").flex_none().h(size).min_w(size).px(small ? 3 : 5).flex().items_center().justify_center().rounded(size / 2)
      .bg(t.blocked).text_color(t.background).text_size(small ? 9.5 : 11).font_semibold()
      .tooltip(words).accessibility_label(words).child(String(n));
  }
  /** Each remote machine, in its own color, and whether it is connected. */
  machineList() {
    const t = theme(), known = machines(), names = known.map(m => m.name ?? null);
    const remote = names.filter(name => name !== null);
    return h_flex().id("machine-states").h(18).pl(31).gap(8).items_center().overflow_hidden().text_size(11)
      .children(remote.map(name => {
        const state = machineState(name, known), word = stateWord(state), color = machineColor(t, name, names);
        return h_flex().id(`machine-state-${name}`).flex_none().gap(4).items_center()
          .tooltip(`${machineLabel(name)} · ${word || "connected"}`)
          .child(div().size(7).rounded(7).flex_none()
            .when(state === "online", el => el.bg(color))
            .when(state === "connecting", el => el.bg(color).opacity(0.45))
            .when(state === "offline", el => el.border_1().border_color(color)))
          .child(div().text_color(state === "online" ? t.dim : t.blocked).child(word ? `${machineLabel(name)} ${word}` : machineLabel(name)));
      }));
  }
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/erics-linear-chrome/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label));
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(!collapsed && Boolean(props()?.version), el => el
            .child(div().flex_1())
            .child(div().text_size(11).text_color(t.muted).child(`Layout v${props().version}`)))
          .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent))))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })))
        .when(!collapsed, el => el.child(this.machineList()));
    }
    const badge = this.needsBadge(collapsed);
    // On the macOS rail the window buttons fill the row, so the count sits under them.
    if (collapsed && window()?.platform === "macos") {
      return v_flex().size_full().bg(t.chrome).items_center().justify_end().pb(2)
        .when(Boolean(badge), el => el.child(badge));
    }
    // Elsewhere the rail is only as wide as its button, so the count sits on its corner.
    if (collapsed) {
      return h_flex().size_full().bg(t.chrome).items_center().justify_center()
        .child(div().relative()
          .child(this.button("sidebar-toggle", svg("mods/erics-linear-chrome/sidebar.svg").size(15), toggleSidebar))
          .when(Boolean(badge), el => el.child(badge.absolute().top(-5).right(-7))));
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Erics Linear"))
        .when(Boolean(badge), el => el.child(badge))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/erics-linear-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/erics-linear-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
