const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30, no daylight saving

/**
 * IST wall clock by UTC arithmetic. toLocaleTimeString('en-IN', { hour12: false }) returns "24:05"
 * between 00:00 and 00:59 on Node 20, which made the 15:10 square-off fire at midnight instead
 * (positions #24 and #50 closed at 00:00 the next day).
 */
export function istClock(at: Date = new Date()): {
  date: string;      // YYYY-MM-DD
  time: string;      // HH:MM
  hour: number;      // 0–23
  minute: number;
  minutes: number;   // minutes since midnight
  weekday: number;   // 0 = Sunday
} {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const hour = ist.getUTCHours();
  const minute = ist.getUTCMinutes();
  return {
    date: ist.toISOString().slice(0, 10),
    time: ist.toISOString().slice(11, 16),
    hour,
    minute,
    minutes: hour * 60 + minute,
    weekday: ist.getUTCDay(),
  };
}

/** "HH:MM" → minutes since midnight; `fallback` when the text is not a valid time. */
export function hhmmToMinutes(text: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : fallback;
}
