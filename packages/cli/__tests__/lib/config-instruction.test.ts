import { describe, expect, it } from "vitest";
import { getConfigInstruction } from "../../src/lib/config-instruction.js";

describe("getConfigInstruction", () => {
  it("advertises the local tracker plugin in project tracker config", () => {
    const instruction = getConfigInstruction();

    expect(instruction).toContain("plugin: github          # github | local | linear | gitlab");
    expect(instruction).toContain("# issuesPath: .ao/issues");
    expect(instruction).toContain("# idPrefix: TASK");
  });

  it("lists local in the available tracker plugins summary", () => {
    const instruction = getConfigInstruction();

    expect(instruction).toContain("# Tracker:   github, local, linear, gitlab");
  });
});
