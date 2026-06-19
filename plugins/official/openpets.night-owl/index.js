// Night Owl (openpets.night-owl) — detects late-night activity and gently nudges you to rest.

export const SCHEDULE_ID = "night-owl-reminder";
export const LAST_REMINDED_KEY = "lastRemindedDate";
export const PAUSED_DATE_KEY = "pausedDate";
export const ACTIVE_SINCE_KEY = "activeSince";

const DAY_MS = 24 * 60 * 60_000;

export function localDateKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseTime(value, fallback) {
  const text = typeof value === "string" ? value : fallback;
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (!match) return parseTime(fallback, "23:00");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return parseTime(fallback, "23:00");
  return { hour, minute };
}

function normalizeTime(value, fallback) {
  const { hour, minute } = parseTime(value, fallback);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function nextReminderMs(time, now = Date.now()) {
  const { hour, minute } = parseTime(time, "23:00");
  const d = new Date(now);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
  return target > now ? target : target + DAY_MS;
}

function isNightHour(hour) {
  return hour >= 23 || hour < 5;
}

async function config(ctx) {
  return (await ctx.config.get()) ?? {};
}

async function isPausedToday(ctx) {
  return (await ctx.storage.get(PAUSED_DATE_KEY)) === localDateKey();
}

function nightSpeechSpec(ctx, text) {
  return {
    text,
    indicator: {
      icon: ctx.assets.icon("night-owl"),
      label: ctx.t("plugin.name"),
      tone: "info",
      color: "#7c3aed",
      background: "#ede9fe",
      borderColor: "#c4b5fd",
    },
    tone: "info",
  };
}

export async function scheduleReminder(ctx) {
  const cfg = await config(ctx);
  if (cfg.enableNightReminder === false) {
    await ctx.schedule.cancel(SCHEDULE_ID);
    return;
  }
  await ctx.schedule.cancel(SCHEDULE_ID);
  await ctx.schedule.daily(SCHEDULE_ID, normalizeTime(cfg.nightTriggerTime || "23:00", "23:00"), () => fireReminder(ctx));
}

export async function fireReminder(ctx, opts = {}) {
  const today = localDateKey();
  if (!opts.force && (await ctx.storage.get(LAST_REMINDED_KEY)) === today) return false;
  if (!opts.force && (await isPausedToday(ctx))) return false;
  await ctx.storage.set(LAST_REMINDED_KEY, today);
  await ctx.pet.speak(nightSpeechSpec(ctx, ctx.t("speech.nightReminder")));
  return true;
}

async function handleIdleExit(ctx) {
  const now = new Date();
  if (!isNightHour(now.getHours())) return;
  const today = localDateKey();
  if ((await ctx.storage.get(LAST_REMINDED_KEY)) === today) return;
  if (await isPausedToday(ctx)) return;
  await fireReminder(ctx);
}

export async function pauseToday(ctx) {
  await ctx.storage.set(PAUSED_DATE_KEY, localDateKey());
  await ctx.pet.speak(nightSpeechSpec(ctx, ctx.t("speech.paused")));
  await scheduleReminder(ctx);
}

function registerEventHandlers(ctx) {
  ctx.events.on("idle:exit", () => handleIdleExit(ctx));
  ctx.events.on("day:partChanged", (payload) => {
    if (payload.part === "night") {
      fireReminder(ctx);
    }
  });
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await scheduleReminder(ctx);
      const icon = ctx.assets.icon("night-owl");
      await ctx.commands.register({ id: "remind-now", title: "$t:command.remindNow.title", description: "$t:command.remindNow.description", icon }, () => fireReminder(ctx, { force: true }));
      await ctx.commands.register({ id: "pause-today", title: "$t:command.pauseToday.title", description: "$t:command.pauseToday.description", icon: "pause" }, () => pauseToday(ctx));
      registerEventHandlers(ctx);
    },
    async stop() {},
  });
}