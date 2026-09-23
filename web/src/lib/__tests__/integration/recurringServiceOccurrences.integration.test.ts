/**
 * Phase 4 (plan-servicios-recurrentes.md): generate_due_recurring_service_
 * occurrences() and the cron route that calls it, against the real
 * inma-erp-dev project. Run with `npm run test:integration`.
 *
 * Two layers:
 * 1. The live function on today's date, through the real cron route
 *    handler and supabase-js. Fixtures are two throwaway companies
 *    created here and deleted in afterAll; nothing depends on data
 *    already loaded in dev. The function processes *every* active
 *    service in the project, so any occurrence it creates for a
 *    pre-existing service during this run is deleted afterward too.
 * 2. Calendar edge cases (February, December -> January, mid-month
 *    start/end) that today's date can't reach: a copy of the *live*
 *    function body, with only `current_date` swapped for a parameter,
 *    is created in pg_temp and exercised on fixed dates inside a
 *    transaction that is rolled back -- nothing it writes survives.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addMonths,
  anonClient,
  assertDevProject,
  lastDayOfMonth,
  runLinkedSql,
  serviceClient,
  todayUtc,
  ymd,
} from "./devProject";

vi.mock("server-only", () => ({}));

import { GET } from "@/app/api/cron/recurring-service-occurrences/route";

type Occurrence = {
  occurrence_id: string;
  service_id: string;
  occurrence_period: string;
};

type ServiceFixture = {
  key: string;
  company: "A" | "B";
  periodicity: "monthly" | "annual";
  invoicing_mode: "advance" | "arrears";
  due_day: number | null;
  due_month?: number | null;
  status?: "active" | "paused" | "cancelled";
  start_date?: string;
  end_date?: string | null;
};

const tag = `zz-test-occ-${randomUUID().slice(0, 8)}`;
const today = todayUtc();
const currentPeriod = ymd(today.year, today.month, 1);
const next = addMonths(today.year, today.month, 1);
const prev = addMonths(today.year, today.month, -1);

const serviceFixtures: ServiceFixture[] = [
  { key: "monthlyArrears", company: "A", periodicity: "monthly", invoicing_mode: "arrears", due_day: 10 },
  { key: "monthlyAdvance", company: "A", periodicity: "monthly", invoicing_mode: "advance", due_day: 10 },
  { key: "monthlyAdvanceDay31", company: "A", periodicity: "monthly", invoicing_mode: "advance", due_day: 31 },
  { key: "noDueDay", company: "A", periodicity: "monthly", invoicing_mode: "advance", due_day: null },
  { key: "paused", company: "A", periodicity: "monthly", invoicing_mode: "advance", due_day: 10, status: "paused" },
  { key: "cancelled", company: "A", periodicity: "monthly", invoicing_mode: "advance", due_day: 10, status: "cancelled" },
  {
    key: "ended",
    company: "A",
    periodicity: "monthly",
    invoicing_mode: "advance",
    due_day: 10,
    end_date: ymd(prev.year, prev.month, lastDayOfMonth(prev.year, prev.month)),
  },
  {
    key: "notStarted",
    company: "A",
    periodicity: "monthly",
    invoicing_mode: "advance",
    due_day: 10,
    start_date: ymd(next.year, next.month, 1),
  },
  { key: "annualThisMonth", company: "A", periodicity: "annual", invoicing_mode: "advance", due_day: 15, due_month: today.month },
  {
    key: "startsLaterThisMonth",
    company: "A",
    periodicity: "monthly",
    invoicing_mode: "advance",
    due_day: 10,
    start_date: ymd(today.year, today.month, lastDayOfMonth(today.year, today.month)),
  },
  {
    key: "arrearsEndedLastMonth",
    company: "A",
    periodicity: "monthly",
    invoicing_mode: "arrears",
    due_day: 10,
    end_date: ymd(prev.year, prev.month, lastDayOfMonth(prev.year, prev.month)),
  },
  { key: "annualArrearsThisMonth", company: "A", periodicity: "annual", invoicing_mode: "arrears", due_day: 15, due_month: today.month },
  { key: "annualOtherMonth", company: "A", periodicity: "annual", invoicing_mode: "advance", due_day: 15, due_month: next.month },
  { key: "otherCompany", company: "B", periodicity: "monthly", invoicing_mode: "advance", due_day: 5 },
];

const expectedGenerated = [
  "monthlyArrears",
  "monthlyAdvance",
  "monthlyAdvanceDay31",
  "noDueDay",
  "annualThisMonth",
  "annualArrearsThisMonth",
  "startsLaterThisMonth",
  "arrearsEndedLastMonth",
  "otherCompany",
];

const ids = {
  companies: {} as Record<"A" | "B", string>,
  services: {} as Record<string, string>,
  // Every occurrence any generation call in this file created -- fixture
  // or not -- so afterAll can put dev back exactly as it was.
  createdOccurrences: new Set<string>(),
  authUser: null as string | null,
};

function keyOf(serviceId: string) {
  return Object.entries(ids.services).find(([, id]) => id === serviceId)?.[0];
}

function track(rows: Occurrence[] | null | undefined) {
  for (const row of rows ?? []) ids.createdOccurrences.add(row.occurrence_id);
}

beforeAll(async () => {
  assertDevProject();
  const db = serviceClient();

  for (const company of ["A", "B"] as const) {
    const { data: c, error: companyError } = await db
      .from("companies")
      .insert({ name: `${tag} ${company}`, currency: "USD" })
      .select("id")
      .single();
    if (companyError) throw companyError;
    ids.companies[company] = c.id;
  }

  const clientIds: Record<string, string> = {};
  for (const company of ["A", "B"] as const) {
    const { data: client, error } = await db
      .from("clients")
      .insert({ company_id: ids.companies[company], name: `${tag} client ${company}` })
      .select("id")
      .single();
    if (error) throw error;
    clientIds[company] = client.id;
  }

  const { data: services, error } = await db
    .from("recurring_services")
    .insert(
      serviceFixtures.map((s) => ({
        company_id: ids.companies[s.company],
        client_id: clientIds[s.company],
        name: `${tag} ${s.key}`,
        price: 100,
        currency: "USD",
        periodicity: s.periodicity,
        invoicing_mode: s.invoicing_mode,
        due_day: s.due_day,
        due_month: s.due_month ?? null,
        status: s.status ?? "active",
        active: (s.status ?? "active") === "active",
        start_date: s.start_date ?? "2020-01-01",
        end_date: s.end_date ?? null,
      })),
    )
    .select("id, name");
  if (error) throw error;
  for (const s of services) ids.services[s.name.slice(tag.length + 1)] = s.id;
});

afterAll(async () => {
  const db = serviceClient();
  const serviceIds = Object.values(ids.services);
  const companyIds = Object.values(ids.companies);

  // Collect failures instead of stopping at the first, so one failed
  // step never strands the rest of the fixtures in dev.
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };

  if (ids.createdOccurrences.size > 0) {
    await step(
      db.from("recurring_service_occurrences").delete().in("id", [...ids.createdOccurrences]),
    );
  }
  if (serviceIds.length > 0) {
    await step(db.from("recurring_service_occurrences").delete().in("recurring_service_id", serviceIds));
    await step(db.from("recurring_services").delete().in("id", serviceIds));
  }
  if (companyIds.length > 0) {
    await step(db.from("clients").delete().in("company_id", companyIds));
    // Seeded by the seed_business_areas_on_company_insert trigger.
    await step(db.from("business_areas").delete().in("company_id", companyIds));
    await step(db.from("companies").delete().in("id", companyIds));
  }
  if (ids.authUser) {
    const { error } = await db.auth.admin.deleteUser(ids.authUser);
    if (error) failures.push(error);
  }

  if (failures.length > 0) {
    throw new Error(`Fixture cleanup failed (tag ${tag}): ${JSON.stringify(failures)}`);
  }
});

describe("cron route + generate_due_recurring_service_occurrences() on today's date", () => {
  let firstRun: { generated: number; occurrences: Occurrence[] };

  it("GET with the right secret returns 200 and the count of what it generated", async () => {
    const response = await GET(
      new Request("http://localhost/api/cron/recurring-service-occurrences", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    );
    firstRun = await response.json();
    track(firstRun.occurrences);

    expect(response.status).toBe(200);
    expect(firstRun.generated).toBe(firstRun.occurrences.length);

    const fixtureKeys = firstRun.occurrences
      .map((o) => keyOf(o.service_id))
      .filter((k): k is string => k !== undefined);
    expect(fixtureKeys.sort()).toEqual([...expectedGenerated].sort());
  });

  it("writes the expected period, due dates and amounts for each kind of service", async () => {
    const { data, error } = await serviceClient()
      .from("recurring_service_occurrences")
      .select("recurring_service_id, period, invoice_due_date, collection_due_date, amount, currency, status, created_by")
      .in("recurring_service_id", Object.values(ids.services));
    expect(error).toBeNull();

    const byKey = Object.fromEntries(data!.map((row) => [keyOf(row.recurring_service_id), row]));
    const due = (y: number, m: number, d: number) => ymd(y, m, Math.min(d, lastDayOfMonth(y, m)));

    // Vencido: bills the month that just closed, due in the current one.
    expect(byKey.monthlyArrears).toMatchObject({
      period: ymd(prev.year, prev.month, 1),
      invoice_due_date: due(today.year, today.month, 10),
      collection_due_date: due(today.year, today.month, 10),
    });
    // Its last month is still billed after end_date has passed.
    expect(byKey.arrearsEndedLastMonth).toMatchObject({
      period: ymd(prev.year, prev.month, 1),
      invoice_due_date: due(today.year, today.month, 10),
    });
    // Starting later this month: active during part of the period is
    // enough -- full amount, no proration.
    expect(byKey.startsLaterThisMonth).toMatchObject({ period: currentPeriod, amount: 100 });
    // Anticipado: due within the period itself.
    expect(byKey.monthlyAdvance).toMatchObject({
      period: currentPeriod,
      invoice_due_date: due(today.year, today.month, 10),
    });
    // due_day 31 clamps to the month's last day.
    expect(byKey.monthlyAdvanceDay31.invoice_due_date).toBe(
      ymd(today.year, today.month, lastDayOfMonth(today.year, today.month)),
    );
    // No due_day configured: still generated, just without due dates.
    expect(byKey.noDueDay).toMatchObject({
      period: currentPeriod,
      invoice_due_date: null,
      collection_due_date: null,
    });
    // Annual: one occurrence for the year, due in due_month.
    expect(byKey.annualThisMonth).toMatchObject({
      period: ymd(today.year, 1, 1),
      invoice_due_date: due(today.year, today.month, 15),
    });
    // Annual vencido: bills last year, due this year in due_month.
    expect(byKey.annualArrearsThisMonth).toMatchObject({
      period: ymd(today.year - 1, 1, 1),
      invoice_due_date: due(today.year, today.month, 15),
    });
    expect(byKey.otherCompany).toMatchObject({ period: currentPeriod });

    for (const row of data!) {
      expect(row).toMatchObject({
        amount: 100,
        currency: "USD",
        status: "pending_invoice",
        created_by: null,
      });
    }

    for (const skipped of ["paused", "cancelled", "ended", "notStarted", "annualOtherMonth"]) {
      expect(byKey[skipped], skipped).toBeUndefined();
    }
  });

  it("covers every company in a single run", () => {
    const companiesHit = new Set(
      firstRun.occurrences
        .map((o) => keyOf(o.service_id))
        .filter(Boolean)
        .map((k) => serviceFixtures.find((s) => s.key === k)!.company),
    );
    expect([...companiesHit].sort()).toEqual(["A", "B"]);
  });

  it("is idempotent: a second run of the same period generates nothing", async () => {
    const db = serviceClient();
    const { data, error } = await db.rpc("generate_due_recurring_service_occurrences");
    track(data as Occurrence[]);

    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { count } = await db
      .from("recurring_service_occurrences")
      .select("id", { count: "exact", head: true })
      .in("recurring_service_id", Object.values(ids.services));
    expect(count).toBe(expectedGenerated.length);
  });

  it("never regenerates a period that was voided (Anular on Pendientes is final)", async () => {
    const db = serviceClient();
    const { error: voidError } = await db
      .from("recurring_service_occurrences")
      .update({ status: "void" })
      .eq("recurring_service_id", ids.services.monthlyAdvance);
    expect(voidError).toBeNull();

    const { data, error } = await db.rpc("generate_due_recurring_service_occurrences");
    track(data as Occurrence[]);
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: rows } = await db
      .from("recurring_service_occurrences")
      .select("status")
      .eq("recurring_service_id", ids.services.monthlyAdvance);
    expect(rows).toEqual([{ status: "void" }]);
  });
});

describe("who can execute generate_due_recurring_service_occurrences()", () => {
  it("an anonymous caller (anon key, no session) is refused", async () => {
    const { data, error } = await anonClient().rpc("generate_due_recurring_service_occurrences");
    track(data as Occurrence[] | null);
    expect(error?.code).toBe("42501");
  });

  it("an ordinary authenticated user is refused", async () => {
    const admin = serviceClient();
    const email = `${tag}@example.test`;
    const password = randomBytes(24).toString("base64url");
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(createError).toBeNull();
    ids.authUser = created.user!.id;

    const user = anonClient();
    const { error: signInError } = await user.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();

    const { data, error } = await user.rpc("generate_due_recurring_service_occurrences");
    track(data as Occurrence[] | null);
    expect(error?.code).toBe("42501");
  });

  it("only service_role (and the owner) hold EXECUTE", () => {
    const rows = runLinkedSql<{ rolname: string; can_execute: boolean }>(
      `select r.rolname, has_function_privilege(r.rolname, 'public.generate_due_recurring_service_occurrences()', 'execute') as can_execute
       from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') order by r.rolname`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.rolname, r.can_execute]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });

  it("the app's member-scoped RPCs are closed to anon but still open to authenticated", () => {
    const rows = runLinkedSql<{ fn: string; anon: boolean; authenticated: boolean }>(
      `select fn, has_function_privilege('anon', fn, 'execute') as anon, has_function_privilege('authenticated', fn, 'execute') as authenticated
       from unnest(array['public.create_mcp_access_token(text)', 'public.allocate_recurring_service_cost_pool(uuid)', 'public.match_recurring_service_occurrences_for_import_batch(uuid)']) as fn`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row, row.fn).toMatchObject({ anon: false, authenticated: true });
    }
  });
});

describe("calendar edge cases (live function body on fixed dates, rolled back)", () => {
  type Row = {
    run: string;
    service: string;
    period: string;
    invoice_due_date: string | null;
    collection_due_date: string | null;
  };

  const runs: [string, string][] = [
    ["2026-01-10", "2026-01-10"],
    ["2026-10-01", "2026-10-01"],
    ["2026-10-01 again", "2026-10-01"],
    ["2026-11-01", "2026-11-01"],
    ["2026-12-01", "2026-12-01"],
    ["2027-01-01", "2027-01-01"],
    ["2027-02-01", "2027-02-01"],
    ["2027-03-01", "2027-03-01"],
    ["2028-02-01", "2028-02-01"],
    ["2028-03-01", "2028-03-01"],
  ];

  let rows: Row[] = [];
  const at = (run: string, service: string) =>
    rows.filter((r) => r.run === run && r.service === service);

  beforeAll(() => {
    assertDevProject();
    const company = randomUUID();
    const client = randomUUID();
    const services: [string, string][] = [
      // name, column values (periodicity, invoicing_mode, due_day, due_month, start_date, end_date)
      ["decArrears", `'monthly', 'arrears', 10, null, '2020-01-01', null`],
      ["advanceDay31", `'monthly', 'advance', 31, null, '2020-01-01', null`],
      ["arrearsDay31", `'monthly', 'arrears', 31, null, '2020-01-01', null`],
      ["annualJanAdvance", `'annual', 'advance', 15, 1, '2020-01-01', null`],
      ["annualJanArrears", `'annual', 'arrears', 15, 1, '2020-01-01', null`],
      ["annualDecArrears", `'annual', 'arrears', 20, 12, '2020-01-01', null`],
      ["annualFebDay31", `'annual', 'advance', 31, 2, '2020-01-01', null`],
      ["startsMidMonth", `'monthly', 'advance', 10, null, '2026-10-15', null`],
      ["arrearsStartsMidMonth", `'monthly', 'arrears', 10, null, '2026-10-15', null`],
      ["startsNextMonth", `'monthly', 'advance', 10, null, '2026-11-01', null`],
      ["endsMidMonth", `'monthly', 'advance', 10, null, '2020-01-01', '2026-10-15'`],
      ["arrearsEndsMidMonth", `'monthly', 'arrears', 10, null, '2020-01-01', '2026-10-15'`],
      ["annualStartsMidDueMonth", `'annual', 'advance', 10, 3, '2027-03-10', null`],
      ["annualArrearsStartsMidYear", `'annual', 'arrears', 10, 3, '2027-03-10', null`],
    ];
    const marker = "v_today date := current_date;";

    const sql = `
begin;
do $harness$
declare
  src text := pg_get_functiondef('public.generate_due_recurring_service_occurrences()'::regprocedure);
  marker text := '${marker}';
begin
  if length(src) - length(replace(src, marker, '')) <> length(marker)
     or position('current_date' in replace(src, marker, '')) > 0 then
    raise exception 'harness out of date: expected current_date only in "%"', marker;
  end if;
  src := replace(src, marker, 'v_today date := p_today;');
  src := replace(src, 'public.generate_due_recurring_service_occurrences()', 'pg_temp.generate_occurrences_as_of(p_today date)');
  execute src;
end
$harness$;
insert into public.companies (id, name, currency) values ('${company}', '${tag} dates', 'USD');
insert into public.clients (id, company_id, name) values ('${client}', '${company}', '${tag} dates');
insert into public.recurring_services
  (company_id, client_id, name, price, currency, status, periodicity, invoicing_mode, due_day, due_month, start_date, end_date)
values
${services.map(([name, cols]) => `  ('${company}', '${client}', '${name}', 100, 'USD', 'active', ${cols})`).join(",\n")};
create temp table harness_runs (run text, occurrence_id uuid);
${runs
  .map(
    ([label, date]) =>
      `insert into harness_runs select '${label}', occurrence_id from pg_temp.generate_occurrences_as_of('${date}');`,
  )
  .join("\n")}
select hr.run, rs.name as service, o.period::text, o.invoice_due_date::text, o.collection_due_date::text
from harness_runs hr
join public.recurring_service_occurrences o on o.id = hr.occurrence_id
join public.recurring_services rs on rs.id = o.recurring_service_id
where rs.company_id = '${company}';
rollback;`;

    rows = runLinkedSql<Row>(sql);
  });

  it("monthly vencido bills the month that just closed, due in the current month (incl. December -> January)", () => {
    expect(at("2026-12-01", "decArrears")).toEqual([
      expect.objectContaining({ period: "2026-11-01", invoice_due_date: "2026-12-10", collection_due_date: "2026-12-10" }),
    ]);
    expect(at("2027-01-01", "decArrears")).toEqual([
      expect.objectContaining({ period: "2026-12-01", invoice_due_date: "2027-01-10", collection_due_date: "2027-01-10" }),
    ]);
  });

  it("due_day 31 clamps to the last day of February (28, and 29 in a leap year)", () => {
    expect(at("2027-02-01", "advanceDay31")[0]).toMatchObject({ period: "2027-02-01", invoice_due_date: "2027-02-28" });
    expect(at("2028-02-01", "advanceDay31")[0].invoice_due_date).toBe("2028-02-29");
    // Vencido run in February bills January, due in February.
    expect(at("2027-02-01", "arrearsDay31")[0]).toMatchObject({ period: "2027-01-01", invoice_due_date: "2027-02-28" });
    expect(at("2027-02-01", "annualFebDay31")[0]).toMatchObject({ period: "2027-01-01", invoice_due_date: "2027-02-28" });
  });

  it("annual services only generate in their due month, and a new year gets a new occurrence", () => {
    expect(at("2026-12-01", "annualJanAdvance")).toEqual([]);
    expect(at("2026-01-10", "annualJanAdvance")[0]).toMatchObject({ period: "2026-01-01", invoice_due_date: "2026-01-15" });
    expect(at("2027-01-01", "annualJanAdvance")[0]).toMatchObject({ period: "2027-01-01", invoice_due_date: "2027-01-15" });
    expect(at("2027-02-01", "annualJanAdvance")).toEqual([]);
  });

  it("annual vencido bills the year that just closed, due this year in its due month", () => {
    expect(at("2026-12-01", "annualDecArrears")[0]).toMatchObject({ period: "2025-01-01", invoice_due_date: "2026-12-20" });
    expect(at("2027-01-01", "annualDecArrears")).toEqual([]);
    // Year change: the January 2027 run bills 2026.
    expect(at("2026-01-10", "annualJanArrears")[0]).toMatchObject({ period: "2025-01-01", invoice_due_date: "2026-01-15" });
    expect(at("2027-01-01", "annualJanArrears")[0]).toMatchObject({ period: "2026-01-01", invoice_due_date: "2027-01-15" });
  });

  it("re-running the same date generates nothing", () => {
    expect(rows.filter((r) => r.run === "2026-10-01 again")).toEqual([]);
  });

  it("a service that hasn't started by the end of the period generates nothing", () => {
    expect(at("2026-10-01", "startsNextMonth")).toEqual([]);
    expect(at("2026-11-01", "startsNextMonth")[0]).toMatchObject({ period: "2026-11-01" });
  });

  it("a service starting mid-period gets that first period in full (no proration)", () => {
    // Anticipado: the run on the 1st already covers the month it starts in.
    expect(at("2026-10-01", "startsMidMonth")[0]).toMatchObject({ period: "2026-10-01", invoice_due_date: "2026-10-10" });
    expect(at("2026-11-01", "startsMidMonth")[0]).toMatchObject({ period: "2026-11-01" });
    // Vencido: nothing for September; October is billed on November 1st.
    expect(at("2026-10-01", "arrearsStartsMidMonth")).toEqual([]);
    expect(at("2026-11-01", "arrearsStartsMidMonth")[0]).toMatchObject({ period: "2026-10-01", invoice_due_date: "2026-11-10" });

    expect(at("2027-03-01", "annualStartsMidDueMonth")[0]).toMatchObject({ period: "2027-01-01", invoice_due_date: "2027-03-10" });
    expect(at("2027-03-01", "annualArrearsStartsMidYear")).toEqual([]);
    expect(at("2028-03-01", "annualArrearsStartsMidYear")[0]).toMatchObject({ period: "2027-01-01", invoice_due_date: "2028-03-10" });
  });

  it("a service ending mid-period is billed for that last period, then stops", () => {
    expect(at("2026-10-01", "endsMidMonth")[0]).toMatchObject({ period: "2026-10-01" });
    expect(at("2026-11-01", "endsMidMonth")).toEqual([]);
    expect(at("2026-11-01", "arrearsEndsMidMonth")[0]).toMatchObject({ period: "2026-10-01" });
    expect(at("2026-12-01", "arrearsEndsMidMonth")).toEqual([]);
  });
});

