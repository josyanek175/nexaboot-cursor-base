/**
 * Testes manuais do normalizador E.164.
 * Uso: node scripts/test-phone-normalizer.mjs
 */
import {
  normalizePhone,
  normalizePhoneE164,
  isValidE164Digits,
  formatPhoneDisplay,
} from "../src/lib/phone.ts";

const cases = [
  { input: "5534999708837", e164: "5534999708837" },
  { input: "+55 34 99970-8837", e164: "5534999708837" },
  { input: "15556034558", e164: "15556034558" },
  { input: "+1 555 603-4558", e164: "15556034558" },
  { input: "351912345678", e164: "351912345678" },
  { input: "5534999708837@s.whatsapp.net", e164: "5534999708837" },
];

let failed = 0;

for (const { input, e164 } of cases) {
  const got = normalizePhoneE164(input, { defaultCountry: "BR" });
  const ok = got === e164 && isValidE164Digits(got);
  if (!ok) {
    failed += 1;
    console.error(`FAIL input=${JSON.stringify(input)} expected=${e164} got=${got}`);
  } else {
    console.log(`OK   ${JSON.stringify(input)} → ${got} (${formatPhoneDisplay(got)})`);
  }
}

// Garantias extras
const usNotBr = normalizePhoneE164("15556034558", { defaultCountry: "BR" });
if (usNotBr.startsWith("55") && usNotBr.length > 13) {
  failed += 1;
  console.error("FAIL US number must not become BR with extra 55");
} else {
  console.log(`OK   US stays international: ${usNotBr}`);
}

const brLocal = normalizePhoneE164("34999708837", { defaultCountry: "BR" });
if (brLocal !== "5534999708837") {
  failed += 1;
  console.error(`FAIL BR local inference expected 5534999708837 got ${brLocal}`);
} else {
  console.log(`OK   BR local 34999708837 → ${brLocal}`);
}

if (normalizePhone("+1 555 603-4558") !== "15556034558") {
  failed += 1;
  console.error("FAIL normalizePhone compatibility");
}

console.log(failed === 0 ? "\nAll phone normalizer tests passed." : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
