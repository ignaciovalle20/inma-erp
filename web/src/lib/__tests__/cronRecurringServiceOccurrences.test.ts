/**
 * The recurring-service-occurrences cron route (Vercel Cron target):
 * CRON_SECRET check, error handling when the SQL function fails, and the
 * middleware letting it through without a session. The function's own
 * behavior against a real database is covered by
 * integration/recurringServiceOccurrences.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const state: { rpc: { data: unknown; error: { message: string } | null } } = {
  rpc: { data: [], error: null },
};
const rpcCalls: string[] = [];

vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: () => ({
    rpc: async (name: string) => {
      rpcCalls.push(name);
      return state.rpc;
    },
  }),
}));

// The middleware's session check: always "no session" here.
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getClaims: async () => ({ data: null, error: { message: "no session" } }) },
  }),
}));

import { GET } from "@/app/api/cron/recurring-service-occurrences/route";
import { middleware } from "@/middleware";

const URL_PATH = "http://localhost/api/cron/recurring-service-occurrences";
const request = (authorization?: string) =>
  new Request(URL_PATH, authorization ? { headers: { authorization } } : undefined);

beforeEach(() => {
  rpcCalls.length = 0;
  state.rpc = { data: [], error: null };
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/cron/recurring-service-occurrences", () => {
  it("returns 401 without an Authorization header, and never calls the function", async () => {
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(rpcCalls).toEqual([]);
  });

  it("returns 401 with the wrong secret", async () => {
    expect((await GET(request("Bearer wrong"))).status).toBe(401);
    expect((await GET(request("test-cron-secret"))).status).toBe(401);
    expect(rpcCalls).toEqual([]);
  });

  it("returns 401 even for `Bearer undefined` when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(request("Bearer "))).status).toBe(401);
    expect((await GET(request("Bearer undefined"))).status).toBe(401);
    expect(rpcCalls).toEqual([]);
  });

  it("returns 200 with the generated count when the secret matches", async () => {
    const occurrences = [
      { occurrence_id: "o1", service_id: "s1", occurrence_period: "2026-09-01" },
      { occurrence_id: "o2", service_id: "s2", occurrence_period: "2026-01-01" },
    ];
    state.rpc = { data: occurrences, error: null };

    const response = await GET(request("Bearer test-cron-secret"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ generated: 2, occurrences });
    expect(rpcCalls).toEqual(["generate_due_recurring_service_occurrences"]);
  });

  it("returns 500 (not 200) and hides the database error when the function fails", async () => {
    state.rpc = { data: null, error: { message: "permission denied for function" } };

    const response = await GET(request("Bearer test-cron-secret"));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).not.toHaveProperty("generated");
    expect(JSON.stringify(body)).not.toContain("permission denied");
    expect(console.error).toHaveBeenCalled();
  });
});

describe("middleware", () => {
  it("lets the cron route through without a session (no redirect to /login)", async () => {
    const response = await middleware(new NextRequest(URL_PATH));
    expect(response.headers.get("location")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("still redirects other unauthenticated routes to /login", async () => {
    const response = await middleware(new NextRequest("http://localhost/api/cron/other"));
    expect(response.headers.get("location")).toBe("http://localhost/login");
  });
});
