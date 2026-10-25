"use client";

import { AnimatePresence, motion } from "motion/react";
import { Brain, Circle, Keyboard, LoaderCircle, Mic, ShieldCheck, TriangleAlert, Volume2, Wrench } from "lucide-react";
import type { ActivityItem, VoiceCall } from "@/hooks/useVoiceCall";
import { average, formatMs } from "@/lib/format";
import { Sheet } from "./ui/Sheet";

const ICONS = { system: Circle, heard: Mic, tool: Wrench, guardrail: ShieldCheck, model: Brain, voice: Volume2, error: TriangleAlert };

function Icon({ item }: { item: ActivityItem }) {
  if (item.status === "running") return <LoaderCircle size={14} className="spin" />;
  const Component = item.kind === "heard" && item.title.startsWith("Typed") ? Keyboard : ICONS[item.kind];
  return <Component size={14} />;
}

/** "Under the hood": what Aria heard, which tools she called, which guardrails fired, and timings. */
export function TraceDrawer({ call, open, onClose }: { call: VoiceCall; open: boolean; onClose: () => void }) {
  const avg = average(call.latencies);
  const tools = call.activity.filter(item => item.kind === "tool").length;
  const guards = call.activity.filter(item => item.kind === "guardrail").length;

  return (
    <Sheet open={open} onClose={onClose} side="right" width={420} title="Aria Pulse">
      <div className="trace-stats">
        <div><strong>{avg === null ? "—" : formatMs(avg)}</strong><span>avg response</span></div>
        <div><strong>{tools}</strong><span>tool calls</span></div>
        <div><strong>{guards}</strong><span>guardrails</span></div>
      </div>
      {call.activity.length === 0 ? (
        <p className="trace-empty">Start a call to watch Aria decide when to call a tool, which guardrails apply, and how long each step takes.</p>
      ) : (
        <ol className="trace">
          <AnimatePresence initial={false}>
            {call.activity.map(item => (
              <motion.li key={item.id} className="trace-item" data-kind={item.kind} data-status={item.status ?? "none"} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }}>
                <span className="trace-icon"><Icon item={item} /></span>
                <div>
                  <div className="trace-title">{item.title}</div>
                  {item.detail && <div className="trace-detail">{item.detail}</div>}
                </div>
                {item.ms !== undefined && <span className="trace-ms">{formatMs(item.ms)}</span>}
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}
    </Sheet>
  );
}
