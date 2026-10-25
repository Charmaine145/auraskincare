"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";

/**
 * Animated overlay used for the trace drawer ("right") and dialogs ("center").
 * Escape and the backdrop close it; focus moves in on open and back out on close.
 */
export function Sheet({ open, onClose, title, side = "center", width, children, footer }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  side?: "center" | "right";
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close.current();
    document.addEventListener("keydown", onKey);
    document.documentElement.classList.add("sheet-open");
    setTimeout(() => panel.current?.focus(), 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("sheet-open");
      previous?.focus?.();
    };
  }, [open]);

  if (typeof document === "undefined") return null;
  const fromRight = side === "right";
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className={`sheet-root ${side}`}>
          <motion.div className="sheet-backdrop" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === "string" ? title : undefined}
            tabIndex={-1}
            className={`sheet ${side}`}
            style={width ? { width: `min(${width}px, calc(100vw - 24px))` } : undefined}
            initial={fromRight ? { x: "104%" } : { opacity: 0, y: 24, scale: 0.97 }}
            animate={fromRight ? { x: 0 } : { opacity: 1, y: 0, scale: 1 }}
            exit={fromRight ? { x: "104%" } : { opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
          >
            <header className="sheet-head">
              <h2>{title}</h2>
              <button className="icon-btn" onClick={onClose} aria-label="Close">
                <X size={17} />
              </button>
            </header>
            <div className="sheet-body">{children}</div>
            {footer && <footer className="sheet-foot">{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
