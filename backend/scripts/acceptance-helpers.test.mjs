import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedLoadRequestCount,
  loadPhaseOffsetMilliseconds,
  missedLoadScheduleSlots,
} from "./acceptance-helpers.mjs";

test("spreads virtual-user request phases evenly across one request interval", () => {
  const offsets = Array.from(
    { length: 4 },
    (_, index) => loadPhaseOffsetMilliseconds(index, 4, 1_000),
  );

  assert.deepEqual(offsets, [0, 250, 500, 750]);
  assert.ok(offsets.at(-1) < 1_000);
});

test("rejects an invalid load phase", () => {
  assert.throws(
    () => loadPhaseOffsetMilliseconds(4, 4, 1_000),
    /index must be within/i,
  );
  assert.throws(
    () => loadPhaseOffsetMilliseconds(0, 0, 1_000),
    /concurrency must be a positive integer/i,
  );
  assert.throws(
    () => loadPhaseOffsetMilliseconds(0, 1, 0),
    /request interval must be positive/i,
  );
});

test("calculates the scheduled request count for evenly spread users", () => {
  assert.equal(expectedLoadRequestCount(100, 120_000, 1_000), 12_000);
  assert.equal(expectedLoadRequestCount(4, 1_000, 1_000), 4);
  assert.throws(
    () => expectedLoadRequestCount(1, 0, 1_000),
    /duration must be positive/i,
  );
});

test("skips missed load ticks instead of catching up with a burst", () => {
  assert.equal(missedLoadScheduleSlots(2_000, 1_999, 1_000), 0);
  assert.equal(missedLoadScheduleSlots(2_000, 2_000, 1_000), 1);
  assert.equal(missedLoadScheduleSlots(2_000, 4_250, 1_000), 3);
  assert.throws(
    () => missedLoadScheduleSlots(2_000, 2_100, 0),
    /request interval must be positive/i,
  );
});
