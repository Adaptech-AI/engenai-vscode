import { AGENTS } from "../../types/protocol.js";
import * as assert from "assert";

suite("Protocol Types", () => {
  test("All 5 agents are defined", () => {
    assert.strictEqual(Object.keys(AGENTS).length, 5);
    assert.ok(AGENTS.keith);
    assert.ok(AGENTS.sophi);
    assert.ok(AGENTS.marv);
    assert.ok(AGENTS.promi);
    assert.ok(AGENTS.sage);
  });

  test("PROMI is always uppercase", () => {
    assert.strictEqual(AGENTS.promi.name, "PROMI");
  });

  test("Each agent has unique color", () => {
    const colors = Object.values(AGENTS).map((a) => a.color);
    const uniqueColors = new Set(colors);
    assert.strictEqual(uniqueColors.size, colors.length);
  });

  test("Each agent has role", () => {
    for (const agent of Object.values(AGENTS)) {
      assert.ok(agent.role.length > 0, `${agent.name} should have a role`);
    }
  });
});
