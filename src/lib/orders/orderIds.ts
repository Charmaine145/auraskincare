/**
 * Finds order IDs in what a customer said or typed.
 *
 * Speech recognition produces many spellings of the same ID: "ORD-101", "O R D 101",
 * "order one zero one", "ORD one oh one", "one hundred and one". Amounts and durations
 * ("I paid 699", "20 days ago", "up to 2,500 rupees") must not be mistaken for IDs.
 */

const UNITS: Record<string, number> = {
  zero: 0, oh: 0, o: 0, nought: 0, naught: 0,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Words that introduce an order ID ("order number 103", "ORD 101"). */
const PREFIXES = new Set(["ord", "order", "orders", "id", "number", "no", "num"]);
/** Words around a number that mean it is money, time or size rather than an ID. */
const QUANTITY_BEFORE = new Set(["₹", "rs", "inr", "rupees", "rupee", "paid", "pay", "cost", "costs", "price", "priced", "worth", "spent", "above", "below", "under", "over", "upto"]);
const QUANTITY_AFTER = new Set(["rupees", "rupee", "rs", "inr", "bucks", "days", "day", "hours", "hour", "hrs", "minutes", "mins", "weeks", "months", "years", "ml", "g", "gm", "gms", "grams", "percent", "am", "pm", "km"]);

interface DigitRun {
  digits: string;
  start: number;
  end: number;
}

const isUnit = (token: string | undefined): token is string => token !== undefined && token in UNITS;
const isShortNumber = (token: string | undefined): token is string => token !== undefined && /^\d{1,2}$/.test(token);

/** Joins spoken or typed digits into runs: ["one", "oh", "one"] -> "101". */
function digitRuns(tokens: string[]): DigitRun[] {
  const runs: DigitRun[] = [];
  let digits = "";
  let start = -1;
  const flush = (end: number) => {
    if (digits) runs.push({ digits, start, end });
    digits = "";
    start = -1;
  };
  const append = (index: number, value: string) => {
    if (!digits) start = index;
    digits += value;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];

    if (/^\d+$/.test(token)) {
      // A 3+ digit number is complete by itself; never glue it to its neighbours.
      if (token.length >= 3) {
        flush(i - 1);
        runs.push({ digits: token, start: i, end: i });
      } else append(i, token);
      continue;
    }

    // "one hundred and three", "a hundred and one", "one hundred twelve"
    if (token === "hundred" && (digits.length === 1 || (!digits && tokens[i - 1] === "a"))) {
      if (!digits) append(i - 1, "1");
      let j = i + 1;
      if (tokens[j] === "and") j++;
      let tail: number | undefined;
      const word = tokens[j];
      if (isUnit(word) && word !== "o" && word !== "oh") tail = UNITS[word];
      else if (word !== undefined && word in TEENS) tail = TEENS[word];
      else if (word !== undefined && word in TENS) {
        tail = TENS[word];
        const unit = tokens[j + 1];
        if (isUnit(unit) && UNITS[unit] > 0) {
          tail += UNITS[unit];
          j++;
        }
      } else if (isShortNumber(word)) tail = Number(word);
      if (tail !== undefined) {
        digits += String(tail).padStart(2, "0");
        i = j;
      } else digits += "00";
      flush(i);
      continue;
    }

    if (isUnit(token)) {
      // "o"/"oh" only mean zero between other digits ("one oh one"), not in "oh, and ...".
      if ((token === "o" || token === "oh") && !(digits && (isUnit(next) || isShortNumber(next)))) {
        flush(i - 1);
        continue;
      }
      append(i, String(UNITS[token]));
      continue;
    }

    if ((token === "double" || token === "triple") && (isUnit(next) || /^\d$/.test(next ?? ""))) {
      const digit = isUnit(next) ? String(UNITS[next]) : next!;
      append(i, digit.repeat(token === "double" ? 2 : 3));
      i++;
      continue;
    }

    flush(i - 1);
  }
  flush(tokens.length - 1);
  return runs;
}

function looksLikeQuantity(tokens: string[], run: DigitRun): boolean {
  const before = tokens[run.start - 1];
  const after = tokens[run.end + 1];
  const upTo = tokens[run.start - 2] === "up" && before === "to";
  return upTo || (before !== undefined && QUANTITY_BEFORE.has(before)) || (after !== undefined && QUANTITY_AFTER.has(after));
}

/** Zero in each Indian script (Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam). */
const INDIC_ZEROS = [0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66];

/**
 * Number words in the call languages, mapped to the English words the parser already reads, so
 * "ഒന്ന് പൂജ്യം ഏഴ്" or "एक शून्य सात" becomes "one zero seven" (speech recognition often spells
 * digits out). Also "order", "ID" and "hundred", which mark the digits that follow as an ID.
 */
