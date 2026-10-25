/**
 * Simple per-instance, per-IP hourly limits so a public demo link can't run up API costs.
 * A production deployment would use a shared store (e.g. Redis) instead.
 */
const windows = new Map<string, { count: number; resetAt: number }>();
const limits = { chat: 120, tts: 80, transcription: 60, summary: 30, feedback: 20, tickets: 60, "tickets-admin": 120, "admin-login": 10 } as const;
const HOUR = 60 * 60 * 1000;

export function checkRateLimit(request: Request, kind: keyof typeof limits): boolean {
  const now = Date.now();
  if (windows.size > 5000) for (const [key, value] of windows) if (value.resetAt < now) windows.delete(key);
  const ip = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "local";
  const key = `${kind}:${ip}`;
  const existing = windows.get(key);
  if (!existing || existing.resetAt < now) {
    windows.set(key, { count: 1, resetAt: now + HOUR });
    return true;
  }
  if (existing.count >= limits[kind]) return false;
  existing.count++;
  return true;
}

export const limitFor = (kind: keyof typeof limits) => limits[kind];
