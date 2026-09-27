import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
for (let slot = 1; slot <= 5; slot++) {
  const username = `judge${slot}`;
  const email = `${username}@hidc.internal`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  const result = await client.from("profiles").insert({
    id: data.user.id,
    name: username,
    username,
    slot,
    role: "judge",
    active: true,
  });
  if (result.error) {
    await client.auth.admin.deleteUser(data.user.id);
    throw result.error;
  }
  console.log(`${username}\t${password}`);
}
console.log("Store the generated credentials securely. Do not commit them.");
