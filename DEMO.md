# Aria — AI Voice Customer Care Demo Script
**Duration: Approximately 5 minutes 30 seconds**

| Time | Do / Say | Point Out on Screen |
|---|---|---|
| **0:00–0:20** | “This is Aria, an AI voice customer-support agent built for Aura Skincare.” | Show the sample orders, conversation panel, and call controls. |
| **0:20–0:55** | Click **Start Call**. After Aria greets you, ask: “Where is my order O R D one oh one?” | Point out the call status as it changes through Connecting, Thinking, Speaking, and Listening, depending on the current stage. Show the `get_order_details` tool call in the trace and the order information in Aria’s response. If the instant path is active, highlight the **instant** tag and response time. |
| **0:55–1:25** | Ask: “Can I return ORD-102?” | Show the policy-based refusal. Explain that the order was delivered 14 days ago, beyond Aura Skincare’s seven-day return window. Point out the policy tag if displayed. |
| **1:25–2:00** | Ask: “Please cancel ORD-103.” When Aria asks for confirmation, say: “Yes, go ahead.” | Show the confirmation step and the order’s status changing to Cancelled, if the deployed version performs the update successfully. Explain that cancellation requires explicit confirmation. |
| **2:00–2:20** | Ask: “Can you book me a flight to Goa?” | Show how Aria politely declines unrelated requests and redirects the conversation to Aura customer support. |
| **2:20–2:45** | Ask: “Can I talk to a real person?” | Show the support reference and escalation details. Explain that this creates a demo ticket rather than contacting a real support representative. |
| **2:45–3:00** | Speak while Aria is responding, or use the interruption control if available. | Demonstrate interruption handling. Explain that the agent should stop speaking and return to listening when interrupted. |
| **3:00–3:20** | Say: “That’s all, thank you. Bye!” | Show Aria's goodbye and the call ending, if automatic call termination works as expected. |
| **3:20–4:00** | Open the Call Summary after the call ends. | Show the customer intent, order, resolution, issues, actions, and support ticket details. Open the JSON view and demonstrate copying or downloading the summary. Mention the optional rating and comment. Explain that verified facts should come from recorded tool outcomes. |
| **4:00–4:25** | Switch from Aura Skincare to Aura Haircare using the brand selector. Ask: “Can I return ORD-202?” | Explain that the same agent supports multiple brands with different policies. Aura Haircare has a ten-day return window, so an order delivered nine days ago is within its stated window. Show the actual eligibility result. |
| **4:25–4:55** | Open **How it works** in the header. | Explain the pipeline: speech recognition → AI agent and tool calling → server-side policy checks → spoken response → call summary. Highlight order validation, cancellation confirmation, and policy enforcement. |
| **4:55–5:30** | Navigate to `/admin` and authenticate if prompted. | Show the available conversation metrics, resolution counts, tool outcomes, customer ratings, and demo tickets. If available, change a ticket’s status and explain the workflow. Clarify that this dashboard contains demonstration data, not real customer records. |

## Optional Hindi Demonstration

Select Hindi in the voice settings and ask:

“मेरा ऑर्डर ORD-101 कहाँ है?”

Point out the recognized request and Aria’s Hindi response, provided multilingual speech is working in the deployed environment.

## Optional Scenarios

If time permits, demonstrate one of these:

- “Where is ORD-999?” — demonstrates unknown-order handling.
- “I bought this 20 days ago and opened it. Can I return it?” — demonstrates policy enforcement without an order ID.
- “Mera order ORD-101 kab tak aayega?” — demonstrates Hinglish handling.

## If Something Goes Wrong

If the microphone does not work, use text chat or a suggested question.

If a voice provider fails, try again or explain the configured fallback only if it is available in the deployed version.

If a rating, cancellation, ticket, or summary does not save, do not claim that the operation succeeded. Point out the issue and explain that the relevant backend behavior needs verification.

## Closing Statement

“Aria demonstrates how voice-based AI, tool calling, server-side policy enforcement, and structured summaries can work together to create a more transparent customer-support experience. The current application uses fictional brands and sample orders, providing a foundation for further testing and future integration with real support systems.”
