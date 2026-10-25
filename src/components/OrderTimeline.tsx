import type { OrderStatus } from "@/types";

const FLOW = ["Order Placed", "Processing", "Shipped", "Out for Delivery", "Delivered"] as const;
const CURRENT: Record<Exclude<OrderStatus, "Cancelled">, number> = {
  Processing: 1,
  Shipped: 2,
  "Out for Delivery": 3,
  Delivered: 4,
};

/**
 * Shipment progress built only from the sample order record. It never invents a courier scan,
 * GPS location or delivery estimate: the note says exactly what the data is.
 */
export function OrderTimeline({ status, courier, trackingId }: { status: OrderStatus; courier?: string; trackingId?: string }) {
  const cancelled = status === "Cancelled";
  const current = cancelled ? 1 : CURRENT[status];
  const steps = cancelled ? ["Order Placed", "Cancelled"] : [...FLOW];

  return (
    <div className={`timeline ${cancelled ? "cancelled" : ""}`} role="group" aria-label={`Demo shipment progress: ${status}`}>
      <ol>
        {steps.map((label, index) => {
          const state = index < current ? "done" : index === current ? "current" : "pending";
          return (
            <li key={label} className={state} aria-current={state === "current" ? "step" : undefined}>
              <span className="timeline-dot" aria-hidden />
              <span className="timeline-label">{label}</span>
            </li>
          );
        })}
      </ol>
      <p className="timeline-note">
        {cancelled
          ? "Cancelled during this call. Demo record · no courier update is implied."
          : trackingId && courier
            ? `Demo shipment progress · ${courier} tracking ${trackingId}. No live scans or GPS.`
            : "Demo shipment progress · no tracking ID has been assigned yet."}
      </p>
    </div>
  );
}
