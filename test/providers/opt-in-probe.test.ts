import { describe, expect, it, vi } from "vitest";
import { parseFlags } from "../../src/args.js";
import { parseProviders } from "../../src/providers/index.js";
import {
  createMiniMaxAdapter,
  type MiniMaxCredentialResolution,
} from "../../src/providers/minimax.js";

describe("MiniMax opt-in selection", () => {
  it.each([[], ["--json"], ["--tui", "--once"]])(
    "does not select MiniMax for implicit probes %j",
    (...args: string[]) => {
      expect(parseFlags(args).providers).not.toContain("minimax");
    },
  );

  it("selects MiniMax when explicitly requested", () => {
    expect(parseFlags(["--provider", "minimax"]).providers).toEqual(["minimax"]);
    expect(parseProviders("minimax,openrouter")).toEqual(["minimax", "openrouter"]);
  });
});

describe("MiniMax probe failure preservation", () => {
  const options = { allowKeychainPrompt: false, refreshCredentials: false };
  const credentials = (): MiniMaxCredentialResolution[] =>
    ["env:MINIMAX_API_KEY", "pi:minimax", "minimax:config.json"].map(
      (source) => ({
        status: "available",
        source,
        key: `synthetic-${source}`,
        baseUrl: "https://api.minimax.io",
      }),
    );
  const failures = [
    {
      name: "server",
      response: () => new Response(null, { status: 503 }),
      error: "provider_request_rejected",
    },
    {
      name: "rate limit",
      response: () => new Response(null, { status: 429 }),
      error: "provider_rate_limited",
    },
    {
      name: "decoding",
      response: () => new Response("{"),
      error: "malformed_json",
    },
    {
      name: "network",
      response: () => {
        throw new Error("synthetic socket failure");
      },
      error: "network_unavailable",
    },
  ];

  describe.each([false, true])("earlier rejection: %s", (rejected) => {
    it.each(failures)("stops handover on $name failure", async ({ response, error }) => {
      const fetch = vi.fn(async () => response());
      if (rejected)
        fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
      const deleteCachedProvider = vi.fn();
      const report = await createMiniMaxAdapter({
        credential: credentials,
        fetch,
        readCachedProvider: () => undefined,
        deleteCachedProvider,
      }).fetchQuota(options);

      expect(fetch).toHaveBeenCalledTimes(rejected ? 2 : 1);
      expect(report.state.error).toBe(error);
      expect(report.state.status).not.toBe("auth_required");
      expect(report.attempts).toHaveLength(rejected ? 2 : 1);
      expect(deleteCachedProvider).not.toHaveBeenCalled();
    });
  });

  it.each(["before", "after"])(
    "preserves a read error %s a rejected credential",
    async (order) => {
      const unreadable: MiniMaxCredentialResolution = {
        status: "error",
        source: "unreadable",
        error: "file_read_error",
      };
      const rejected = credentials()[0]!;
      const fetch = vi.fn(async () => new Response(null, { status: 401 }));
      const deleteCachedProvider = vi.fn();
      const report = await createMiniMaxAdapter({
        credential: () =>
          order === "before"
            ? [unreadable, rejected]
            : [rejected, unreadable],
        fetch,
        readCachedProvider: () => undefined,
        deleteCachedProvider,
      }).fetchQuota(options);

      expect(fetch).toHaveBeenCalledOnce();
      expect(report.state).toMatchObject({
        status: "error",
        error: "credential_resolution_failed",
      });
      expect(report.attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "unreadable", status: "failed" }),
          expect.objectContaining({
            error: "provider_auth_rejected",
            status: "failed",
          }),
        ]),
      );
      expect(deleteCachedProvider).not.toHaveBeenCalled();
    },
  );
});
