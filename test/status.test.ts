import assert from "node:assert/strict";
import { test } from "node:test";
import { StatusStore } from "../src/runtime/status.js";

test("StatusStore records ticks and newest-first events, capped", () => {
  const store = new StatusStore({ startedAt: "2026-07-17T00:00:00Z", project: "bugs", mode: "dry-run", cap: 3 });

  store.tick("2026-07-17T00:00:10Z");
  store.event("2026-07-17T00:00:11Z", "triage IN-1 fixable");
  store.event("2026-07-17T00:00:12Z", "triage IN-2 dangerous");

  const snap = store.snapshot();
  assert.equal(snap.ticks, 1);
  assert.equal(snap.lastTickAt, "2026-07-17T00:00:10Z");
  assert.equal(snap.events[0]!.text, "triage IN-2 dangerous"); // newest first
  assert.equal(snap.project, "bugs");
});

test("events are capped at the configured size", () => {
  const store = new StatusStore({ startedAt: "t0", project: "p", mode: "m", cap: 2 });
  store.event("t1", "a");
  store.event("t2", "b");
  store.event("t3", "c");
  const snap = store.snapshot();
  assert.equal(snap.events.length, 2);
  assert.deepEqual(snap.events.map((e) => e.text), ["c", "b"]);
});
