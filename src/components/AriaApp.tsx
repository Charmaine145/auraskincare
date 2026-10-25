"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Activity, Check, ChevronDown, CircleAlert, CircleHelp, CreditCard, Home, Info, Menu, Moon, Package, RotateCcw, Sparkles, Sun, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { BRAND_IDS, BRANDS, brandById, DEFAULT_BRAND, type BrandId } from "@/data/brand";
import { useTheme } from "@/hooks/useTheme";
import { useVoiceCall, type Notice } from "@/hooks/useVoiceCall";
import { Conversation } from "./Conversation";
import { HowItWorks } from "./HowItWorks";
import { Stage } from "./Stage";
import { SummarySheet } from "./SummarySheet";
import { TestOrders } from "./TestOrders";
import { TraceDrawer } from "./TraceDrawer";
import { BrandMark } from "./ui/BrandMark";

const NOTICE_ICON = { info: Info, warning: TriangleAlert, error: CircleAlert };

function Toast({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  const Icon = notice ? NOTICE_ICON[notice.tone] : Info;
  return (
    <AnimatePresence>
      {notice && (
        <motion.div
          key={notice.text}
          className={`toast ${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
          initial={{ opacity: 0, y: -16, x: "-50%" }}
          animate={{ opacity: 1, y: 0, x: "-50%" }}
          exit={{ opacity: 0, y: -12, x: "-50%" }}
          transition={{ type: "spring", stiffness: 360, damping: 30 }}
        >
          <Icon size={17} aria-hidden />
          <span>{notice.text}</span>
          <button onClick={onDismiss} aria-label="Dismiss"><X size={15} /></button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function AriaApp() {
  const call = useVoiceCall();
  const brand = brandById(call.brand);
  const router = useRouter();
  // The brand lives in the URL (?brand=veda), so a link opens the right brand and the tab title follows.
  const chooseBrand = (id: BrandId) => {
    if (call.setBrand(id)) {
      setSummaryOpen(false);
      router.replace(id === DEFAULT_BRAND ? "/" : `/?brand=${id}`, { scroll: false });
    }
  };
  const { theme, toggle } = useTheme();
  const [traceOpen, setTraceOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [brandOpen, setBrandOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("home");
  const brandWrap = useRef<HTMLDivElement>(null);
  const brandTrigger = useRef<HTMLButtonElement>(null);
  const ordersRef = useRef<HTMLElement>(null);
  const brandLocked = call.phase !== "idle";
  const tools = call.activity.filter(item => item.kind === "tool").length;

  // Present the summary as soon as it's ready.
  useEffect(() => {
    if (call.summary) setSummaryOpen(true);
  }, [call.summary]);

  // The brand is fixed for the duration of a call, so never leave the menu hanging open.
  useEffect(() => {
    if (brandLocked) setBrandOpen(false);
  }, [brandLocked]);

  useEffect(() => {
    if (!brandOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (brandWrap.current && !brandWrap.current.contains(event.target as Node)) setBrandOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setBrandOpen(false);
      brandTrigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [brandOpen]);

  const closeBrand = (refocus = false) => {
    setBrandOpen(false);
    if (refocus) brandTrigger.current?.focus();
  };

  const navigateTo = (section: string, target: string) => {
    setActiveSection(section);
    setMobileNavOpen(false);
    setProfileOpen(false);
    if (target === "orders" && ordersRef.current) {
      window.setTimeout(() => ordersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
      return;
    }
    const destination = document.getElementById(target) ?? document.getElementById("conversation");
    destination?.scrollIntoView({ behavior: "smooth", block: target === "home" ? "start" : "center" });
  };

  return (
    <div className="app">
      <div className="backdrop" aria-hidden>
        <span className="blob one" />
        <span className="blob two" />
        <span className="blob three" />
      </div>

      <div className="dashboard-shell">
        {mobileNavOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
        <aside className={`sidebar ${mobileNavOpen ? "mobile-open" : ""}`} aria-label="Main navigation">
          <div className="sidebar-brand">
            <div className="brand-wrap" ref={brandWrap}>
              <button
                ref={brandTrigger}
                type="button"
                className={`brand ${brandLocked ? "locked" : ""}`}
                data-brand={call.brand}
                onClick={() => setBrandOpen(open => !open)}
                onKeyDown={event => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setBrandOpen(true);
                  }
                }}
                disabled={brandLocked}
                aria-haspopup="listbox"
                aria-expanded={brandOpen}
                title={brandLocked ? "The brand is fixed for this call" : "Switch brand"}
              >
                <BrandMark brand={call.brand} />
                <span className="brand-name">{brand.wordmark}</span>
                <ChevronDown size={14} className="brand-caret" aria-hidden />
              </button>
              <AnimatePresence>
                {brandOpen && (
                  <motion.ul
                    className="brand-menu"
                    role="listbox"
                    aria-label="Brand"
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.99 }}
                    transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                  >
                    {BRAND_IDS.map(id => (
                      <li key={id} role="presentation">
                        <button
                          type="button"
                          role="option"
                          aria-selected={id === call.brand}
                          className={id === call.brand ? (id === "veda" ? "on haircare" : "on") : ""}
                          onClick={() => {
                            chooseBrand(id);
                            closeBrand(true);
                          }}
                        >
                          <BrandMark brand={id} />
                          <span className="brand-menu-name">{BRANDS[id].name}</span>
                          {id === call.brand && <Check size={15} className="brand-menu-check" aria-hidden />}
                        </button>
                      </li>
                    ))}
                  </motion.ul>
                )}
              </AnimatePresence>
            </div>
          </div>

          <nav className="sidebar-nav" aria-label="Support topics">
            <button className={`sidebar-link ${activeSection === "home" ? "active" : ""}`} onClick={() => navigateTo("home", "home")} aria-current={activeSection === "home" ? "page" : undefined}>
              <Home size={18} aria-hidden /><span>Home</span>
            </button>
            <button className={`sidebar-link ${activeSection === "orders" ? "active" : ""}`} onClick={() => navigateTo("orders", "orders")} aria-current={activeSection === "orders" ? "page" : undefined}>
              <Package size={18} aria-hidden /><span>Orders</span>
            </button>
            <button className={`sidebar-link ${activeSection === "returns" ? "active" : ""}`} onClick={() => navigateTo("returns", "suggestion-return")} aria-current={activeSection === "returns" ? "page" : undefined}>
              <RotateCcw size={18} aria-hidden /><span>Returns</span>
            </button>
            <button className={`sidebar-link ${activeSection === "payments" ? "active" : ""}`} onClick={() => navigateTo("payments", "suggestion-payments")} aria-current={activeSection === "payments" ? "page" : undefined}>
              <CreditCard size={18} aria-hidden /><span>Payments</span>
            </button>
            <button className={`sidebar-link ${activeSection === "skincare" ? "active" : ""}`} onClick={() => navigateTo("skincare", "welcome-banner")} aria-current={activeSection === "skincare" ? "page" : undefined}>
              <Sparkles size={18} aria-hidden /><span>{brand.concern === "skin" ? "Skincare" : "Haircare"} Help</span>
            </button>
          </nav>

          <div className="sidebar-divider" />
          <nav className="sidebar-nav sidebar-tools" aria-label="Assistant tools">
            <button className="sidebar-link" onClick={() => { setTraceOpen(true); setMobileNavOpen(false); }}>
              <Activity size={18} aria-hidden /><span>Aria Pulse</span>{tools > 0 && <span className="sidebar-count">{tools}</span>}
            </button>
            <button className="sidebar-link" onClick={() => { setHowOpen(true); setMobileNavOpen(false); }}>
              <CircleHelp size={18} aria-hidden /><span>How it works</span>
            </button>
          </nav>

          <div className="sidebar-profile">
            {profileOpen && (
              <div className="profile-menu">
                <div className="profile-details"><span className="profile-avatar">A</span><span><strong>Aura Guest</strong><small>{brand.concern === "skin" ? "Skincare" : "Haircare"} support</small></span></div>
                <button className="profile-theme" onClick={toggle}>
                  {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
                  <span>Switch to {theme === "dark" ? "light" : "dark"} theme</span>
                </button>
              </div>
            )}
            <button className="profile-trigger" onClick={() => setProfileOpen(open => !open)} aria-expanded={profileOpen} aria-haspopup="true">
              <span className="profile-avatar">A</span><span className="profile-name">Guest</span><ChevronDown size={15} aria-hidden />
            </button>
          </div>
        </aside>

        <main className="dashboard-main">
          <header className="mobile-bar">
            <button className="mobile-menu-button" aria-label="Open navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)}><Menu size={20} /></button>
            <span className="mobile-brand" data-brand={call.brand}><BrandMark brand={call.brand} />{brand.wordmark}</span>
            <button className="icon-btn theme-toggle mobile-theme-toggle" onClick={toggle} aria-label={theme === "dark" ? "Light theme" : "Dark theme"} title={theme === "dark" ? "Light theme" : "Dark theme"}>
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </header>
          <div className="layout">
            <motion.div id="home" className="left" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
              <Stage call={call} />
            </motion.div>
            <motion.div className="right" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}>
              <Conversation call={call} onShowSummary={() => setSummaryOpen(true)} />
            </motion.div>
          </div>
          <section className="orders-drawer" id="orders" ref={ordersRef} aria-labelledby="orders-heading">
            <h2 className="orders-heading" id="orders-heading"><Package size={17} aria-hidden /> Your sample orders</h2>
            <TestOrders call={call} />
          </section>
        </main>
      </div>

      <Toast notice={call.notice} onDismiss={call.dismissNotice} />
      <TraceDrawer call={call} open={traceOpen} onClose={() => setTraceOpen(false)} />
      <HowItWorks brand={brand} open={howOpen} onClose={() => setHowOpen(false)} />
      <SummarySheet call={call} open={summaryOpen} onClose={() => setSummaryOpen(false)} />
    </div>
  );
}
