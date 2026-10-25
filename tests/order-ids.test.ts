import { test } from "node:test";
import assert from "node:assert/strict";
import { extractOrderIds, normalizeOrderId } from "../src/lib/orders/orderIds";

const cases: [string, string[]][] = [
  ["Where is my order ORD-101?", ["ORD-101"]],
  ["O R D one zero one", ["ORD-101"]],
  ["ORD one oh one", ["ORD-101"]],
  ["order one-o-three", ["ORD-103"]],
  ["one hundred and one", ["ORD-101"]],
  ["a hundred and two please", ["ORD-102"]],
  ["o.r.d. 102", ["ORD-102"]],
  ["ORD1 01", ["ORD-101"]],
  ["cancel ord103", ["ORD-103"]],
  ["order number 103", ["ORD-103"]],
  ["one zero three", ["ORD-103"]],
  ["ORD double one zero", ["ORD-110"]],
  ["mera order ORD 101 kab tak aayega", ["ORD-101"]],
  ["What about ORD-101 and ORD-102?", ["ORD-101", "ORD-102"]],
  ["ORD-101 and 102", ["ORD-101", "ORD-102"]],
  ["ORD-1010", ["ORD-1010"]],
  ["ORD-12", ["ORD-12"]],
];

test("recognises typed and spoken order IDs", () => {
  for (const [input, expected] of cases) assert.deepEqual(extractOrderIds(input), expected, input);
});

test("ignores amounts, durations and sizes", () => {
  for (const input of ["I paid 699 rupees", "Is COD available up to 2,500 rupees?", "I bought this 20 days ago", "Hydrating Sunscreen SPF 50, 30ml", "Is shipping free above 499?", "Oh, and one more thing"]) {
    assert.deepEqual(extractOrderIds(input), [], input);
  }
  assert.deepEqual(extractOrderIds("I paid 699 for ORD-101"), ["ORD-101"]);
});

test("normalises tool arguments", () => {
  assert.equal(normalizeOrderId("ORD-101"), "ORD-101");
  assert.equal(normalizeOrderId("101"), "ORD-101");
  assert.equal(normalizeOrderId("ord 103"), "ORD-103");
  assert.equal(normalizeOrderId("something else"), "SOMETHING ELSE");
});

test("reads IDs in Indian digits and number words, as speech recognition writes them", () => {
  const indic: [string, string[]][] = [
    ["ORD-൧൦൭ എവിടെയാണ്?", ["ORD-107"]], // Malayalam digits
    ["ഓർഡർ ഐഡി ഒന്ന് പൂജ്യം ഏഴ്", ["ORD-107"]], // Malayalam words
    ["मेरा ऑर्डर एक शून्य तीन कैंसल करो", ["ORD-103"]],
    ["ஆர்டர் ஒன்று பூஜ்ஜியம் இரண்டு எங்கே?", ["ORD-102"]],
    ["ఆర్డర్ ౧౦౧ ఎక్కడ ఉంది?", ["ORD-101"]], // Telugu digits
    ["অর্ডার ১০৫", ["ORD-105"]], // Bengali digits
    ["ऑर्डर एक सौ आठ", ["ORD-108"]], // "one hundred eight"
  ];
  for (const [input, expected] of indic) assert.deepEqual(extractOrderIds(input), expected, input);
  for (const input of ["मैंने 699 रुपये दिए", "20 दिन पहले खरीदा था", "ഞാൻ 850 രൂപ അടച്ചു", "एकदम सही", "मेरा एक सवाल है"]) {
    assert.deepEqual(extractOrderIds(input), [], input);
  }
});
