// Work-Life Balance (openpets.work-life) — tracks continuous active time and nudges breaks.

export const STORAGE_KEY = "work-life-state";
export const SCHEDULE_ID = "work-life-check";
export const IDLE_THRESHOLD_MS = 2 * 60_000;

const MINUTES_MS = 60_000;

export function workThresholdMs(config = {}) {
  const minutes = [60, 90, 120, 180].includes(Number(config.workThresholdMinutes)) ? Number(config.workThresholdMinutes) : 120;
  return minutes * MINUTES_MS;
}

export function reminderIntervalMs(config = {}) {
  const minutes = [30, 60, 90].includes(Number(config.reminderIntervalMinutes)) ? Number(config.reminderIntervalMinutes) : 60;
  return minutes * MINUTES_MS;
}

export function cleanState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    activeSince: typeof state.activeSince === "number" ? state.activeSince : null,
    lastReminderAt: typeof state.lastReminderAt === "number" ? state.lastReminderAt : 0,
    cooldownUntil: typeof state.cooldownUntil === "number" ? state.cooldownUntil : 0,
    todayReminded: typeof state.todayReminded === "number" ? state.todayReminded : 0,
  };
}

function todayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function state(ctx) {
  return cleanState(await ctx.storage.get(STORAGE_KEY));
}

async function save(ctx, next) {
  await ctx.storage.set(STORAGE_KEY, cleanState(next));
  await updateStatus(ctx, next);
}

async function config(ctx) {
  return (await ctx.config.get()) ?? {};
}

async function updateStatus(ctx, current) {
  const s = current ?? (await state(ctx));
  if (!s.activeSince) {
    await ctx.status.set({ text: ctx.t("status.idle"), tone: "info" });
    return;
  }
  const elapsed = Math.round((Date.now() - s.activeSince) / MINUTES_MS);
  await ctx.status.set({ text: ctx.t("status.active", { minutes: elapsed }), tone: "info" });
}

function remindSpec(ctx) {
  return {
    text: ctx.t("speech.breakReminder"),
    indicator: {
      icon: ctx.assets.icon("work-life"),
      label: ctx.t("plugin.name"),
      tone: "info",
      color: "#6366f1",
      background: "#e0e7ff",
      borderColor: "#a5b4fc",
    },
    tone: "info",
    dismissOn: ["action", "petClick", "click"],
    actions: [
      { id: "break-now", label: ctx.t("action.breakNow"), style: "primary" },
      { id: "dismiss", label: ctx.t("action.dismiss") },
    ],
  };
}

export async function maybeRemind(ctx, opts = {}) {
  const now = Date.now();
  const s = await state(ctx);
  const cfg = await config(ctx);
  const thresholdMs = workThresholdMs(cfg);
  const intervalMs = reminderIntervalMs(cfg);

  if (s.cooldownUntil && now < s.cooldownUntil) return false;

  if (s.activeSince) {
    const elapsed = now - s.activeSince;
    if (elapsed < thresholdMs) return false;

    const today = todayKey(now);
    const todayCount = today === todayKey(s.lastReminderAt) ? s.todayReminded : 0;

    const sinceLast = now - (s.lastReminderAt || 0);
    if (sinceLast < intervalMs && todayCount > 0) return false;

    const next = {
      ...s,
      lastReminderAt: now,
      cooldownUntil: now + intervalMs,
      todayReminded: todayCount + 1,
    };
    await save(ctx, next);

    const alert = await ctx.ui.alert(remindSpec(ctx));
    alert.onAction((id) => {
      if (id === "break-now") handleBreakNow(ctx);
      else handleDismiss(ctx);
    });
    return true;
  }

  return false;
}

export async function handleIdleEnter(ctx) {
  const s = await state(ctx);
  if (!s.activeSince) return;
  const now = Date.now();
  await save(ctx, { ...s, activeSince: null, cooldownUntil: 0, todayReminded: 0 });
}

export async function handleIdleExit(ctx) {
  const now = Date.now();
  const s = await state(ctx);
  if (s.activeSince) return;
  await save(ctx, { ...s, activeSince: now, cooldownUntil: 0, todayReminded: 0 });
  await scheduleCheck(ctx);
}

export async function handleBreakNow(ctx) {
  const now = Date.now();
  const s = await state(ctx);
  const elapsed = s.activeSince ? now - s.activeSince : 0;
  const minutes = Math.max(1, Math.round(elapsed / MINUTES_MS));
  await save(ctx, { activeSince: null, lastReminderAt: 0, cooldownUntil: 0, todayReminded: 0 });
  await ctx.pet.react("celebrating");
  await ctx.pet.speak(ctx.t("speech.tookBreak", { minutes }));
  await scheduleCheck(ctx);
}

export async function handleDismiss(ctx) {
  const now = Date.now();
  const cfg = await config(ctx);
  const s = await state(ctx);
  await save(ctx, { ...s, cooldownUntil: now + reminderIntervalMs(cfg) });
  await ctx.pet.speak(ctx.t("speech.dismissed"));
}

export async function scheduleCheck(ctx) {
  await ctx.schedule.cancel(SCHEDULE_ID);
  const now = Date.now();
  const cfg = await config(ctx);
  const s = await state(ctx);

  if (!s.activeSince) return;

  const thresholdMs = workThresholdMs(cfg);
  const elapsed = now - s.activeSince;
  const remaining = Math.max(1, thresholdMs - elapsed);

  await ctx.schedule.once(SCHEDULE_ID, remaining, () => maybeRemind(ctx));
}

export async function resetActive(ctx) {
  const now = Date.now();
  const s = await state(ctx);
  if (s.activeSince) {
    await save(ctx, { ...s, activeSince: now, cooldownUntil: 0 });
    await scheduleCheck(ctx);
  }
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await reconcile(ctx);
      const icon = ctx.assets.icon("work-life");
      await ctx.commands.register({ id: "check-status", title: "$t:command.checkStatus.title", description: "$t:command.checkStatus.description", icon }, () => showStatus(ctx));
      await ctx.commands.register({ id: "break-now", title: "$t:command.breakNow.title", description: "$t:command.breakNow.description", icon }, () => handleBreakNow(ctx));
      await ctx.commands.register({ id: "reset-timer", title: "$t:command.resetTimer.title", description: "$t:command.resetTimer.description", icon }, () => resetActive(ctx));
      ctx.events.on("idle:enter", () => handleIdleEnter(ctx));
      ctx.events.on("idle:exit", () => handleIdleExit(ctx));
    },
    async stop() {},
  });
}

export async function reconcile(ctx) {
  const s = await state(ctx);
  const now = Date.now();
  if (s.activeSince) {
    await scheduleCheck(ctx);
    await updateStatus(ctx, s);
  } else {
    await updateStatus(ctx, s);
  }
}

async function showStatus(ctx) {
  const s = await state(ctx);
  if (!s.activeSince) {
    await ctx.pet.speak(ctx.t("speech.idle"));
    return;
  }
  const minutes = Math.max(1, Math.round((Date.now() - s.activeSince) / MINUTES_MS));
  await ctx.pet.speak(ctx.t("speech.statusActive", { minutes }));
}