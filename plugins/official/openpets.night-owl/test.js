// Golden test for openpets.night-owl.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LAST_REMINDED_KEY,
  PAUSED_DATE_KEY,
  SCHEDULE_ID,
  fireReminder,
  localDateKey,
  nextReminderMs,
  parseTime,
  register,
  scheduleReminder,
} from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(new URL("../../../packages/sdk/dist/testing.js", import.meta.url)));
}

assert.deepEqual(parseTime("23:00", "23:00"), { hour: 23, minute: 0 });
assert.deepEqual(parseTime("02:30", "23:00"), { hour: 2, minute: 30 });
assert.deepEqual(parseTime("bad", "23:00"), { hour: 23, minute: 0 });
assert.equal(nextReminderMs("23:00", new Date(2026, 0, 1, 22, 0).getTime()), new Date(2026, 0, 1, 23, 0).getTime());
assert.equal(nextReminderMs("23:00", new Date(2026, 0, 1, 23, 30).getTime()), new Date(2026, 0, 2, 23, 0).getTime());

const PERMISSIONS = ["pet:speak", "pet:interact", "schedule", "storage", "events", "commands"];
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

// 1) Start schedules night reminder and does not speak on launch.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { nightTriggerTime: "23:00", enableNightReminder: true } });
  await h.start();
  assert.equal(h.calls.schedules.size, 1, "expected one daily schedule");
  assert.ok(h.calls.schedules.has(SCHEDULE_ID));
  assert.equal(h.calls.speak.length, 0, "start should not speak");
  h.expectNoErrors();
}

// 2) Fire reminder once per date and stores lastRemindedDate.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { nightTriggerTime: "23:00" } });
  await h.start();
  const fired = await fireReminder(h.ctx);
  assert.equal(fired, true, "should fire reminder on first call");
  h.expectSpoke(/It's getting late|rest/);
  h.expectStored(LAST_REMINDED_KEY, (v) => v === localDateKey());
  assert.equal(h.calls.reactions?.length ?? 0, 0, "night reminder should not use reactions directly");
  assertNoMixedBodyMedia(h);
  const speechCount = h.calls.speak.length;
  const firedAgain = await fireReminder(h.ctx);
  assert.equal(firedAgain, false, "should not fire again same day");
  assert.equal(h.calls.speak.length, speechCount, "second same-day reminder should be suppressed");
  h.expectNoErrors();
}

// 3) Command metadata has icons.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: {} });
  await h.start();
  assert.deepEqual(h.calls.commands.get("remind-now")?.meta.icon, { kind: "icon", name: "night-owl" });
  assert.deepEqual(h.calls.commands.get("pause-today")?.meta.icon, "pause");
  h.expectNoErrors();
}

// 4) Pause today stores the date and suppresses reminders.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { nightTriggerTime: "23:00" } });
  await h.start();
  await h.runCommand("pause-today");
  h.expectStored(PAUSED_DATE_KEY, (v) => v === localDateKey());
  h.expectSpoke(/Paused/);
  const speechCount = h.calls.speak.length;
  await fireReminder(h.ctx);
  assert.equal(h.calls.speak.length, speechCount, "paused day should not add night reminder");
  h.expectNoErrors();
}

// 5) Disabled night reminder cancels the schedule.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { enableNightReminder: false } });
  await h.start();
  assert.equal(h.calls.schedules.has(SCHEDULE_ID), false);
  assert.equal(h.calls.speak.length, 0, "disabled reminder should not speak");
  h.expectNoErrors();
}

// 6) Force command always delivers feedback.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, config: { nightTriggerTime: "23:00" }, nowMs: new Date(2026, 0, 1, 23, 30).getTime() });
  await h.start();
  await h.runCommand("remind-now");
  h.expectSpoke(/It's getting late|rest/);
  h.expectStored(LAST_REMINDED_KEY, (v) => v === localDateKey());
  h.expectNoErrors();
}

console.log("openpets.night-owl: all checks passed.");