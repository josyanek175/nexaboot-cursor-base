/**
 * Testes da janela progressiva de disparo entre campanhas.
 * Uso: npx tsx scripts/test-campaign-dispatch-window.mjs
 */
import {
  DEFAULT_DISPATCH_WINDOW_SETTINGS,
  DISPATCH_WINDOW_LABEL,
  DISPATCH_WINDOW_SKIP_REASON,
  clampDispatchWindowDays,
  computeDispatchBlock,
  normalizeDispatchWindowSettings,
  windowDaysForSendCount,
} from "../src/lib/campaign-dispatch-window.ts";

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

assert("skip reason", DISPATCH_WINDOW_SKIP_REASON === "dispatch_window");
assert("label", DISPATCH_WINDOW_LABEL.includes("janela de disparo"));

assert("days after 0", windowDaysForSendCount(0) === 0);
assert("days after 1", windowDaysForSendCount(1) === 7);
assert("days after 2", windowDaysForSendCount(2) === 10);
assert("days after 3", windowDaysForSendCount(3) === 30);
assert("days after 9", windowDaysForSendCount(9) === 30);

const custom = { firstWindowDays: 3, secondWindowDays: 5, thirdWindowDays: 14 };
assert("custom days 1", windowDaysForSendCount(1, custom) === 3);
assert("custom days 2", windowDaysForSendCount(2, custom) === 5);
assert("custom days 3", windowDaysForSendCount(3, custom) === 14);

const t0 = new Date("2026-10-01T12:00:00.000Z");

{
  const day6 = new Date(t0.getTime() + 6 * 24 * 60 * 60 * 1000);
  const block = computeDispatchBlock({
    sendCount: 1,
    lastSentAt: t0,
    now: day6,
  });
  assert("1st still blocked on day 6", block?.blocked === true);
  assert("1st window days 7", block?.windowDays === 7);
}

{
  const day8 = new Date(t0.getTime() + 8 * 24 * 60 * 60 * 1000);
  const block = computeDispatchBlock({
    sendCount: 1,
    lastSentAt: t0,
    now: day8,
  });
  assert("1st free on day 8", block?.blocked === false);
}

{
  const day10 = new Date(t0.getTime() + 10 * 24 * 60 * 60 * 1000 - 1);
  const block = computeDispatchBlock({
    sendCount: 2,
    lastSentAt: t0,
    now: day10,
  });
  assert("2nd blocked until day 10", block?.blocked === true);
  assert("2nd window days 10", block?.windowDays === 10);
}

{
  const day11 = new Date(t0.getTime() + 11 * 24 * 60 * 60 * 1000);
  const block = computeDispatchBlock({
    sendCount: 2,
    lastSentAt: t0,
    now: day11,
  });
  assert("2nd free on day 11", block?.blocked === false);
}

{
  const day29 = new Date(t0.getTime() + 29 * 24 * 60 * 60 * 1000);
  const block = computeDispatchBlock({
    sendCount: 3,
    lastSentAt: t0,
    now: day29,
  });
  assert("3rd blocked on day 29", block?.blocked === true);
  assert("3rd window days 30", block?.windowDays === 30);
}

{
  const day31 = new Date(t0.getTime() + 31 * 24 * 60 * 60 * 1000);
  const block = computeDispatchBlock({
    sendCount: 3,
    lastSentAt: t0,
    now: day31,
  });
  assert("3rd free on day 31", block?.blocked === false);
}

{
  const block = computeDispatchBlock({
    sendCount: 4,
    lastSentAt: t0,
    now: new Date(t0.getTime() + 20 * 24 * 60 * 60 * 1000),
  });
  assert("4th uses 30-day tier", block?.windowDays === 30 && block.blocked === true);
}

assert("no history", computeDispatchBlock({ sendCount: 0, lastSentAt: t0 }) === null);

assert("clamp low", clampDispatchWindowDays(0, 7) === 1);
assert("clamp high", clampDispatchWindowDays(999, 7) === 365);
assert("clamp default", clampDispatchWindowDays("x", 7) === 7);

const normalized = normalizeDispatchWindowSettings({
  firstWindowDays: 7,
  secondWindowDays: 10,
  thirdWindowDays: 30,
});
assert(
  "normalize defaults",
  normalized.firstWindowDays === DEFAULT_DISPATCH_WINDOW_SETTINGS.firstWindowDays &&
    normalized.secondWindowDays === DEFAULT_DISPATCH_WINDOW_SETTINGS.secondWindowDays &&
    normalized.thirdWindowDays === DEFAULT_DISPATCH_WINDOW_SETTINGS.thirdWindowDays,
);

if (failed > 0) {
  console.error(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log("\nTodos os testes da janela de disparo passaram.");
