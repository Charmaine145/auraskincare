import type { Order } from "@/types";
import { orders as auraOrders, vedaOrders } from "./orders";

/**
 * Every brand Aria serves. One agent and one policy engine; each brand brings its own facts,
 * policy numbers, orders and greetings. A call is bound to one brand in its signed session, so
 * it can only see that brand's orders and is judged by that brand's rules.
 */

export type BrandId = "aura" | "veda";

export interface BrandPolicy {
  /** Returns accepted within this many days of delivery (unopened, unused, original packaging). */
  returnDays: number;
  /** Damaged or defective items must be reported within this many hours of delivery. */
  damageHours: number;
  /** Cash on Delivery for orders up to this value, inclusive (rupees). */
  codLimit: number;
  /** Free delivery above this order value (rupees); below it, `shippingFee`. */
  freeShippingAbove: number;
  shippingFee: number;
  /** Standard delivery time, e.g. [3, 5] business days. */
  deliveryDays: [number, number];
}

export interface Brand {
  id: BrandId;
  name: string;
  shortName: string;
  /** Brand wordmark shown in the sidebar and mobile header. */
  wordmark: string;
  /** "skin" or "hair": what product-suitability questions Aria cannot answer. */
  concern: string;
  overview: string;
  policy: BrandPolicy;
  orders: Order[];
  /** Prefix of care-team references, e.g. AUR-4821. */
  referencePrefix: string;
  /** Aria's greeting in each call language (brand names inflect, so these are whole sentences). */
  greetings: Record<string, string>;
}

export const BRANDS: Record<BrandId, Brand> = {
  aura: {
    id: "aura",
    name: "Aura Skincare",
    shortName: "Aura",
    wordmark: "Aura Skincare",
    concern: "skin",
    // From the brief, word for word.
    overview: "Aura Skincare is a premium organic Indian skincare brand focused on simple, effective skincare products made with thoughtfully selected ingredients.",
    policy: { returnDays: 7, damageHours: 48, codLimit: 2500, freeShippingAbove: 499, shippingFee: 50, deliveryDays: [3, 5] },
    orders: auraOrders,
    referencePrefix: "AUR",
    greetings: {
      "en-IN": "Hi, I'm Aria, your AI care specialist at Aura Skincare. How can I help you today?",
      "hi-IN": "नमस्ते, मैं आरिया हूँ, ऑरा स्किनकेयर की एआई सहायक। मैं आपकी कैसे मदद कर सकती हूँ?",
      "ta-IN": "வணக்கம், நான் ஆரியா, ஆரா ஸ்கின்கேரின் உதவியாளர். நான் உங்களுக்கு எப்படி உதவலாம்?",
      "te-IN": "నమస్తే, నేను ఆరియా, ఆరా స్కిన్‌కేర్ సహాయకురాలిని. నేను మీకు ఎలా సహాయం చేయగలను?",
      "bn-IN": "নমস্কার, আমি আরিয়া, আউরা স্কিনকেয়ারের সহকারী। আমি আপনাকে কীভাবে সাহায্য করতে পারি?",
      "mr-IN": "नमस्कार, मी आरिया, ऑरा स्किनकेअरची सहायक. मी तुमची कशी मदत करू शकते?",
      "gu-IN": "નમસ્તે, હું આરિયા છું, ઓરા સ્કિનકેરની સહાયક. હું તમારી કેવી રીતે મદદ કરી શકું?",
      "kn-IN": "ನಮಸ್ಕಾರ, ನಾನು ಆರಿಯಾ, ಆರಾ ಸ್ಕಿನ್‌ಕೇರ್ ಸಹಾಯಕಿ. ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?",
      "ml-IN": "നമസ്കാരം, ഞാൻ ആരിയ, ഓറ സ്കിൻകെയറിന്റെ സഹായി. ഞാൻ നിങ്ങളെ എങ്ങനെ സഹായിക്കണം?",
      "pa-IN": "ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਮੈਂ ਆਰੀਆ ਹਾਂ, ਔਰਾ ਸਕਿਨਕੇਅਰ ਦੀ ਸਹਾਇਕ। ਮੈਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦੀ ਹਾਂ?",
    },
  },
  veda: {
    id: "veda",
    name: "Aura Haircare",
    shortName: "Aura Haircare",
    wordmark: "Aura Haircare",
    concern: "hair",
    overview: "Aura Haircare is an Ayurvedic Indian haircare brand making oils, shampoos and scalp treatments from traditional herbs such as bhringraj, amla and neem.",
    policy: { returnDays: 10, damageHours: 72, codLimit: 5000, freeShippingAbove: 799, shippingFee: 79, deliveryDays: [4, 6] },
    orders: vedaOrders,
    referencePrefix: "VED",
    greetings: {
      "en-IN": "Hi, I'm Aria, your AI care specialist at Aura Haircare. How can I help you today?",
      "hi-IN": "नमस्ते, मैं आरिया हूँ, ऑरा हेयरकेयर की एआई सहायक। मैं आपकी कैसे मदद कर सकती हूँ?",
      "ta-IN": "வணக்கம், நான் ஆரியா, ஆரா ஹேர்கேரின் உதவியாளர். நான் உங்களுக்கு எப்படி உதவலாம்?",
      "te-IN": "నమస్తే, నేను ఆరియా, ఆరా హెయిర్‌కేర్ సహాయకురాలిని. నేను మీకు ఎలా సహాయం చేయగలను?",
      "bn-IN": "নমস্কার, আমি আরিয়া, আউরা হেয়ারকেয়ারের সহকারী। আমি আপনাকে কীভাবে সাহায্য করতে পারি?",
      "mr-IN": "नमस्कार, मी आरिया, ऑरा हेअरकेअरची सहायक. मी तुमची कशी मदत करू शकते?",
      "gu-IN": "નમસ્તે, હું આરિયા છું, ઓરા હેરકેરની સહાયક. હું તમારી કેવી રીતે મદદ કરી શકું?",
      "kn-IN": "ನಮಸ್ಕಾರ, ನಾನು ಆರಿಯಾ, ಆರಾ ಹೇರ್‌ಕೇರ್ ಸಹಾಯಕಿ. ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?",
      "ml-IN": "നമസ്കാരം, ഞാൻ ആരിയ, ഓറ ഹെയർകെയറിന്റെ സഹായി. ഞാൻ നിങ്ങളെ എങ്ങനെ സഹായിക്കണം?",
      "pa-IN": "ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਮੈਂ ਆਰੀਆ ਹਾਂ, ਔਰਾ ਹੇਅਰਕੇਅਰ ਦੀ ਸਹਾਇਕ। ਮੈਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦੀ ਹਾਂ?",
    },
  },
};

