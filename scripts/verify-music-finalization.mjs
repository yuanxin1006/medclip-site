import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  finalizeGeneratedMusic,
} from "../supabase/functions/_shared/ai-tasks/music-finalization.ts";
import { createAuthenticatedMusicFinalizationRepository } from "../supabase/functions/_shared/ai-tasks/music-track-repository.ts";

const SYNTHETIC_MP3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);

function requireEnvironment() {
  const names = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "MEDCLIP_TEST_USER_A_EMAIL",
    "MEDCLIP_TEST_USER_A_PASSWORD",
    "MEDCLIP_TEST_USER_B_EMAIL",
    "MEDCLIP_TEST_USER_B_PASSWORD",
  ];
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing finalization verifier environment: ${missing.join(", ")}`);
  return {
    projectUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    userA: {
      email: process.env.MEDCLIP_TEST_USER_A_EMAIL,
      password: process.env.MEDCLIP_TEST_USER_A_PASSWORD,
    },
    userB: {
      email: process.env.MEDCLIP_TEST_USER_B_EMAIL,
      password: process.env.MEDCLIP_TEST_USER_B_PASSWORD,
    },
  };
}

function browserClient(projectUrl, anonKey) {
  return createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signIn(client, account) {
  const { data, error } = await client.auth.signInWithPassword(account);
  if (error || !data.user) throw new Error("Finalization verifier authentication failed.");
  return data.user;
}

function inMemoryFinalizingOperation(userId) {
  const now = new Date().toISOString();
  let operation = {
    id: randomUUID(),
    userId,
    operationId: `c1d_finalization_fixture_${randomUUID().replaceAll("-", "")}`,
    task: "music.generate",
    provider: "tencent_tokenhub",
    requestHash: "a".repeat(64),
    state: "FINALIZING",
    providerCallCount: 1,
    providerRequestId: "synthetic-request",
    providerTraceId: "synthetic-trace",
    finalTrackId: null,
    failureCode: null,
    createdAt: now,
    updatedAt: now,
  };
  return {
    initial: operation,
    repository: {
      async reserve() { throw new Error("Finalization-only verifier cannot reserve operations."); },
      async load(targetUserId, operationId) {
        return operation.userId === targetUserId && operation.operationId === operationId ? operation : null;
      },
      async transition(input) {
        assert.equal(input.userId, operation.userId);
        assert.equal(input.operationId, operation.operationId);
        assert.equal(input.expectedState, operation.state);
        assert.equal(input.providerCallCount, 1);
        operation = {
          ...operation,
          state: input.nextState,
          providerCallCount: input.providerCallCount,
          providerRequestId: input.providerRequestId ?? operation.providerRequestId,
          providerTraceId: input.providerTraceId ?? operation.providerTraceId,
          finalTrackId: input.finalTrackId ?? operation.finalTrackId,
          failureCode: input.failureCode ?? null,
          updatedAt: new Date().toISOString(),
        };
        return operation;
      },
    },
    current: () => operation,
  };
}

export async function runMusicFinalizationVerifier() {
  const env = requireEnvironment();
  const userAClient = browserClient(env.projectUrl, env.anonKey);
  const userBClient = browserClient(env.projectUrl, env.anonKey);
  let trackId = null;
  let audioPath = null;
  try {
    const userA = await signIn(userAClient, env.userA);
    await signIn(userBClient, env.userB);
    const operation = inMemoryFinalizingOperation(userA.id);
    const finalized = await finalizeGeneratedMusic(
      userA.id,
      operation.initial,
      {
        operationId: operation.initial.operationId,
        mode: "instrumental",
        prompt: "synthetic finalization-only fixture",
        title: "C1D finalization verifier",
      },
      {
        audioBytes: SYNTHETIC_MP3,
        providerReportedDurationSeconds: 1,
        serverVerifiedDurationSeconds: null,
        format: "mp3",
        metadata: { musicSize: SYNTHETIC_MP3.byteLength },
        usage: null,
        metrics: {
          providerResponseMs: 0,
          providerRequestDurationMs: 0,
          providerGenerationLatencyMs: 0,
          hexValidationDecodeMs: 0,
          mp3ValidationMs: 0,
          hexCharacterLength: 0,
        },
      },
      {
        tracks: createAuthenticatedMusicFinalizationRepository(userAClient),
        operations: operation.repository,
      },
    );
    trackId = finalized.trackId;
    audioPath = finalized.path;
    assert.equal(finalized.path, `${userA.id}/${trackId}/audio.mp3`);
    assert.equal(finalized.published, false);
    assert.equal(operation.current().state, "COMPLETED");
    assert.equal(operation.current().finalTrackId, trackId);

    const ownTrack = await userAClient
      .from("music_tracks")
      .select("id,user_id,audio_path,published")
      .eq("id", trackId)
      .maybeSingle();
    assert.equal(ownTrack.error, null);
    assert.equal(ownTrack.data?.user_id, userA.id);
    assert.equal(ownTrack.data?.audio_path, audioPath);
    assert.equal(ownTrack.data?.published, false);

    const otherTrack = await userBClient.from("music_tracks").select("id").eq("id", trackId);
    assert.equal(otherTrack.error, null);
    assert.deepEqual(otherTrack.data, []);
    const otherAudio = await userBClient.storage.from("music-audio").createSignedUrl(audioPath, 60);
    assert.ok(otherAudio.error || !otherAudio.data?.signedUrl);

    console.log("FINALIZATION-ONLY HARNESS = PASS");
    console.log("DRAFT CREATE = PASS");
    console.log("STORAGE UPLOAD = PASS");
    console.log("TRACK FINALIZATION = PASS");
    console.log("OPERATION COMPLETION = PASS");
    console.log("OWNER BINDING = PASS");
    console.log("DRAFT PUBLIC VISIBILITY = BLOCKED");
    console.log("TOKENHUB PROVIDER CALLS = 0");
  } finally {
    if (audioPath) {
      const { error } = await userAClient.storage.from("music-audio").remove([audioPath]);
      assert.equal(error, null);
    }
    if (trackId) {
      const { error } = await userAClient.from("music_tracks").delete().eq("id", trackId);
      assert.equal(error, null);
    }
    const remainingTrack = trackId
      ? await userAClient.from("music_tracks").select("id").eq("id", trackId)
      : { data: [], error: null };
    assert.equal(remainingTrack.error, null);
    assert.deepEqual(remainingTrack.data, []);
    await Promise.allSettled([
      userAClient.auth.signOut({ scope: "local" }),
      userBClient.auth.signOut({ scope: "local" }),
    ]);
  }
  console.log("FINALIZATION HARNESS CLEANUP = PASS");
}

await runMusicFinalizationVerifier();
