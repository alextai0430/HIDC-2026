import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
test("PostgreSQL migration enforces RLS, lifecycle, deduplication, versions and attribution", async () => {
  const db = new PGlite();
  await db.exec(
    `create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select null::uuid$$;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`,
  );
  const sql = readFileSync("supabase/migrations/001_hidc.sql", "utf8").replace(
    "alter publication supabase_realtime add table public.competitors;",
    "",
  );
  await db.exec(sql);
  await db.exec(
    readFileSync("supabase/migrations/002_live_and_admin.sql", "utf8").replace(
      "alter publication supabase_realtime add table public.live_signal;",
      "",
    ),
  );
  const user = crypto.randomUUID(),
    other = crypto.randomUUID(),
    admin = crypto.randomUUID(),
    comp = crypto.randomUUID();
  await db.exec(
    `insert into auth.users values('${user}'),('${other}'),('${admin}');insert into profiles(id,name,slot,role) values('${user}','J1',1,'judge'),('${other}','J2',2,'judge'),('${admin}','Organizer',null,'server_admin');insert into competitors(id,name,division,position) values('${comp}','Test','Individual Open',1);`,
  );
  const invoke = (id: string, version: number, actor = user, slot = 1) =>
    db.query(`select apply_score($1,$2,$3,$4,$5,'put_event',$6)`, [
      actor,
      slot,
      id,
      comp,
      version,
      JSON.stringify({
        id: crypto.randomUUID(),
        trick: "T 3D",
        level: 1,
        features: [],
        at: new Date().toISOString(),
      }),
    ]);
  await assert.rejects(invoke(crypto.randomUUID(), 0), /not active/);
  await db.query(`select manage_competitor($1,'activate',$2)`, [
    admin,
    JSON.stringify({ id: comp }),
  ]);
  const op = crypto.randomUUID();
  await invoke(op, 0);
  await invoke(op, 0);
  const first = await db.query<{ version: number; events: unknown[] }>(
    "select version,events from submissions where user_id=$1",
    [user],
  );
  assert.equal(first.rows[0].version, 1);
  assert.equal(first.rows[0].events.length, 1);
  await assert.rejects(invoke(crypto.randomUUID(), 0), /Version conflict/);
  await assert.rejects(
    invoke(crypto.randomUUID(), 1, other, 1),
    /no longer active/,
  );
  await db.query(`select manage_competitor($1,'lock',$2)`, [
    admin,
    JSON.stringify({ id: comp }),
  ]);
  await invoke(crypto.randomUUID(), 1);
  await invoke(crypto.randomUUID(), 0, other, 2);
  await db.exec("set role authenticated");
  await assert.rejects(
    db.query("select * from submissions"),
    /permission denied/,
  );
  await assert.rejects(
    db.query(`select apply_score($1,1,$2,$3,2,'finish','{"finished":true}')`, [
      user,
      crypto.randomUUID(),
      comp,
    ]),
    /permission denied/,
  );
  await db.exec("reset role");
  const audit = await db.query<{ count: number }>(
    "select count(*)::int as count from audit",
  );
  assert.equal(audit.rows[0].count, 5);
  for (let i = 0; i < 6; i++) {
    const r = await db.query<{ consume_unlock_attempt: boolean }>(
      "select consume_unlock_attempt($1)",
      [user],
    );
    assert.equal(r.rows[0].consume_unlock_attempt, i < 5);
  }
  await db.exec(
    readFileSync(
      "supabase/migrations/003_usernames_and_development_access.sql",
      "utf8",
    ),
  );
  const usernames = await db.query<{ username: string }>(
    "select username from profiles",
  );
  assert.ok(usernames.rows.every((p) => p.username.length <= 32));
  await assert.rejects(
    db.query("select manage_competitor($1,'lock',$2,false)", [
      user,
      JSON.stringify({ id: comp }),
    ]),
    /Organizer required/,
  );
  await db.query("select manage_competitor($1,'lock',$2,true)", [
    user,
    JSON.stringify({ id: comp }),
  ]);
  await db.exec("set role authenticated");
  await assert.rejects(
    db.query("select manage_competitor($1,'lock',$2,true)", [
      user,
      JSON.stringify({ id: comp }),
    ]),
    /permission denied/,
  );
  await db.exec("reset role");
  // Upgrade an existing event with scores and acknowledged operation IDs already present.
  await db.query("update profiles set username='alexandertai' where id=$1", [
    user,
  ]);
  await db.query("update profiles set username='organizer' where id=$1", [
    admin,
  ]);
  const beforeProfiles = (await db.query("select * from profiles order by id"))
    .rows;
  const beforeScores = (await db.query("select * from submissions order by id"))
    .rows;
  const beforeOps = (await db.query("select * from operations order by id"))
    .rows;
  const beforeAudit = (await db.query("select * from audit order by id")).rows;
  await db.exec(
    readFileSync("supabase/migrations/004_admin_judge_access.sql", "utf8"),
  );
  await db.exec(
    readFileSync("supabase/migrations/005_profile_settings.sql", "utf8"),
  );
  await db.exec(
    readFileSync("supabase/migrations/006_division_judges.sql", "utf8"),
  );
  await db.exec(
    readFileSync("supabase/migrations/20260928041346_user_appearance_preferences.sql", "utf8"),
  );
  const beforePointConfigScores = (
    await db.query("select * from submissions order by id")
  ).rows;
  await db.exec(
    readFileSync("supabase/migrations/20260928033101_technical_point_configuration.sql", "utf8"),
  );
  const initialPointConfig = await db.query<{ revision: number; data_revision: number; t1d: string }>(
    "select revision,data_revision,rules->'bases'->'T'->>'1D' as t1d from scoring_configuration where config_id='global'",
  );
  assert.equal(initialPointConfig.rows[0].revision, 1);
  assert.equal(initialPointConfig.rows[0].data_revision, 1);
  assert.equal(initialPointConfig.rows[0].t1d, "0.1");
  await db.exec("set role authenticated");
  await assert.rejects(
    db.query("select * from scoring_configuration"),
    /permission denied/,
  );
  await assert.rejects(
    db.query(
      "select update_scoring_configuration($1,1,1,'{}','{}')",
      [user],
    ),
    /permission denied/,
  );
  await db.exec("reset role");
  const updatedRules = (
    await db.query<{ rules: Record<string, any> }>(
      "select rules from scoring_configuration where config_id='global'",
    )
  ).rows[0].rules;
  updatedRules.bases.T["1D"] = 3;
  const pointImpact = {
    technicalSubmissions: 1,
    technicalEventValues: 2,
    competitors: 1,
    rankingDivisions: 1,
    finalizedRankings: 0,
  };
  // A concurrent score-data write invalidates the impact snapshot before any rule changes.
  await db.query("update submissions set updated_at=updated_at where user_id=$1", [user]);
  await assert.rejects(
    db.query(
      "select update_scoring_configuration($1,1,1,$2,$3)",
      [user, JSON.stringify(updatedRules), JSON.stringify(pointImpact)],
    ),
    /scoring data changed/i,
  );
  await assert.rejects(
    db.query(
      "select update_scoring_configuration($1,1,2,$2,$3)",
      [other, JSON.stringify(updatedRules), JSON.stringify(pointImpact)],
    ),
    /access denied/,
  );
  const configUpdate = await db.query<{ result: Record<string, any> }>(
    "select update_scoring_configuration($1,1,2,$2,$3) as result",
    [user, JSON.stringify(updatedRules), JSON.stringify(pointImpact)],
  );
  assert.equal(configUpdate.rows[0].result.changed, true);
  assert.equal(configUpdate.rows[0].result.revision, 2);
  assert.equal(configUpdate.rows[0].result.data_revision, 2);
  assert.equal(configUpdate.rows[0].result.rules.bases.T["1D"], 3);
  await assert.rejects(
    db.query(
      "select update_scoring_configuration($1,1,2,$2,$3)",
      [user, JSON.stringify(updatedRules), JSON.stringify(pointImpact)],
    ),
    /configuration changed/,
  );
  assert.deepEqual(
    (await db.query("select * from submissions order by id")).rows,
    beforePointConfigScores,
    "configuration edits must not rewrite score selections or their attribution",
  );
  const configAudit = await db.query<{
    action: string;
    prior: Record<string, any>;
    next: Record<string, any>;
  }>(
    "select action,prior,next from audit where action='scoring_configuration_update'",
  );
  assert.equal(configAudit.rows.length, 1);
  assert.equal(configAudit.rows[0].prior.revision, 1);
  assert.equal(configAudit.rows[0].prior.rules.bases.T["1D"], 0.1);
  assert.equal(configAudit.rows[0].next.revision, 2);
  assert.equal(configAudit.rows[0].next.rules.bases.T["1D"], 3);
  assert.deepEqual(configAudit.rows[0].next.affected_rules, ["base:T:1D"]);
  assert.equal(configAudit.rows[0].next.recalculation.performed, true);
  assert.equal(configAudit.rows[0].next.recalculation.mode, "derived_on_read");
  const avatarSchema = await db.query<{ avatar_path: string | null }>(
    "select avatar_path from profiles limit 1",
  );
  assert.equal(avatarSchema.rows[0].avatar_path, null);
  const avatarBucket = await db.query<{
    public: boolean;
    file_size_limit: number;
    allowed_mime_types: string[];
  }>("select public,file_size_limit,allowed_mime_types from storage.buckets where id='profile-avatars'");
  assert.equal(avatarBucket.rows[0].public, false);
  assert.equal(Number(avatarBucket.rows[0].file_size_limit), 2 * 1024 * 1024);
  assert.deepEqual(avatarBucket.rows[0].allowed_mime_types, ["image/jpeg", "image/png", "image/webp"]);
  const afterProfiles = (
    await db.query<{ is_admin: boolean; id: string; avatar_path: string | null; appearance_preferences: Record<string, string>; appearance_updated_at: string }>(
      "select * from profiles order by id",
    )
  ).rows;
  assert.deepEqual(
    afterProfiles.map(({ is_admin, avatar_path: _avatar, appearance_preferences: _appearance, appearance_updated_at: _appearanceAt, ...p }) => p),
    beforeProfiles,
  );
  assert.deepEqual(afterProfiles[0].appearance_preferences, {
    template: "control-room", scheme: "hidc-navy", font: "system-ui", mode: "light",
  });
  assert.ok(afterProfiles.every((p) => Number.isFinite(Date.parse(p.appearance_updated_at))));
  assert.equal(afterProfiles.find((p) => p.id === user)!.is_admin, true);
  assert.equal(afterProfiles.find((p) => p.id === admin)!.is_admin, true);
  assert.equal(afterProfiles.find((p) => p.id === other)!.is_admin, false);
  assert.deepEqual(
    (await db.query("select * from submissions order by id")).rows,
    beforeScores,
  );
  assert.deepEqual(
    (await db.query("select * from operations order by id")).rows,
    beforeOps,
  );
  assert.deepEqual(
    (await db.query("select * from audit where action <> 'scoring_configuration_update' order by id")).rows,
    beforeAudit,
  );
  await invoke(op, 0); // An acknowledged pre-upgrade operation still deduplicates.
  assert.deepEqual(
    (await db.query("select * from submissions order by id")).rows,
    beforeScores,
  );
  await invoke(crypto.randomUUID(), 2); // Pending Judge 1 work syncs after upgrade and lock.
  await db.query("select manage_competitor($1,'activate',$2,false)", [
    user,
    JSON.stringify({ id: comp }),
  ]);
  await db.query("select manage_competitor($1,'lock',$2,false)", [
    admin,
    JSON.stringify({ id: comp }),
  ]);
  for (let slot = 2; slot <= 5; slot++) {
    let judge = other;
    if (slot > 2) {
      judge = crypto.randomUUID();
      await db.query("insert into auth.users values($1)", [judge]);
      await db.query(
        "insert into profiles(id,name,username,role,slot) values($1,'Judge',$2,'judge',$3)",
        [judge, "judge" + slot, slot],
      );
    }
    await assert.rejects(
      db.query("select manage_competitor($1,'lock',$2,false)", [
        judge,
        JSON.stringify({ id: comp }),
      ]),
      /Organizer required/,
    );
  }
  await db.exec(
    readFileSync("supabase/migrations/20260928200849_variable_judge_groups.sql", "utf8"),
  );
  await db.exec(
    readFileSync("supabase/migrations/20260928195640_allow_competitor_deletion.sql", "utf8"),
  );
  await db.exec(
    readFileSync("supabase/migrations/20260928200909_restore_unrestricted_competitor_deletion.sql", "utf8"),
  );
  const alternateJ1 = crypto.randomUUID();
  await db.query("insert into auth.users values($1)", [alternateJ1]);
  await db.query(
    "insert into profiles(id,name,username,role,slot) values($1,'Alternate Judge 1','alternate1','judge',1)",
    [alternateJ1],
  );
  const judgeIds = (
    await db.query<{ id: string; slot: number }>(
      "select id,slot from profiles where active and role='judge' order by slot,id",
    )
  ).rows;
  const judge3 = judgeIds.find((judge) => judge.slot === 3)!.id;
  const judge4 = judgeIds.find((judge) => judge.slot === 4)!.id;
  const judge5 = judgeIds.find((judge) => judge.slot === 5)!.id;
  const teamGroup = [
    { slot: 1, user_id: alternateJ1, scoring_type: "technical" },
    { slot: 2, user_id: other, scoring_type: "technical" },
    { slot: 3, user_id: judge3, scoring_type: "technical" },
    { slot: 4, user_id: judge4, scoring_type: "performance" },
    { slot: 5, user_id: judge5, scoring_type: "performance" },
  ];
  await db.query("select manage_judge_assignments($1,$2,$3)", [
    admin,
    "Team Division",
    JSON.stringify(teamGroup),
  ]);
  const teamCompetitor = crypto.randomUUID();
  await db.query(
    "insert into competitors(id,name,division,position) values($1,'Team test','Team Division',2)",
    [teamCompetitor],
  );
  await db.query("select manage_competitor($1,'activate',$2,false)", [
    admin,
    JSON.stringify({ id: teamCompetitor }),
  ]);
  const scorePayload = JSON.stringify({ finished: true });
  await assert.rejects(
    db.query("select apply_score($1,1,$2,$3,0,'finish',$4)", [
      user,
      crypto.randomUUID(),
      teamCompetitor,
      scorePayload,
    ]),
    /not assigned to this competitor division/,
  );
  await db.query("select apply_score($1,2,$2,$3,0,'finish',$4)", [
    other,
    crypto.randomUUID(),
    teamCompetitor,
    scorePayload,
  ]);
  const nextTeamCompetitor = crypto.randomUUID();
  await db.query(
    "insert into competitors(id,name,division,position) values($1,'Next team','Team Division',3)",
    [nextTeamCompetitor],
  );
  await assert.rejects(
    db.query("select apply_score($1,2,$2,$3,0,'finish',$4)", [
      other,
      crypto.randomUUID(),
      nextTeamCompetitor,
      scorePayload,
    ]),
    /Only the active competitor can be started/,
  );
  const extraTechnicalJudges: string[] = [];
  for (let index = 6; index <= 9; index++) {
    const id = crypto.randomUUID();
    extraTechnicalJudges.push(id);
    await db.query("insert into auth.users values($1)", [id]);
    await db.query(
      "insert into profiles(id,name,username,role,slot) values($1,$2,$3,'judge',1)",
      [id, `Extra Judge ${index}`, `extrajudge${index}`],
    );
  }
  const tenJudgeGroup = [
    ...[user, other, judge3, alternateJ1, ...extraTechnicalJudges].map((user_id, index) => ({ slot: index + 1, user_id, scoring_type: "technical" })),
    ...[judge4, judge5].map((user_id, index) => ({ slot: index + 9, user_id, scoring_type: "performance" })),
  ];
  await db.query("select manage_judge_assignments($1,$2,$3)", [
    admin,
    "Individual Juniors",
    JSON.stringify(tenJudgeGroup),
  ]);
  await assert.rejects(
    db.query("select manage_judge_assignments($1,$2,$3)", [
      admin,
      "Individual Newcomer",
      JSON.stringify([
        { slot: 1, user_id: user, scoring_type: "technical" },
        { slot: 2, user_id: other, scoring_type: "technical" },
      ]),
    ]),
    /at least one Technical judge and one Performance judge/,
  );
  await db.query("select manage_judge_assignments($1,$2,$3)", [
    admin,
    "Individual Newcomer",
    JSON.stringify([
      { slot: 1, user_id: user, scoring_type: "technical" },
      { slot: 2, user_id: judge4, scoring_type: "performance" },
    ]),
  ]);
  await db.query("update competitors set division='Individual Juniors' where id=$1", [nextTeamCompetitor]);
  await db.query("select manage_competitor($1,'lock',$2,false)", [
    admin,
    JSON.stringify({ id: teamCompetitor }),
  ]);
  await db.query("select manage_competitor($1,'activate',$2,false)", [
    admin,
    JSON.stringify({ id: nextTeamCompetitor }),
  ]);
  const variableReservations = await db.query<{ count: number; technical: number; performance: number }>(
    "select count(*)::int as count,count(*) filter (where scoring_type='technical')::int as technical,count(*) filter (where scoring_type='performance')::int as performance from submissions where competitor_id=$1",
    [nextTeamCompetitor],
  );
  assert.deepEqual(variableReservations.rows[0], { count: 10, technical: 8, performance: 2 });
  await assert.rejects(
    db.query("select apply_score($1,4,$2,$3,0,'put_event',$4)", [
      judge4,
      crypto.randomUUID(),
      nextTeamCompetitor,
      JSON.stringify({ id: crypto.randomUUID(), trick: "T 1D", level: 1, features: [], at: new Date().toISOString() }),
    ]),
    /Technical judge required/,
  );
  await db.query("select apply_score($1,4,$2,$3,0,'finish',$4)", [
    judge4,
    crypto.randomUUID(),
    nextTeamCompetitor,
    scorePayload,
  ]);
  const unscoredCompetitor = crypto.randomUUID();
  await db.query("insert into competitors(id,name,division,position,dq) values($1,'Delete me','Individual Juniors',4,true)", [unscoredCompetitor]);
  await assert.rejects(
    db.query("select delete_competitor($1,$2)", [other, unscoredCompetitor]),
    /Organizer required/,
  );
  assert.equal((await db.query("select id from competitors where id=$1", [unscoredCompetitor])).rows.length, 1);
  await db.query("select delete_competitor($1,$2)", [admin, unscoredCompetitor]);
  const deletedSubmissions = await db.query<{ count: number }>(
    "select count(*)::int as count from submissions where competitor_id=$1",
    [nextTeamCompetitor],
  );
  assert.equal(deletedSubmissions.rows[0].count, 10);
  await db.query("select delete_competitor($1,$2)", [admin, nextTeamCompetitor]);
  assert.equal((await db.query("select id from competitors where id=$1", [nextTeamCompetitor])).rows.length, 0);
  assert.equal((await db.query("select id from submissions where competitor_id=$1", [nextTeamCompetitor])).rows.length, 0);
  const deletionAudit = await db.query<{ prior: Record<string, unknown> }>(
    "select prior from audit where competitor_id=$1 and action='competitor_delete' order by id desc limit 1",
    [nextTeamCompetitor],
  );
  assert.equal(deletionAudit.rows[0].prior.deleted_submission_count, 10);
  assert.ok((await db.query("select id from audit where competitor_id=$1 and action='finish'", [nextTeamCompetitor])).rows.length > 0);
  assert.equal((await db.query("select id from competitors where id=$1", [unscoredCompetitor])).rows.length, 0);
  await db.exec("set role authenticated");
  await assert.rejects(
    db.query("select manage_competitor($1,'lock',$2,true)", [
      user,
      JSON.stringify({ id: comp }),
    ]),
    /permission denied/,
  );
  await assert.rejects(
    db.query("update profiles set is_admin=true where id=$1", [other]),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select * from submissions"),
    /permission denied/,
  );
  await db.exec("reset role");
  await db.query("update profiles set active=false where id=$1", [user]);
  await assert.rejects(
    db.query("select manage_competitor($1,'lock',$2,false)", [
      user,
      JSON.stringify({ id: comp }),
    ]),
    /Organizer required/,
  );
  await assert.rejects(invoke(crypto.randomUUID(), 3), /no longer active/);

  // Migrate global account slots to roles; division assignments retain their own scoring group.
  await db.exec(readFileSync("supabase/migrations/20260928205013_role_model_and_account_lifecycle.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260928213559_execution_scoring_workflow.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260928230000_lock_submitted_scores.sql", "utf8"));
  const executionConfig = await db.query<{ revision: number; data_revision: number; rules: Record<string, any> }>(
    "select revision,data_revision,rules from scoring_configuration where config_id='global'",
  );
  assert.equal(executionConfig.rows[0].revision, 3);
  assert.deepEqual(executionConfig.rows[0].rules.executions, { E0: 1, "E-1": 0.9, "E-2": 0.8, "E-3": 0.7 });
  const executionRules = structuredClone(executionConfig.rows[0].rules);
  executionRules.executions["E-2"] = 0.5;
  const executionUpdate = await db.query<{ result: Record<string, any> }>(
    "select public.update_scoring_configuration($1,$2,$3,$4,$5) as result",
    [admin, executionConfig.rows[0].revision, executionConfig.rows[0].data_revision, JSON.stringify(executionRules), JSON.stringify({ technicalEventValues: 1 })],
  );
  assert.equal(executionUpdate.rows[0].result.revision, 4);
  assert.deepEqual(executionUpdate.rows[0].result.impact, { technicalEventValues: 1 });
  const executionAudit = await db.query<{ next: Record<string, any> }>(
    "select next from audit where action='scoring_configuration_update' and user_id=$1 order by id desc limit 1",
    [admin],
  );
  assert.deepEqual(executionAudit.rows[0].next.affected_rules, ["execution:E-2"]);
  assert.equal(executionAudit.rows[0].next.recalculation.performed, true);
  const migratedRoles = await db.query<{ id: string; role: string }>(
    "select id,role from profiles where id=any($1::uuid[]) order by id",
    [[user, other, admin]],
  );
  assert.equal((await db.query("select column_name from information_schema.columns where table_name='profiles' and column_name='slot'")).rows.length, 0);
  assert.equal(migratedRoles.rows.find((row) => row.id === user)?.role, "organizer");
  assert.equal(migratedRoles.rows.find((row) => row.id === other)?.role, "technical_judge");
  assert.equal(migratedRoles.rows.find((row) => row.id === admin)?.role, "organizer");

  const addAccount = async (name: string, role: "technical_judge" | "performance_judge" | "organizer") => {
    const id = crypto.randomUUID();
    await db.query("insert into auth.users values($1)", [id]);
    await db.query("insert into profiles(id,name,username,role,is_admin) values($1,$2,$3,$4,$5)", [id, name, name.toLowerCase().replaceAll(" ", ""), role, role === "organizer"]);
    return id;
  };
  const technicalOne = await addAccount("Taylor Chen", "technical_judge");
  const technicalTwo = await addAccount("Morgan Lee", "technical_judge");
  const performanceOne = await addAccount("Riley Shah", "performance_judge");
  const scoringOrganizer = await addAccount("Event Organizer", "organizer");
  const unused = await addAccount("Unused Judge", "technical_judge");
  const assignments = [
    { slot: 1, user_id: technicalOne, scoring_type: "technical" },
    { slot: 2, user_id: technicalTwo, scoring_type: "technical" },
    { slot: 3, user_id: performanceOne, scoring_type: "performance" },
    { slot: 4, user_id: scoringOrganizer, scoring_type: "performance" },
  ];
  await assert.rejects(db.query("select manage_judge_assignments($1,$2,$3)", [admin, "Individual Open", JSON.stringify([
    { slot: 1, user_id: technicalOne, scoring_type: "performance" },
    { slot: 2, user_id: performanceOne, scoring_type: "technical" },
  ])]), /role matches the scoring group/);
  await db.query("select manage_judge_assignments($1,$2,$3)", [admin, "Individual Open", JSON.stringify(assignments)]);
  const teamAssignments = [
    { slot: 1, user_id: technicalTwo, scoring_type: "technical" },
    { slot: 2, user_id: performanceOne, scoring_type: "performance" },
  ];
  await db.query("select manage_judge_assignments($1,$2,$3)", [admin, "Team Division", JSON.stringify(teamAssignments)]);
  assert.deepEqual(
    (await db.query<{ user_id: string; scoring_type: string }>("select user_id,scoring_type from division_judges where division='Team Division' order by slot")).rows,
    teamAssignments.map(({ user_id, scoring_type }) => ({ user_id, scoring_type })),
  );
  const changedDivision = await db.query<{ next: Record<string, any> }>(
    "select next from audit where action='judge_assignments' and next->>'division'='Individual Open' order by id desc limit 1",
  );
  assert.ok(changedDivision.rows[0].next.saved_submissions_affected >= 0);
  await db.query("select manage_competitor($1,'activate',$2,false)", [admin, JSON.stringify({ id: comp })]);
  const savedEvent = JSON.stringify({ id: crypto.randomUUID(), trick: "T 1D", level: 1, features: [], execution: "E-2", at: new Date().toISOString() });
  await db.query("select apply_score($1,99,$2,$3,0,'put_event',$4)", [technicalOne, crypto.randomUUID(), comp, savedEvent]);
  const eventHistory = await db.query<{ events: Array<{ execution?: string }> }>(
    "select events from submissions where competitor_id=$1 and user_id=$2",
    [comp, technicalOne],
  );
  assert.equal(eventHistory.rows[0].events[0].execution, "E-2", "saved events retain their execution selection");
  await db.query("select apply_score($1,1,$2,$3,1,'finish',$4)", [technicalOne, crypto.randomUUID(), comp, scorePayload]);
  const submitted = await db.query<{ id: string; version: number; finished: boolean; submitted_at: string | null }>(
    "select id,version,finished,submitted_at from submissions where competitor_id=$1 and user_id=$2",
    [comp, technicalOne],
  );
  assert.deepEqual(
    { version: submitted.rows[0].version, finished: submitted.rows[0].finished, hasSubmittedAt: !!submitted.rows[0].submitted_at },
    { version: 2, finished: true, hasSubmittedAt: true },
  );
  await assert.rejects(
    db.query("select apply_score($1,1,$2,$3,$4,'put_event',$5)", [
      technicalOne, crypto.randomUUID(), comp, submitted.rows[0].version,
      JSON.stringify({ id: crypto.randomUUID(), trick: "T 2D", level: 1, features: [], at: new Date().toISOString() }),
    ]),
    /already submitted; ask the Organizer to reopen it/,
  );
  await assert.rejects(
    db.query("select apply_score($1,1,$2,$3,$4,'finish',$5)", [technicalOne, crypto.randomUUID(), comp, submitted.rows[0].version, JSON.stringify({ finished: false })]),
    /already submitted; ask the Organizer to reopen it/,
  );
  await db.query("select review_submission($1,$2,$3,false,false)", [admin, submitted.rows[0].id, submitted.rows[0].version]);
  const reopened = await db.query<{ finished: boolean; version: number }>("select finished,version from submissions where id=$1", [submitted.rows[0].id]);
  assert.deepEqual(reopened.rows[0], { finished: false, version: 3 }, "manager reopen restores editing and increments the version");
  await db.query("select apply_score($1,1,$2,$3,3,'put_event',$4)", [
    technicalOne, crypto.randomUUID(), comp,
    JSON.stringify({ id: crypto.randomUUID(), trick: "T 2D", level: 1, features: [], at: new Date().toISOString() }),
  ]);
  await assert.rejects(db.query("select apply_score($1,1,$2,$3,0,'put_event',$4)", [performanceOne, crypto.randomUUID(), comp, savedEvent]), /Technical Judge assignment required/);
  await assert.rejects(db.query("select apply_score($1,1,$2,$3,0,'performance',$4)", [technicalOne, crypto.randomUUID(), comp, JSON.stringify({ values: [4,4,4,4,4,4] })]), /Performance Judge assignment required/);
  await assert.rejects(db.query("select apply_score($1,1,$2,$3,0,'finish',$4)", [admin, crypto.randomUUID(), comp, scorePayload]), /not assigned to this competitor division/);
  await db.query("select apply_score($1,1,$2,$3,0,'finish',$4)", [scoringOrganizer, crypto.randomUUID(), comp, scorePayload]);

  // Role change removes only incompatible future assignments; the finished submission keeps its original type.
  await db.query("select apply_score($1,2,$2,$3,0,'finish',$4)", [technicalTwo, crypto.randomUUID(), comp, scorePayload]);
  await db.query("select change_judge_account_role($1,$2,'performance_judge')", [admin, technicalTwo]);
  const preserved = await db.query<{ scoring_type: string; finished: boolean }>("select scoring_type,finished from submissions where competitor_id=$1 and user_id=$2", [comp, technicalTwo]);
  assert.deepEqual(preserved.rows[0], { scoring_type: "technical", finished: true });
  assert.equal((await db.query("select 1 from division_judges where division='Individual Open' and user_id=$1", [technicalTwo])).rows.length, 0);

  const unusedResult = await db.query<{ remove_judge_account: Record<string, any> }>("select remove_judge_account($1,$2)", [admin, unused]);
  assert.equal(unusedResult.rows[0].remove_judge_account.hard_delete, true);
  await db.query("delete from auth.users where id=$1", [unused]);
  assert.equal((await db.query("select id from profiles where id=$1", [unused])).rows.length, 0);
  const archivedResult = await db.query<{ remove_judge_account: Record<string, any> }>("select remove_judge_account($1,$2)", [admin, scoringOrganizer]);
  assert.equal(archivedResult.rows[0].remove_judge_account.archived, true);
  assert.equal((await db.query("select id from submissions where competitor_id=$1 and user_id=$2", [comp, scoringOrganizer])).rows.length, 1);
  assert.equal((await db.query("select 1 from division_judges where user_id=$1", [scoringOrganizer])).rows.length, 0);
  await db.query("select reactivate_judge_account($1,$2)", [admin, scoringOrganizer]);
  assert.equal((await db.query<{ active: boolean; archived: boolean }>("select active,archived from profiles where id=$1", [scoringOrganizer])).rows[0].active, true);
  await db.query("select remove_judge_account($1,$2)", [admin, scoringOrganizer]);
  await assert.rejects(db.query("select remove_judge_account($1,$2)", [admin, admin]), /final active Organizer/);
  assert.ok((await db.query("select id from audit where action='account_role_change' and user_id=$1", [admin])).rows.length > 0);
  assert.ok((await db.query("select id from audit where action='account_archive' and user_id=$1", [admin])).rows.length > 0);
  assert.ok((await db.query("select id from audit where action='account_reactivate' and user_id=$1", [admin])).rows.length > 0);
  await db.close();
});
