import { test } from "node:test";
import assert from "node:assert/strict";
import { isAffirmative, isGoodbye, isNegative } from "../src/lib/agent/intents";
import { pickVoice, voiceReport } from "../src/lib/voice/browserVoices";
import { LANGUAGES, isRomanizedHindi, replyLanguage, segmentText } from "../src/lib/voice/languages";
import { extractOrderIds } from "../src/lib/orders/orderIds";

// What Edge on Windows typically exposes, plus a plain Chrome install.
const VOICES = [
  { name: "Microsoft Ravi - English (India)", lang: "en-IN" },
  { name: "Microsoft Neerja Online (Natural) - English (India)", lang: "en-IN" },
  { name: "Microsoft Zira - English (United States)", lang: "en-US" },
  { name: "Microsoft Hemant - Hindi (India)", lang: "hi-IN" },
  { name: "Microsoft Swara Online (Natural) - Hindi (India)", lang: "hi-IN" },
  { name: "Google தமிழ்", lang: "ta-IN" },
  { name: "Microsoft Valluvar - Tamil (India)", lang: "ta-IN" },
];

test("picks the natural female voice for each language, and null when none is installed", () => {
  assert.match(pickVoice(VOICES, "en-IN")!.name, /Neerja/);
  assert.match(pickVoice(VOICES, "hi-IN")!.name, /Swara/);
  assert.match(pickVoice(VOICES, "ta-IN")!.name, /Google/, "a neural-or-Google voice beats a plain male one");
  assert.equal(pickVoice(VOICES, "te-IN"), null);
  assert.equal(pickVoice(VOICES.filter(v => v.lang === "en-US"), "en-IN")?.lang, "en-US", "any English voice is better than none");
  assert.equal(pickVoice([{ name: "Some Voice", lang: "hi_IN" }], "hi-IN")?.name, "Some Voice", "Android-style hi_IN codes match");
});

test("voice report lists every supported language", () => {
  const report = voiceReport(VOICES);
  assert.equal(report.length, LANGUAGES.length);
  assert.equal(report.find(r => r.code === "hi-IN")?.voice, "Microsoft Swara Online (Natural) - Hindi (India)");
  assert.equal(report.find(r => r.code === "bn-IN")?.voice, null);
});

test("replies are split by script so each part gets the right voice", () => {
  assert.deepEqual(segmentText("Your order is out for delivery."), [{ lang: "en-IN", text: "Your order is out for delivery." }]);
  assert.deepEqual(segmentText("आपका ऑर्डर आज शाम तक पहुँच जाएगा।"), [{ lang: "hi-IN", text: "आपका ऑर्डर आज शाम तक पहुँच जाएगा।" }]);
  assert.deepEqual(segmentText("आपका ऑर्डर ORD-101 आज पहुँचेगा।").map(s => s.lang), ["hi-IN"], "a short ID stays with the Hindi voice");
  assert.deepEqual(segmentText("உங்கள் ஆர்டர் இன்று வரும்.").map(s => s.lang), ["ta-IN"]);
  const mixed = segmentText("आपका ऑर्डर आज आएगा। I'm sorry, ORD-102 was delivered 14 days ago, so I can't approve a return.");
  assert.deepEqual(mixed.map(s => s.lang), ["hi-IN", "en-IN"]);
  assert.equal(segmentText("नमस्कार", "mr-IN")[0].lang, "mr-IN", "Devanagari follows the chosen language");
  assert.deepEqual(segmentText("   "), []);
});

test("long replies are cut into sentences (Chrome stops long utterances)", () => {
  const long = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i} of a long reply.`).join(" ");
  const parts = segmentText(long);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.text.length <= 260));
});

test("Hindi yes, no and goodbye are understood", () => {
  for (const yes of ["हाँ", "जी हाँ कर दो", "ठीक है", "जरूर"]) assert.equal(isAffirmative(yes), true, yes);
  for (const no of ["नहीं", "नहीं, रहने दो", "मत करो"]) assert.equal(isNegative(no), true, no);
  assert.equal(isAffirmative("हाँ लेकिन मेरा ऑर्डर कहाँ है?"), false);
  assert.equal(isGoodbye("बस इतना ही, धन्यवाद"), true);
  assert.equal(isGoodbye("बाय द वे मेरा ऑर्डर कहाँ है"), false);
});

test("order IDs spoken with Devanagari digits or transcribed as digits are found", () => {
  assert.deepEqual(extractOrderIds("मेरा ऑर्डर ORD-१०१ कहाँ है"), ["ORD-101"]);
  assert.deepEqual(extractOrderIds("ओ आर डी 103 कैंसिल करो"), ["ORD-103"]);
});

test("replies in the language the customer wrote, not the one picked in the app", () => {
  assert.equal(replyLanguage(["Where is my order ORD-101?"], "te-IN"), "en-IN", "English question with Telugu selected");
  assert.equal(replyLanguage(["Cancel ORD-102"], "hi-IN"), "en-IN");
  assert.equal(replyLanguage(["ORD-101 ఎక్కడ ఉంది?"], "en-IN"), "te-IN");
  assert.equal(replyLanguage(["mera order kahan hai?"], "en-IN"), "hi-IN", "Hinglish");
  assert.equal(replyLanguage(["माझी ऑर्डर कुठे आहे?"], "mr-IN"), "mr-IN", "Devanagari is Marathi when Marathi is picked");
  assert.equal(replyLanguage(["ORD-101 ఎక్కడ ఉంది?", "ok"], "en-IN"), "te-IN", "a bare 'ok' keeps the previous language");
  assert.equal(replyLanguage(["ORD-103"], "ta-IN"), "ta-IN", "no language signal falls back to the selection");
  assert.equal(isRomanizedHindi("Where is my order? Is it here?"), false);
});
