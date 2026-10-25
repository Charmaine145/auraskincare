import { z } from "zod";

export const messageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) }).strict();
export const historySchema = z.array(messageSchema).min(1).max(120);
export const sessionTokenSchema = z.string().max(60_000).optional();

/** Reads a JSON body with a hard size cap. */
export async function readBody(request: Request): Promise<unknown> {
  const body = await request.text();
  if (body.length > 200_000) throw new SyntaxError("Request too large");
  return JSON.parse(body);
}
