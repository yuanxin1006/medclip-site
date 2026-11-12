import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const supabaseCli = require.resolve("supabase/dist/supabase.js");

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

const OPERATION_PREFIX = "c1c2_remote_";
const TRACK_TITLE_PREFIX = "C1C2 verifier ";
const TRACK_ARTIST = "MedClip C1C2 verifier";
const TASK = "music.generate";
const PROVIDER = "tencent_tokenhub";

function requireEnvironment() {
  const required = [
    ["NEXT_PUBLIC_SUPABASE_URL", projectUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey],
    ["MEDCLIP_TEST_USER_A_EMAIL", credentials.userA.email],
    ["MEDCLIP_TEST_USER_A_PASSWORD", credentials.userA.password],
    ["MEDCLIP_TEST_USER_B_EMAIL", credentials.userB.email],
    ["MEDCLIP_TEST_USER_B_PASSWORD", credentials.userB.password],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) throw new Error(`Missing verifier environment: ${missing.join(", ")}`);
}

function createBrowserClient() {
  return createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function assertUUID(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} is not a UUID.`);
  }
  return value.toLowerCase();
}

function assertOperationId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value)) throw new Error("Verifier operation ID is invalid.");
  return value;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function canonicalHash(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function runSQL(sql) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [supabaseCli, "db", "query", "--linked", sql],
    { cwd: process.cwd(), timeout: 120_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

async function expectSQLFailure(sql, expectedCode) {
  const expectedCodes = Array.isArray(expectedCode) ? expectedCode : [expectedCode];
  try {
    await runSQL(sql);
  } catch (error) {
    const diagnostic = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    if (expectedCodes.some((code) => diagnostic.includes(code))) return;
    throw new Error(`Remote SQL failed outside the expected ${expectedCodes.join(" or ")} contract.`);
  }
  throw new Error(`Remote SQL unexpectedly accepted ${expectedCodes.join(" or ")}.`);
}

function resultObject(rows, label) {
  const value = rows[0]?.result;
  const result = typeof value === "string" ? JSON.parse(value) : value;
  if (!result || typeof result !== "object") throw new Error(`${label} returned invalid data.`);
  return result;
}

async function signIn(client, account, label) {
  const { data, error } = await client.auth.signInWithPassword(account);
  if (error || !data.user) throw new Error(`${label} sign-in failed.`);
  return { client, user: data.user };
}

async function assertBrowserDenied(client, userAId, operationId, label) {
  const privateRead = await client
    .schema("medclip_private")
    .from("music_generation_operations")
    .select("id")
    .limit(1);
  if (!privateRead.error) throw new Error(`${label} unexpectedly read the private operation table.`);

  const rpcRead = await client.rpc("medclip_get_music_generation_operation", {
    target_user_id: userAId,
    target_operation_id: operationId,
  });
  if (!rpcRead.error) throw new Error(`${label} unexpectedly executed the server-only read RPC.`);

  const rpcMutation = await client.rpc("medclip_transition_music_generation_operation", {
    target_user_id: userAId,
    target_operation_id: operationId,
    expected_state: "RESERVED",
    next_state: "PROVIDER_IN_FLIGHT",
    next_provider_call_count: 1,
  });
  if (!rpcMutation.error) throw new Error(`${label} unexpectedly executed the server-only transition RPC.`);
}

function reserveSQL(userId, operationId, requestHash) {
  return `select public.medclip_reserve_music_generation_operation(${sqlLiteral(userId)}::uuid, ${sqlLiteral(operationId)}, ${sqlLiteral(TASK)}, ${sqlLiteral(PROVIDER)}, ${sqlLiteral(requestHash)}) as result;`;
}

function transitionSQL(userId, operationId, expectedState, nextState, providerCallCount, options = {}) {
  const requestId = options.requestId ? sqlLiteral(options.requestId) : "null";
  const traceId = options.traceId ? sqlLiteral(options.traceId) : "null";
  const trackId = options.trackId ? `${sqlLiteral(options.trackId)}::uuid` : "null";
  const failureCode = options.failureCode ? sqlLiteral(options.failureCode) : "null";
  return `select public.medclip_transition_music_generation_operation(${sqlLiteral(userId)}::uuid, ${sqlLiteral(operationId)}, ${sqlLiteral(expectedState)}, ${sqlLiteral(nextState)}, ${providerCallCount}::smallint, ${requestId}, ${traceId}, ${trackId}, ${failureCode}) as result;`;
}

function authorizeDispatchSQL(userId, operationId) {
  return `select public.medclip_authorize_music_provider_dispatch(${sqlLiteral(userId)}::uuid, ${sqlLiteral(operationId)}, true, false, 100000, 100000) as result;`;
}

async function assertNoStaleFixtures(userAId, userBId) {
  const users = `${sqlLiteral(userAId)}::uuid, ${sqlLiteral(userBId)}::uuid`;
  const rows = await runSQL(`select
    (select count(*)::int from medclip_private.music_generation_operations where user_id in (${users}) and operation_id like ${sqlLiteral(`${OPERATION_PREFIX}%`)}) as operation_count,
    (select count(*)::int from public.music_tracks where user_id in (${users}) and artist_name = ${sqlLiteral(TRACK_ARTIST)} and title like ${sqlLiteral(`${TRACK_TITLE_PREFIX}%`)}) as track_count;`);
  if (Number(rows[0]?.operation_count ?? -1) !== 0 || Number(rows[0]?.track_count ?? -1) !== 0) {
    throw new Error("Stale verifier fixtures must be investigated before a new run.");
  }
}

async function createTrackFixture(client, userId, title) {
  const { data, error } = await client
    .from("music_tracks")
    .insert({
      user_id: userId,
      title,
      artist_name: TRACK_ARTIST,
      description: "",
      published: false,
    })
    .select("id,user_id,published")
    .single();
  if (error || !data) throw new Error("Authenticated track fixture creation failed.");
  const trackId = assertUUID(data.id, "Verifier track ID");
  if (data.user_id !== userId || data.published !== false) {
    throw new Error("Track fixture was not owner-bound and unpublished.");
  }
  return { userId, trackId };
}

async function assertCrossUserTrackRejected(userAClient, userAId, operationId, userBTrackId) {
  const visibility = await userAClient.from("music_tracks").select("id").eq("id", userBTrackId);
  if (visibility.error || (visibility.data?.length ?? 0) !== 0) {
    throw new Error("User A unexpectedly read User B's draft track.");
  }
  const transition = await userAClient.rpc("medclip_transition_music_generation_operation", {
    target_user_id: userAId,
    target_operation_id: operationId,
    expected_state: "FINALIZING",
    next_state: "COMPLETED",
    next_provider_call_count: 1,
    next_final_track_id: userBTrackId,
  });
  if (!transition.error) throw new Error("User A unexpectedly supplied a cross-user final_track_id.");
}

async function cleanupRunFixtures(userAId, userBId, operationIds, tracks) {
  const users = `${sqlLiteral(userAId)}::uuid, ${sqlLiteral(userBId)}::uuid`;
  if (operationIds.size > 0) {
    const ids = [...operationIds].map(sqlLiteral).join(", ");
    await runSQL(`delete from medclip_private.music_generation_operations where user_id in (${users}) and operation_id in (${ids});`);
  }
  if (tracks.length > 0) {
    const trackIds = tracks.map(({ trackId }) => `${sqlLiteral(trackId)}::uuid`).join(", ");
    await runSQL(`delete from public.music_tracks where user_id in (${users}) and id in (${trackIds}) and artist_name = ${sqlLiteral(TRACK_ARTIST)};`);
  }
}

async function remainingRunFixtureCounts(userAId, userBId, operationIds, tracks) {
  const users = `${sqlLiteral(userAId)}::uuid, ${sqlLiteral(userBId)}::uuid`;
  const operationFilter = operationIds.size > 0
    ? `user_id in (${users}) and operation_id in (${[...operationIds].map(sqlLiteral).join(", ")})`
    : "false";
  const trackFilter = tracks.length > 0
    ? `user_id in (${users}) and id in (${tracks.map(({ trackId }) => `${sqlLiteral(trackId)}::uuid`).join(", ")})`
    : "false";
  const storageFilter = tracks.length > 0
    ? tracks.map(({ userId, trackId }) => `name like ${sqlLiteral(`${userId}/${trackId}/%`)}`).join(" or ")
    : "false";
  const rows = await runSQL(`select
    (select count(*)::int from medclip_private.music_generation_operations where ${operationFilter}) as operation_count,
    (select count(*)::int from public.music_tracks where ${trackFilter}) as track_count,
    (select count(*)::int from storage.objects where bucket_id in ('music-audio', 'music-covers') and (${storageFilter})) as storage_count;`);
  return {
    operations: Number(rows[0]?.operation_count ?? -1),
    tracks: Number(rows[0]?.track_count ?? -1),
    storage: Number(rows[0]?.storage_count ?? -1),
  };
}

async function main() {
  requireEnvironment();
  const anon = createBrowserClient();
  const userAClient = createBrowserClient();
  const userBClient = createBrowserClient();
  let userA;
  let userB;
  let cleanupPassed = false;
  let validExistingTrackAccepted = false;
  let nonexistentTrackRejected = false;
  let crossUserTrackRejected = false;
  const operationIds = new Set();
  const tracks = [];

  try {
    userA = await signIn(userAClient, credentials.userA, "User A");
    userB = await signIn(userBClient, credentials.userB, "User B");
    const userAId = assertUUID(userA.user.id, "User A ID");
    const userBId = assertUUID(userB.user.id, "User B ID");
    await assertNoStaleFixtures(userAId, userBId);

    const run = randomUUID().replaceAll("-", "");
    const sameId = assertOperationId(`${OPERATION_PREFIX}${run}_same`);
    const concurrentId = assertOperationId(`${OPERATION_PREFIX}${run}_concurrent`);
    const boundaryId = assertOperationId(`${OPERATION_PREFIX}${run}_boundary`);
    const unknownId = assertOperationId(`${OPERATION_PREFIX}${run}_unknown`);
    const missingTrackId = assertOperationId(`${OPERATION_PREFIX}${run}_missing_track`);
    const crossUserTrackId = assertOperationId(`${OPERATION_PREFIX}${run}_cross_user_track`);
    const completedId = assertOperationId(`${OPERATION_PREFIX}${run}_completed`);
    for (const operationId of [sameId, concurrentId, boundaryId, unknownId, missingTrackId, crossUserTrackId, completedId]) {
      operationIds.add(operationId);
    }
    const requestHash = canonicalHash({ task: TASK, provider: PROVIDER, mode: "custom_lyrics", lyrics: "synthetic line", prompt: "small fixture", title: "fixture" });
    const differentHash = canonicalHash({ task: TASK, provider: PROVIDER, mode: "custom_lyrics", lyrics: "different synthetic line", prompt: "small fixture", title: "fixture" });

    const first = resultObject(await runSQL(reserveSQL(userAId, sameId, requestHash)), "first reserve");
    const replay = resultObject(await runSQL(reserveSQL(userAId, sameId, requestHash)), "same-payload replay");
    if (first.created !== true || replay.created !== false || first.id !== replay.id) {
      throw new Error("Same-ID same-payload reservation did not reuse one durable operation.");
    }
    await expectSQLFailure(reserveSQL(userAId, sameId, differentHash), "OPERATION_CONFLICT");

    const userBReservation = resultObject(await runSQL(reserveSQL(userBId, sameId, requestHash)), "User B reserve");
    if (userBReservation.created !== true || userBReservation.id === first.id) {
      throw new Error("Owner-scoped operation identity was not independent.");
    }
    await assertBrowserDenied(userBClient, userAId, sameId, "User B");
    await assertBrowserDenied(anon, userAId, sameId, "Anonymous user");

    // The linked Management API serializes its temporary login-role setup, so
    // two concurrent CLI processes are not a safe remote transport. Exercise
    // both volatile reserve calls in one remote statement and combine the
    // result with the deployed UNIQUE constraint and ON CONFLICT contract.
    const doubleReserveRows = await runSQL(
      `select public.medclip_reserve_music_generation_operation(${sqlLiteral(userAId)}::uuid, ${sqlLiteral(concurrentId)}, ${sqlLiteral(TASK)}, ${sqlLiteral(PROVIDER)}, ${sqlLiteral(requestHash)}) as first_result, public.medclip_reserve_music_generation_operation(${sqlLiteral(userAId)}::uuid, ${sqlLiteral(concurrentId)}, ${sqlLiteral(TASK)}, ${sqlLiteral(PROVIDER)}, ${sqlLiteral(requestHash)}) as second_result;`,
    );
    const concurrentResults = ["first_result", "second_result"].map((field, index) => {
      const value = doubleReserveRows[0]?.[field];
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (!parsed || typeof parsed !== "object") throw new Error(`double reserve ${index + 1} returned invalid data.`);
      return parsed;
    });
    const createdCount = concurrentResults.filter((result) => result.created === true).length;
    const concurrentCountRows = await runSQL(`select count(*)::int as count from medclip_private.music_generation_operations where user_id = ${sqlLiteral(userAId)}::uuid and operation_id = ${sqlLiteral(concurrentId)};`);
    if (createdCount !== 1 || Number(concurrentCountRows[0]?.count) !== 1) {
      throw new Error("Concurrent reservation did not converge to one durable operation.");
    }

    await runSQL(reserveSQL(userAId, boundaryId, requestHash));
    await expectSQLFailure(transitionSQL(userAId, boundaryId, "RESERVED", "PROVIDER_IN_FLIGHT", 1), "INVALID_OPERATION_TRANSITION");
    await runSQL(authorizeDispatchSQL(userAId, boundaryId));
    await expectSQLFailure(
      `update medclip_private.music_generation_operations set provider_call_count = 2 where user_id = ${sqlLiteral(userAId)}::uuid and operation_id = ${sqlLiteral(boundaryId)};`,
      ["music_generation_operations_provider_call_count_safe", "music_generation_operations_dispatch_timestamp_safe"],
    );

    await runSQL(reserveSQL(userAId, unknownId, requestHash));
    await runSQL(authorizeDispatchSQL(userAId, unknownId));
    await runSQL(transitionSQL(userAId, unknownId, "PROVIDER_IN_FLIGHT", "UNKNOWN", 1, { failureCode: "TEST_UNKNOWN" }));
    const unknownReplay = resultObject(await runSQL(reserveSQL(userAId, unknownId, requestHash)), "UNKNOWN replay");
    if (unknownReplay.created !== false || unknownReplay.state !== "UNKNOWN" || unknownReplay.provider_call_count !== 1) {
      throw new Error("UNKNOWN replay did not preserve the terminal ambiguous state.");
    }
    await expectSQLFailure(transitionSQL(userAId, unknownId, "UNKNOWN", "PROVIDER_IN_FLIGHT", 1), "INVALID_OPERATION_TRANSITION");

    await runSQL(reserveSQL(userAId, missingTrackId, requestHash));
    await runSQL(authorizeDispatchSQL(userAId, missingTrackId));
    await runSQL(transitionSQL(userAId, missingTrackId, "PROVIDER_IN_FLIGHT", "FINALIZING", 1));
    await expectSQLFailure(
      transitionSQL(userAId, missingTrackId, "FINALIZING", "COMPLETED", 1, { trackId: randomUUID() }),
      "23503",
    );
    nonexistentTrackRejected = true;

    const userBTrack = await createTrackFixture(userBClient, userBId, `${TRACK_TITLE_PREFIX}${run} User B`);
    tracks.push(userBTrack);
    await runSQL(reserveSQL(userAId, crossUserTrackId, requestHash));
    await runSQL(authorizeDispatchSQL(userAId, crossUserTrackId));
    await runSQL(transitionSQL(userAId, crossUserTrackId, "PROVIDER_IN_FLIGHT", "FINALIZING", 1));
    await assertCrossUserTrackRejected(userAClient, userAId, crossUserTrackId, userBTrack.trackId);
    crossUserTrackRejected = true;

    const userATrack = await createTrackFixture(userAClient, userAId, `${TRACK_TITLE_PREFIX}${run} User A`);
    tracks.push(userATrack);
    const trackId = userATrack.trackId;
    await runSQL(reserveSQL(userAId, completedId, requestHash));
    await runSQL(authorizeDispatchSQL(userAId, completedId));
    await runSQL(transitionSQL(userAId, completedId, "PROVIDER_IN_FLIGHT", "FINALIZING", 1, { requestId: "c1c2-request", traceId: "c1c2-trace" }));
    await runSQL(transitionSQL(userAId, completedId, "FINALIZING", "COMPLETED", 1, { trackId }));
    const completedReplay = resultObject(await runSQL(reserveSQL(userAId, completedId, requestHash)), "COMPLETED replay");
    if (completedReplay.created !== false || completedReplay.state !== "COMPLETED" || completedReplay.final_track_id !== trackId) {
      throw new Error("COMPLETED replay did not preserve the durable result.");
    }
    validExistingTrackAccepted = true;
    await expectSQLFailure(transitionSQL(userAId, completedId, "COMPLETED", "PROVIDER_IN_FLIGHT", 1), "INVALID_OPERATION_TRANSITION");

    console.log("REMOTE MUSIC OPERATION VERIFIER = PASS");
    console.log("SAME-ID SAME-PAYLOAD REMOTE = PASS");
    console.log("SAME-ID DIFFERENT-PAYLOAD REMOTE = PASS");
    console.log("CONCURRENT DUPLICATE REMOTE = PASS (UNIQUE + ON CONFLICT ATOMIC CONTRACT)");
    console.log("CROSS-USER OPERATION ISOLATION = PASS");
    console.log("PROVIDER CALL COUNT >1 REJECTED = PASS");
    console.log("UNKNOWN AUTO-RETRY = NO");
    console.log("COMPLETED AUTO-REGENERATE = NO");
    console.log("VALID EXISTING FINAL TRACK = PASS");
    console.log("NONEXISTENT FINAL TRACK FK = PASS");
    console.log("CROSS-USER FINAL TRACK = BLOCKED BY RLS + SERVER-ONLY RPC");
    console.log("TOKENHUB PROVIDER CALLS = 0");
  } finally {
    if (userA?.user && userB?.user) {
      try {
        await cleanupRunFixtures(userA.user.id, userB.user.id, operationIds, tracks);
        const remaining = await remainingRunFixtureCounts(userA.user.id, userB.user.id, operationIds, tracks);
        cleanupPassed = remaining.operations === 0 && remaining.tracks === 0 && remaining.storage === 0;
        console.log(`FINAL TEST MUSIC OPERATIONS REMAIN = ${remaining.operations}`);
        console.log(`FINAL TEST MUSIC TRACKS REMAIN = ${remaining.tracks}`);
        console.log(`FINAL TEST STORAGE OBJECTS REMAIN = ${remaining.storage}`);
      } catch {
        cleanupPassed = false;
      }
    }
    await userAClient.auth.signOut({ scope: "local" });
    await userBClient.auth.signOut({ scope: "local" });
    await anon.auth.signOut({ scope: "local" });
    console.log(`REMOTE MUSIC OPERATION CLEANUP = ${cleanupPassed ? "PASS" : "FAIL"}`);
    console.log(`SUCCESS FIXTURE CLEANUP = ${cleanupPassed && validExistingTrackAccepted ? "PASS" : "FAIL"}`);
    console.log(`INDUCED FAILURE CLEANUP = ${cleanupPassed && nonexistentTrackRejected ? "PASS" : "FAIL"}`);
    console.log(`CROSS-USER FIXTURE CLEANUP = ${cleanupPassed && crossUserTrackRejected ? "PASS" : "FAIL"}`);
    if (!cleanupPassed) process.exitCode = 1;
  }
}

await main();
