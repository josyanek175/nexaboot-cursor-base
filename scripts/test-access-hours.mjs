/**
 * Horário de acesso por perfil — regra pura, sem banco.
 * Uso: npx tsx scripts/test-access-hours.mjs
 */
import { readFileSync } from "node:fs";
import {
  ACCESS_OUTSIDE_ALLOWED_HOURS,
  ACCESS_OUTSIDE_LOGIN_MESSAGE,
  ACCESS_SESSION_ENDED_MESSAGE,
  companyTimezoneOrDefault,
  describeAccessHoursNotice,
  formatAccessHoursUserMessage,
  isInsideAccessSchedule,
  zonedClock,
} from "../src/lib/access-hours.ts";

let failed = 0;
function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

const days = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  blocked: weekday === 7,
  startTime: "09:00",
  endTime: "18:00",
}));

/** 2026-09-28 12:00 UTC = 09:00 America/Sao_Paulo, segunda. */
const mondayOpen = new Date("2026-09-28T12:00:00.000Z");
/** 2026-09-28 11:00 UTC = 08:00 São Paulo, antes da janela. */
const mondayEarly = new Date("2026-09-28T11:00:00.000Z");
/** 2026-10-04 15:00 UTC = 12:00 São Paulo, domingo bloqueado. */
const sundayNoon = new Date("2026-10-04T15:00:00.000Z");

assert("fuso da empresa", companyTimezoneOrDefault("America/Recife") === "America/Recife");
assert("fallback de fuso", companyTimezoneOrDefault(null) === "America/Sao_Paulo");
assert("fuso inválido cai no fallback", companyTimezoneOrDefault("Nao/Existe") === "America/Sao_Paulo");

const mondayClock = zonedClock(mondayOpen, "America/Sao_Paulo");
assert("segunda 09:00 SP", mondayClock.weekday === 1 && mondayClock.minutes === 9 * 60);

assert(
  "dentro da janela",
  isInsideAccessSchedule({
    enabled: true,
    bypass: false,
    timeZone: "America/Sao_Paulo",
    now: mondayOpen,
    days,
  }),
);
assert(
  "antes da janela",
  isInsideAccessSchedule({
    enabled: true,
    bypass: false,
    timeZone: "America/Sao_Paulo",
    now: mondayEarly,
    days,
  }) === false,
);
assert(
  "domingo bloqueado",
  isInsideAccessSchedule({
    enabled: true,
    bypass: false,
    timeZone: "America/Sao_Paulo",
    now: sundayNoon,
    days,
  }) === false,
);
assert(
  "restrição desligada libera",
  isInsideAccessSchedule({
    enabled: false,
    bypass: false,
    timeZone: "America/Sao_Paulo",
    now: mondayEarly,
    days,
  }),
);
assert(
  "bypass do admin geral libera",
  isInsideAccessSchedule({
    enabled: true,
    bypass: true,
    timeZone: "America/Sao_Paulo",
    now: sundayNoon,
    days,
  }),
);

const login = readFileSync("src/routes/api/auth/login.ts", "utf8");
const session = readFileSync("src/server.ts", "utf8");
const earlyNotice = describeAccessHoursNotice({
  timeZone: "America/Sao_Paulo",
  now: mondayEarly,
  days,
});
assert(
  "login traduz o código e mostra a janela do dia",
  formatAccessHoursUserMessage({
    sessionEnded: false,
    allowedStart: earlyNotice.allowedStart,
    allowedEnd: earlyNotice.allowedEnd,
  }) === `${ACCESS_OUTSIDE_LOGIN_MESSAGE}\nHorário permitido: 09:00 às 18:00.`,
);
const sundayNotice = describeAccessHoursNotice({
  timeZone: "America/Sao_Paulo",
  now: sundayNoon,
  days: days.map((day) => (day.weekday === 1 ? { ...day, startTime: "08:00" } : day)),
});
assert(
  "próxima janela depois de dia bloqueado",
  formatAccessHoursUserMessage({
    sessionEnded: false,
    nextWeekdayLabel: sundayNotice.nextWeekdayLabel,
    nextTime: sundayNotice.nextTime,
  }) === `${ACCESS_OUTSIDE_LOGIN_MESSAGE}\nPróximo acesso permitido: segunda-feira, às 08:00.`,
);
assert(
  "sessão encerrada tem mensagem própria",
  formatAccessHoursUserMessage({ sessionEnded: true }) === ACCESS_SESSION_ENDED_MESSAGE,
);
const auth = readFileSync("src/lib/auth.tsx", "utf8");
assert("código técnico não entra no texto do usuário", !formatAccessHoursUserMessage({}).includes(ACCESS_OUTSIDE_ALLOWED_HOURS));
assert("senha inválida permanece", auth.includes('invalid_password: "Senha inválida."'));
assert(
  "bloqueio que não é horário continua no aviso atual",
  readFileSync("src/routes/login.tsx", "utf8").includes("Acesso bloqueado. Procure o administrador."),
);
assert("login devolve o código", login.includes(ACCESS_OUTSIDE_ALLOWED_HOURS));
const loginGate = login.indexOf("roleUpper === \"ATENDENTE\"");
const loginCookie = login.indexOf("setCookieHeader = buildSessionSetCookie");
assert("login do atendente acontece antes do cookie", loginGate > 0 && loginGate < loginCookie);
assert("demais perfis não entram na checagem do login", login.includes("ATENDENTE"));
assert("API autenticada revalida o horário", session.includes("attendantAccessHoursResponse"));
assert("logout opcional só no atendente", session.includes("role !== \"ATENDENTE\"") && session.includes("forceLogout"));
assert(
  "só atendente é barrado",
  readFileSync("src/lib/access-hours.server.ts", "utf8").includes('!== "ATENDENTE"'),
);
assert("não é permissão funcional", !readFileSync("src/lib/permissions.ts", "utf8").includes("ACCESS_OUTSIDE_ALLOWED_HOURS"));

if (failed) {
  console.error(`\n${failed} access hour tests failed`);
  process.exit(1);
}
console.log("\nAll access hour tests passed");
