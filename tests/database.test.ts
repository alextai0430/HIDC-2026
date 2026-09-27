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
    await db.query<{ is_admin: boolean; id: string; avatar_path: string | null }>(
      "select * from profiles order by id",
    )
  ).rows;
  assert.deepEqual(
    afterProfiles.map(({ is_admin, avatar_path: _avatar, ...p }) => p),
    beforeProfiles,
  );
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
    (await db.query("select * from audit order by id")).rows,
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
    { slot: 1, user_id: alternateJ1 },
    { slot: 2, user_id: other },
    { slot: 3, user_id: judge3 },
    { slot: 4, user_id: judge4 },
    { slot: 5, user_id: judge5 },
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
  await db.close();
});
