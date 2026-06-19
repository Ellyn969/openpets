// Golden test for openpets.work-life.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SCHEDULE_ID,
  STORAGE_KEY,
  cleanState,
  handleBreakNow,
  handleDismiss,
  handleIdleEnter,
  handleIdleExit,
  maybeRemind,
  reconcile,
  reminderIntervalMs,
  workThresholdMs,
  register,
} from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(new URL("../../../packages/sdk/dist/testing.js", import.meta.url)));
}

assert.equal(workThresholdMs({ workThresholdMinutes: "120" }), 120 * 60_000);
assert.equal(workThresholdMs({ workThresholdMinutes: "60" }), 60 * 60_000);
assert.equal(workThresholdMs({ workThresholdMinutes: "bad" }), 120 * 60_000);
assert.equal(reminderIntervalMs({ reminderIntervalMinutes: "60" }), 60 * 60_000);
assert.equal(reminderIntervalMs({ reminderIntervalMinutes: "30" }), 30 * 60_000);
assert.equal(reminderIntervalMs({ reminderIntervalMinutes: "bad" }), 60 * 60_000);

const PERMISSIONS = ["pet:speak", "pet:interact", "schedule", "storage", "events", "commands", "status"];
const LOCALES = { en: JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8")) };
const MESSAGE_FILTER_PATTERN = /```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b|https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\/;

for (const [key, value] of Object.entries(LOCALES.en)) {
  if (key.startsWith("speech.")) {
    assert.equal(MESSAGE_FILTER_PATTERN.test(value), false, `${key} must pass the host speech safety filter`);
  }
}

function assertNoMixedBodyMedia(h) {
  for (const bubble of h.calls.bubbles) {
    assert.equal(Boolean(bubble.spec.icon && (bubble.spec.text || bubble.spec.markdown)), false, "bubble body icon must not be combined with text/markdown");
    assert.equal(Boolean(bubble.spec.svg && (bubble.spec.text || bubble.spec.markdown)), false, "bubble body svg must not be combined with text/markdown");
    assert.equal(Boolean(bubble.spec.image && (bubble.spec.text || bubble.spec.markdown)), false, "bubble body image must not be combined with text/markdown");
  }
}

// 1) Start with no active session does not speak.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { workThresholdMinutes: "60", reminderIntervalMinutes: "60" } });
  await h.start();
  assert.equal(h.calls.speak.length, 0, "start should not speak without active session");
  assert.equal(h.calls.schedules.size, 0, "no schedule without active session");
  h.expectNoErrors();
}

// 2) Idle exit starts tracking and schedules a check.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { workThresholdMinutes: "60", reminderIntervalMinutes: "60" }, nowMs: 100_000 });
  await h.start();
  await h.ctx.storage.set(STORAGE_KEY, cleanState(null));
  h.emit("idle:exit", { idleSeconds: 10 });
  h.expectStored(STORAGE_KEY, (v) => v.activeSince !== null);
  assert.equal(h.calls.schedules.size, 1, "should schedule a check after idle exit");
  h.expectNoErrors();
}

// 3) Idle enter clears active tracking.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { workThresholdMinutes: "60", reminderIntervalMinutes: "60" }, nowMs: 200_000 });
  await h.start();
  const now = Date.now();
  await h.ctx.storage.set(STORAGE_KEY, cleanState({ activeSince: now, lastReminderAt: 0, cooldownUntil: 0, todayReminded: 0 }));
  h.emit("idle:enter", { idleSeconds: 180 });
  h.expectStored(STORAGE_KEY, (v) => v.activeSince === null);
  h.expectNoErrors();
}

// 4) Break now resets and speaks celebration.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { workThresholdMinutes: "60", reminderIntervalMinutes: "60" } });
  const now = Date.now();
  await h.ctx.storage.set(STORAGE_KEY, cleanState({ activeSince: now - 130 * 60_000, lastReminderAt: 0, cooldownUntil: 0, todayReminded: 0 }));
  await h.start();
  await h.runCommand("break-now");
  h.expectSpoke(/Nice break|minutes/);
  assert.equal(h.calls.reactions.length, 1, "break-now should trigger celebrating reaction");
  h.expectStored(STORAGE_KEY, (v) => v.activeSince === null);
  h.expectNoErrors();
}

// 5) Dismiss sets a cooldown.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { workThresholdMinutes: "60", reminderIntervalMinutes: "30" } });
  const now = Date.now();
  const threshold = 60 * 60_000;
  await h.ctx.storage.set(STORAGE_KEY, cleanState({ activeSince: now - threshold - 1000, lastReminderAt: 0, cooldownUntil: 0, todayReminded: 0 }));
  await h.start();
  const reminded = await maybeRemind(h.ctx);
  assert.equal(reminded, true, "should remind after threshold");
  h.expectSpoke(/You've been/);
  assert.equal(h.calls.alerts.length, 1, "should show alert");
  const alert = h.calls.alerts[0];
  assert.deepEqual(alert.spec.actions.map((a) => a.id), ["break-now", "dismiss"]);
  await h.fireAlertAction(alert.handle.id, "dismiss");
  h.expectStored(STORAGE_KEY, (v) => v.cooldownUntil > 0);
  h.expectSpoke(/Got it|remind/);
  assertNoMixedBodyMedia(h);
  h.expectNoErrors();
}

// 6) Command metadata has icons.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: {} });
  await h.start();
  assert.deepEqual(h.calls.commands.get("check-status")?.meta.icon, { kind: "icon", name: "work-life" });
  assert.deepEqual(h.calls.commands.get("break-now")?.meta.icon, { kind: "icon", name: "work-life" });
  assert.deepEqual(h.calls.commands.get("reset-timer")?.meta.icon, { kind: "icon", name: "work-life" });
  h.expectNoErrors();
}

// 7) MaybeRemind skips when under threshold or in cooldown.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { workThresholdMinutes: "120", reminderIntervalMinutes: "60" } });
  const now = Date.now();
  await h.ctx.storage.set(STORAGE_KEY, cleanState({ activeSince: now - 30 * 60_000, lastReminderAt: 0, cooldownUntil: 0, todayReminded: 0 }));
  await h.start();
  const reminded = await maybeRemind(h.ctx);
  assert.equal(reminded, false, "should not remind under threshold");
  h.expectNoErrors();
}

// 8) Reconcile recovers future schedule.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { workThresholdMinutes: "60", reminderIntervalMinutes: "60" }, nowMs: 500_000 });
  const now = Date.now();
  await h.ctx.storage.set(STORAGE_KEY, cleanState({ activeSince: now, lastReminderAt: 0, cooldownUntil: 0, todayReminded: 0 }));
  await h.start();
  assert.equal(h.calls.schedules.size, 1, "should schedule check on reconcile");
  h.expectNoErrors();
}

console.log("openpets.work-life: all checks passed.");