export const DEFAULT_BRAND: BrandId = "aura";
export const BRAND_IDS = Object.keys(BRANDS) as BrandId[];
export const isBrandId = (id: unknown): id is BrandId => typeof id === "string" && id in BRANDS;
export const brandById = (id?: string | null): Brand => BRANDS[isBrandId(id) ? id : DEFAULT_BRAND];

/** One order per scenario, so suggestions always point at IDs this brand really has. */
export function sampleIds(brand: Brand) {
  const first = (status: Order["status"]) => brand.orders.find(o => o.status === status)?.order_id ?? brand.orders[0].order_id;
  const damaged = brand.orders.find(o => o.status === "Delivered" && o.delivered_days_ago !== undefined && o.delivered_days_ago * 24 <= brand.policy.damageHours)?.order_id ?? first("Delivered");
  return {
    track: first("Out for Delivery"),
    returnable: first("Delivered"),
    cancellable: first("Processing"),
    damaged,
    shipped: first("Shipped"),
  };
}

const inr = (value: number) => `₹${value.toLocaleString("en-IN")}`;
const spoken = (value: number) => `${value.toLocaleString("en-IN")} rupees`;

/** The policy cards shown on the page. */
export function policyCards(brand: Brand) {
  const p = brand.policy;
  return [
    {
      id: "shipping",
      title: "Shipping and Delivery",
      points: [
        `Orders above ${inr(p.freeShippingAbove)} qualify for free delivery.`,
        `Orders below ${inr(p.freeShippingAbove)} incur a ${inr(p.shippingFee)} shipping charge.`,
        `Standard delivery takes ${p.deliveryDays[0]}–${p.deliveryDays[1]} business days.`,
      ],
    },
    {
      id: "returns",
      title: "Returns and Refunds",
      points: [
        `Returns are accepted within ${p.returnDays} days of delivery.`,
        "Products must be unopened, unused, and kept in their original packaging.",
      ],
    },
    {
      id: "damage",
      title: "Damaged or Defective Products",
      points: [
        `Issues must be reported within ${p.damageHours} hours of delivery.`,
        "Customers must provide photographs of the damaged or defective item to request a replacement.",
      ],
    },
    {
      id: "cancellation",
      title: "Order Cancellation",
      points: [
        "Cancellation is permitted only while an order is in the Processing stage.",
        "Orders that have already shipped or are out for delivery may be refused at the doorstep.",
      ],
    },
    {
      id: "cod",
      title: "Cash on Delivery (COD)",
      points: [
        `COD is available for orders up to ${inr(p.codLimit)}.`,
        "Customers can pay using cash or UPI when the order arrives.",
      ],
    },
  ];
}

/** Everything the model may state about the brand; it is told to use nothing else. */
export function brandKnowledge(brand: Brand): string {
  const p = brand.policy;
  return `Brand: ${brand.overview}
Shipping: free delivery on orders above ${spoken(p.freeShippingAbove)}; orders below ${spoken(p.freeShippingAbove)} pay a ${spoken(p.shippingFee).replace("rupees", "rupee")} shipping fee. The policy does not say what happens at exactly ${spoken(p.freeShippingAbove)}, so say that honestly instead of guessing. Standard delivery takes ${p.deliveryDays[0]} to ${p.deliveryDays[1]} business days.
Returns and refunds: accepted within ${p.returnDays} days of delivery, only for products that are unopened AND unused AND in their original packaging. Otherwise the return is declined; there are no exceptions, discounts or goodwill refunds.
Damaged or defective products: must be reported within ${p.damageHours} hours of delivery, with photos, for a replacement. You cannot receive photos or book the replacement yourself.
Cancellation: only while the order status is Processing. Shipped or Out for Delivery orders cannot be cancelled, but the customer may refuse delivery at the doorstep. Delivered orders cannot be cancelled.
Cash on Delivery: available for orders up to ${spoken(p.codLimit)} (inclusive); pay by cash or UPI at the doorstep.
Products: you only know the product names that appear in orders. You have no ingredient lists, prices for other products, stock levels, offers or ${brand.concern}-suitability data.`;
}
