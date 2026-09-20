import { describe, expect, it, vi } from "vitest";
import {
  createOpenRouterAdapter,
  extractOpenRouterCredential,
  normalizeOpenRouterCredits,
  normalizeOpenRouterPayload,
  OPENROUTER_CREDITS_URL,
  OPENROUTER_KEY_URL,
  resolveOpenRouterCredentials,
} from "../../src/providers/openrouter.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-openrouter-key";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

/** Serve per-URL responses so the key and credits endpoints stay distinct. */
function urlAwareFetch(
  keyResponse: () => Response,
  creditsResponse: () => Response = () => jsonResponse({}),
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL) => {
    if (String(url) === OPENROUTER_CREDITS_URL) return creditsResponse();
    return keyResponse();
  });
}

describe("OpenRouter provider", () => {
  it("reports the key spend cap and remaining balance", async () => {
    const request = urlAwareFetch(() =>
      jsonResponse({
        data: {
          label: "personal",
          limit: 100,
          limit_remaining: 73.25,
          limit_reset: "Daily",
          usage: 26.75,
          usage_daily: 5,
          usage_weekly: 15,
          usage_monthly: 26.75,
          is_free_tier: false,
        },
      }),
    );

    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "openrouter",
      source: "api",
      state: { status: "fresh", stale: false },
      credits: { remaining: 73.25, unit: "usd" },
      account: { accountId: "personal", identityStatus: "unverified" },
      attempts: [{ source: "env:OPENROUTER_API_KEY", status: "success" }],
    });
    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "key-limit",
        kind: "credits",
        spentUsd: 26.75,
        limitUsd: 100,
        percentRemaining: 73.25,
        resetText: "Daily",
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0][0])).toBe(OPENROUTER_KEY_URL);
    const init = request.mock.calls[0][1];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer " + KEY,
    );
  });

  it("tries Pi auth after an environment key is rejected", async () => {
    const request = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get("authorization");
      if (String(url) === OPENROUTER_CREDITS_URL)
        return jsonResponse({ data: { total_credits: 50, total_usage: 10 } });
      if (bearer === "Bearer stale-env-key")
        return new Response(null, { status: 403 });
      return jsonResponse({ data: { limit: 100, limit_remaining: 40 } });
    });

    const report = await createOpenRouterAdapter({
      credential: () => [
        {
          status: "available",
          key: "stale-env-key",
          source: "env:OPENROUTER_API_KEY",
        },
        { status: "available", key: KEY, source: "pi:openrouter" },
      ],
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: {
        status: "fresh",
        sourcesTried: ["env:OPENROUTER_API_KEY", "pi:openrouter"],
      },
      attempts: [
        {
          source: "env:OPENROUTER_API_KEY",
          status: "failed",
          error: "provider_auth_rejected",
        },
        { source: "pi:openrouter", status: "success" },
      ],
      credits: { remaining: 40, unit: "usd" },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reports the purchased-credit balance when the key has no spend cap", async () => {
    const request = urlAwareFetch(
      () =>
        jsonResponse({
          data: {
            limit: null,
            limit_remaining: null,
            usage: 10,
            usage_daily: 10,
            usage_weekly: 10,
            usage_monthly: 10,
            is_free_tier: true,
          },
        }),
      () => jsonResponse({ data: { total_credits: 300, total_usage: 181.5 } }),
    );

    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: { status: "fresh", stale: false },
      windows: [],
      credits: { remaining: 118.5, unit: "usd" },
    });
    expect(JSON.stringify(report)).not.toContain("unlimited");
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1][0])).toBe(OPENROUTER_CREDITS_URL);
    expect(
      new Headers(request.mock.calls[1][1]?.headers).get("authorization"),
    ).toBe("Bearer " + KEY);
  });

  it("never claims unlimited when a capless key's balance is unreadable", async () => {
    const request = urlAwareFetch(
      () =>
        jsonResponse({
          data: {
            limit: null,
            limit_remaining: null,
            usage: 10,
          },
        }),
      () => new Response(null, { status: 404 }),
    );

    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: { status: "fresh", stale: false },
      windows: [],
    });
    expect(report.credits).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("unlimited");
  });

  it("accepts the documented credits field spellings and clamps overage", () => {
    expect(
      normalizeOpenRouterCredits({
        data: { total_credits_purchased: 25, total_credits_used: 10 },
      }),
    ).toEqual({ purchased: 25, used: 10 });
    expect(() =>
      normalizeOpenRouterCredits({ data: { unrelated: true } }),
    ).toThrow("invalid_payload");
  });

  it.each([9.996, 9.994])(
    "preserves sub-cent credit balances with usage %s",
    async (usage) => {
      const request = urlAwareFetch(
        () => jsonResponse({ data: { limit: null } }),
        () => jsonResponse({ data: { total_credits: 10, total_usage: usage } }),
      );

      const report = await createOpenRouterAdapter({
        credential: () => ({
          status: "available",
          key: KEY,
          source: "env:OPENROUTER_API_KEY",
        }),
        fetch: request,
      }).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("fresh");
      expect(report.credits).toEqual({ remaining: 10 - usage, unit: "usd" });
      expect(report.credits?.remaining).toBeGreaterThan(0);
      expect(report.credits?.remaining).toBeLessThan(0.01);
    },
  );

  it("clamps a negative credit balance to zero", async () => {
    const request = urlAwareFetch(
      () => jsonResponse({ data: { limit: null } }),
      () => jsonResponse({ data: { total_credits: 10, total_usage: 12 } }),
    );

    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report.credits).toEqual({ remaining: 0, unit: "usd" });
  });

  it("omits credits when a finite cap lacks remaining balance", async () => {
    const request = urlAwareFetch(() =>
      jsonResponse({ data: { limit: 100, usage: 10 } }),
    );

    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.windows).toEqual([]);
    expect(report.credits).toBeUndefined();
  });

  it("reports an over-cap key as spent with a negative remaining balance", async () => {
    const request = urlAwareFetch(() =>
      jsonResponse({ data: { limit: 100, limit_remaining: -5 } }),
    );

    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "key-limit",
        limitUsd: 100,
        spentUsd: 105,
        percentRemaining: 0,
      }),
    ]);
    expect(report.credits).toEqual({ remaining: -5, unit: "usd" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports a zero finite cap as fully spent", async () => {
    const request = urlAwareFetch(() =>
      jsonResponse({ data: { limit: 0, limit_remaining: 0 } }),
    );

    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "key-limit",
        limitUsd: 0,
        spentUsd: 0,
        percentRemaining: 0,
      }),
    ]);
    expect(report.credits).toEqual({ remaining: 0, unit: "usd" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid payload", () => {
    expect(() => normalizeOpenRouterPayload({ error: "test" })).toThrow(
      "missing_data",
    );
    expect(() => normalizeOpenRouterPayload({ data: { usage: 10 } })).toThrow(
      "invalid_limit",
    );
  });

  it("reports unusable local credentials as auth_required", async () => {
    const request = vi.fn();
    const deleteCachedProvider = vi.fn();
    const missing = await createOpenRouterAdapter({
      credential: () => ({ status: "missing", source: "pi:openrouter" }),
      fetch: request,
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);
    const invalid = await createOpenRouterAdapter({
      credential: () => ({ status: "invalid", source: "pi:openrouter" }),
      fetch: request,
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);
    expect(missing).toMatchObject({
      provider: "openrouter",
      source: "unavailable",
      state: {
        status: "auth_required",
        error: "openrouter_credential_unavailable",
      },
    });
    expect(invalid).toMatchObject({
      provider: "openrouter",
      source: "unavailable",
      state: {
        status: "auth_required",
        error: "openrouter_credential_invalid",
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(deleteCachedProvider).toHaveBeenCalledWith("openrouter");
  });

  it("enumerates the environment source even when unset", () => {
    expect(resolveOpenRouterCredentials({}, "/missing/auth.json")).toEqual([
      { status: "missing", source: "env:OPENROUTER_API_KEY" },
      {
        status: "missing",
        source: "pi:openrouter",
        path: "/missing/auth.json",
      },
    ]);
  });

  it("extracts a Pi auth.json openrouter entry", () => {
    expect(
      extractOpenRouterCredential(
        { openrouter: { apiKey: KEY } },
        "/auth.json",
      ),
    ).toEqual({
      status: "available",
      key: KEY,
      source: "pi:openrouter",
      path: "/auth.json",
    });
  });

  it("rejects template and scalar Pi auth entries as invalid", () => {
    expect(
      extractOpenRouterCredential(
        { openrouter: { apiKey: "${OPENROUTER_API_KEY}" } },
        "/auth.json",
      ),
    ).toEqual({
      status: "invalid",
      source: "pi:openrouter",
      path: "/auth.json",
    });
    expect(
      extractOpenRouterCredential({ openrouter: KEY }, "/auth.json"),
    ).toEqual({
      status: "invalid",
      source: "pi:openrouter",
      path: "/auth.json",
    });
  });

  it("reports 429 as rate_limited with the Retry-After hint", async () => {
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    }).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      source: "unavailable",
      state: { status: "rate_limited", error: "provider_rate_limited" },
    });
    expect(report.state.retryAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects a response body larger than the bounded limit", async () => {
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: async () =>
        new Response("{}", {
          headers: { "content-length": "999999999" },
        }),
    }).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      source: "unavailable",
      state: { status: "error", error: "response_too_large" },
    });
  });
});
