import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import { parse } from "smol-toml";
import { MODELS_DEV_URL, SELECTEL_URL, parseCatalog, parseMetadata, type MetadataIndex, type RemoteModel } from "./catalog.ts";

const MAX_COMPRESSED = 24 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_ENTRY = 1024 * 1024;

function limit(bytes: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(received > bytes ? new Error("Catalog download exceeded the size limit.") : null, chunk);
    },
  });
}

async function json(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Selectel returned no response body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_COMPRESSED) throw new Error("Selectel catalog exceeded the size limit.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Selectel returned malformed JSON."); }
}

export async function fetchSelectel(key: string, signal: AbortSignal): Promise<RemoteModel[]> {
  const response = await fetch(SELECTEL_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Selectel catalog request failed (HTTP ${response.status}).`);
  }
  return parseCatalog(await json(response));
}

/** Read only TOML metadata from the archive; never extract files or execute repository code. */
export async function readMetadataArchive(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<MetadataIndex> {
  const archive = extract();
  const models: MetadataIndex = Object.create(null);
  let entries = 0;
  archive.on("entry", (header, stream, next) => {
    if (++entries > 50_000) { archive.destroy(new Error("models.dev archive contains too many entries.")); return; }
    const match = /^[^/]+\/providers\/openrouter\/models\/(.+)\.toml$/.exec(header.name);
    if (!match || header.type !== "file") {
      stream.on("end", next);
      stream.resume();
      return;
    }
    if (header.size! > MAX_ENTRY || match[1].split("/").some((part) => part === ".." || part === ".")) {
      archive.destroy(new Error("Invalid models.dev archive entry."));
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", (error) => archive.destroy(error));
    stream.on("end", () => {
      try {
        if (Object.hasOwn(models, match[1])) throw new Error("Duplicate models.dev entry.");
        models[match[1]] = parseMetadata(parse(Buffer.concat(chunks).toString("utf8")));
        next();
      } catch {
        archive.destroy(new Error(`Invalid models.dev metadata: ${match[1]}.`));
      }
    });
  });
  await pipeline(Readable.from(body), limit(MAX_COMPRESSED), createGunzip(), limit(MAX_EXPANDED), archive, { signal });
  if (!Object.keys(models).length) throw new Error("models.dev returned no OpenRouter model metadata.");
  return models;
}

export async function fetchMetadata(etag: string | undefined, signal: AbortSignal): Promise<{ etag?: string; models?: MetadataIndex }> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const response = await fetch(MODELS_DEV_URL, {
    headers: { Accept: "application/gzip", ...(etag ? { "If-None-Match": etag } : {}) },
    signal: requestSignal,
  });
  if (response.status === 304) { await response.body?.cancel(); return { etag }; }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`models.dev download failed (HTTP ${response.status}).`);
  }
  return { etag: response.headers.get("etag") ?? undefined, models: await readMetadataArchive(response.body, requestSignal) };
}
