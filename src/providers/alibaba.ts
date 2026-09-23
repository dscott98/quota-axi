import * as processUtils from "../lib/process.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  statusFromError,
  successProvider,
} from "./common.js";

const BL_COMMAND = "bl";
const BL_SOURCE = "bl-cli";
const BL_ARGS = ["usage", "token-plan", "--output", "json"];
const BL_TIMEOUT_MS = 15_000;
const LABEL = "Alibaba Coding Plan";
/**
 * `bl` exits non-zero with a structured JSON error body on stderr. The
 * observed session failure is code 3 ("Console session is not logged in or
 * has expired.") whose own hint names this remedy; quota-axi classifies it as a
 * sign-in need instead of an opaque command failure, and stays read-only.
 */
const BL_ERROR_SESSION_EXPIRED = "bl_console_session_expired";
export const BL_CONSOLE_LOGIN_REMEDY = "bl auth login --console";

type AlibabaDependencies = {
  findCommandPath: typeof processUtils.findCommandPath;
  execFileText: typeof processUtils.execFileText;
  now: () => number;
};

export type NormalizedAlibabaUsage = {
  plan?: string;
  windows: QuotaWindow[];
};

export function createAlibabaAdapter(
  overrides: Partial<AlibabaDependencies> = {},
): ProviderAdapter {
  const dependencies: AlibabaDependencies = {
    findCommandPath: (...args) => processUtils.findCommandPath(...args),
    execFileText: (...args) => processUtils.execFileText(...args),
    now: Date.now,
    ...overrides,
  };

  return {
    id: "alibaba",
    label: LABEL,
    fetchQuota: (_options: ProviderOptions) =>
      fetchQuotaWithDependencies(dependencies),
    inspectAuth: (_options: ProviderOptions) =>
      inspectAuthWithDependencies(dependencies),
  };
}

export const alibabaAdapter = createAlibabaAdapter();

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  return fetchQuotaWithDependencies({
    findCommandPath: (...args) => processUtils.findCommandPath(...args),
    execFileText: (...args) => processUtils.execFileText(...args),
    now: Date.now,
  });
}

