# Demo video script (about 5½ minutes)

Record the **deployed HTTPS app** in Chrome or Edge with headphones. Aria's natural Indian voices (Neerja for English, Swara for Hindi, Shruti for Telugu) come from the server, so every browser sounds the same; the trace shows "Edge Neural · Neerja" on each reply. Keep the browser address bar visible. Before recording, check that the header shows the Gemini model (not "Rule-based demo"), and use the ⚙ settings next to the call button to check the language and hear the voice. Open **Trace** in the header and keep it open on the right while you talk. It's the best way to show the agent at work. Set `ADMIN_TOKEN` in the deployment if you want to show the protected admin dashboard at the end.

| Time | Do / say | Point out on screen |
| --- | --- | --- |
| 0:00–0:20 | "This is Aria, a voice support agent for Aura Skincare." | The orb, the test orders and the conversation panel. |
| 0:20–0:55 | **Start call.** After the greeting: *"Where is my order O R D one oh one?"* | The orb turns emerald while listening, amber while thinking, violet while speaking. The trace shows `get_order_details(order_id: "ORD-101")` and *Answered from the order record*: a plain status question needs no model call, so the reply is tagged **instant**. Point at the response time under the reply. |
| 0:55–1:25 | *"Can I return ORD-102?"* | The refusal (14 days, beyond the 7-day window) carries a **policy** tag: the server made the decision and wrote the words. |
| 1:25–2:00 | *"Please cancel ORD-103."* → Aria asks to confirm → *"Yes, go ahead."* | *Confirmation before action* in the trace; the ORD-103 badge flips to **Cancelled** live. |
| 2:00–2:20 | *"Can you book me a flight to Goa?"* | Polite scope refusal. |
| 2:20–2:45 | *"Can I talk to a real person?"* | Aria provides a support reference; the trace shows the escalation tool. Explain that this creates a **demo ticket** and does not contact a real agent. |
| 2:45–3:00 | Start talking while Aria is answering (or press ✋). | Barge-in: she fades out and listens; the bubble is marked *interrupted*. |
| 3:00–3:20 | *"That's all, thank you. Bye!"* | Aria says goodbye and ends the call herself. |
| 3:20–4:00 | The **Call summary** sheet opens by itself. | Intent / order / resolution tiles, issues handled, actions taken and the support ticket reference/status, then the **JSON** tab, Copy JSON and Transcript. Point out the optional star rating and comment; submit a rating or skip it. Mention that the summary facts come from the verified tool log. |
| 4:00–4:25 | Click the **Aura Skincare** wordmark and switch to **Aura Haircare**. Tap *Ask about a return* (*"Can I return ORD-202?"*). | Multi-brand: same agent, different policy. ORD-202 was delivered 9 days ago; Aura Haircare's 10-day window allows it, where Aura Skincare's 7-day window refused ORD-102. |
| 4:25–4:55 | Open **How it works** in the header. | Speech recognition → Gemini function calling → server tools and policy engine → streamed neural voice → summary. Guardrails: order-ID provenance, decisions in code, verbatim refusals, confirmation, scope. |
| 4:55–5:30 | Navigate to `/admin` (log in with the configured admin token if prompted). | Show conversation and resolution metrics, verified tool outcomes, satisfaction, and the escalation ticket. If you change the ticket status, point out the available workflow states. Remind viewers that the dashboard contains demo data, not production customer records. |

**A short Hindi moment** works well: pick Hindi in ⚙, then ask *"मेरा ऑर्डर ORD-101 कहाँ है?"*. Aria answers in Hindi with a Hindi voice.

**Optional extras if time allows:** the brief's example *"I bought this 20 days ago and have opened it, can I return it?"*, *"Where is ORD-999?"*, or Hinglish: *"Mera order ORD-101 kab tak aayega?"* (all in the ✦ scenarios menu too).

**If something goes wrong on camera:** typing works for every scenario, and Aria still speaks her replies. If the voice service fails, the next voice in the chain (Sarvam, then the browser's) takes over. Say so rather than cutting it.
