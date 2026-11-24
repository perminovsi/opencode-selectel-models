import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { readMetadataArchive } from "./sources.ts";

async function archive(files: Record<string, string>): Promise<ReadableStream<Uint8Array>> {
  const tar = pack();
  for (const [name, content] of Object.entries(files)) tar.entry({ name }, content);
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) chunks.push(chunk as Buffer);
  return Readable.toWeb(Readable.from([gzipSync(Buffer.concat(chunks))])) as ReadableStream<Uint8Array>;
}

test("archive reader reads only OpenRouter TOML, not code or other providers", async () => {
  const body = await archive({
    "models.dev-dev/providers/openrouter/models/openai/example.toml": 'schema = 2\n[capabilities]\nreasoning = { supported = true, effort = ["low", "max"] }',
    "models.dev-dev/providers/openai/models/example.toml": "invalid TOML",
    "models.dev-dev/evil.ts": "throw new Error('must never run')",
  });
  const result = await readMetadataArchive(body, new AbortController().signal);
  assert.deepEqual(Object.keys(result), ["openai/example"]);
  assert.deepEqual(result["openai/example"].reasoning?.effort, ["low", "max"]);
});

test("invalid or empty archive cannot discard previous metadata", async () => {
  await assert.rejects(readMetadataArchive(await archive({ "models.dev-dev/README.md": "hello" }), new AbortController().signal));
  await assert.rejects(readMetadataArchive(await archive({ "models.dev-dev/providers/openrouter/models/example.toml": "[broken" }), new AbortController().signal));
});
