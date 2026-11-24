import type { Model } from "@opencode/plugin";

export const SELECTEL_URL = "https://api.selectel.ru/aig/v1/models";
export const MODELS_DEV_URL = "https://codeload.github.com/anomalyco/models.dev/tar.gz/refs/heads/dev";
export const PROVIDERS = ["selectel", "selectel-anthropic"] as const;
export type ProviderID = typeof PROVIDERS[number];

export type Reasoning = {
  supported: boolean;
  effort?: string[];
  toggle?: boolean;
  budget?: { min?: number; max?: number };
};
export type Metadata = { reasoning?: Reasoning; releaseDate?: string };
export type MetadataIndex = Record<string, Metadata>;
export type RemoteModel = {
  id: string;
  aliases: string[];
  display_name: string;
  created: number;
  context_window: number | null;
  max_output: number | null;
  input_modalities: string[];
  output_modalities: string[];
  capabilities: { reasoning: boolean; tool_calling: boolean };
  pricing: Record<string, string | number>;
};

const ALIASES: Record<string, string> = {
  "reka/reka-edge": "rekaai/reka-edge",
  "sakana/namazu": "sakana/sakana-namazu",
  "selectel/deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "selectel/glm-5.3-flash": "z-ai/glm-5.3-flash",
  "selectel/qwen3.8-27b": "qwen/qwen3.8-27b",
};
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Shift the decimal exponent, avoiding multiplication errors such as 51.516000000000005. */
export function perMillion(value: unknown): number {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new Error("Selectel returned an invalid token price.");
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0) + 6 - fraction.length;
  const price = Number(`${match[1]}${fraction}e${exponent}`);
  if (!Number.isFinite(price) || price < 0 || price > Number.MAX_SAFE_INTEGER) {
    throw new Error("Selectel returned a token price outside the supported range.");
  }
  return price;
}

