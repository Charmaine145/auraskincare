"use client";

import { useRouter } from "next/navigation";

export function AdminLogout() {
  const router = useRouter();
  return (
    <button
      className="chip-btn"
      onClick={async () => {
        await fetch("/api/admin/login", { method: "DELETE" }).catch(() => undefined);
        router.refresh();
      }}
    >
      Lock dashboard
    </button>
  );
}
