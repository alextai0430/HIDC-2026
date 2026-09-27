import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
test("PostgreSQL migration enforces RLS, lifecycle, deduplication, versions and attribution", async () => {
  const db = new PGlite();
  await db.exec(
    `create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select null::uuid$$;`,
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
  await db.exec(readFileSync('supabase/migrations/003_usernames_and_development_access.sql','utf8'));
  const usernames=await db.query<{username:string}>('select username from profiles');
  assert.ok(usernames.rows.every(p=>p.username.length<=32));
  await assert.rejects(db.query("select manage_competitor($1,'lock',$2,false)",[user,JSON.stringify({id:comp})]),/Organizer required/);
  await db.query("select manage_competitor($1,'lock',$2,true)",[user,JSON.stringify({id:comp})]);
  await db.exec('set role authenticated');
  await assert.rejects(db.query("select manage_competitor($1,'lock',$2,true)",[user,JSON.stringify({id:comp})]),/permission denied/);
  await db.exec('reset role');
  await db.close();
});
