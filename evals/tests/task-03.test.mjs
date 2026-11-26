import assert from "node:assert/strict";
import test from "node:test";
import { parseLog } from "../../src/eval/metrics.mjs";

test("parseLog returns no event for a blank line", () => {
  const events = parseLog("2026-01-01T00:00:00Z repo:a/b task:T-1 spawned\n\n2026-01-01T00:01:00Z repo:a/b task:T-1 merged");
  assert.equal(events.length, 2);
});

test("parseLog returns no event for a line starting with '#'", () => {
  const events = parseLog("# this is a comment\n2026-01-01T00:00:00Z repo:a/b task:T-1 spawned");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "spawned");
});

test("parseLog returns correct events for valid lines interleaved with blanks and comments", () => {
  const text = [
    "# comment at top",
    "2026-01-01T00:00:00Z repo:a/b task:T-1 spawned",
    "",
    "# another comment",
    "2026-01-01T00:01:00Z repo:a/b task:T-1 merged",
    "",
  ].join("\n");
  const events = parseLog(text);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "spawned");
  assert.equal(events[1].event, "merged");
});
