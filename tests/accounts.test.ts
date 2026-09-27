import { test } from "node:test";
import assert from "node:assert/strict";
import { usernameSchema, internalAddress } from "../lib/usernames";
import { canManage, isAssignedJudge } from "../lib/access";
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
    name: "judge1",
    username: "judge1",
    slot: 1,
    role: "judge",
    active: true,
    is_admin: false,
  };
  assert.equal(canManage(judge), false);
  assert.equal(isAssignedJudge(judge), true);
  assert.equal(canManage({ ...judge, is_admin: true }), true);
  assert.equal(canManage({ ...judge, role: "server_admin" }), true);
  assert.equal(canManage({ ...judge, active: false, is_admin: true }), false);
});
