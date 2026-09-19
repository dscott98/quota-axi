import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFetch } from "../../src/lib/http.js";
import {
  createMinimaxAdapter,
  extractMinimaxCredential,
} from "../../src/providers/minimax.js";
import {
  createOpenRouterAdapter,
  extractOpenRouterCredential,
} from "../../src/providers/openrouter.js";

vi.mock("../../src/lib/http.js", () => ({ providerFetch: vi.fn() }));

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "quota-opt-in-probe-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe.each([
  {
    provider: "minimax",
    create: createMinimaxAdapter,
    extract: extractMinimaxCredential,
  },
  {
    provider: "openrouter",
    create: createOpenRouterAdapter,
    extract: extractOpenRouterCredential,
  },
])("$provider probe contracts", ({ provider, create, extract }) => {
  function sources() {
    return ["primary", "secondary"].map((name) => {
      const path = join(directory, `${name}.json`);
      writeFileSync(
        path,
        JSON.stringify({ [provider]: { key: `synthetic-${name}` } }),
      );
      return { name, path: () => path, extract };
    });
  }

  const failures = [
    {
      name: "server",
      response: () => new Response("", { status: 503 }),
      error: "provider_request_rejected",
    },
    {
      name: "rate limit",
      response: () => new Response("", { status: 429 }),
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

  it.each(failures)(
    "stops handover after $name failure",
    async ({ response, error }) => {
      const fetch = vi.fn(async () => response());
      const report = await create({
        envApiKey: () => "synthetic-env",
        credentialSources: sources(),
        fetch,
      }).fetchQuota(OPTIONS);
      expect(fetch).toHaveBeenCalledOnce();
      expect(report.state.error).toBe(error);
      expect(report.state.status).not.toBe("auth_required");
      expect(report.attempts).toHaveLength(1);
    },
  );

  it.each(failures)(
    "preserves $name failure over an earlier rejection",
    async ({ response, error }) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 401 }))
        .mockImplementationOnce(async () => response())
        .mockResolvedValue(new Response("{}"));
      const report = await create({
        envApiKey: () => "synthetic-env",
        credentialSources: sources(),
        fetch,
      }).fetchQuota(OPTIONS);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(report.state.error).toBe(error);
      expect(report.state.status).not.toBe("auth_required");
      expect(report.attempts).toHaveLength(2);
    },
  );

  it("hands over after rejection and stops at usable auth without windows", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValue(new Response("{}"));
    const report = await create({
      envApiKey: () => "synthetic-env",
      credentialSources: sources(),
      fetch,
    }).fetchQuota(OPTIONS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(report.state.authStatus).toBe("usable");
    expect(report.windows).toEqual([]);
    expect(report.attempts).toMatchObject([
      { status: "failed" },
      { source: "primary", status: "success" },
    ]);
  });

  it("uses the shared transport by default", async () => {
    vi.mocked(providerFetch).mockResolvedValue(new Response("{}"));
    const report = await create({
      envApiKey: () => "synthetic-env",
      credentialSources: [],
    }).fetchQuota(OPTIONS);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(report.state.authStatus).toBe("usable");
  });

  it("caps streamed decoded bytes and cancels before reading the remainder", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const chunk = new TextEncoder().encode("é".repeat(65_537));
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(chunk);
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const report = await create({
      envApiKey: () => "synthetic-env",
      credentialSources: [],
      fetch: vi.fn(async () => new Response(body)),
    }).fetchQuota(OPTIONS);
    expect(report.state.error).toBe("response_too_large");
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([262_144, 262_145])(
    "enforces a %i-byte JSON response at the exact boundary",
    async (size) => {
      const payload = '{"label":"' + "x".repeat(size - 12) + '"}';
      expect(new TextEncoder().encode(payload).byteLength).toBe(size);
      const report = await create({
        envApiKey: () => "synthetic-env",
        credentialSources: [],
        fetch: vi.fn(async () => new Response(payload)),
      }).fetchQuota(OPTIONS);
      if (size === 262_144) expect(report.state.authStatus).toBe("usable");
      else expect(report.state.error).toBe("response_too_large");
    },
  );
});
