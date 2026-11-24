import assert from "node:assert/strict";
import { test } from "node:test";
import { formatStatus } from "./format.ts";

test("status shows times in the system's local zone as DD.MM.YYYY HH:MM:SS", () => {
  const iso = "2026-11-24T13:49:40.176Z";
  const local = new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short",
  });
  const text = formatStatus({
    refreshing: false,
    metadataModels: 10,
    metadataUpdatedAt: iso,
    providers: { selectel: { models: 334, updatedAt: iso, cached: false, missingMetadata: [] } },
  });
  assert.ok(text.includes(`обновлено ${local}`));
  assert.ok(text.includes(`проверены ${local}`));
  assert.match(local, /^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2} /);
  assert.ok(!text.includes(iso));
});
