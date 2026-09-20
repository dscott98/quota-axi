import { describe, expect, it } from "vitest";
import { parseEpochOrIso } from "../../src/lib/time.js";

describe("parseEpochOrIso", () => {
  it("interprets numeric timestamps as seconds regardless of magnitude", () => {
    expect(parseEpochOrIso(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(parseEpochOrIso(100_000_000_000)).toBe("5138-11-16T09:46:40.000Z");
  });

  it("leaves out-of-range numeric dates unresolved", () => {
    expect(parseEpochOrIso(Number.MAX_VALUE)).toBeUndefined();
    expect(parseEpochOrIso(-Number.MAX_VALUE)).toBeUndefined();
  });
});
