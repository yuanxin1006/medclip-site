import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const supabaseCli = require.resolve("supabase/dist/supabase.js");

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireEnvironment() {
  const names = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "MEDCLIP_TEST_USER_A_EMAIL",
    "MEDCLIP_TEST_USER_A_PASSWORD",
    "MEDCLIP_TEST_USER_B_EMAIL",
    "MEDCLIP_TEST_USER_B_PASSWORD",
  ];
  if (names.some((name) => !process.env[name])) throw new Error("MUSIC_TEST_RELEASE_ENVIRONMENT_MISSING");
}

async function authenticatedUserId(client, email, password) {
  const result = await client.auth.signInWithPassword({ email, password });
  if (result.error || !result.data.user) throw new Error("MUSIC_TEST_RELEASE_USER_AUTH_FAILED");
  const userId = result.data.user.id.toLowerCase();
  await client.auth.signOut({ scope: "local" });
  return userId;
}

requireEnvironment();
const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
);
const userAId = await authenticatedUserId(client, process.env.MEDCLIP_TEST_USER_A_EMAIL, process.env.MEDCLIP_TEST_USER_A_PASSWORD);
const userBId = await authenticatedUserId(client, process.env.MEDCLIP_TEST_USER_B_EMAIL, process.env.MEDCLIP_TEST_USER_B_PASSWORD);
const { stdout } = await execFileAsync(process.execPath, [supabaseCli, "secrets", "list"], {
  cwd: process.cwd(),
  timeout: 120_000,
  windowsHide: true,
  maxBuffer: 2 * 1024 * 1024,
});
const rows = JSON.parse(stdout).secrets;
const digest = (name) => rows.find((entry) => entry.name === name)?.value;
const modeOff = digest("MEDCLIP_MUSIC_TEST_RELEASE_MODE") === sha256("OFF");
const allowlistUserAOnly = digest("MEDCLIP_MUSIC_TESTER_USER_IDS") === sha256(userAId)
  && digest("MEDCLIP_MUSIC_TESTER_USER_IDS") !== sha256(userBId);

console.log(`TEST MODE OFF = ${modeOff ? "YES" : "NO"}`);
console.log(`ALLOWLIST IS USER A ONLY = ${allowlistUserAOnly ? "YES" : "NO"}`);
if (!modeOff || !allowlistUserAOnly) process.exitCode = 1;
