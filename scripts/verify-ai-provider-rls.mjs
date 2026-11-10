import { createClient } from "@supabase/supabase-js";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const credentials = {
  userA: {
    email: process.env.MEDCLIP_TEST_USER_A_EMAIL,
    password: process.env.MEDCLIP_TEST_USER_A_PASSWORD,
  },
  userB: {
    email: process.env.MEDCLIP_TEST_USER_B_EMAIL,
    password: process.env.MEDCLIP_TEST_USER_B_PASSWORD,
  },
};

function createBrowserClient() {
  return createClient(projectUrl, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function pass(label) {
  console.log(`PASS: ${label}`);
}

function errorCode(result) {
  return result?.error?.code ?? result?.error?.status ?? "unknown";
}

function requireSuccess(result, label) {
  if (result.error) {
    throw new Error(`${label}: failed (${errorCode(result)})`);
  }
  pass(label);
  return result.data;
}

function requireError(result, label) {
  if (!result.error) {
    throw new Error(`${label}: operation unexpectedly succeeded`);
  }
  pass(label);
}

async function signIn(client, credential, label) {
  const result = await client.auth.signInWithPassword(credential);
  const data = requireSuccess(result, `${label} authenticated`);
  if (!data.user) throw new Error(`${label}: authenticated session has no user`);
  return data.user;
}

function requireOnlyOwnRows(rows, userId, label) {
  if (!Array.isArray(rows) || rows.some((row) => row.user_id !== userId)) {
    throw new Error(`${label}: cross-user metadata was visible`);
  }
  pass(label);
}

async function main() {
  const requiredEnvironment = [
    ["NEXT_PUBLIC_SUPABASE_URL", projectUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey],
    ["MEDCLIP_TEST_USER_A_EMAIL", credentials.userA.email],
    ["MEDCLIP_TEST_USER_A_PASSWORD", credentials.userA.password],
    ["MEDCLIP_TEST_USER_B_EMAIL", credentials.userB.email],
    ["MEDCLIP_TEST_USER_B_PASSWORD", credentials.userB.password],
  ];
  const missing = requiredEnvironment
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    console.error(`AI PROVIDER RLS TEST = NOT READY; missing variables: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const anonymous = createBrowserClient();
  const userAClient = createBrowserClient();
  const userBClient = createBrowserClient();
  const metadataColumns = [
    "id",
    "user_id",
    "provider",
    "provider_resource_id",
    "key_last4",
    "status",
    "last_validated_at",
    "created_at",
    "updated_at",
  ].join(",");
  const nonexistentUserId = crypto.randomUUID();
  const nonexistentConnectionId = crypto.randomUUID();

  try {
    const userA = await signIn(userAClient, credentials.userA, "User A");
    const userB = await signIn(userBClient, credentials.userB, "User B");

    const ownRowsA = requireSuccess(
      await userAClient.from("user_ai_provider_connections").select(metadataColumns),
      "Authenticated User A can select metadata",
    );
    requireOnlyOwnRows(ownRowsA, userA.id, "User A metadata SELECT is owner-scoped");

    const ownRowsB = requireSuccess(
      await userBClient.from("user_ai_provider_connections").select(metadataColumns),
      "Authenticated User B can select metadata",
    );
    requireOnlyOwnRows(ownRowsB, userB.id, "User B metadata SELECT is owner-scoped");

    const userAReadsUserB = requireSuccess(
      await userAClient
        .from("user_ai_provider_connections")
        .select("id,user_id")
        .eq("user_id", userB.id),
      "User A cross-user metadata query is safely filtered",
    );
    if (userAReadsUserB.length !== 0) {
      throw new Error("User A can read User B metadata");
    }
    pass("User A cannot read User B metadata");

    const userBReadsUserA = requireSuccess(
      await userBClient
        .from("user_ai_provider_connections")
        .select("id,user_id")
        .eq("user_id", userA.id),
      "User B cross-user metadata query is safely filtered",
    );
    if (userBReadsUserA.length !== 0) {
      throw new Error("User B can read User A metadata");
    }
    pass("User B cannot read User A metadata");

    requireError(
      await anonymous.from("user_ai_provider_connections").select("id").limit(1),
      "Anonymous metadata access is blocked",
    );

    requireError(
      await userAClient.from("user_ai_provider_connections").insert({
        id: nonexistentConnectionId,
        user_id: nonexistentUserId,
        provider: "deepseek",
        provider_resource_id: null,
        key_last4: "TEST",
      }).select("id"),
      "Authenticated direct metadata INSERT is blocked",
    );
    requireError(
      await userAClient
        .from("user_ai_provider_connections")
        .update({ status: "needs_update" })
        .eq("id", nonexistentConnectionId)
        .select("id"),
      "Authenticated direct metadata UPDATE is blocked",
    );
    requireError(
      await userAClient
        .from("user_ai_provider_connections")
        .delete()
        .eq("id", nonexistentConnectionId)
        .select("id"),
      "Authenticated direct metadata DELETE is blocked",
    );

    requireError(
      await anonymous
        .schema("medclip_private")
        .from("user_ai_credentials")
        .select("connection_id")
        .limit(1),
      "Anonymous private credential access is blocked",
    );
    requireError(
      await userAClient
        .schema("medclip_private")
        .from("user_ai_credentials")
        .select("connection_id")
        .limit(1),
      "Authenticated private credential access is blocked",
    );

    const upsertProbe = {
      target_user_id: nonexistentUserId,
      target_provider: "deepseek",
      target_provider_resource_id: null,
      target_key_last4: "TEST",
      target_ciphertext: "runtime-probe-ciphertext-0000",
      target_iv: "runtime-probe-iv-0000",
      target_encryption_version: 1,
      target_validated_at: new Date().toISOString(),
    };
    requireError(
      await userAClient.rpc("medclip_upsert_ai_provider_credential", upsertProbe),
      "Authenticated credential UPSERT RPC is blocked",
    );
    requireError(
      await userAClient.rpc("medclip_get_ai_provider_credential", {
        target_user_id: nonexistentUserId,
        target_provider: "deepseek",
      }),
      "Authenticated credential GET RPC is blocked",
    );
    requireError(
      await userAClient.rpc("medclip_delete_ai_provider_credential", {
        target_user_id: nonexistentUserId,
        target_provider: "deepseek",
      }),
      "Authenticated credential DELETE RPC is blocked",
    );

    for (const forbiddenColumn of ["api_key", "plaintext_api_key", "credential", "secret"]) {
      requireError(
        await userAClient
          .from("user_ai_provider_connections")
          .select(forbiddenColumn)
          .limit(1),
        `Metadata plaintext column ${forbiddenColumn} is absent`,
      );
    }

    console.log("AI PROVIDER RLS TEST = PASS");
    console.log("PRODUCTION DATA MODIFIED = NO");
  } catch (error) {
    console.error(`AI PROVIDER RLS TEST = FAIL: ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([
      userAClient.auth.signOut(),
      userBClient.auth.signOut(),
    ]);
  }
}

await main();
