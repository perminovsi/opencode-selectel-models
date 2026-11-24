import { Plugin } from "@opencode/plugin/tui";
import { setupUI } from "./ui.ts";

export default Plugin.define({
  id: "selectel-models.tui",
  setup: setupUI,
});
