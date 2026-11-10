import { randomUUID } from "node:crypto";
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

const sensitiveValues = [
  projectUrl,
  anonKey,
  credentials.userA.email,
  credentials.userA.password,
  credentials.userB.email,
  credentials.userB.password,
].filter(Boolean);

function safeMessage(error) {
  const fields = [];
  if (error && typeof error === "object") {
    for (const field of ["code", "message", "details", "hint"]) {
      const value = error[field];
      if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
        fields.push(`${field}=${String(value).trim()}`);
      }
    }
  } else if (error !== null && error !== undefined) {
    fields.push(`message=${String(error)}`);
  }

  let message = fields.join(" | ") || "message=Unknown error";
  for (const value of sensitiveValues) message = message.split(value).join("[REDACTED]");
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/\b(access_token|refresh_token|token|apikey)=([^&\s]+)/gi, "$1=[REDACTED]");
}

function errorCode(error) {
  if (!error || typeof error !== "object") return "";
  return String(error.code ?? "").toUpperCase();
}

function errorText(error) {
  if (!error || typeof error !== "object") return String(error ?? "").toLowerCase();
  return [error.message, error.details, error.hint]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function isDatabaseInternalError(error) {
  const code = errorCode(error);
  const text = errorText(error);
  return code === "42P17"
    || code.startsWith("XX")
    || code === "PGRST500"
    || /infinite recursion|internal (database|server) error|stack depth|recursive policy/.test(text);
}

function isIntendedSecurityDenial(error) {
  const code = errorCode(error);
  const text = errorText(error);
  return code === "42501"
    || code === "401"
    || code === "403"
    || code === "404"
    || /row-level security|permission denied|not authorized|unauthorized|access denied|object not found|not found|must belong to the work owner/.test(text);
}

function createAnonClient() {
  return createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function pass(label) {
  console.log(`PASS: ${label}`);
}

function requireSuccess(result, label) {
  if (result.error) throw new Error(`${label}: ${safeMessage(result.error)}`);
  pass(label);
  return result.data;
}

function hasMeaningfulData(data) {
  if (Array.isArray(data)) return data.length > 0;
  if (data === null || data === undefined) return false;
  if (typeof data === "object" && "signedUrl" in data) return Boolean(data.signedUrl);
  return true;
}

function requireDenied(result, label) {
  if (result.error) {
    if (isDatabaseInternalError(result.error)) {
      throw new Error(`${label}: database internal error is not a security denial | ${safeMessage(result.error)}`);
    }
    if (!isIntendedSecurityDenial(result.error)) {
      throw new Error(`${label}: unexpected error is not an accepted security denial | ${safeMessage(result.error)}`);
    }
    pass(label);
    return;
  }
  if (!result.error && hasMeaningfulData(result.data)) {
    throw new Error(`${label}: operation unexpectedly succeeded`);
  }
  pass(label);
}

function requireInvisible(result, label) {
  if (result.error) throw new Error(`${label}: ${safeMessage(result.error)}`);
  if (!Array.isArray(result.data) || result.data.length !== 0) {
    throw new Error(`${label}: protected row was visible`);
  }
  pass(label);
}

function requireOneRow(result, label) {
  const data = requireSuccess(result, label);
  if (!Array.isArray(data) || data.length !== 1) throw new Error(`${label}: expected exactly one row`);
  return data[0];
}

async function requireReadableDownload(client, path, label) {
  const data = requireSuccess(await client.storage.from("work-media").download(path), label);
  if (!(data instanceof Blob) || data.size === 0) throw new Error(`${label}: downloaded object was empty`);
}

async function requireReadableSignedUrl(client, path, label) {
  const data = requireSuccess(
    await client.storage.from("work-media").createSignedUrl(path, 120),
    `${label} (signed URL)`,
  );
  if (!data?.signedUrl) throw new Error(`${label}: no signed URL returned`);
  const response = await fetch(data.signedUrl);
  if (!response.ok) throw new Error(`${label}: signed media returned HTTP ${response.status}`);
  pass(`${label} (media read)`);
}

async function signInTestUser(client, credential, label) {
  const data = requireSuccess(
    await client.auth.signInWithPassword(credential),
    `${label} normal email/password sign-in`,
  );
  if (!data.user) throw new Error(`${label}: no authenticated user returned`);
  return data.user;
}

function createOwnerState(client) {
  return {
    client,
    user: null,
    workIds: new Set(),
    assetRows: new Map(),
    mediaPaths: new Set(),
    musicTrackIds: new Set(),
  };
}

async function createTrackedWork(owner, input, label) {
  const work = requireSuccess(
    await owner.client.from("works").insert({ user_id: owner.user.id, ...input }).select("*").single(),
    label,
  );
  owner.workIds.add(work.id);
  return work;
}

const verifierWorkSpecs = [
  {
    ownerKey: "A",
    titlePattern: "Works RLS A %",
    body: "Runtime verifier media work",
  },
  {
    ownerKey: "A",
    titlePattern: "Works text only %",
    body: "Text-only runtime publication",
  },
  {
    ownerKey: "B",
    titlePattern: "Works RLS B %",
    body: "Runtime verifier cross-user work",
  },
];

const canonicalWorkFileName = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|mp4|webm|mp3|wav)$/i;
const verifierTrackTitle = /^Works source ownership [0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireCleanupQuery(result, label) {
  if (result.error) throw new Error(`${label}: ${safeMessage(result.error)}`);
  return result.data ?? [];
}

async function removeStaleVerifierWork(owner, work, spec) {
  const unpublished = requireCleanupQuery(
    await owner.client
      .from("works")
      .update({ published: false })
      .eq("id", work.id)
      .eq("user_id", owner.user.id)
      .like("title", spec.titlePattern)
      .eq("body", spec.body)
      .select("id"),
    "stale verifier work unpublish",
  );
  if (unpublished.length !== 1) throw new Error("stale verifier work unpublish: strict row match failed");

  const assets = requireCleanupQuery(
    await owner.client
      .from("work_assets")
      .select("id, storage_path")
      .eq("work_id", work.id)
      .eq("user_id", owner.user.id),
    "stale verifier asset lookup",
  );
  const folder = `${owner.user.id}/${work.id}`;
  const listedObjects = requireCleanupQuery(
    await owner.client.storage.from("work-media").list(folder, { limit: 100 }),
    "stale verifier media lookup",
  );
  const mediaPaths = new Set(assets.map((asset) => asset.storage_path));
  for (const object of listedObjects) {
    if (!canonicalWorkFileName.test(object.name)) {
      throw new Error("stale verifier media cleanup: non-canonical object name refused");
    }
    mediaPaths.add(`${folder}/${object.name}`);
  }
  for (const path of mediaPaths) {
    const expectedPrefix = `${folder}/`;
    if (!path.startsWith(expectedPrefix) || !canonicalWorkFileName.test(path.slice(expectedPrefix.length))) {
      throw new Error("stale verifier media cleanup: path outside exact verifier work refused");
    }
  }
  if (mediaPaths.size > 0) {
    requireCleanupQuery(
      await owner.client.storage.from("work-media").remove([...mediaPaths]),
      "stale verifier media cleanup",
    );
    const remainingObjects = requireCleanupQuery(
      await owner.client.storage.from("work-media").list(folder, { limit: 100 }),
      "stale verifier media cleanup verification",
    );
    if (remainingObjects.length > 0) {
      throw new Error("stale verifier media cleanup: objects remain in the exact verifier work folder");
    }
  }

  if (assets.length > 0) {
    const deletedAssets = requireCleanupQuery(
      await owner.client
        .from("work_assets")
        .delete()
        .eq("work_id", work.id)
        .eq("user_id", owner.user.id)
        .in("id", assets.map((asset) => asset.id))
        .select("id"),
      "stale verifier asset cleanup",
    );
    if (deletedAssets.length !== assets.length) {
      throw new Error("stale verifier asset cleanup: not every strict-matched row was deleted");
    }
  }

  const deletedWork = requireCleanupQuery(
    await owner.client
      .from("works")
      .delete()
      .eq("id", work.id)
      .eq("user_id", owner.user.id)
      .like("title", spec.titlePattern)
      .eq("body", spec.body)
      .select("id"),
    "stale verifier work cleanup",
  );
  if (deletedWork.length !== 1) throw new Error("stale verifier work cleanup: strict row match failed");
}

async function cleanupStaleVerifierResidue(ownerA, ownerB) {
  const owners = { A: ownerA, B: ownerB };
  const staleWorks = [];
  const failures = [];

  for (const spec of verifierWorkSpecs) {
    const owner = owners[spec.ownerKey];
    const rows = requireCleanupQuery(
      await owner.client
        .from("works")
        .select("id, title, body")
        .eq("user_id", owner.user.id)
        .like("title", spec.titlePattern)
        .eq("body", spec.body),
      "stale verifier work discovery",
    );
    for (const work of rows) staleWorks.push({ owner, work, spec });
  }

  const trackCandidates = requireCleanupQuery(
    await ownerB.client
      .from("music_tracks")
      .select("id, title")
      .eq("user_id", ownerB.user.id)
      .like("title", "Works source ownership %")
      .eq("artist_name", "MedClip Runtime Verifier")
      .eq("description", "")
      .is("genre", null)
      .is("cover_path", null)
      .is("audio_path", null)
      .is("duration_seconds", null)
      .eq("published", false),
    "stale verifier music track discovery",
  );
  const staleTracks = trackCandidates.filter((track) => verifierTrackTitle.test(track.title));

  console.log(`STALE VERIFIER RESIDUE FOUND = ${staleWorks.length + staleTracks.length}`);

  for (const residue of staleWorks) {
    try {
      await removeStaleVerifierWork(residue.owner, residue.work, residue.spec);
    } catch (error) {
      failures.push(`stale work ${residue.work.id} cleanup: ${safeMessage(error)}`);
    }
  }

  for (const track of staleTracks) {
    const deleted = await ownerB.client
      .from("music_tracks")
      .delete()
      .eq("id", track.id)
      .eq("user_id", ownerB.user.id)
      .eq("title", track.title)
      .eq("artist_name", "MedClip Runtime Verifier")
      .eq("description", "")
      .is("genre", null)
      .is("cover_path", null)
      .is("audio_path", null)
      .is("duration_seconds", null)
      .eq("published", false)
      .select("id");
    if (deleted.error || deleted.data?.length !== 1) {
      failures.push(`stale track ${track.id} cleanup: ${safeMessage(deleted.error ?? "strict row match failed")}`);
    }
  }

  if (failures.length) {
    console.error("STALE VERIFIER RESIDUE CLEANUP = FAIL");
    failures.forEach((failure) => console.error(failure));
    throw new Error("stale verifier residue cleanup did not complete");
  }
  console.log("STALE VERIFIER RESIDUE CLEANUP = PASS");
}

async function cleanupOwner(owner, label, failures) {
  if (!owner.user) return;

  for (const workId of owner.workIds) {
    const result = await owner.client
      .from("works")
      .update({ published: false })
      .eq("id", workId)
      .eq("user_id", owner.user.id)
      .select("id");
    if (result.error || result.data?.length !== 1) {
      failures.push(`${label} work ${workId} unpublish cleanup: ${safeMessage(result.error ?? "work not updated")}`);
    }
  }

  for (const path of owner.mediaPaths) {
    const result = await owner.client.storage.from("work-media").remove([path]);
    if (result.error) failures.push(`${label} media ${path} cleanup: ${safeMessage(result.error)}`);
  }

  for (const [assetId, workId] of owner.assetRows) {
    const result = await owner.client
      .from("work_assets")
      .delete()
      .eq("id", assetId)
      .eq("work_id", workId)
      .eq("user_id", owner.user.id)
      .select("id");
    if (result.error || result.data?.length !== 1) {
      failures.push(`${label} asset ${assetId} cleanup: ${safeMessage(result.error ?? "asset row not deleted")}`);
    }
  }

  for (const workId of owner.workIds) {
    const result = await owner.client
      .from("works")
      .delete()
      .eq("id", workId)
      .eq("user_id", owner.user.id)
      .select("id");
    if (result.error || result.data?.length !== 1) {
      failures.push(`${label} work ${workId} cleanup: ${safeMessage(result.error ?? "work not deleted")}`);
    }
  }

  for (const trackId of owner.musicTrackIds) {
    const result = await owner.client
      .from("music_tracks")
      .delete()
      .eq("id", trackId)
      .eq("user_id", owner.user.id)
      .select("id");
    if (result.error || result.data?.length !== 1) {
      failures.push(`${label} music track ${trackId} cleanup: ${safeMessage(result.error ?? "track not deleted")}`);
    }
  }

  const signOut = await owner.client.auth.signOut({ scope: "local" });
  if (signOut.error) failures.push(`${label} sign-out cleanup: ${safeMessage(signOut.error)}`);
}

async function main() {
  const missingFoundation = [
    ["NEXT_PUBLIC_SUPABASE_URL", projectUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missingFoundation.length) {
    console.error(`RUNTIME WORKS TEST = NOT READY; missing: ${missingFoundation.join(", ")}`);
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
    console.log("RUNTIME WORKS TEST = READY, NOT RUN");
    console.log("Required local test credentials are missing.");
    return;
  }

  const anonymous = createAnonClient();
  const ownerA = createOwnerState(createAnonClient());
  const ownerB = createOwnerState(createAnonClient());
  const cleanupFailures = [];
  const runId = randomUUID();
  const imageBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });

  try {
    ownerA.user = await signInTestUser(ownerA.client, credentials.userA, "User A");
    ownerB.user = await signInTestUser(ownerB.client, credentials.userB, "User B");
    await cleanupStaleVerifierResidue(ownerA, ownerB);

    const workA = await createTrackedWork(
      ownerA,
      { title: `Works RLS A ${runId}`, body: "Runtime verifier media work" },
      "User A can create own draft work",
    );
    const workB = await createTrackedWork(
      ownerB,
      { title: `Works RLS B ${runId}`, body: "Runtime verifier cross-user work" },
      "User B can create own draft work",
    );

    requireInvisible(
      await anonymous.from("works").select("id").eq("id", workA.id),
      "Anonymous cannot read draft works",
    );
    requireInvisible(
      await ownerB.client.from("works").select("id").eq("id", workA.id),
      "User B cannot read User A draft work",
    );

    const orphanAssetId = randomUUID();
    const orphanPath = `${ownerA.user.id}/${workA.id}/${orphanAssetId}.jpg`;
    const forgedForeignPath = `${ownerA.user.id}/${workA.id}/${randomUUID()}.jpg`;
    const forgedSecondLevelPath = `${ownerB.user.id}/${workA.id}/${randomUUID()}.jpg`;
    const forgedWorkOwnerPath = `${ownerA.user.id}/${workB.id}/${randomUUID()}.jpg`;

    requireDenied(
      await ownerB.client.storage.from("work-media").upload(forgedForeignPath, imageBlob, {
        contentType: "image/jpeg",
        upsert: false,
      }),
      "User B cannot upload into User A path",
    );
    requireDenied(
      await ownerB.client.storage.from("work-media").upload(forgedSecondLevelPath, imageBlob, {
        contentType: "image/jpeg",
        upsert: false,
      }),
      "User B cannot bind User A work ID beneath User B directory",
    );
    requireDenied(
      await ownerA.client.storage.from("work-media").upload(forgedWorkOwnerPath, imageBlob, {
        contentType: "image/jpeg",
        upsert: false,
      }),
      "User A cannot bind User B work ID beneath User A directory",
    );

    requireSuccess(
      await ownerA.client.storage.from("work-media").upload(orphanPath, imageBlob, {
        contentType: "image/jpeg",
        upsert: false,
      }),
      "User A can upload into own draft path before an asset row exists",
    );
    ownerA.mediaPaths.add(orphanPath);
    await requireReadableDownload(ownerA.client, orphanPath, "User A can read own unbound draft object");
    requireDenied(
      await anonymous.storage.from("work-media").download(orphanPath),
      "Anonymous cannot read an unbound draft object",
    );
    requireDenied(
      await ownerB.client.storage.from("work-media").download(orphanPath),
      "User B cannot read User A unbound draft object",
    );
    requireDenied(
      await ownerB.client.storage.from("work-media").update(orphanPath, imageBlob, { contentType: "image/jpeg" }),
      "User B cannot update User A unbound draft object",
    );
    requireDenied(
      await ownerB.client.storage.from("work-media").remove([orphanPath]),
      "User B cannot delete User A unbound draft object",
    );
    requireSuccess(
      await ownerA.client.storage.from("work-media").remove([orphanPath]),
      "User A can clean up an unbound object from own draft work",
    );
    ownerA.mediaPaths.delete(orphanPath);

    const boundAssetId = randomUUID();
    const boundPath = `${ownerA.user.id}/${workA.id}/${boundAssetId}.jpg`;
    requireSuccess(
      await ownerA.client.storage.from("work-media").upload(boundPath, imageBlob, {
        contentType: "image/jpeg",
        upsert: false,
      }),
      "User A can upload a future bound object before its asset row exists",
    );
    ownerA.mediaPaths.add(boundPath);

    const boundAsset = requireSuccess(
      await ownerA.client.from("work_assets").insert({
        id: boundAssetId,
        work_id: workA.id,
        user_id: ownerA.user.id,
        asset_type: "image",
        storage_path: boundPath,
        mime_type: "image/jpeg",
        sort_order: 0,
      }).select("*").single(),
      "User A can create the matching work_assets row after upload",
    );
    ownerA.assetRows.set(boundAsset.id, workA.id);

    await requireReadableSignedUrl(ownerA.client, boundPath, "User A can read own bound draft media");
    requireDenied(
      await ownerB.client.storage.from("work-media").createSignedUrl(boundPath, 120),
      "User B cannot obtain signed access to User A draft media",
    );
    requireDenied(
      await anonymous.storage.from("work-media").createSignedUrl(boundPath, 120),
      "Anonymous cannot obtain signed access to draft media",
    );

    requireDenied(
      await ownerA.client.from("works").delete().eq("id", workA.id).eq("user_id", ownerA.user.id).select("id"),
      "Draft work with asset rows cannot be directly deleted",
    );

    const foreignTrack = requireSuccess(
      await ownerB.client.from("music_tracks").insert({
        user_id: ownerB.user.id,
        title: `Works source ownership ${runId}`,
        artist_name: "MedClip Runtime Verifier",
      }).select("id").single(),
      "User B can create a temporary source-ownership test track",
    );
    ownerB.musicTrackIds.add(foreignTrack.id);
    requireDenied(
      await ownerA.client
        .from("works")
        .update({ source_music_track_id: foreignTrack.id })
        .eq("id", workA.id)
        .eq("user_id", ownerA.user.id)
        .select("id"),
      "User A cannot attach User B music track as a work source",
    );

    requireSuccess(
      await ownerA.client
        .from("works")
        .update({ published: true })
        .eq("id", workA.id)
        .eq("user_id", ownerA.user.id)
        .select("id, published")
        .single(),
      "User A can explicitly publish a valid work",
    );
    requireDenied(
      await ownerA.client.from("works").delete().eq("id", workA.id).eq("user_id", ownerA.user.id).select("id"),
      "Published work cannot be directly deleted",
    );

    requireOneRow(
      await anonymous.from("works").select("id").eq("id", workA.id),
      "Anonymous can read an explicitly published work",
    );
    await requireReadableSignedUrl(anonymous, boundPath, "Anonymous can read published bound media");
    requireOneRow(
      await ownerB.client.from("works").select("id").eq("id", workA.id),
      "User B can read User A published work",
    );
    await requireReadableDownload(ownerB.client, boundPath, "User B can read User A published media");

    requireDenied(
      await ownerB.client.from("works").update({ title: "Denied" }).eq("id", workA.id).select("id"),
      "User B cannot update User A published work",
    );
    requireDenied(
      await ownerB.client.from("works").delete().eq("id", workA.id).select("id"),
      "User B cannot delete User A published work",
    );
    requireDenied(
      await ownerB.client.storage.from("work-media").update(boundPath, imageBlob, { contentType: "image/jpeg" }),
      "User B cannot update User A published media",
    );
    requireDenied(
      await ownerB.client.storage.from("work-media").remove([boundPath]),
      "User B cannot delete User A published media",
    );
    requireDenied(
      await ownerA.client.storage.from("work-media").update(boundPath, imageBlob, { contentType: "image/jpeg" }),
      "Owner cannot update published media before unpublishing",
    );
    requireDenied(
      await ownerA.client.storage.from("work-media").remove([boundPath]),
      "Owner cannot delete published media before unpublishing",
    );

    const textWork = await createTrackedWork(
      ownerA,
      { title: `Works text only ${runId}`, body: "Text-only runtime publication" },
      "User A can create a text-only draft work",
    );
    requireSuccess(
      await ownerA.client
        .from("works")
        .update({ published: true })
        .eq("id", textWork.id)
        .eq("user_id", ownerA.user.id)
        .select("id")
        .single(),
      "Text-only work can publish without an asset",
    );
    requireDenied(
      await ownerA.client.from("works").delete().eq("id", textWork.id).eq("user_id", ownerA.user.id).select("id"),
      "Published text-only work cannot be directly deleted",
    );

    requireSuccess(
      await ownerA.client
        .from("works")
        .update({ published: false })
        .eq("id", workA.id)
        .eq("user_id", ownerA.user.id)
        .select("id")
        .single(),
      "Deletion flow unpublishes the work first",
    );
    requireSuccess(
      await ownerA.client.storage.from("work-media").remove([boundPath]),
      "Deletion flow removes Storage before asset rows",
    );
    ownerA.mediaPaths.delete(boundPath);
    requireOneRow(
      await ownerA.client
        .from("work_assets")
        .delete()
        .eq("id", boundAsset.id)
        .eq("work_id", workA.id)
        .eq("user_id", ownerA.user.id)
        .select("id"),
      "Deletion flow removes the asset row after Storage",
    );
    ownerA.assetRows.delete(boundAsset.id);
    requireOneRow(
      await ownerA.client
        .from("works")
        .delete()
        .eq("id", workA.id)
        .eq("user_id", ownerA.user.id)
        .select("id"),
      "Deletion flow removes the work row last",
    );
    ownerA.workIds.delete(workA.id);

    console.log("RUNTIME WORKS TEST = PASS");
  } catch (error) {
    console.error(`RUNTIME WORKS TEST = FAIL: ${safeMessage(error)}`);
    process.exitCode = 1;
  } finally {
    await cleanupOwner(ownerA, "User A", cleanupFailures);
    await cleanupOwner(ownerB, "User B", cleanupFailures);

    if (cleanupFailures.length) {
      console.error("RUNTIME WORKS CLEANUP = FAIL");
      cleanupFailures.forEach((failure) => console.error(safeMessage(failure)));
      process.exitCode = 1;
    } else {
      console.log("RUNTIME WORKS CLEANUP = PASS");
    }
  }
}

await main();