const INDIC_WORDS: Record<string, string[]> = {
  zero: ["शून्य", "ज़ीरो", "जीरो", "শূন্য", "জিরো", "ਸਿਫ਼ਰ", "ਸਿਫਰ", "ਜ਼ੀਰੋ", "શૂન્ય", "ઝીરો", "பூஜ்ஜியம்", "பூஜ்யம்", "ஜீரோ", "సున్నా", "జీరో", "ಸೊನ್ನೆ", "ಜೀರೋ", "പൂജ്യം", "സീറോ"],
  one: ["एक", "এক", "ਇੱਕ", "ਇਕ", "એક", "ஒன்று", "ஒண்ணு", "ఒకటి", "ಒಂದು", "ഒന്ന്"],
  two: ["दो", "दोन", "দুই", "ਦੋ", "બે", "இரண்டு", "ரெண்டு", "రెండు", "ಎರಡು", "രണ്ട്"],
  three: ["तीन", "তিন", "ਤਿੰਨ", "ત્રણ", "மூன்று", "மூணு", "మూడు", "ಮೂರು", "മൂന്ന്"],
  four: ["चार", "চার", "ਚਾਰ", "ચાર", "நான்கு", "நாலு", "నాలుగు", "ನಾಲ್ಕು", "നാല്"],
  five: ["पांच", "पाँच", "पाच", "পাঁচ", "ਪੰਜ", "પાંચ", "ஐந்து", "அஞ்சு", "ఐదు", "ಐದು", "അഞ്ച്"],
  six: ["छह", "छः", "छे", "सहा", "ছয়", "ছয়", "ਛੇ", "છ", "ஆறு", "ఆరు", "ಆರು", "ആറ്"],
  seven: ["सात", "সাত", "ਸੱਤ", "સાત", "ஏழு", "ఏడు", "ಏಳು", "ഏഴ്"],
  eight: ["आठ", "আট", "ਅੱਠ", "આઠ", "எட்டு", "ఎనిమిది", "ಎಂಟು", "എട്ട്"],
  nine: ["नौ", "नऊ", "নয়", "নয়", "ਨੌਂ", "ਨੌ", "નવ", "ஒன்பது", "తొమ్మిది", "ಒಂಬತ್ತು", "ഒമ്പത്"],
  hundred: ["सौ", "শো", "ਸੌ", "સો", "நூறு", "వంద", "ನೂರು", "നൂറ്"],
  order: ["ऑर्डर", "ओर्डर", "आर्डर", "অর্ডার", "ਆਰਡਰ", "ઓર્ડર", "ஆர்டர்", "ఆర్డర్", "ಆರ್ಡರ್", "ഓർഡർ"],
  id: ["आईडी", "আইডি", "ਆਈਡੀ", "આઈડી", "ஐடி", "ఐడి", "ಐಡಿ", "ഐഡി"],
  // Amounts and durations, so "699 रुपये" or "20 दिन" is never taken for an ID.
  rupees: ["रुपये", "रुपए", "रुपया", "रुपयांचा", "টাকা", "ਰੁਪਏ", "રૂપિયા", "ரூபாய்", "రూపాయలు", "ರೂಪಾಯಿ", "രൂപ"],
  days: ["दिन", "दिवस", "দিন", "ਦਿਨ", "દિવસ", "நாள்", "நாட்கள்", "రోజులు", "రోజుల", "ದಿನ", "ದಿನಗಳ", "ദിവസം"],
};
const INDIC_WORD = new Map(Object.entries(INDIC_WORDS).flatMap(([english, words]) => words.map(word => [word, english] as const)));
// Longest first, and never inside a longer word ("एक" in "एकदम").
const INDIC_WORD_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{M}])(${[...INDIC_WORD.keys()].sort((a, b) => b.length - a.length).join("|")})(?![\\p{L}\\p{M}])`,
  "gu",
);

/** Indian digits and number words, rewritten as ASCII digits and English words. */
function latinNumerals(text: string): string {
  return text
    .replace(/[०-൯]/g, char => {
      const code = char.codePointAt(0)!;
      const zero = INDIC_ZEROS.find(z => code >= z && code <= z + 9);
      return zero === undefined ? char : String(code - zero);
    })
    .replace(INDIC_WORD_PATTERN, word => ` ${INDIC_WORD.get(word)} `);
}

/** Returns every order ID mentioned, in order, normalised to "ORD-123". */
export function extractOrderIds(text: string): string[] {
  const prepared = latinNumerals(text)
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1") // "2,500" -> "2500"
    .replace(/\bo[\s.\-]*r[\s.\-]*d\b\.?/g, " ord ") // "O R D", "o.r.d." -> "ord"
    .replace(/\bhundred\s+and\b/g, "hundred");

  const ids: string[] = [];
  // Separate lists like "ORD-101 and 102" so their digits are not glued together.
  for (const segment of prepared.split(/[,;!?]|\.(?=\s|$)|\band\b|\bor\b|&|\//)) {
    const tokens = segment.match(/[a-z]+|\d+|₹/g) ?? [];
    for (const run of digitRuns(tokens)) {
      const prefixed = tokens.slice(Math.max(0, run.start - 3), run.start).some(token => PREFIXES.has(token));
      const valid = prefixed
        ? run.digits.length <= 8
        : run.digits.length >= 3 && run.digits.length <= 6 && !looksLikeQuantity(tokens, run);
      const id = `ORD-${run.digits}`;
      if (valid && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** Normalises one ID (for example a tool argument). Returns the input upper-cased if no ID is found. */
export function normalizeOrderId(input: string): string {
  return extractOrderIds(input)[0] ?? input.trim().toUpperCase();
}
