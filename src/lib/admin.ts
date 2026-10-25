import { cookies } from "next/headers";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The project has no authentication architecture. Admin analytics therefore stay closed by
 * default: they need ADMIN_TOKEN (cookie set through /admin) in production. Local development
 * opens them without a token so the dashboard can be reviewed, and says so on screen.
 */

export const ADMIN_COOKIE = "aria_admin";
export const ADMIN_MAX_AGE = 8 * 60 * 60;

export const adminConfigured = () => Boolean(process.env.ADMIN_TOKEN?.trim());
/** Never available in production without a configured token. */
export const adminAvailable = () => adminConfigured() || process.env.NODE_ENV !== "production";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function tokenMatches(candidate: string): boolean {
  const expected = process.env.ADMIN_TOKEN?.trim();
  if (!expected) return false;
  const a = digest(candidate);
  const b = digest(expected);
  return timingSafeEqual(a, b);
}

export async function isAdmin(): Promise<boolean> {
  if (!adminAvailable()) return false;
  if (!adminConfigured()) return true;
  const cookie = (await cookies()).get(ADMIN_COOKIE)?.value;
  return Boolean(cookie && tokenMatches(cookie));
}