async function fetchQuotaWithDependencies(
  dependencies: AlibabaDependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [{ source: BL_SOURCE, status: "failed" }];

  try {
    const commandPath = await dependencies.findCommandPath(BL_COMMAND);
    if (!commandPath) {
      attempts[0] = {
        source: BL_SOURCE,
        status: "skipped",
        error: "bl_cli_unavailable",
      };
      throw new Error("bl_cli_unavailable");
    }

    const output = await dependencies.execFileText(
      commandPath,
      BL_ARGS,
      BL_TIMEOUT_MS,
    );
    const raw = JSON.parse(output);
    // An authenticated `bl` that answers with a bare empty object is the
    // vendor serving no usage data for a live session - the same established
    // empty reading Kimi's `/usages` produces - not a malformed payload, so it
    // reports a usable provider with no windows rather than an error that
    // would read as the subscription being gone.
    if (isEstablishedEmptyAlibabaUsage(raw)) {
      attempts[0] = { source: BL_SOURCE, status: "success" };
      return noQuotaReport(attempts, dependencies);
    }
    if (!isAlibabaUsagePayload(raw)) throw new Error("bl_usage_malformed_json");
    const normalized = normalizeAlibabaUsage(raw);

    attempts[0] = { source: BL_SOURCE, status: "success" };
    return successProvider({
      provider: "alibaba",
      label: LABEL,
      source: "cli",
      plan: normalized.plan,
      windows: normalized.windows,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const failure = classifyBlFailure(error);
    if (attempts[0]?.status !== "skipped")
      attempts[0] = {
        source: BL_SOURCE,
        status: "failed",
        error: failure.error,
      };
    const report = failedProvider({
      provider: "alibaba",
      label: LABEL,
      status:
        failure.error === "bl_cli_unavailable"
          ? "unavailable"
          : failure.sessionExpired
            ? "auth_required"
            : statusFromError(failure.error),
      error: failure.error,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
    return failure.sessionExpired
      ? {
          ...report,
          state: { ...report.state, remedyCommand: BL_CONSOLE_LOGIN_REMEDY },
        }
      : report;
  }
}

/**
 * The authenticated no-data reading: the session answered, so the provider is
 * usable, but the vendor served no usage windows to measure. Mirrors Kimi's
 * `live_no_quota` report - fresh, no windows, `authStatus: "usable"` - and,
 * like every fresh reading with no windows, clears rather than preserves the
 * provider's cache slot.
 */
function noQuotaReport(
  attempts: SourceAttempt[],
  dependencies: AlibabaDependencies,
): ProviderQuota {
  return {
    provider: "alibaba",
    label: LABEL,
    source: "cli",
    windows: [],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      authStatus: "usable",
      sourcesTried: sourceNames(attempts),
    },
    attempts,
  };
}

/**
 * `bl usage token-plan --output json` echoes only the vendor's usage fields
 * when present, so a parsed object with no keys at all is the established
 * shape of an authenticated account the vendor currently serves no usage data
 * for. Anything nonempty that fails recognition stays malformed, never this.
 */
function isEstablishedEmptyAlibabaUsage(raw: unknown): boolean {
  const root = objectValue(raw);
  return root !== undefined && Object.keys(root).length === 0;
}

/**
 * A failed `bl` invocation carries the vendor's structured error on stderr;
 * prefer its `error.message` over the multi-line "Command failed" blob so
 * every output surface states one clean fact. Only the observed session
 * failure is classified as an auth verdict - anything else stays a failed
 * read, never a sign-out.
 */
export function classifyBlFailure(error: unknown): {
  error: string;
  sessionExpired: boolean;
} {
  if (error instanceof SyntaxError)
    return { error: "bl_usage_malformed_json", sessionExpired: false };
  if (!(error instanceof Error))
    return { error: "bl_usage_failed", sessionExpired: false };
  const message = error.message.trim();
  if (message === "bl_usage_malformed_json" || message === "bl_cli_unavailable")
    return { error: message, sessionExpired: false };
  const payload = parseBlErrorPayload(failureStderrText(error));
  if (payload?.message) {
    const sessionExpired = payload.code === 3;
    return {
      error: sessionExpired
        ? BL_ERROR_SESSION_EXPIRED
        : `bl_usage_failed: ${payload.message.slice(0, 240)}`,
      sessionExpired,
    };
  }
  return {
    error: message
      ? `bl_usage_failed: ${message.slice(0, 240)}`
      : "bl_usage_failed",
    sessionExpired: false,
  };
}

function parseBlErrorPayload(
  stderr: unknown,
): { code?: number; message?: string } | undefined {
  const text =
    typeof stderr === "string"
      ? stderr
      : Buffer.isBuffer(stderr)
        ? stderr.toString("utf8")
        : undefined;
  if (!text?.trim()) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const payload = objectValue(objectValue(raw)?.error);
  if (!payload) return undefined;
  return {
    code: numberValue(payload.code),
    message: stringValue(payload.message),
  };
}

/** The vendor error body `execFileText` preserved on the rejection. */
function failureStderrText(error: Error): unknown {
  const enriched = error as Error & {
    commandStderr?: unknown;
    stderr?: unknown;
  };
  return enriched.commandStderr ?? enriched.stderr;
}

async function inspectAuthWithDependencies(
  dependencies: AlibabaDependencies,
): Promise<AuthProviderReport> {
  let source: AuthSourceReport;
  try {
    source = (await dependencies.findCommandPath(BL_COMMAND))
      ? { source: BL_SOURCE, status: "available" }
      : { source: BL_SOURCE, status: "missing" };
  } catch (error) {
    source = {
      source: BL_SOURCE,
      status: "error",
      error: errorMessage(error),
    };
  }
  return { provider: "alibaba", sources: [source] };
}

/** Normalize the stable fields emitted by `bl usage token-plan --output json`. */
export function normalizeAlibabaUsage(raw: unknown): NormalizedAlibabaUsage {
  const root = objectValue(raw);
  if (!root) return { windows: [] };
  const usage = numberValue(root.per1WeekPercentage);
  const windows: QuotaWindow[] = [];
  if (usage !== undefined) {
    const percentUsed = clampPercentage(usage <= 1 ? usage * 100 : usage);
    const percentRemaining = 100 - percentUsed;
    const reset = parseAlibabaReset(root.per1WeekResetTime);
    windows.push({
      id: "weekly",
      label: "week",
      kind: "weekly",
      percentUsed,
      percentRemaining,
      ...(reset ? { resetsAt: reset } : {}),
    });
  }

  return {
    plan: stringValue(root.planName) ?? stringValue(root.plan) ?? LABEL,
    windows: [...windows, ...normalizeAlibabaModelLimits(root.limits)],
  };
}

function isAlibabaUsagePayload(raw: unknown): boolean {
  const root = objectValue(raw);
  if (!root) return false;
  const hasRecognizedField = [
    "planName",
    "plan",
    "per1WeekPercentage",
    "per1WeekResetTime",
    "limits",
  ].some((key) => key in root);
  if (!hasRecognizedField) return false;
  const hasUsageEvidence = [
    "planName",
    "plan",
    "per1WeekPercentage",
    "limits",
  ].some((key) => key in root);
  if (!hasUsageEvidence) return false;
  if (
    ("planName" in root && typeof root.planName !== "string") ||
    ("plan" in root && typeof root.plan !== "string") ||
    ("per1WeekPercentage" in root &&
      numberValue(root.per1WeekPercentage) === undefined) ||
    ("per1WeekResetTime" in root &&
      !isValidAlibabaResetValue(root.per1WeekResetTime)) ||
    ("limits" in root &&
      (!Array.isArray(root.limits) ||
        root.limits.some((limit) => !isValidAlibabaModelLimit(limit))))
  ) {
    return false;
  }
  return true;
}

function isValidAlibabaResetValue(value: unknown): boolean {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 100_000_000_000 ? value : value * 1000);
    return !Number.isNaN(date.getTime());
  }
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function isValidAlibabaModelLimit(value: unknown): boolean {
  const entry = objectValue(value);
  if (!entry) return false;
  const details =
    objectValue(entry.limit) ??
    objectValue(entry.quota) ??
    objectValue(entry.modelLimit) ??
    objectValue(entry.model_limit);
  const record = details ? { ...entry, ...details } : entry;
  const model = firstString(record, ["model", "modelName", "model_name"]);
  if (!model) return false;
  const remaining = firstNumber(record, [
    "percentRemaining",
    "remainingPercent",
  ]);
  const fraction = firstNumber(record, ["per1WeekPercentage"]);
  const used =
    fraction !== undefined
      ? fraction <= 1
        ? fraction * 100
        : fraction
      : firstNumber(record, [
          "percentUsed",
          "usedPercent",
          "usagePercent",
          "percentage",
          "percent",
        ]);
  return remaining !== undefined || used !== undefined;
}

function normalizeAlibabaModelLimits(value: unknown): QuotaWindow[] {
  if (!Array.isArray(value)) return [];
  const occurrences = new Map<string, number>();
  const ids = new Set<string>();
  const windows: QuotaWindow[] = [];
  for (const rawLimit of value) {
    const entry = objectValue(rawLimit);
    if (!entry) continue;
    const details =
      objectValue(entry.limit) ??
      objectValue(entry.quota) ??
      objectValue(entry.modelLimit) ??
      objectValue(entry.model_limit);
    const record = details ? { ...entry, ...details } : entry;
    const model = firstString(record, ["model", "modelName", "model_name"]);
    if (!model) continue;

    const remaining = firstNumber(record, [
      "percentRemaining",
      "remainingPercent",
    ]);
    const fraction = firstNumber(record, ["per1WeekPercentage"]);
    const used =
      fraction !== undefined
        ? fraction <= 1
          ? fraction * 100
          : fraction
        : firstNumber(record, [
            "percentUsed",
            "usedPercent",
            "usagePercent",
            "percentage",
            "percent",
          ]);
    const percentRemaining =
      remaining !== undefined
        ? clampPercentage(remaining)
        : used !== undefined
          ? clampPercentage(100 - used)
          : undefined;
    if (percentRemaining === undefined) continue;

    const baseId = `model:${model}`;
    const occurrence = (occurrences.get(baseId) ?? 0) + 1;
    occurrences.set(baseId, occurrence);
    let suffix = occurrence;
    let id = occurrence === 1 ? baseId : `${baseId}:${suffix}`;
    while (ids.has(id)) {
      id = `${baseId}:${suffix}`;
      suffix += 1;
    }
    ids.add(id);
    const reset = parseAlibabaReset(
      firstValue(record, [
        "resetsAt",
        "resetAt",
        "reset_at",
        "per1WeekResetTime",
        "nextResetTime",
      ]),
    );
    windows.push({
      id,
      label: model,
      kind: "model",
      percentUsed: clampPercentage(100 - percentRemaining),
      percentRemaining,
      ...(reset ? { resetsAt: reset } : {}),
    });
  }
  return windows;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function firstString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  return keys.map((key) => stringValue(value[key])).find(Boolean);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstNumber(
  value: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  return keys
    .map((key) => numberValue(value[key]))
    .find((item) => item !== undefined);
}

function firstValue(
  value: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  return keys
    .map((key) => value[key])
    .find((item) => item !== undefined && item !== null);
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function parseAlibabaReset(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 100_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return classifyBlFailure(error).error;
}
