import { test } from "node:test";
import assert from "node:assert/strict";
import { usernameSchema, internalAddress } from "../lib/usernames";
import { canManage, isAssignedJudge, profileCanScoreType, scoringTabs } from "../lib/access";
import type { Profile } from "../lib/model";

test("usernames normalize and reject email identifiers or unsafe characters", () => {
  assert.equal(usernameSchema.parse(" Judge_1 "), "judge_1");
  for (const value of ["x", "a@b.com", "a b", "<script>", "a".repeat(33)])
    assert.equal(usernameSchema.safeParse(value).success, false);
  const address = internalAddress("Judge_1");
  assert.match(address, /^judge_1\.[a-f0-9-]+@hidc\.internal$/);
  assert.notEqual(address, internalAddress("judge_1"));
});

test("admin permission follows the account in every build mode", () => {
  const judge: Profile = {
    id: "judge",
    name: "Taylor Chen",
    username: "taylor",
    role: "technical_judge",
    active: true,
    is_admin: false,
  };
  assert.equal(canManage(judge), false);
  assert.equal(isAssignedJudge(judge), true);
  assert.equal(canManage({ ...judge, is_admin: true }), true);
  assert.equal(canManage({ ...judge, role: "organizer" }), true);
  assert.equal(canManage({ ...judge, role: "performance_judge" }), false);
  assert.equal(isAssignedJudge({ ...judge, role: "organizer" }), true);
  assert.equal(profileCanScoreType({ ...judge, role: "technical_judge" }, "technical"), true);
  assert.equal(profileCanScoreType({ ...judge, role: "technical_judge" }, "performance"), false);
  assert.equal(profileCanScoreType({ ...judge, role: "performance_judge" }, "performance"), true);
  assert.deepEqual(scoringTabs({ ...judge, role: "technical_judge" }), ["Technical"]);
  assert.deepEqual(scoringTabs({ ...judge, role: "performance_judge" }), ["Performance"]);
  assert.deepEqual(scoringTabs({ ...judge, role: "organizer" }), ["Technical", "Performance"]);
  assert.deepEqual(scoringTabs({ ...judge, role: "server_admin" }), ["Technical", "Performance"]);
  assert.deepEqual(scoringTabs({ ...judge, active: false }), []);
  assert.equal(canManage({ ...judge, active: false, is_admin: true }), false);
});
