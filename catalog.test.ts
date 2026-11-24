import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@opencode/plugin";
import { buildInventory, mergeMetadata, parseCatalog, perMillion, type RemoteModel } from "./catalog.ts";

export function remote(id = "openai/example"): RemoteModel {
  return {
    id, aliases: [], display_name: "Example", created: 1_790_000_000,
    context_window: 200_000, max_output: 32_000,
    capabilities: { reasoning: true, tool_calling: true },
    input_modalities: ["file", "image", "text"], output_modalities: ["text"],
    pricing: { prompt: "0.000051516", completion: "0.000237767", input_cache_read: "0.000005152", input_cache_write: "0.000000123" },
  };
}

test("token prices retain API precision when converted to a million tokens", () => {
  assert.equal(perMillion("0.000051516"), 51.516);
  assert.equal(perMillion("0.000000123"), 0.123);
  assert.equal(perMillion("1.25e-7"), 0.125);
  assert.equal(perMillion("0"), 0);
  for (const bad of [undefined, null, "", "NaN", "-0.1", "1e400", "0.1 USD"]) {
    assert.throws(() => perMillion(bad));
  }
});

test("empty, duplicate, partial and invalid catalogs cannot replace the inventory", () => {
  assert.throws(() => parseCatalog({ object: "list", data: [] }));
  assert.throws(() => parseCatalog({ object: "list", data: [remote(), remote()] }));
  assert.throws(() => parseCatalog({ object: "list", data: [remote()], has_more: true }));
  assert.throws(() => parseCatalog({ object: "list", data: [{ ...remote(), pricing: { prompt: "bad" } }] }));
  assert.equal(parseCatalog({ object: "list", data: [remote()] }).length, 1);
  assert.equal(parseCatalog({ object: "list", data: [{ ...remote(), output_modalities: ["image"], context_window: null, max_output: null }] }).length, 1);
  assert.throws(() => parseCatalog({ object: "list", data: [{ ...remote(), context_window: null }] }));
});

test("catalog mapping splits Anthropic, omits nontext models, preserves custom variants and settings", () => {
  const initial = buildInventory("selectel", [remote()], {}, new Map())[0];
  const prior = {
    ...initial,
    settings: { temperature: 0.2 }, headers: { "x-custom": "yes" }, enabled: false,
    variants: [{ id: "custom" as Model.Variant["id"], body: { custom_reasoning: "careful" } }, { id: "high" as Model.Variant["id"], body: { reasoning_effort: "high", extra: true } }],
  } as Model.Info;
  const entries = [remote(), remote("anthropic/claude-example-5.5"), { ...remote("image/example"), output_modalities: ["image"] }];
  const meta = { "openai/example": { reasoning: { supported: true, effort: ["none", "low", "high", "max"] } } };
  const result = buildInventory("selectel", entries, meta, new Map([[prior.id, prior]]));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].settings, prior.settings);
  assert.deepEqual(result[0].headers, prior.headers);
  assert.equal(result[0].enabled, false);
  assert.deepEqual(result[0].capabilities.input, ["pdf", "image", "text"]);
  assert.deepEqual(result[0].variants.find((v) => v.id === "high"), prior.variants[1]);
  assert.deepEqual(result[0].variants.find((v) => v.id === "none")?.body, { reasoning_effort: "off" });
  assert.deepEqual(result[0].variants.map((v) => v.id), ["none", "low", "high", "max", "custom"]);
  assert.deepEqual(prior.variants.map((v) => v.id), ["custom", "high"]);
  assert.equal(buildInventory("selectel", [remote("new/model")], {}, new Map([[prior.id, prior]])).some((m) => m.id === prior.id), false);
});

test("Anthropic IDs use advertised aliases or a canonical request ID and native reasoning", () => {
  const first = { ...remote("anthropic/claude-sonnet-5.5"), aliases: ["claude-sonnet-5-5"] };
  const second = remote("anthropic/claude-fable-5.2");
  const meta = {
    [first.id]: { reasoning: { supported: true, effort: ["none", "high"] } },
    [second.id]: { reasoning: { supported: true, toggle: true } },
  };
  const result = buildInventory("selectel-anthropic", [first, second], meta, new Map());
  assert.equal(result[0].id, "claude-sonnet-5-5");
  assert.equal(result[0].modelID, "claude-sonnet-5-5");
  assert.deepEqual(result[0].variants.find((v) => v.id === "high")?.settings, { thinking: { type: "adaptive", display: "summarized" }, effort: "high" });
  assert.equal(result[1].id, "claude-fable-5-2");
  assert.equal(result[1].modelID, second.id);
  assert.deepEqual(result[1].variants.map((v) => v.id), ["none", "thinking"]);
});

test("metadata refresh cannot erase previous reasoning efforts", () => {
  const before = { example: { reasoning: { supported: true, effort: ["low", "max"], toggle: true } } };
  const result = mergeMetadata(before, { example: { reasoning: { supported: true, effort: ["none", "high"] } } });
  assert.deepEqual(new Set(result.example.reasoning?.effort), new Set(["low", "max", "none", "high"]));
  assert.equal(result.example.reasoning?.toggle, true);
  assert.deepEqual(before.example.reasoning.effort, ["low", "max"]);
  assert.deepEqual(mergeMetadata(before, {}).example, before.example);
});

test("Selectel lab IDs use exact known metadata aliases without guessing families", () => {
  const entries = [remote("selectel/qwen3.8-27b"), remote("selectel/qwen3.8-flash-next")];
  const meta = { "qwen/qwen3.8-27b": { reasoning: { supported: true, effort: ["low", "xhigh"] } } };
  const result = buildInventory("selectel", entries, meta, new Map());
  assert.deepEqual(result[0].variants.map((v) => v.id), ["low", "xhigh"]);
  assert.deepEqual(result[1].variants, []);
});
