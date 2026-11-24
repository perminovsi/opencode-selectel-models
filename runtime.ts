import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import type { ConnectionInfo } from "@opencode/client";
import {
  PROVIDERS, buildInventory, findMetadata, mergeMetadata, parseCatalog, record,
  type MetadataIndex, type ProviderID, type RemoteModel,
} from "./catalog.ts";
import { fetchMetadata, fetchSelectel } from "./sources.ts";
import type { Status } from "./format.ts";

type Context = Plugin.Context;
type Account = { key: string; fingerprint: string; connection: ConnectionInfo };
type Snapshot = { updatedAt: number; models: RemoteModel[]; fingerprint: string };
type Options = { refreshIntervalMs: number; autoRefresh: boolean; aliases: Record<string, string> };
type ProviderEditor = Parameters<Parameters<Context["provider"]["transform"]>[0]>[0];
type ProviderInfo = Parameters<ProviderEditor["add"]>[0]["info"];

export function readOptions(input: Record<string, unknown>): Options {
  const refreshIntervalMs = input.refreshIntervalMs ?? 21_600_000;
  if (!Number.isSafeInteger(refreshIntervalMs) || Number(refreshIntervalMs) < 60_000 || Number(refreshIntervalMs) > 2_147_483_647) {
    throw new Error("selectel-models: refreshIntervalMs must be an integer between 60000 and 2147483647.");
  }
  if (input.autoRefresh !== undefined && typeof input.autoRefresh !== "boolean") {
    throw new Error("selectel-models: autoRefresh must be a boolean.");
  }
  const aliases = input.metadataAliases ?? {};
  if (!record(aliases) || !Object.values(aliases).every((id) => typeof id === "string" && id.length > 0)) {
    throw new Error("selectel-models: metadataAliases must map Selectel IDs to OpenRouter IDs.");
  }
  return { refreshIntervalMs: Number(refreshIntervalMs), autoRefresh: input.autoRefresh !== false, aliases: aliases as Record<string, string> };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Catalog refresh failed.";
  return message.replace(/sk-[\w.-]+/g, "[redacted]").slice(0, 500);
}

function sameAccount(left: Account | undefined, right: Account | undefined): boolean {
  const identity = (account: Account | undefined) => !account ? undefined
    : account.connection.type === "credential" ? account.connection.id : account.connection.name;
  return left?.fingerprint === right?.fingerprint && identity(left) === identity(right);
}

