/**
 * 日本時間(JST)の計算。Linux Consumption プランでは WEBSITE_TIME_ZONE が使えないので、
 * タイマーはUTCで15分おきに動かし、実行するかどうかはここでJSTに直して判定する。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface JstNow {
  /** YYYY-MM-DD */
  date: string;
  /** 0:00 からの経過分 */
  minutes: number;
  /** 0=日曜 … 6=土曜 */
  weekday: number;
}

export function toJst(d: Date): JstNow {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return {
    date: j.toISOString().slice(0, 10),
    minutes: j.getUTCHours() * 60 + j.getUTCMinutes(),
    weekday: j.getUTCDay(),
  };
}

const HHMM = /^(\d{1,2}):(\d{2})$/;

/** "7:30" / "07:30" を分に変換。不正な値なら fallback を使う。 */
export function parseRunTime(value: string | undefined | null, fallback = "07:30"): number {
  for (const s of [value, fallback]) {
    const m = HHMM.exec((s ?? "").trim());
    if (!m) continue;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h <= 23 && mi <= 59) return h * 60 + mi;
  }
  return 7 * 60 + 30;
}

export interface ScheduleSetting {
  enabled: boolean;
  runTime?: string | null;
  weekdaysOnly: boolean;
  lastRunAt?: string | null;
}

/** 今このユーザーの処理を実行すべきか */
export function isDue(s: ScheduleSetting, now: Date): boolean {
  if (!s.enabled) return false;
  const n = toJst(now);
  if (s.weekdaysOnly && (n.weekday === 0 || n.weekday === 6)) return false;
  const run = parseRunTime(s.runTime);
  if (n.minutes < run) return false;
  if (s.lastRunAt) {
    const last = toJst(new Date(s.lastRunAt));
    // 今日の実行時刻以降にすでに実行済みなら何もしない
    if (last.date === n.date && last.minutes >= run) return false;
  }
  return true;
}

/** SharePointの日付のみ列に書く値。JST/UTCのどちらで解釈されても日付がずれないよう正午UTCにする。 */
export function toSharePointDate(date: string): string {
  return `${date}T12:00:00Z`;
}
