import type { Intent } from "@/types";
import { extractOrderIds } from "@/lib/orders/orderIds";

/**
 * Lightweight keyword classification (English + common Hinglish).
 * The model does the real understanding; this labels outcomes, drives the no-key
 * rule-based mode and powers a few deterministic fast paths.
 */
export function detectIntent(text: string): Intent {
  const t = text.toLowerCase();
  const mentionsOrder = extractOrderIds(t).length > 0 || /\b(my|mera|meri|mere)\s+(order|parcel|package|delivery|serum|sunscreen|face ?wash|toner|moisturi[sz]er|lip balm|kit|hair ?oil|oil|shampoo|tonic|comb|hair ?mask|mask)\b/.test(t);

  if (/\b(human|real person|agent|representative|manager|supervisor|someone (else|real)|call ?back|escalate|talk to (a|some)one)\b/.test(t)) return "HUMAN_HANDOFF";
  if (/\b(don'?t|do not|never|not)\s+(want to\s+)?cancel\b/.test(t)) return "GENERAL";
  if (/\bcancel|\bradd\b/.test(t)) return "CANCELLATION";
  if (/\b(damag\w*|broken|defect\w*|leak\w*|spill\w*|crack\w*|wrong (item|product)|kharab|toota|tuta)\b/.test(t)) return "DAMAGED_PRODUCT";
  if (/\b(return\w*|refund\w*|replace\w*|exchange|money back|wapas|vapas|wapis)\b/.test(t)) return "RETURN_REQUEST";
  const productWords = /\b(serum|sunscreen|moisturi[sz]er|cleanser|face ?wash|toner|shampoo|conditioner|hair ?oil|scalp|lip balm|product|products|routine|ingredients?|catalogue|catalog)\b/.test(t);
  const productAsk = /\b(recommend\w*|suggest\w*|suitable|best|which|what (should|can|do) (i|you)|for (my|dry|oily|sensitive|combination)|skin type|ingredients?|routine|help (me )?(with|choose)|good for)\b/.test(t) || /\b(dry|oily|dull|acne|blemish\w*|sensitive) (skin|scalp)\b/.test(t);
  if (!extractOrderIds(t).length && productWords && productAsk) return "PRODUCT_QUESTION";
  if (mentionsOrder && /\b(where|track\w*|status|arriv\w*|reach\w*|dispatch\w*|deliver\w*|ship\w*|when|kab|kahan|kaha|aayega|ayega|aaega|pahunch\w*)\b/.test(t)) return "ORDER_TRACKING";
  if (/\b(cod|cash|upi|pay\w*|shipping|delivery|deliver|charges?|fees?|free|policy|policies|how long|business days|brand|organic|ayurved\w*|about (aura|veda))\b/.test(t)) return "POLICY_QUESTION";
  if (/\b(where|track\w*|status|kab tak|kahan|aayega)\b/.test(t)) return "ORDER_TRACKING";
  if (/\b(flights?|hotel|weather|cricket|movie|recipe|coding|code|politic\w*|stocks?|bitcoin|crypto|joke|song|news|homework|travel|goa|train|taxi|uber|restaurant|pizza)\b/.test(t)) return "OUT_OF_SCOPE";
  if (mentionsOrder) return "ORDER_TRACKING";
  return "GENERAL";
}

const cleaned = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{M}\s']/gu, " ").replace(/\s+/g, " ").trim();

/** A short reply that only confirms or refuses — not "Right, and what about shipping?". */
function isBareReply(text: string, pattern: RegExp): boolean {
  if (text.includes("?")) return false;
  const t = cleaned(text);
  const match = pattern.exec(t);
  if (!match) return false;
  const rest = t.slice(match[0].length).trim();
  return rest.split(" ").filter(Boolean).length <= 6 && !/\b(what|where|when|how|why|which|who|return|refund|ship\w*|cod|track|status|policy)\b|क्या|कहाँ|कब|कैसे|क्यों|कौन/.test(rest);
}

/** "yes", "haan", "go ahead", "please do" — a short confirmation. */
export function isAffirmative(text: string): boolean {
  return isBareReply(text, /^(yes|yeah|yep|yup|ya|yah|sure|ok|okay|okey|alright|all right|haan|haa|han|ha|ji|ji haan|haan ji|theek hai|thik hai|please do|please go ahead|go ahead|do it|confirm\w*|correct|absolutely|definitely|of course|kar do|karo|cancel it|हाँ|हां|हा|जी|जी हाँ|जी हां|ठीक है|कर दो|कर दीजिए|कीजिए|जरूर|ज़रूर)(?![\p{L}\p{M}])/u);
}

/** "no", "don't", "keep it", "nahi" — a short refusal. */
export function isNegative(text: string): boolean {
  return isBareReply(text, /^(no|nope|nah|nahi|nahin|na|don't|do not|dont|not now|wait|hold on|leave it|keep it|never ?mind|mat karo|rehne do|actually no|नहीं|नही|ना|मत करो|रहने दो|रुको)(?![\p{L}\p{M}])/u);
}

export function isGoodbye(text: string): boolean {
  const t = cleaned(text);
  return (/\b(bye|goodbye|good bye|that's all|that is all|that's it|thats it|nothing else|end the call|hang up|have a (good|nice|great) day)\b/.test(t) || /अलविदा|बाय|बस इतना ही|बस यही|कॉल खत्म|फोन रख/.test(t))
    && !/\b(cancel|return|order|where|refund)\b|कैंसिल|रद्द|वापस|ऑर्डर|कहाँ/.test(t);
}

/** Which policy a general question is about, for summaries and rule-based answers. */
export function policyTopic(text: string): "cod" | "shipping" | "returns" | "damage" | "cancellation" | "brand" | "general" {
  const t = text.toLowerCase();
  if (/\b(cod|cash|upi|pay\w*)\b/.test(t)) return "cod";
  if (/\b(ship\w*|deliver\w*|charges?|fees?|free|how long|business days)\b/.test(t)) return "shipping";
  if (/\b(damag\w*|defect\w*|broken|leak\w*)\b/.test(t)) return "damage";
  if (/\b(return\w*|refund\w*|exchange)\b/.test(t)) return "returns";
  if (/\bcancel/.test(t)) return "cancellation";
  if (/\b(brand|organic|ayurved\w*|about (aura|veda)|who are you|aura|veda)\b/.test(t)) return "brand";
  return "general";
}
