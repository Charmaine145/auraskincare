"use client";

import { Ban, Brain, CircleCheck, Ear, FileJson, Fingerprint, Gavel, Linkedin, MessageSquareQuote, Volume2, Wrench } from "lucide-react";
import { policyCards, type Brand } from "@/data/brand";
import { Sheet } from "./ui/Sheet";

const PIPELINE = [
  { icon: Ear, title: "Voice Input", text: "Captures spoken requests using browser-based speech recognition configured for Indian English, with Gemini-powered transcription as a backup." },
  { icon: Brain, title: "Request Interpretation", text: "Uses Gemini and its native function-calling capabilities to identify the customer's intent and determine which support tool is required." },
  { icon: Wrench, title: "Secure Action Processing", text: "Backend tools retrieve order information and enforce return, refund, and cancellation rules through server-side logic." },
  { icon: Volume2, title: "Natural Voice Responses", text: "Responds using Microsoft's natural-sounding Indian voices, with Sarvam and browser speech synthesis available as alternatives." },
  { icon: FileJson, title: "Conversation Summary", text: "Creates a structured JSON conversation record from the transcript and validates it against the verified tool execution log." },
];

const GUARDRAILS = [
  { icon: Gavel, title: "Policy-controlled decisions", text: "Return eligibility, damage reporting deadlines, and cancellation permissions are calculated on the server." },
  { icon: MessageSquareQuote, title: "Exact policy responses", text: "When a policy decision is made, Aria communicates the server-provided refusal wording without changing it." },
  { icon: Fingerprint, title: "Verified order references", text: "Tool execution is blocked if the customer has not actually mentioned the required order ID." },
  { icon: CircleCheck, title: "Explicit cancellation approval", text: "A cancellation requires a clear confirmation from the customer, enforced by backend logic." },
];

export function HowItWorks({ brand, open, onClose }: { brand: Brand; open: boolean; onClose: () => void }) {
  const guardrails = [
    ...GUARDRAILS,
    { icon: Ban, title: "Brand-focused assistance", text: `Requests outside the support scope are politely declined and redirected to relevant ${brand.name} services.` },
  ];
  return (
    <Sheet open={open} onClose={onClose} width={720} title="How Aria Operates">
      <ol className="how-steps">
        {PIPELINE.map(({ icon: Icon, title, text }, i) => (
          <li key={title}>
            <span className="how-num">{i + 1}</span>
            <Icon size={17} aria-hidden />
            <div>
              <strong>{title}</strong>
              <p>{text}</p>
            </div>
          </li>
        ))}
      </ol>
      <h3 className="how-sub">Built-in Safety Measures</h3>
      <ul className="how-guards">
        {guardrails.map(({ icon: Icon, title, text }) => (
          <li key={title}>
            <Icon size={16} aria-hidden />
            <div>
              <strong>{title}</strong>
              <p>{text}</p>
            </div>
          </li>
        ))}
      </ul>
      <h3 className="how-sub">{brand.name} Customer Policies</h3>
      <dl className="how-policies">
        {policyCards(brand).map(policy => (
          <div key={policy.id}>
            <dt>{policy.title}</dt>
            <dd>
              <ul>
                {policy.points.map(point => <li key={point}>{point}</li>)}
              </ul>
            </dd>
          </div>
        ))}
      </dl>
      <p className="how-credit">
        Aura Skincare and Aura Haircare are fictional brands created for demonstration purposes. All displayed orders and customer details are sample data.
      </p>
      <p className="how-credit">
        Created by Charmaine Joy ·{" "}
        <a href="https://www.linkedin.com/in/charmaine-joy/" target="_blank" rel="noreferrer"><Linkedin size={12} aria-hidden /> LinkedIn</a>
      </p>
    </Sheet>
  );
}
