"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LockKeyhole } from "lucide-react";

export function AdminLogin({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "That token didn't work.");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That token didn't work.");
      setBusy(false);
    }
  };

  return (
    <main className="admin-login">
      <form className="admin-card" onSubmit={submit}>
        <span className="admin-lock"><LockKeyhole size={20} aria-hidden /></span>
        <h1>Support analytics</h1>
        <p>This view contains customer feedback and support tickets. Enter the admin token to continue.</p>
        <label>
          <span>Admin token</span>
          <input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="admin-error" role="alert">{error}</p>}
        <button className="pill-btn" type="submit" disabled={busy || !token}>{busy ? "Checking…" : "Unlock dashboard"}</button>
        {!configured && <p className="admin-hint">No admin token is configured, so this page stays closed in production. Set <code>ADMIN_TOKEN</code> to enable it.</p>}
      </form>
    </main>
  );
}
