import { z } from "zod";
import { ADMIN_COOKIE, ADMIN_MAX_AGE, adminAvailable, adminConfigured, tokenMatches } from "@/lib/admin";
import { checkRateLimit } from "@/lib/rateLimit";
import { readBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ token: z.string().min(1).max(200) }).strict();

/** Exchanges ADMIN_TOKEN for an httpOnly cookie. Without a configured token, admin is local-only. */
export async function POST(request: Request) {
  if (!adminAvailable()) return Response.json({ error: "Not available." }, { status: 404 });
  if (!adminConfigured()) return Response.json({ error: "No ADMIN_TOKEN is configured on this server." }, { status: 400 });
  if (!checkRateLimit(request, "admin-login")) return Response.json({ error: "Too many attempts. Please try again later." }, { status: 429 });

  let token: string;
  try {
    token = bodySchema.parse(await readBody(request)).token;
  } catch {
    return Response.json({ error: "Enter the admin token." }, { status: 400 });
  }
  if (!tokenMatches(token)) return Response.json({ error: "That token doesn't match." }, { status: 401 });

  const response = Response.json({ ok: true });
  response.headers.append(
    "Set-Cookie",
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_MAX_AGE}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
  );
  return response;
}

export async function DELETE() {
  const response = Response.json({ ok: true });
  response.headers.append("Set-Cookie", `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  return response;
}
