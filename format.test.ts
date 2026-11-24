import assert from "node:assert/strict";
import { test } from "node:test";
import { formatStatus } from "./format.ts";

test("status shows times in the system's local zone instead of raw UTC", () => {
  const iso = "2026-11-24T13:49:40.176Z";
  const local = new Date(iso).toLocaleString(undefined, { timeZoneName: "short" });
  const text = formatStatus({
    refreshing: false,
    metadataModels: 10,
    metadataUpdatedAt: iso,
    providers: { selectel: { models: 334, updatedAt: iso, cached: false, missingMetadata: [] } },
  });
  assert.ok(text.includes(`обновлено ${local}`));
  assert.ok(text.includes(`проверены ${local}`));
  assert.ok(!text.includes(iso));
});
