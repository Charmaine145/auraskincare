/**
 * Live smoke test against the real Gemini API (uses a few requests of quota).
 *   npx tsx scripts/check-gemini.ts
 * Runs a real tool-calling turn and a real post-call summary. Never prints the key.
 */
import { runTurn } from "../src/lib/agent/agent";
import { getProvider } from "../src/lib/agent/providers";
import { newSession } from "../src/lib/session";
import { modelSummary } from "../src/lib/summary";
import { GREETING } from "../src/lib/voice/options";
import type { AgentEvent, ChatMessage } from "../src/types";

process.loadEnvFile?.(".env.local");

async function main() {
  const provider = getProvider();
  if (!provider || provider.name !== "Gemini") throw new Error("Set GEMINI_API_KEY in .env.local first.");
  const session = newSession();
  // The UI always starts with Aria's greeting, so the live check does too.
  const transcript: ChatMessage[] = [{ role: "assistant", content: GREETING }];
  const lines = process.argv.slice(2).length ? process.argv.slice(2) : ["Where is my order ORD one oh one?", "Can I return ORD-102? I haven't opened it.", "Book me a flight to Goa."];

  for (const line of lines) {
    transcript.push({ role: "user", content: line });
    const events: AgentEvent[] = [];
    const started = performance.now();
    const result = await runTurn(transcript, session, event => events.push(event));
    transcript.push({ role: "assistant", content: result.reply });
    console.log(`\nCustomer: ${line}\nAria (${result.source}, ${Math.round(performance.now() - started)} ms): ${result.reply}`);
    for (const event of events) console.log(`  · ${event.type}${"name" in event ? ` ${event.name}` : ""}${"ms" in event ? ` ${event.ms} ms` : ""}${"status" in event ? ` → ${event.status}` : ""}`);
  }

  const summary = await modelSummary(provider, { session, transcript, durationSeconds: 60, avgResponseMs: null });
  console.log("\nSummary:", JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message.replaceAll(process.env.GEMINI_API_KEY || "\u0000", "[redacted]") : "Check failed");
  process.exitCode = 1;
});
