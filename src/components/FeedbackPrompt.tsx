"use client";

import { useState } from "react";
import { CircleAlert, Star, Sparkles, CheckCircle2, MessageSquareHeart } from "lucide-react";
import type { VoiceCall } from "@/hooks/useVoiceCall";

const RATING_LABELS: Record<number, string> = {
  1: "Needs improvement",
  2: "Could be better",
  3: "Good & helpful",
  4: "Great experience",
  5: "Exceptional assistance!",
};

/**
 * Optional post-call satisfaction prompt with interactive feedback ratings.
 */
export function FeedbackPrompt({ call }: { call: VoiceCall }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "skipped">("idle");
  const [error, setError] = useState<string | null>(null);

  const activeRating = hover || rating;

  if (state === "saved") {
    return (
      <div className="feedback-card feedback-saved-box">
        <div className="feedback-saved-content">
          <span className="feedback-check-badge">
            <CheckCircle2 size={16} aria-hidden />
          </span>
          <div>
            <strong>Thank you for your feedback!</strong>
            <p>Your {rating}-star rating helps refine Aria&apos;s customer concierge experience.</p>
          </div>
        </div>
      </div>
    );
  }
  if (state === "skipped") {
    return (
      <div className="feedback-card feedback-saved-box muted">
        <p className="feedback-saved-muted">Feedback skipped — thank you for using Aura Concierge.</p>
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
    <div className="feedback-card">
      <div className="feedback-card-head">
        <div className="feedback-title-group">
          <span className="feedback-icon-spark">
            <Sparkles size={14} aria-hidden />
          </span>
          <div>
            <h4 className="feedback-title">How was your experience with Aria?</h4>
            <p className="feedback-subtitle">Optional · Your rating directly informs continuous AI evaluation.</p>
          </div>
        </div>
        {activeRating > 0 && (
          <span className="feedback-rating-badge animate-fade-in">
            {RATING_LABELS[activeRating]}
          </span>
        )}
      </div>

      <div className="feedback-rating-row">
        <div className="stars-modern" role="radiogroup" aria-label="Rating from 1 to 5 stars">
          {[1, 2, 3, 4, 5].map(value => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={rating === value}
              aria-label={`${value} star${value === 1 ? "" : "s"} - ${RATING_LABELS[value]}`}
              className={`star-modern-btn ${activeRating >= value ? "is-active" : ""}`}
              onMouseEnter={() => setHover(value)}
              onMouseLeave={() => setHover(0)}
              onFocus={() => setHover(value)}
              onBlur={() => setHover(0)}
              onClick={() => setRating(value)}
            >
              <Star size={24} aria-hidden />
            </button>
          ))}
        </div>
      </div>

      <label className="feedback-comment-modern">
        <span>Share any thoughts or suggestions <small>(optional)</small></span>
        <textarea
          value={comment}
          maxLength={500}
          rows={2}
          onChange={event => setComment(event.target.value)}
          placeholder="E.g. Was Aria natural, quick, and accurate with your query?"
        />
      </label>

      {error && (
        <p className="feedback-error-modern" role="alert">
          <CircleAlert size={14} aria-hidden /> {error}
        </p>
      )}

      <div className="feedback-actions-modern">
        <button
          className="feedback-submit-btn"
          onClick={() => void submit()}
          disabled={!rating || state === "saving"}
        >
          {state === "saving" ? "Saving rating…" : "Submit Feedback"}
        </button>
        <button
          className="feedback-skip-btn"
          onClick={() => setState("skipped")}
          disabled={state === "saving"}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
