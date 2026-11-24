import assert from "node:assert/strict";
import { test } from "node:test";
import { setupUI } from "./ui.ts";

test("TUI commands call RPC at the current location, sync models and show a dialog", async () => {
  const location = { directory: "/test/project" };
  const calls: string[] = [];
  const dialogs: string[] = [];
  let commands: { slash: { name: string }; run: () => Promise<void> }[] = [];
  const reply = { refreshing: false, metadataModels: 10, providers: { selectel: { models: 334, cached: false, missingMetadata: [] } } };
  const rpcCall = (name: string) => async (_input: unknown, options: { location: unknown }) => {
    assert.deepEqual(options.location, location); calls.push(name); return reply;
  };
  const cleanup = setupUI({
    client: { rpc: () => ({ refresh: rpcCall("refresh"), status: rpcCall("status") }) },
    data: { location: { default: () => location, model: { sync: async (value: unknown) => { assert.equal(value, location); calls.push("sync"); } } } },
    keymap: { layer: (factory: () => { commands: typeof commands }) => { commands = factory().commands; } },
    ui: { dialog: { alert: async ({ message }: { message: string }) => { dialogs.push(message); } }, toast: { show: () => assert.fail("Unexpected error") } },
  } as unknown as Parameters<typeof setupUI>[0]);
  assert.deepEqual(commands.map((command) => command.slash.name), ["selectel-models-update", "selectel-models-status"]);
  await commands[0].run();
  await commands[1].run();
  assert.deepEqual(calls, ["refresh", "sync", "status", "sync"]);
  assert.equal(dialogs.length, 2);
  assert.match(dialogs[0], /334 моделей/);
  cleanup();
});
