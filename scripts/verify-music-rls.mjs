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

function createAnonClient() {
  return createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function pass(label) {
  console.log(`PASS: ${label}`);
}

function requireSuccess(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  pass(label);
  return result.data;
}

function requireDenied(result, label) {
  const emptyResult = Array.isArray(result.data) && result.data.length === 0;
  if (!result.error && !emptyResult) throw new Error(`${label}: operation unexpectedly succeeded`);
  pass(label);
}

async function requireReadableSignedUrl(client, bucket, path, label) {
  const signed = await client.storage.from(bucket).createSignedUrl(path, 120);
  const data = requireSuccess(signed, `${label} (signed URL)`);
  const response = await fetch(data.signedUrl);
  if (!response.ok) throw new Error(`${label}: signed media returned HTTP ${response.status}`);
  pass(`${label} (media read)`);
}

async function signInTestUser(client, credential, label) {
  const result = await client.auth.signInWithPassword(credential);
  const data = requireSuccess(result, `${label} normal email/password sign-in`);
  if (!data.user) throw new Error(`${label}: no authenticated user returned`);
  return data.user;
}

async function main() {
  const missingFoundation = [
    ["NEXT_PUBLIC_SUPABASE_URL", projectUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missingFoundation.length) {
    console.error(`RUNTIME RLS TEST = NOT READY; missing: ${missingFoundation.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const missingCredentials = [
    ["MEDCLIP_TEST_USER_A_EMAIL", credentials.userA.email],
    ["MEDCLIP_TEST_USER_A_PASSWORD", credentials.userA.password],
    ["MEDCLIP_TEST_USER_B_EMAIL", credentials.userB.email],
    ["MEDCLIP_TEST_USER_B_PASSWORD", credentials.userB.password],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missingCredentials.length) {
    console.log("RUNTIME RLS TEST = READY, NOT RUN");
    console.log(`Missing local test variables: ${missingCredentials.join(", ")}`);
    return;
  }

  const anonymous = createAnonClient();
  const userAClient = createAnonClient();
  const userBClient = createAnonClient();
  let userA;
  let userB;
  let trackId;
  let audioPath;
  const cleanupFailures = [];

  try {
    userA = await signInTestUser(userAClient, credentials.userA, "User A");
    userB = await signInTestUser(userBClient, credentials.userB, "User B");

    requireSuccess(
      await anonymous.from("music_tracks").select("id").eq("published", true).limit(1),
      "Anonymous can query published tracks",
    );

    const createdTrack = requireSuccess(
      await userAClient.from("music_tracks").insert({
        user_id: userA.id,
        title: `RLS verification ${new Date().toISOString()}`,
        artist_name: "MedClip Test User A",
      }).select("*").single(),
      "User A can create own draft track",
    );
    trackId = createdTrack.id;
    audioPath = `${userA.id}/${trackId}/audio.mp3`;

    requireSuccess(
      await userAClient.from("music_tracks").select("id").eq("id", trackId).single(),
      "User A can read own draft",
    );
    requireSuccess(
      await userAClient.from("music_tracks").update({ description: "RLS runtime verification" }).eq("id", trackId).select("id").single(),
      "User A can update own track",
    );

    const anonymousDraftRead = await anonymous.from("music_tracks").select("id").eq("id", trackId);
    if (anonymousDraftRead.error || anonymousDraftRead.data.length !== 0) {
      throw new Error("Anonymous draft track must be invisible");
    }
    pass("Anonymous cannot read draft tracks");

    const userBDraftRead = await userBClient.from("music_tracks").select("id").eq("id", trackId);
    if (userBDraftRead.error || userBDraftRead.data.length !== 0) {
      throw new Error("User B must not read User A draft track");
    }
    pass("User B cannot read User A draft track");

    requireDenied(
      await anonymous.from("music_tracks").insert({ user_id: userA.id, title: "Denied", artist_name: "Denied" }).select("id"),
      "Anonymous cannot create tracks",
    );
    requireDenied(
      await anonymous.from("music_tracks").update({ title: "Denied" }).eq("id", trackId).select("id"),
      "Anonymous cannot update tracks",
    );
    requireDenied(
      await anonymous.from("music_tracks").delete().eq("id", trackId).select("id"),
      "Anonymous cannot delete tracks",
    );
    requireDenied(
      await userBClient.from("music_tracks").update({ title: "Denied" }).eq("id", trackId).select("id"),
      "User B cannot update User A track",
    );
    requireDenied(
      await userBClient.from("music_tracks").delete().eq("id", trackId).select("id"),
      "User B cannot delete User A track",
    );

    const testAudio = new Blob([new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0])], { type: "audio/mpeg" });
    requireDenied(
      await anonymous.storage.from("music-audio").upload(audioPath, testAudio, { contentType: "audio/mpeg" }),
      "Anonymous cannot upload media",
    );
    requireDenied(
      await userBClient.storage.from("music-audio").upload(audioPath, testAudio, { contentType: "audio/mpeg" }),
      "User B cannot upload into User A path",
    );
    const forgedUserBPath = `${userB.id}/${trackId}/audio.mp3`;
    requireDenied(
      await userBClient.storage.from("music-audio").upload(forgedUserBPath, testAudio, { contentType: "audio/mpeg" }),
      "User B cannot bind User A track ID beneath User B directory",
    );
    requireSuccess(
      await userAClient.storage.from("music-audio").upload(audioPath, testAudio, { contentType: "audio/mpeg", upsert: false }),
      "User A can upload media into own valid track path",
    );

    requireDenied(
      await anonymous.storage.from("music-audio").createSignedUrl(audioPath, 120),
      "Anonymous cannot obtain signed access to draft media",
    );
    requireDenied(
      await userBClient.storage.from("music-audio").createSignedUrl(audioPath, 120),
      "User B cannot obtain signed access to User A draft media",
    );
    await requireReadableSignedUrl(userAClient, "music-audio", audioPath, "User A can read own draft media");

    requireDenied(
      await anonymous.storage.from("music-audio").update(audioPath, testAudio, { contentType: "audio/mpeg" }),
      "Anonymous cannot update media",
    );
    requireDenied(
      await anonymous.storage.from("music-audio").remove([audioPath]),
      "Anonymous cannot delete media",
    );
    requireDenied(
      await userBClient.storage.from("music-audio").update(audioPath, testAudio, { contentType: "audio/mpeg" }),
      "User B cannot update User A media",
    );
    requireDenied(
      await userBClient.storage.from("music-audio").remove([audioPath]),
      "User B cannot delete User A media",
    );

    requireSuccess(
      await userAClient.from("music_tracks").update({
        audio_path: audioPath,
        duration_seconds: 1,
        published: true,
      }).eq("id", trackId).select("id").single(),
      "User A can publish a valid track",
    );

    const userBPublished = requireSuccess(
      await userBClient.from("music_tracks").select("id").eq("id", trackId),
      "User B can query User A published track",
    );
    if (userBPublished.length !== 1) throw new Error("User B did not receive the published track");
    const anonymousPublished = requireSuccess(
      await anonymous.from("music_tracks").select("id").eq("id", trackId),
      "Anonymous can query User A published track",
    );
    if (anonymousPublished.length !== 1) throw new Error("Anonymous did not receive the published track");

    await requireReadableSignedUrl(userBClient, "music-audio", audioPath, "User B can read published media");
    await requireReadableSignedUrl(anonymous, "music-audio", audioPath, "Anonymous can read published media");
    requireDenied(
      await userBClient.from("music_tracks").update({ title: "Denied after publish" }).eq("id", trackId).select("id"),
      "User B cannot update User A published track",
    );
    requireDenied(
      await userBClient.from("music_tracks").delete().eq("id", trackId).select("id"),
      "User B cannot delete User A published track",
    );
    requireDenied(
      await userBClient.storage.from("music-audio").update(audioPath, testAudio, { contentType: "audio/mpeg" }),
      "User B cannot update User A published media",
    );
    requireDenied(
      await userBClient.storage.from("music-audio").remove([audioPath]),
      "User B cannot delete User A published media",
    );
    console.log("RUNTIME RLS TEST = PASS");
  } catch (error) {
    console.error(`RUNTIME RLS TEST = FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (audioPath && userAClient) {
      const removed = await userAClient.storage.from("music-audio").remove([audioPath]);
      if (removed.error) cleanupFailures.push(`audio cleanup: ${removed.error.message}`);
      else pass("Cleanup removed User A test media");
    }
    if (trackId && userAClient) {
      const removedTrack = await userAClient.from("music_tracks").delete().eq("id", trackId).select("id");
      if (removedTrack.error || removedTrack.data?.length !== 1) {
        cleanupFailures.push(`track cleanup: ${removedTrack.error?.message || "track was not deleted"}`);
      } else pass("Cleanup removed User A test track");
    }
    await userAClient.auth.signOut({ scope: "local" });
    await userBClient.auth.signOut({ scope: "local" });
    if (cleanupFailures.length) {
      console.error("RUNTIME RLS CLEANUP = PARTIAL FAILURE");
      cleanupFailures.forEach((failure) => console.error(failure));
      process.exitCode = 1;
    } else if (trackId) {
      console.log("RUNTIME RLS CLEANUP = PASS");
    }
  }
}

await main();
