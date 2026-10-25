"use client";

import { useState } from "react";
import { CircleAlert, Star } from "lucide-react";
import type { VoiceCall } from "@/hooks/useVoiceCall";

/**
 * Optional post-call satisfaction prompt. Success is shown only after /api/feedback
 * confirms the record was written. Skipping is always allowed.
 */
export function FeedbackPrompt({ call }: { call: VoiceCall }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "skipped">("idle");
  const [error, setError] = useState<string | null>(null);

  if (state === "saved") {
    return (
      <div className="summary-block feedback">
        <p className="feedback-saved" role="status"><Star size={14} aria-hidden /> Thank you — your {rating}-star feedback was saved.</p>
      </div>
    );
  }
  if (state === "skipped") {
    return (
      <div className="summary-block feedback">
        <p className="feedback-saved muted">No problem — feedback is always optional.</p>
      </div>
    );
  }

  const submit = async () => {
    if (!rating || state === "saving") return;
    setState("saving");
    setError(null);
    try {
      await call.submitFeedback(rating, comment);
      setState("saved");
    } catch (reason) {
      setState("idle");
      setError(reason instanceof Error ? reason.message : "Feedback couldn't be saved. Please try again.");
    }
  };

  return (
    <div className="summary-block feedback">
      <h3>How did Aria do?</h3>
      <p className="feedback-copy">Optional. Your rating helps improve the demo experience.</p>
      <div className="stars" role="radiogroup" aria-label="Rating from 1 to 5 stars">
        {[1, 2, 3, 4, 5].map(value => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={rating === value}
            aria-label={`${value} star${value === 1 ? "" : "s"}`}
            className={(hover || rating) >= value ? "on" : ""}
            onMouseEnter={() => setHover(value)}
            onMouseLeave={() => setHover(0)}
            onFocus={() => setHover(value)}
            onBlur={() => setHover(0)}
            onClick={() => setRating(value)}
          >
            <Star size={22} aria-hidden />
          </button>
        ))}
      </div>
      <label className="feedback-comment">
        <span>Anything you&apos;d like to add? <small>(optional)</small></span>
        <textarea value={comment} maxLength={500} rows={2} onChange={event => setComment(event.target.value)} placeholder="A quick note about your experience…" />
      </label>
      {error && <p className="feedback-error" role="alert"><CircleAlert size={13} aria-hidden /> {error}</p>}
      <div className="feedback-actions">
        <button className="pill-btn small" onClick={() => void submit()} disabled={!rating || state === "saving"}>
          {state === "saving" ? "Saving…" : "Send feedback"}
        </button>
        <button className="text-btn" onClick={() => setState("skipped")} disabled={state === "saving"}>Skip</button>
      </div>
    </div>
  );
}
