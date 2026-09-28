import { test } from "node:test";
import { strict as assert } from "node:assert";
import { selectRingWindows, ringTone } from "../src/rings.js";

test("the compact badge prioritizes five-hour and weekly limits", () => {
  const day = { seconds: 86400 };
  const fiveHours = { seconds: 18000 };
  const weekly = { seconds: 604800 };
  assert.deepEqual(selectRingWindows([day, fiveHours, weekly]), [fiveHours, weekly]);
  assert.deepEqual(selectRingWindows([weekly]), [weekly]);
  assert.deepEqual(selectRingWindows([]), []);
});

test("quota tones change only at useful warning thresholds", () => {
  assert.equal(ringTone(72), "normal");
  assert.equal(ringTone(30), "warning");
  assert.equal(ringTone(10), "critical");
});
