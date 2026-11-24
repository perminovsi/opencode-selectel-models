import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plugin } from "@opencode/plugin";
import { buildInventory, type MetadataIndex, type RemoteModel } from "./catalog.ts";
import { createUpdater, readOptions } from "./runtime.ts";

function fixture(id = "openai/example"): RemoteModel {
  return { id, display_name: id, aliases: [], created: 1_790_000_000, context_window: 100_000, max_output: 8000,
    capabilities: { reasoning: true, tool_calling: true }, input_modalities: ["text"], output_modalities: ["text"],
    pricing: { prompt: "0.000001", completion: "0.000002" } };
}

function context({ hostRecord = true, declared = true }: { hostRecord?: boolean; declared?: boolean } = {}) {
  let key = "sk-test-account-a";
  let credentialID = "credential-a";
  const storage = new Map<string, unknown>();
  const originalModels = new Map(buildInventory("selectel", [fixture()], {}, new Map()).map((m) => [String(m.id), m]));
  const provider = { provider: { id: "selectel", name: "Selectel", package: "@opencode/ai/providers/openai-compatible", activation: "enabled" }, models: originalModels };
  const published = new Map<string, { provider: Record<string, unknown>; models: Map<string, unknown> }>();
  const integrationMethods: unknown[] = [];
  let transform: ((editor: unknown) => void) | undefined;
  const reload = async () => {
    published.clear();
    if (hostRecord) published.set("selectel", provider);
    transform?.({ get: (pid: string) => pid === "selectel" && hostRecord ? provider : undefined, add: (entry: { info: { id: string }; models: { id: unknown }[] }) => {
      published.set(entry.info.id, { provider: entry.info, models: new Map(entry.models.map((m) => [String(m.id), m])) });
    } });
  };
  const ctx = {
    options: { autoRefresh: false },
    storage: { get: async (id: string) => storage.get(id), set: async (id: string, value: unknown) => { storage.set(id, structuredClone(value)); } },
    integration: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ get: () => undefined, update: () => {}, method: { update: (input: unknown) => { integrationMethods.push(input); } } });
      },
      connection: {
        active: async (id: string) => id === "selectel" ? { type: "credential", id: credentialID, method: "key", label: "Test" } : undefined,
        resolve: async () => ({ type: "key", key }),
      },
    },
    provider: {
      list: async () => ({ data: declared ? [provider.provider] : [] }),
      reload, transform: async (callback: (editor: unknown) => void) => { transform = callback; await reload(); },
    },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    } },
  } as unknown as Plugin.Context;
  return {
    ctx, storage, integrationMethods,
    models: (pid = "selectel") => published.get(pid)?.models ?? new Map<string, unknown>(),
    info: (pid = "selectel") => published.get(pid)?.provider,
    switchAccount: () => { key = "sk-test-account-b"; credentialID = "credential-b"; },
  };
}

test("failed refresh retains the last successful prices and reasoning; restarts use the cache", async () => {
  const fake = context();
  let fail = false;
  const sources = {
    selectel: async () => { if (fail) throw new Error("HTTP 503 sk-secret-must-not-leak"); return [fixture("openai/new")]; },
    metadata: async () => { if (fail) throw new Error("metadata offline"); return { models: { "openai/new": { reasoning: { supported: true, effort: ["high"] } } } as MetadataIndex }; },
  };
  const updater = createUpdater(fake.ctx, readOptions(fake.ctx.options), sources);
  await updater.start();
  const first = await updater.refresh();
  assert.equal(first.providers.selectel.models, 1);
  assert.deepEqual([...fake.models().keys()], ["openai/new"]);
  assert.deepEqual((fake.models().get("openai/new") as { variants: { id: string }[] }).variants.map((v) => v.id), ["high"]);
  fail = true;
  const failed = await updater.refresh();
  assert.deepEqual([...fake.models().keys()], ["openai/new"]);
  assert.equal(failed.providers.selectel.cached, true);
  assert.match(failed.error!, /\[redacted\]/);
  assert.equal(JSON.stringify([...fake.storage.values()]).includes("sk-test-account"), false);
  await updater.stop();
  const restored = createUpdater(fake.ctx, readOptions(fake.ctx.options), sources);
  await restored.start();
  assert.deepEqual([...fake.models().keys()], ["openai/new"]);
  assert.equal(restored.status().providers.selectel.cached, true);
  await restored.stop();
});

test("a changed credential cannot receive an inventory fetched for the previous account", async () => {
  const fake = context();
  let resolveDownload!: (models: RemoteModel[]) => void;
  let announce!: () => void;
  const started = new Promise<void>((resolve) => { announce = resolve; });
  const updater = createUpdater(fake.ctx, readOptions(fake.ctx.options), {
    selectel: async () => { announce(); return new Promise((resolve) => { resolveDownload = resolve; }); },
    metadata: async () => ({ models: {} }),
  });
  await updater.start();
  const pending = updater.refresh();
  assert.equal(updater.refresh(), pending);
  await started;
  fake.switchAccount();
  resolveDownload([fixture("openai/account-a-only")]);
  await pending;
  assert.deepEqual([...fake.models().keys()], ["openai/example"]);
  assert.equal([...fake.storage.keys()].some((key) => key.startsWith("v1/catalog/")), false);
  await updater.stop();
});

test("a declared provider without a host source record still receives the inventory", async () => {
  const fake = context({ hostRecord: false });
  const updater = createUpdater(fake.ctx, readOptions(fake.ctx.options), {
    selectel: async () => [fixture("openai/from-declared")],
    metadata: async () => ({ models: {} }),
  });
  await updater.start();
  const status = await updater.refresh();
  assert.equal(status.providers.selectel.models, 1);
  assert.deepEqual([...fake.models().keys()], ["openai/from-declared"]);
  await updater.stop();
});

test("the plugin registers one Selectel key integration for /connect", async () => {
  const fake = context();
  const updater = createUpdater(fake.ctx, readOptions(fake.ctx.options), {
    selectel: async () => [fixture()],
    metadata: async () => ({ models: {} }),
  });
  await updater.start();
  assert.deepEqual(fake.integrationMethods, [{ integrationID: "selectel", method: { type: "key", label: "Selectel API key", form: [{ key: "key", title: "API key", type: "string", required: true }] } }]);
  await updater.stop();
});

test("providers missing from opencode.json are registered by the plugin", async () => {
  const fake = context({ hostRecord: false, declared: false });
  const updater = createUpdater(fake.ctx, readOptions(fake.ctx.options), {
    selectel: async () => [fixture("openai/from-builtin"), fixture("anthropic/claude-builtin")],
    metadata: async () => ({ models: {} }),
  });
  await updater.start();
  const status = await updater.refresh();
  assert.equal(status.providers.selectel.models, 1);
  assert.equal(status.providers["selectel-anthropic"].models, 1);
  assert.deepEqual([...fake.models().keys()], ["openai/from-builtin"]);
  assert.deepEqual([...fake.models("selectel-anthropic").keys()], ["claude-builtin"]);
  assert.deepEqual(fake.info(), {
    id: "selectel", name: "Selectel", package: "@opencode/ai/providers/openai-compatible", activation: "auto",
    integrationID: "selectel", settings: { baseURL: "https://api.selectel.ru/aig/v1" },
  });
  assert.equal(fake.info("selectel-anthropic")?.package, "@opencode/ai/providers/anthropic-compatible");
  await updater.stop();
});
