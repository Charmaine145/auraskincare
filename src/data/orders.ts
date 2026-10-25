import type { Order } from "@/types";

/**
 * The mock order database from the assessment brief.
 * Fixtures are never mutated: a cancellation only exists inside that call's signed session.
 */
export const orders: Order[] = [
  {
    order_id: "ORD-101",
    customer_name: "Priya Sharma",
    product: "Vitamin C Serum (30ml)",
    value: 699,
    status: "Out for Delivery",
    courier: "BlueDart",
    tracking_id: "BD-982103",
    notes: "Expected by 6 PM today",
  },
  {
    order_id: "ORD-102",
    customer_name: "Rahul Verma",
    product: "Hydrating Sunscreen SPF 50",
    value: 499,
    status: "Delivered",
    courier: "Delhivery",
    tracking_id: "DL-441029",
    notes: "Delivered 14 days ago",
    delivered_days_ago: 14,
  },
  {
    order_id: "ORD-103",
    customer_name: "Ananya Patel",
    product: "Green Tea Face Wash + Toner",
    value: 850,
    status: "Processing",
    notes: "Placed 3 hours ago · Cancellation is currently available",
    ordered_hours_ago: 3,
  },
  // Extra fixtures, one per policy path the brief's three orders don't reach.
  {
    // In transit: too late to cancel, too early to return.
    order_id: "ORD-104",
    customer_name: "Arjun Nair",
    product: "Ceramide Barrier Moisturiser (50g)",
    value: 1249,
    status: "Shipped",
    courier: "Delhivery",
    tracking_id: "DL-553817",
    notes: "Dispatched yesterday · Estimated arrival in 2–3 days",
  },
  {
    // Inside the 7-day return window: Aria must ask about its condition.
    order_id: "ORD-105",
    customer_name: "Sneha Iyer",
    product: "Niacinamide 10% Serum (30ml)",
    value: 599,
    status: "Delivered",
    courier: "BlueDart",
    tracking_id: "BD-774520",
    notes: "Delivered 3 days ago",
    delivered_days_ago: 3,
  },
  {
    // Delivered yesterday: a damage report is still within 48 hours.
    order_id: "ORD-106",
    customer_name: "Karan Mehta",
    product: "Rose Water Toner (100ml)",
    value: 349,
    status: "Delivered",
    courier: "Ekart",
    tracking_id: "EK-209366",
    notes: "Delivered yesterday",
    delivered_days_ago: 1,
  },
  {
    // Cancellable, but above the 2,500 rupee Cash on Delivery limit.
    order_id: "ORD-107",
    customer_name: "Meera Reddy",
    product: "Complete Night Care Kit",
    value: 3200,
    status: "Processing",
    notes: "Placed 1 hour ago · Eligible for cancellation",
    ordered_hours_ago: 1,
  },
  {
    // Exactly on the last day of the 7-day return window.
    order_id: "ORD-108",
    customer_name: "Vikram Singh",
    product: "SPF 30 Tinted Lip Balm",
    value: 299,
    status: "Delivered",
    courier: "Delhivery",
    tracking_id: "DL-618042",
    notes: "Delivered 7 days ago",
    delivered_days_ago: 7,
  },
];

/**
 * Aura Haircare, the second brand. Its orders sit where its policies differ from Aura Skincare's, so the
 * same question gets a different, correct answer depending on the brand the call is for.
 */
export const vedaOrders: Order[] = [
  {
    order_id: "ORD-201",
    customer_name: "Kavya Menon",
    product: "Bhringraj Hair Oil (200ml)",
    value: 649,
    status: "Out for Delivery",
    courier: "Delhivery",
    tracking_id: "DL-730215",
    notes: "Expected by 8 PM today",
  },
  {
    // 9 days: inside Veda's 10-day return window (outside Aura's 7).
    order_id: "ORD-202",
    customer_name: "Rohan Gupta",
    product: "Onion and Amla Shampoo (250ml)",
    value: 549,
    status: "Delivered",
    courier: "BlueDart",
    tracking_id: "BD-651903",
    notes: "Delivered 9 days ago",
    delivered_days_ago: 9,
  },
  {
    order_id: "ORD-203",
    customer_name: "Isha Kapoor",
    product: "Hair Growth Serum + Scalp Tonic",
    value: 1850,
    status: "Processing",
    notes: "Ordered 2 hours ago. Eligible for cancellation",
    ordered_hours_ago: 2,
  },
  {
    // 4,200 rupees: Cash on Delivery at Veda (limit 5,000), not at Aura (2,500).
    order_id: "ORD-204",
    customer_name: "Farhan Qureshi",
    product: "Ayurvedic Hair Care Kit",
    value: 4200,
    status: "Shipped",
    courier: "Ekart",
    tracking_id: "EK-118472",
    notes: "Shipped yesterday, expected in 3 to 4 days",
  },
  {
    // Delivered 3 days ago: a damage report is inside Veda's 72 hours (outside Aura's 48).
    order_id: "ORD-205",
    customer_name: "Nandini Rao",
    product: "Neem Wood Comb + Hair Mask",
    value: 399,
    status: "Delivered",
    courier: "Delhivery",
    tracking_id: "DL-204118",
    notes: "Delivered 3 days ago",
    delivered_days_ago: 3,
  },
];
