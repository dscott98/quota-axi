import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMinimaxAdapter,
  defaultMinimaxCredentialSources,
  extractMinimaxCredential,
  opencodeAuthFilePath,
  minimaxConfigPath,
} from "../../src/providers/minimax.js";

import { computeWindowPace } from "../../src/pace.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-minimax-key-42";
const CODING_PLAN_REMAINS = JSON.parse(
  readFileSync("test/fixtures/minimax/coding-plan-remains.json", "utf8"),
) as unknown;

const ENV_KEYS = [
  "XDG_DATA_HOME",
  "LOCALAPPDATA",
  "PI_CODING_AGENT_DIR",
  "MINIMAX_API_KEY",
  "MINIMAX_BASE_URL",
  "MMX_CONFIG_DIR",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-minimax-"));
  process.env.XDG_DATA_HOME = join(tempDir, "data");
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi-agent");
  process.env.MMX_CONFIG_DIR = join(tempDir, "mmx");
  delete process.env.MINIMAX_BASE_URL;
  delete process.env.MINIMAX_API_KEY;
  if (process.platform === "win32")
    process.env.LOCALAPPDATA = join(tempDir, "local");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
  vi.useRealTimers();
});

function writePiStore(value: unknown): void {
  const dir = process.env.PI_CODING_AGENT_DIR!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify(value), { mode: 0o600 });
}

