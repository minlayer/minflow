import { describe, expect, it } from "vitest";

import { VERSION } from "../src/index.js";

describe("minflow", () => {
  it("exposes a semver version string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
