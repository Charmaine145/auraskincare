"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, CircleAlert, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { ACTION_STATE_LABEL, type ActionRecord, type ActionState } from "@/lib/agent/actionState";
import { formatMs } from "@/lib/format";

const ICONS: Record<ActionState, typeof Check> = {
  pending: LoaderCircle,
  confirmed: Check,
  failed: X,
  unconfirmed: CircleAlert,
};

/**
 * Live action status. Every row is derived from a server tool event, so this panel never
 * repeats a promise from Aria's reply and never turns an unknown outcome into a success.
 */
export function ActionStatus({ actions }: { actions: ActionRecord[] }) {
  const list = useRef<HTMLOListElement>(null);

  // Keep the newest server result in view when the call has more actions than fit.
  useEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [actions.length]);

  if (actions.length === 0) return null;
  const recent = actions.slice(-6);

  return (
    <section className="action-status" aria-label="Action status">
      <header className="action-status-head">
        <span className="action-status-title">
          <ShieldCheck size={14} aria-hidden /> Action status
        </span>
        <span className="action-status-note">Checked by the server</span>
      </header>
      <ol ref={list} className="action-status-list" aria-live="polite">
        <AnimatePresence initial={false}>
          {recent.map(action => {
            const Icon = ICONS[action.state];
            return (
              <motion.li
                key={action.id}
                className="action-item"
                data-state={action.state}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16 }}
              >
                <span className="action-item-icon">
                  <Icon size={14} className={action.state === "pending" ? "spin" : undefined} aria-hidden />
                </span>
                <span className="action-item-body">
                  <span className="action-item-title">{action.title}</span>
                  <span className="action-item-detail">{action.detail}</span>
                </span>
                <span className="action-item-side">
                  <span className="action-item-badge">{ACTION_STATE_LABEL[action.state]}</span>
                  {action.ms !== undefined && <span className="action-item-ms">{formatMs(action.ms)}</span>}
                </span>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>
    </section>
  );
}