export function parseCatalog(payload: unknown): RemoteModel[] {
  if (!record(payload) || payload.object !== "list" || !Array.isArray(payload.data) || !payload.data.length) {
    throw new Error("Selectel returned an empty or invalid model catalog; the previous inventory was kept.");
  }
  if (payload.has_more || payload.next || payload.next_page) {
    throw new Error("Selectel returned an incomplete catalog; the previous inventory was kept.");
  }
  const ids = new Set<string>();
  return payload.data.map((value: unknown) => {
    if (!record(value) || typeof value.id !== "string" || !value.id || /[#\s]/.test(value.id)
      || typeof value.display_name !== "string" || !value.display_name
      || !strings(value.aliases) || !strings(value.input_modalities) || !strings(value.output_modalities)
      || !record(value.capabilities) || typeof value.capabilities.reasoning !== "boolean"
      || typeof value.capabilities.tool_calling !== "boolean" || !record(value.pricing)
      || !Number.isSafeInteger(value.created) || Number(value.created) < 0
      || !(value.context_window === null || Number.isSafeInteger(value.context_window) && Number(value.context_window) > 0)
      || !(value.max_output === null || Number.isSafeInteger(value.max_output) && Number(value.max_output) > 0)
      || value.output_modalities.includes("text") && (value.context_window === null || value.max_output === null)) {
      throw new Error("Selectel returned an invalid model entry; the previous inventory was kept.");
    }
    if (ids.has(value.id)) throw new Error("Selectel returned duplicate model IDs.");
    ids.add(value.id);
    perMillion(value.pricing.prompt);
    perMillion(value.pricing.completion);
    for (const key of ["input_cache_read", "input_cache_write"]) {
      if (key in value.pricing) perMillion(value.pricing[key]);
    }
    // Retain only public catalog fields. The cache never contains credentials or request headers.
    return {
      id: value.id, aliases: value.aliases, display_name: value.display_name,
      created: Number(value.created),
      context_window: value.context_window === null ? null : Number(value.context_window),
      max_output: value.max_output === null ? null : Number(value.max_output),
      input_modalities: value.input_modalities, output_modalities: value.output_modalities,
      capabilities: { reasoning: value.capabilities.reasoning, tool_calling: value.capabilities.tool_calling },
      pricing: Object.fromEntries(Object.entries(value.pricing).filter(([, price]) => typeof price === "string" || typeof price === "number")) as RemoteModel["pricing"],
    };
  });
}

export function parseMetadata(payload: unknown): Metadata {
  if (!record(payload)) throw new Error("Invalid models.dev metadata.");
  const result: Metadata = {};
  if (typeof payload.release_date === "string" && /^\d{4}-\d{2}(?:-\d{2})?$/.test(payload.release_date)) {
    result.releaseDate = payload.release_date;
  }
  const capabilities = payload.capabilities;
  const reasoning = record(capabilities) ? capabilities.reasoning : undefined;
  if (record(reasoning) && typeof reasoning.supported === "boolean") {
    result.reasoning = { supported: reasoning.supported };
    if (strings(reasoning.effort)) result.reasoning.effort = [...new Set(reasoning.effort)];
    if (typeof reasoning.toggle === "boolean") result.reasoning.toggle = reasoning.toggle;
    if (record(reasoning.budget)) {
      const min = reasoning.budget.min;
      const max = reasoning.budget.max;
      const budget: NonNullable<Reasoning["budget"]> = {};
      if (Number.isSafeInteger(min) && Number(min) >= 0) budget.min = Number(min);
      if (Number.isSafeInteger(max) && Number(max) >= 0) budget.max = Number(max);
      if (Object.keys(budget).length) result.reasoning.budget = budget;
    }
  }
  return result;
}

export function mergeMetadata(previous: MetadataIndex, incoming: MetadataIndex): MetadataIndex {
  const result = structuredClone(previous);
  for (const [id, meta] of Object.entries(incoming)) {
    const before = previous[id]?.reasoning;
    const next = structuredClone(meta);
    // Missing or reduced upstream controls must not silently remove a user's existing variants.
    if (before?.supported) {
      next.reasoning = { ...before, ...next.reasoning, supported: true };
      const effort = [...new Set([...(before.effort ?? []), ...(next.reasoning.effort ?? [])])];
      if (effort.length) next.reasoning.effort = effort;
      if (before.toggle) next.reasoning.toggle = true;
    }
    result[id] = next;
  }
  return result;
}

export function findMetadata(id: string, metadata: MetadataIndex, aliases: Record<string, string> = {}): Metadata | undefined {
  const lookup = aliases[id] ?? ALIASES[id] ?? id;
  return metadata[lookup] ?? metadata[lookup.replace(/:(?:exacto|extended)$/, "")];
}

function variant(id: string, anthropic: boolean): Model.Variant {
  return {
    id: id as Model.Variant["id"],
    ...(anthropic
      ? { settings: id === "none" ? { thinking: { type: "disabled" } } : { thinking: { type: "adaptive", display: "summarized" }, effort: id } }
      : { body: { reasoning_effort: id === "none" ? "off" : id } }),
  };
}

function variants(remote: RemoteModel, old: Model.Info | undefined, reasoning: Reasoning | undefined, anthropic: boolean): Model.Variant[] {
  const result = new Map((old?.variants ?? []).map((item) => [String(item.id), structuredClone(item)]));
  if (!remote.capabilities.reasoning) return [...result.values()];
  const efforts = reasoning?.supported ? reasoning.effort ?? [] : [];
  for (const effort of efforts) {
    if (effort !== "default" && !result.has(effort)) result.set(effort, variant(effort, anthropic));
  }
  if (reasoning?.toggle && !result.has("none")) result.set("none", variant("none", anthropic));
  if (anthropic && !efforts.length && (reasoning?.toggle || reasoning?.budget) && !result.has("thinking")) {
    const budgetTokens = Math.min(reasoning.budget?.max ?? 16_000, (remote.max_output ?? 0) - 1);
    if (budgetTokens >= Math.max(1024, reasoning.budget?.min ?? 0)) {
      result.set("thinking", { id: "thinking" as Model.Variant["id"], settings: { thinking: { type: "enabled", budgetTokens } } });
    }
  }
  return [...result.values()].sort((a, b) => {
    const left = EFFORT_ORDER.indexOf(a.id);
    const right = EFFORT_ORDER.indexOf(b.id);
    return (left < 0 ? 100 : left) - (right < 0 ? 100 : right);
  });
}

export function buildInventory(
  providerID: ProviderID,
  remote: readonly RemoteModel[],
  metadata: MetadataIndex,
  baseline: ReadonlyMap<string, Model.Info>,
  aliases: Record<string, string> = {},
): Model.Info[] {
  const anthropic = providerID === "selectel-anthropic";
  const models: Model.Info[] = [];
  const ids = new Set<string>();
  for (const item of remote) {
    if (!item.output_modalities.includes("text") || item.id.startsWith("anthropic/") !== anthropic) continue;
    if (item.context_window === null || item.max_output === null) throw new Error("A text model has no token limits.");
    const preferred = anthropic ? item.id.slice("anthropic/".length).replaceAll(".", "-") : item.id;
    const prior = baseline.get(preferred) ?? [...baseline.values()].find((model) => model.modelID === item.id || item.aliases.includes(model.modelID));
    const id = prior?.id ?? preferred;
    if (ids.has(id)) throw new Error("Selectel model aliases produced a duplicate ID.");
    ids.add(id);
    const meta = findMetadata(item.id, metadata, aliases);
    const published = meta?.releaseDate ? Date.parse(meta.releaseDate) : item.created * 1000;
    const model: Model.Info = {
      ...structuredClone(prior ?? {}),
      id: id as Model.Info["id"],
      providerID: providerID as Model.Info["providerID"],
      modelID: (anthropic && item.aliases.includes(preferred) ? preferred : item.id) as Model.Info["modelID"],
      name: item.display_name,
      capabilities: {
        ...prior?.capabilities,
        tools: item.capabilities.tool_calling,
        input: item.input_modalities.map((mode) => mode === "file" ? "pdf" : mode),
        output: [...item.output_modalities],
      },
      variants: variants(item, prior, meta?.reasoning, anthropic),
      time: { released: prior?.time.released || (Number.isFinite(published) ? published : item.created * 1000) },
      cost: [{
        input: perMillion(item.pricing.prompt) as Model.Cost["input"],
        output: perMillion(item.pricing.completion) as Model.Cost["output"],
        cache: {
          read: perMillion(item.pricing.input_cache_read ?? 0) as Model.Cost["cache"]["read"],
          write: perMillion(item.pricing.input_cache_write ?? 0) as Model.Cost["cache"]["write"],
        },
      }],
      status: prior?.status ?? "active",
      enabled: prior?.enabled ?? true,
      limit: {
        ...prior?.limit,
        ...(prior?.limit.input === undefined ? {} : { input: Math.min(prior.limit.input, item.context_window) }),
        context: item.context_window,
        output: item.max_output,
      },
    };
    models.push(model);
  }
  return models;
}