export function createUpdater(
  ctx: Context,
  options = readOptions(ctx.options),
  sources = { selectel: fetchSelectel, metadata: fetchMetadata },
) {
  const controller = new AbortController();
  const snapshots = new Map<ProviderID, Snapshot>();
  const connections = new Map<ProviderID, Account>();
  const counts = new Map<ProviderID, number>();
  const cached = new Set<ProviderID>();
  const errors = new Map<ProviderID, string>();
  let declared = new Map<ProviderID, ProviderInfo>();
  let metadata: MetadataIndex = Object.create(null);
  let metadataAt = 0;
  let etag: string | undefined;
  let lastAttempt = 0;
  let lastError: string | undefined;
  let warning: string | undefined;
  let running: Promise<Status> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let eventTask: Promise<void> | undefined;

  const status = (): Status => ({
    refreshing: !!running,
    ...(lastAttempt ? { lastAttempt: new Date(lastAttempt).toISOString() } : {}),
    ...(metadataAt ? { metadataUpdatedAt: new Date(metadataAt).toISOString() } : {}),
    metadataModels: Object.keys(metadata).length,
    ...(lastError ? { error: lastError } : {}),
    ...(warning ? { warning } : {}),
    providers: Object.fromEntries(PROVIDERS.map((pid) => {
      const snapshot = snapshots.get(pid);
      const inventory = snapshot?.models.filter((model) => model.output_modalities.includes("text")
        && model.id.startsWith("anthropic/") === (pid === "selectel-anthropic"));
      return [pid, {
        models: inventory?.length ?? counts.get(pid) ?? 0,
        ...(snapshot ? { updatedAt: new Date(snapshot.updatedAt).toISOString() } : {}),
        cached: cached.has(pid),
        missingMetadata: inventory?.filter((model) => !findMetadata(model.id, metadata, options.aliases)).map((model) => model.id) ?? [],
        ...(errors.has(pid) ? { error: errors.get(pid) } : {}),
      }];
    })),
  });

  async function account(pid: ProviderID): Promise<Account | undefined> {
    const connection = await ctx.integration.connection.active(pid);
    if (!connection) return;
    const credential = await ctx.integration.connection.resolve(connection);
    if (credential?.type !== "key" || !credential.key) return;
    return {
      connection, key: credential.key,
      fingerprint: createHash("sha256").update(credential.key).digest("hex"),
    };
  }

  function cacheKey(pid: ProviderID, fingerprint: string): string {
    return `v1/catalog/${pid}/${fingerprint}`;
  }

  // The host omits providers declared only in opencode.json from the editor, so their definitions come from the provider list.
  async function loadDeclared(): Promise<void> {
    try {
      const { data } = await ctx.provider.list();
      declared = new Map(data.flatMap((info) => PROVIDERS.includes(info.id as ProviderID) ? [[info.id as ProviderID, info as ProviderInfo] as const] : []));
    } catch { /* Keep the previous definitions; the editor still exposes providers it knows about. */ }
  }

  async function syncAccounts(): Promise<void> {
    let changed = false;
    for (const pid of PROVIDERS) {
      const current = await account(pid);
      const prior = connections.get(pid);
      if (!current) errors.set(pid, `Connect ${pid} with an API key using /connect.`);
      if (sameAccount(prior, current)) continue;
      connections.delete(pid);
      snapshots.delete(pid);
      cached.delete(pid);
      counts.delete(pid);
      changed = true;
      if (!current) continue;
      connections.set(pid, current);
      errors.delete(pid);
      const saved = await ctx.storage.get(cacheKey(pid, current.fingerprint));
      if (record(saved) && Number.isSafeInteger(saved.updatedAt) && Array.isArray(saved.models)) {
        try {
          const models = parseCatalog({ object: "list", data: saved.models });
          snapshots.set(pid, { models, updatedAt: Number(saved.updatedAt), fingerprint: current.fingerprint });
          cached.add(pid);
        } catch { /* Ignore an invalid cache and keep the configured provider inventory. */ }
      }
    }
    if (changed) await ctx.provider.reload();
  }

  async function refreshNow(): Promise<void> {
    lastAttempt = Date.now();
    lastError = undefined;
    warning = undefined;
    await syncAccounts();
    controller.signal.throwIfAborted();
    // Fetch a shared credential only once, even when both providers use it.
    const downloads = new Map<string, Promise<RemoteModel[]>>();
    const selectel = PROVIDERS.map(async (pid) => {
      const selected = connections.get(pid);
      if (!selected) return;
      let download = downloads.get(selected.fingerprint);
      if (!download) {
        download = sources.selectel(selected.key, controller.signal);
        downloads.set(selected.fingerprint, download);
      }
      try {
        const models = await download;
        controller.signal.throwIfAborted();
        const current = await account(pid);
        if (!sameAccount(current, selected)) return;
        if (!models.some((model) => model.output_modalities.includes("text") && model.id.startsWith("anthropic/") === (pid === "selectel-anthropic"))) {
          throw new Error(`Selectel returned no text models for ${pid}; the previous inventory was kept.`);
        }
        const snapshot = { models, fingerprint: selected.fingerprint, updatedAt: Date.now() };
        snapshots.set(pid, snapshot);
        cached.delete(pid);
        errors.delete(pid);
        await ctx.storage.set(cacheKey(pid, selected.fingerprint), JSON.parse(JSON.stringify({ models, updatedAt: snapshot.updatedAt })));
      } catch (error) {
        controller.signal.throwIfAborted();
        errors.set(pid, safeError(error));
        if (snapshots.has(pid)) cached.add(pid);
      }
    });
    const metadataDownload = (async () => {
      try {
        const incoming = await sources.metadata(etag, controller.signal);
        controller.signal.throwIfAborted();
        if (incoming.models) metadata = mergeMetadata(metadata, incoming.models);
        if (!Object.keys(metadata).length) throw new Error("No models.dev metadata is available yet.");
        etag = incoming.etag;
        metadataAt = Date.now();
        await ctx.storage.set("v1/metadata", JSON.parse(JSON.stringify({ models: metadata, updatedAt: metadataAt, etag })));
      } catch (error) {
        controller.signal.throwIfAborted();
        warning = `${safeError(error)} Existing reasoning variants were preserved.`;
      }
    })();
    await Promise.all([...selectel, metadataDownload]);
    await syncAccounts();
    controller.signal.throwIfAborted();
    await loadDeclared();
    await ctx.provider.reload();
    if (errors.size) lastError = [...new Set(errors.values())].join(" ");
  }

  function refresh(): Promise<Status> {
    if (running) return running;
    running = refreshNow().catch((error) => {
      if (!controller.signal.aborted) lastError = safeError(error);
    }).then(() => { running = undefined; return status(); });
    return running;
  }

  async function start(): Promise<void> {
    const saved = await ctx.storage.get("v1/metadata");
    if (record(saved) && record(saved.models) && Number.isSafeInteger(saved.updatedAt)) {
      metadata = saved.models as MetadataIndex;
      metadataAt = Number(saved.updatedAt);
      etag = typeof saved.etag === "string" ? saved.etag : undefined;
    }
    await syncAccounts();
    await loadDeclared();
    await ctx.provider.transform((editor) => {
      for (const pid of PROVIDERS) {
        const record = editor.get(pid);
        const info = record?.provider ?? declared.get(pid);
        const snapshot = snapshots.get(pid);
        const current = connections.get(pid);
        if (!info) continue;
        if (!snapshot || !current || current.fingerprint !== snapshot.fingerprint) {
          counts.set(pid, record?.models.size ?? 0);
          continue;
        }
        const models = buildInventory(pid, snapshot.models, metadata, record?.models ?? new Map(), options.aliases);
        counts.set(pid, models.length);
        editor.add({ info, models, sourceConnection: current.connection });
      }
    });
    // Register immediately, then refresh in the background so network latency does not delay startup.
    if (options.autoRefresh) {
      void refresh();
      timer = setInterval(() => void refresh(), options.refreshIntervalMs);
      timer.unref();
    }
    eventTask = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: ["credential.switched", "credential.updated", "integration.updated"], signal: controller.signal })) {
          if (event.type && !controller.signal.aborted) {
            if (running) await running;
            if (!controller.signal.aborted) await refresh();
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) lastError = safeError(error);
      }
    })();
  }

  async function stop(): Promise<void> {
    if (timer) clearInterval(timer);
    controller.abort();
    await Promise.allSettled([running, eventTask]);
    connections.clear();
  }

  return { start, stop, refresh, status };
}