function writeOpencodeAuth(value: unknown): void {
  mkdirSync(join(process.env.XDG_DATA_HOME!, "opencode"), {
    recursive: true,
  });
  writeFileSync(opencodeAuthFilePath(), JSON.stringify(value), { mode: 0o600 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MiniMax provider", () => {
  it.each([
    [{ api_key: KEY }, "https://api.minimax.io/v1/token_plan/remains"],
    [
      { api_key: KEY, region: "cn" },
      "https://api.minimaxi.com/v1/token_plan/remains",
    ],
    [
      { api_key: KEY, base_url: "https://api.minimaxi.com" },
      "https://api.minimaxi.com/v1/token_plan/remains",
    ],
    [
      {
        oauth: { access_token: KEY, resource_url: "https://api.minimaxi.com" },
      },
      "https://api.minimaxi.com/v1/token_plan/remains",
    ],
  ])(
    "reads native CLI credentials with their deployment: %j",
    async (config, url) => {
      mkdirSync(process.env.MMX_CONFIG_DIR!, { recursive: true });
      writeFileSync(minimaxConfigPath(), JSON.stringify(config));
      const request = vi.fn(async () => jsonResponse(CODING_PLAN_REMAINS));
      const adapter = createMinimaxAdapter({ fetch: request });
      const report = await adapter.fetchQuota(OPTIONS);
      expect(request).toHaveBeenCalledOnce();
      expect(String(request.mock.calls[0]?.[0])).toBe(url);
      expect(
        new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization"),
      ).toBe(`Bearer ${KEY}`);
      expect(report.windows).toHaveLength(2);
      expect((await adapter.inspectAuth(OPTIONS)).sources).toContainEqual({
        source: "minimax:config.json",
        path: minimaxConfigPath(),
        status: "available",
      });
      expect(JSON.stringify(report)).not.toContain(KEY);
    },
  );

  it.each([
    ["https://api.minimax.io", "usd"],
    ["https://api.minimaxi.com", "cny"],
  ])("reads pay-as-you-go balances from %s", async (base, unit) => {
    process.env.MINIMAX_BASE_URL = base;
    const request = vi.fn(async () =>
      jsonResponse({ data: { available_amount: "12.34" } }),
    );
    const report = await createMinimaxAdapter({
      envApiKey: () => "sk-api-synthetic",
      credentialSources: [],
      fetch: request,
    }).fetchQuota(OPTIONS);
    expect(String(request.mock.calls[0]?.[0])).toBe(
      `${base}/account/query_balance`,
    );
    expect(report.credits).toEqual({ remaining: 12.34, unit });
    expect(report.windows).toEqual([]);
  });

  it("uses the China quota endpoint selected by the environment", async () => {
    process.env.MINIMAX_BASE_URL = "https://api.minimaxi.com";
    const request = vi.fn(async () => jsonResponse(CODING_PLAN_REMAINS));
    await createMinimaxAdapter({
      envApiKey: () => KEY,
      credentialSources: [],
      fetch: request,
    }).fetchQuota(OPTIONS);
    expect(String(request.mock.calls[0]?.[0])).toBe(
      "https://api.minimaxi.com/v1/token_plan/remains",
    );
  });

  it("retains supplied cycle starts for per-window pace", async () => {
    const payload = JSON.parse(
      readFileSync("test/fixtures/minimax/quota.json", "utf8"),
    );
    const report = await createMinimaxAdapter({
      envApiKey: () => KEY,
      credentialSources: [],
      fetch: async () => jsonResponse(payload),
    }).fetchQuota(OPTIONS);
    expect(report.windows).toHaveLength(4);
    for (const window of report.windows) {
      expect(window.startsAt).toBe(
        new Date(
          window.kind === "weekly" ? 1787688000000 : 1788264000000,
        ).toISOString(),
      );
      const pace = computeWindowPace(
        window,
        new Date(1788273000000).toISOString(),
      );
      expect(pace.reason).not.toBe("missing_cycle");
      expect(pace.cycleSeconds).toBe(window.kind === "weekly" ? 604800 : 18000);
    }
  });

  it.each(["invalid", "2026-09-01T15:00:00Z"])(
    "omits invalid or reversed cycle start %s",
    async (start) => {
      const report = await createMinimaxAdapter({
        envApiKey: () => KEY,
        credentialSources: [],
        fetch: async () =>
          jsonResponse({
            model_remains: [
              {
                model_name: "general",
                current_interval_remaining_percent: 50,
                start_time: start,
                end_time: "2026-09-01T14:00:00Z",
              },
            ],
          }),
      }).fetchQuota(OPTIONS);
      expect(report.windows[0]?.startsAt).toBeUndefined();
      expect(report.windows[0]?.percentRemaining).toBe(50);
    },
  );

  it("extracts a literal key under the canonical provider ids", () => {
    expect(
      extractMinimaxCredential(
        { minimax: { type: "api", key: KEY } },
        "/auth.json",
      ),
    ).toEqual({ status: "available", apiKeys: [KEY], path: "/auth.json" });
    expect(
      extractMinimaxCredential(
        { "minimax-coding-plan": { type: "api", key: KEY } },
        "/auth.json",
      ),
    ).toEqual({ status: "available", apiKeys: [KEY], path: "/auth.json" });
  });

  it.each([
    ["opencode", "MiniMax"],
    ["pi", "MiniMax"],
    ["pi", "minimax-coding-plan"],
  ])("ignores unsupported %s credential id %s", async (store, id) => {
    writeOpencodeAuth(
      store === "opencode" ? { [id]: { type: "api", key: KEY } } : {},
    );
    writePiStore(store === "pi" ? { [id]: { type: "api_key", key: KEY } } : {});
    const request = vi.fn(async () => jsonResponse({}));
    const adapter = createMinimaxAdapter({ fetch: request });
    const report = await adapter.fetchQuota(OPTIONS);
    expect(request).not.toHaveBeenCalled();
    expect(report.state.status).toBe("auth_required");
    const auth = await adapter.inspectAuth(OPTIONS);
    expect(auth.sources.every((source) => source.status === "missing")).toBe(
      true,
    );
  });

  it.each([
    [200, ["first"], "fresh"],
    [401, ["first", "second"], "fresh"],
    [403, ["first", "second"], "fresh"],
    [429, ["first"], "rate_limited"],
    [503, ["first"], "error"],
  ] as const)(
    "selects OpenCode candidates after HTTP %i",
    async (status, expected, verdict) => {
      writeOpencodeAuth({
        "minimax-coding-plan": { type: "api", key: "second" },
        minimax: { type: "api", key: "first" },
      });
      writePiStore({ minimax: { type: "api_key", key: "pi-key" } });
      const bearers: string[] = [];
      const report = await createMinimaxAdapter({
        fetch: async (_input, init) => {
          const key = new Headers(init?.headers).get("authorization")!.slice(7);
          bearers.push(key);
          return jsonResponse(
            CODING_PLAN_REMAINS,
            key === "first" ? status : 200,
          );
        },
      }).fetchQuota(OPTIONS);
      expect(bearers).toEqual(expected);
      expect(report.state.status).toBe(verdict);
      expect(report.attempts?.map((attempt) => attempt.status)).toEqual(
        expected.map((_, index) =>
          index === 0 && status !== 200 ? "failed" : "success",
        ),
      );
      if (verdict === "fresh") expect(report.windows).toHaveLength(2);
    },
  );

  it("tries Pi only after both OpenCode candidates are rejected", async () => {
    writeOpencodeAuth({
      minimax: { type: "api", key: "first" },
      "minimax-coding-plan": { type: "api", key: "second" },
    });
    writePiStore({ minimax: { type: "api_key", key: "pi-key" } });
    const bearers: string[] = [];
    const report = await createMinimaxAdapter({
      fetch: async (_input, init) => {
        const key = new Headers(init?.headers).get("authorization")!.slice(7);
        bearers.push(key);
        return jsonResponse(CODING_PLAN_REMAINS, key === "pi-key" ? 200 : 401);
      },
    }).fetchQuota(OPTIONS);
    expect(bearers).toEqual(["first", "second", "pi-key"]);
    expect(report.state.status).toBe("fresh");
    expect(report.windows).toHaveLength(2);
  });

  it.each([
    KEY,
    { key: KEY },
    { type: "oauth", key: KEY, access: KEY },
    ...["apiKey", "api_key", "token", "accessToken", "auth_token"].map(
      (field) => ({ type: "api", [field]: KEY }),
    ),
  ])("rejects non-native OpenCode credential records: %j", async (entry) => {
    writeOpencodeAuth({ minimax: entry });
    writePiStore({});
    const request = vi.fn(async () => jsonResponse({}));
    const report = await createMinimaxAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );
    expect(request).not.toHaveBeenCalled();
    expect(report.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "opencode:auth.json",
          credentialPresent: true,
        }),
      ]),
    );
  });

  it("rejects environment, template, and command-referenced keys", () => {
    for (const unsafe of ["$MINIMAX_API_KEY", "!command", "\u0000"]) {
      expect(
        extractMinimaxCredential(
          { minimax: { type: "api", key: unsafe } },
          "/auth.json",
        ).status,
      ).not.toBe("available");
    }
  });

  it("falls through to the Pi source when opencode has no entry", async () => {
    writeOpencodeAuth({ "some-other": { type: "api", key: KEY } });
    writePiStore({ minimax: { type: "api_key", key: KEY } });

    const request = vi.fn(async () =>
      jsonResponse({ data: { id: "MiniMax/M2" } }),
    );
    const report = await createMinimaxAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );

    expect(String(request.mock.calls[0]?.[0])).toBe(
      "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
    );
    expect(
      new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(`Bearer ${KEY}`);
    expect(report).toMatchObject({
      provider: "minimax",
      source: "api",
      windows: [],
      state: { status: "fresh", stale: false, authStatus: "usable" },
    });
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it("reads time-metered Coding Plan windows from the canonical remains endpoint", async () => {
    process.env.MINIMAX_API_KEY = KEY;
    const request = vi.fn(async () => jsonResponse(CODING_PLAN_REMAINS));

    const report = await createMinimaxAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );

    expect(String(request.mock.calls[0]?.[0])).toBe(
      "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
    );
    expect(report).toMatchObject({
      windows: [
        {
          id: "model:general:interval",
          kind: "session",
          percentUsed: 27,
          percentRemaining: 73,
          resetsAt: "2025-10-09T09:00:00.000Z",
          resetText: "59m remaining",
        },
        {
          id: "model:general:weekly",
          kind: "weekly",
          percentUsed: 3,
          percentRemaining: 97,
          resetsAt: "2025-10-14T00:00:00.000Z",
          resetText: "1d 20h remaining",
        },
      ],
      state: { status: "fresh", authStatus: "usable" },
    });
  });

  it.each(["label", "name", "username"])(
    "does not interpret account %s as a plan",
    async (field) => {
      const report = await createMinimaxAdapter({
        envApiKey: () => KEY,
        credentialSources: [],
        fetch: async () =>
          jsonResponse({
            data: {
              [field]: "synthetic-account-name",
              model_remains: [
                {
                  model_name: "general",
                  current_interval_total_count: 100,
                  current_interval_usage_count: 75,
                },
              ],
            },
          }),
      }).fetchQuota(OPTIONS);
      expect(report.plan).toBeUndefined();
      expect(JSON.stringify(report)).not.toContain("synthetic-account-name");
      expect(report.windows).toMatchObject([
        {
          id: "model:general:interval",
          percentUsed: 25,
          percentRemaining: 75,
        },
      ]);
    },
  );

  it("retains seconds-epoch current_interval_end_time as an end_time alias", async () => {
    process.env.MINIMAX_API_KEY = KEY;
    const report = await createMinimaxAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({
          model_remains: [
            {
              model_name: "general",
              current_interval_remaining_percent: 50,
              current_interval_end_time: 1760000400,
            },
          ],
        }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.windows).toMatchObject([
      {
        id: "model:general:interval",
        percentUsed: 50,
        percentRemaining: 50,
        resetsAt: "2025-10-09T09:00:00.000Z",
      },
    ]);
  });

  it("supports count-metered Coding Plans when vendor percentages are absent", async () => {
    process.env.MINIMAX_API_KEY = KEY;
    const report = await createMinimaxAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({
          model_remains: [
            {
              model_name: "general",
              current_interval_total_count: 100,
              current_interval_usage_count: 25,
              current_weekly_total_count: 200,
              current_weekly_usage_count: 50,
            },
          ],
        }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.windows).toMatchObject([
      {
        id: "model:general:interval",
        percentUsed: 75,
        percentRemaining: 25,
      },
      {
        id: "model:general:weekly",
        percentUsed: 75,
        percentRemaining: 25,
      },
    ]);
  });

  it.each([0, 1444, 1500])(
    "reports %i remaining requests for both count-metered periods",
    async (remaining) => {
      const report = await createMinimaxAdapter({
        envApiKey: () => KEY,
        credentialSources: [],
        fetch: async () =>
          jsonResponse({
            model_remains: [
              {
                model_name: "general",
                current_interval_total_count: 1500,
                current_interval_usage_count: remaining,
                current_weekly_total_count: 1500,
                current_weekly_usage_count: remaining,
              },
            ],
          }),
      }).fetchQuota(OPTIONS);
      expect(report.windows).toHaveLength(2);
      for (const window of report.windows) {
        expect(window.percentRemaining).toBeCloseTo((remaining / 1500) * 100);
        expect(window.percentUsed).toBeCloseTo(
          ((1500 - remaining) / 1500) * 100,
        );
      }
    },
  );

  it("rejects vendor-encoded authentication failures and untrusted raw counters", async () => {
    process.env.MINIMAX_API_KEY = KEY;
    const rejected = await createMinimaxAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({
          base_resp: { status_code: 1004, status_msg: "cookie is missing" },
        }),
      ),
    }).fetchQuota(OPTIONS);
    expect(rejected.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });

    const transport = await createMinimaxAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({ base_resp: { status_code: 2001 } }),
      ),
    }).fetchQuota(OPTIONS);
    expect(transport.state).toMatchObject({
      status: "error",
      error: "provider_request_rejected",
    });

    const report = await createMinimaxAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({
          model_remains: [
            {
              model_name: "general",
              current_interval_total_count: 100,
              current_interval_usage_count: 150,
              current_interval_remain_count: 0,
            },
            {
              model_name: "video",
              current_interval_total_count: 100,
              current_interval_usage_count: 50,
              current_interval_remain_count: 40,
              current_weekly_total_count: 100,
              current_weekly_usage_count: 0,
              current_weekly_remain_count: 101,
            },
          ],
        }),
      ),
    }).fetchQuota(OPTIONS);
    expect(report.windows).toEqual([]);
    expect(report.state.untrustedWindowIds).toEqual([
      "model:general:interval",
      "model:video:interval",
      "model:video:weekly",
    ]);
  });

  it.each([
    { current_interval_usage_count: 1000 },
    { current_interval_remain_count: 1000 },
    { current_interval_usage_count: 1000, current_interval_remain_count: 1000 },
  ])(
    "accepts consistent fractional count percentages: %j",
    async (counters) => {
      const report = await createMinimaxAdapter({
        envApiKey: () => KEY,
        credentialSources: [],
        fetch: async () =>
          jsonResponse({
            model_remains: [
              {
                model_name: "general",
                current_interval_total_count: 1500,
                ...counters,
              },
            ],
          }),
      }).fetchQuota(OPTIONS);
      expect(report.windows).toHaveLength(1);
      expect(report.windows[0]?.percentUsed).toBeCloseTo(100 / 3);
      expect(report.windows[0]?.percentRemaining).toBeCloseTo(200 / 3);
      expect(report.state.untrustedWindowIds).toBeUndefined();
    },
  );

  it.each([
    { current_interval_usage_count: 150 },
    { current_interval_remain_count: 101 },
    { current_interval_usage_count: 50, current_interval_remain_count: 40 },
  ])(
    "rejects inconsistent counters even with vendor percentages: %j",
    async (counters) => {
      const report = await createMinimaxAdapter({
        envApiKey: () => KEY,
        credentialSources: [],
        fetch: async () =>
          jsonResponse({
            model_remains: [
              {
                model_name: "general",
                current_interval_total_count: 100,
                current_interval_remaining_percent: 50,
                ...counters,
              },
            ],
          }),
      }).fetchQuota(OPTIONS);
      expect(report.windows).toEqual([]);
      expect(report.state.untrustedWindowIds).toEqual([
        "model:general:interval",
      ]);
    },
  );

  it("recognizes the canonical opencode Coding Plan credential id", async () => {
    writeOpencodeAuth({ "minimax-coding-plan": { type: "api", key: KEY } });
    const request = vi.fn(async () => jsonResponse({ model_remains: [] }));

    await createMinimaxAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledOnce();
  });

  it("honours MINIMAX_API_KEY ahead of the configured stores", async () => {
    process.env.MINIMAX_API_KEY = KEY;
    writePiStore({ minimax: { type: "api_key", key: "pi-store-key" } });
    writeOpencodeAuth({ minimax: { type: "api", key: "opencode-key" } });

    const request = vi.fn(async () => jsonResponse({ data: {} }));
    await createMinimaxAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(
      new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(`Bearer ${KEY}`);
  });

  it("marks a structurally invalid Pi entry as credentialPresent", async () => {
    writeOpencodeAuth({ "some-other": { type: "api", key: KEY } });
    writePiStore({ minimax: { type: "api_key", key: "$REFERENCE" } });

    const request = vi.fn(async () => jsonResponse({ data: {} }));
    const report = await createMinimaxAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );

    const attempt = (report.attempts ?? []).find(
      (item) => item.source === "pi:minimax",
    );
    expect(attempt?.credentialPresent).toBe(true);
    expect(report.state.status).toBe("auth_required");
  });

  it("marks a present-but-invalid opencode entry as credentialPresent", async () => {
    writeOpencodeAuth({ minimax: { type: "api", key: "!command" } });
    writePiStore({});

    const request = vi.fn(async () => jsonResponse({ data: {} }));
    const report = await createMinimaxAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );

    const attempt = (report.attempts ?? []).find(
      (item) => item.source === "opencode:auth.json",
    );
    expect(attempt?.credentialPresent).toBe(true);
  });

  it("rejects Pi OAuth without probing its access token", async () => {
    writeOpencodeAuth({});
    writePiStore({ minimax: { type: "oauth", access: KEY } });
    const request = vi.fn(async () => jsonResponse({}));
    const report = await createMinimaxAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );
    expect(request).not.toHaveBeenCalled();
    expect(report.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "pi:minimax",
          credentialPresent: true,
          error: "minimax_credential_invalid: unsupported_entry_type",
        }),
      ]),
    );
  });

  it("reports auth_required on a 401, error on a malformed body, never ok on transport failures", async () => {
    writeOpencodeAuth({ minimax: { type: "api", key: KEY } });

    const rejected = await createMinimaxAdapter({
      fetch: vi.fn(async () => new Response("nope", { status: 401 })),
    }).fetchQuota(OPTIONS);
    expect(rejected.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });

    const malformed = await createMinimaxAdapter({
      fetch: vi.fn(async () => jsonResponse({ unexpected: true })),
    }).fetchQuota(OPTIONS);
    expect(malformed.state.status).toBe("fresh");
    expect(malformed.state.authStatus).toBe("usable");

    const transportError = await createMinimaxAdapter({
      fetch: vi.fn(async () => {
        throw new Error("socket hangup");
      }),
    }).fetchQuota(OPTIONS);
    expect(transportError.state.status).toBe("error");
    expect(transportError.state.error).toBe("network_unavailable");
    expect(JSON.stringify(transportError)).not.toContain(KEY);
  });

  it("treats every empty credential store as missing, not as degraded", async () => {
    writeOpencodeAuth({});
    writePiStore({});

    const request = vi.fn(async () => jsonResponse({ data: {} }));
    const report = await createMinimaxAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );

    expect(report.state.status).toBe("auth_required");
    for (const attempt of report.attempts ?? []) {
      expect(attempt.credentialPresent).toBeUndefined();
    }
  });

  it("inspects every configured source for the auth command", async () => {
    writeOpencodeAuth({ minimax: { type: "api", key: KEY } });
    writePiStore({ "some-other": { type: "api", key: KEY } });

    const report = await createMinimaxAdapter().inspectAuth(OPTIONS);

    expect(report.sources.map((source) => source.source)).toEqual([
      "MINIMAX_API_KEY",
      "opencode:auth.json",
      "pi:minimax",
      "minimax:config.json",
    ]);
    const opencodeSource = report.sources.find(
      (source) => source.source === "opencode:auth.json",
    );
    expect(opencodeSource?.status).toBe("available");
    const piSource = report.sources.find(
      (source) => source.source === "pi:minimax",
    );
    expect(piSource?.status).toBe("missing");
  });

  it("respects a custom credential source list, keeping its order", () => {
    expect(
      defaultMinimaxCredentialSources().map((source) => source.name),
    ).toEqual(["opencode:auth.json", "pi:minimax", "minimax:config.json"]);
  });

  it("never logs the bearer, even when the upstream returns an error that mentions it", async () => {
    process.env.MINIMAX_API_KEY = KEY;
    const fetchMock = vi.fn(async () => {
      throw new Error(`upstream saw ${KEY}`);
    });
    const report = await createMinimaxAdapter({ fetch: fetchMock }).fetchQuota(
      OPTIONS,
    );
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(report.state.error).not.toContain(KEY);
  });

  it("treats whitespace, template, and command references in MINIMAX_API_KEY as absent", async () => {
    writeOpencodeAuth({ minimax: { type: "api", key: KEY } });
    const request = vi.fn(async () =>
      jsonResponse({ data: { model_remains: [] } }),
    );
    for (const unsafe of ["  ", "\t", "$MINIMAX_API_KEY", "!cmd"]) {
      const report = await createMinimaxAdapter({
        envApiKey: () => unsafe,
        fetch: request,
      }).fetchQuota(OPTIONS);
      // The env source is skipped as absent and credential handover reaches
      // the configured opencode store, which succeeds.
      expect(request).toHaveBeenCalled();
      const envAttempt = (report.attempts ?? []).find(
        (attempt) => attempt.source === "MINIMAX_API_KEY",
      );
      expect(envAttempt).toBeUndefined();
      const opencodeAttempt = (report.attempts ?? []).find(
        (attempt) => attempt.source === "opencode:auth.json",
      );
      expect(opencodeAttempt?.status).toBe("success");
    }
  });

  it("reflects a non-usable MINIMAX_API_KEY as missing in the auth command", async () => {
    writeOpencodeAuth({ minimax: { type: "api", key: KEY } });
    for (const unsafe of ["  ", "$MINIMAX_API_KEY", "!cmd"]) {
      const report = await createMinimaxAdapter({
        envApiKey: () => unsafe,
      }).inspectAuth(OPTIONS);
      const envSource = report.sources.find(
        (source) => source.source === "MINIMAX_API_KEY",
      );
      expect(envSource?.status).toBe("missing");
    }
  });
});
