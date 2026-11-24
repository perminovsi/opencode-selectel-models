import type { Plugin } from "@opencode/plugin/tui";
import { SelectelModels } from "./rpc.ts";
import { formatStatus, type Status } from "./format.ts";

export function setupUI(ctx: Pick<Plugin.Context, "client" | "location" | "data" | "ui" | "keymap">) {
  const controller = new AbortController();
  let busy = false;
  const run = async (refresh: boolean) => {
    if (busy) return;
    busy = true;
    try {
      const rpc = ctx.client.rpc(SelectelModels);
      const options = { location: ctx.location ?? ctx.data.location.default(), signal: controller.signal };
      const result = (refresh ? await rpc.refresh({}, options) : await rpc.status({}, options)) as Status;
      if (controller.signal.aborted) return;
      await ctx.data.location.model.sync(options.location);
      if (controller.signal.aborted) return;
      await ctx.ui.dialog.alert({ title: "Selectel models", message: formatStatus(result) });
    } catch {
      if (!controller.signal.aborted) ctx.ui.toast.show({
        title: "Selectel models", message: "Не удалось прочитать состояние плагина. Проверьте подключение к серверу.", variant: "error",
      });
    } finally { busy = false; }
  };
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      { id: "selectel-models.update", title: "Обновить модели Selectel", group: "Selectel", palette: true, slash: { name: "selectel-models-update" }, run: () => run(true) },
      { id: "selectel-models.status", title: "Состояние каталога Selectel", group: "Selectel", palette: true, slash: { name: "selectel-models-status" }, run: () => run(false) },
    ],
  }));
  return () => controller.abort();
}
