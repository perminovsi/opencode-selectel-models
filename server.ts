import { Plugin } from "@opencode/plugin";
import { createUpdater } from "./runtime.ts";
import { SelectelModels } from "./rpc.ts";

export default Plugin.define({
  id: "selectel-models",
  async setup(ctx) {
    const updater = createUpdater(ctx);
    await updater.start();
    await ctx.rpc.register(SelectelModels, {
      refresh: async () => updater.refresh(),
      status: async () => updater.status(),
    });
    return () => updater.stop();
  },
});
