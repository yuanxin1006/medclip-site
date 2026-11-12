import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "file:///C:/Users/26484/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import {
  C2C2_ACCEPTANCE_MODES,
  createC2C2NavigationAudit,
  parseC2C2AcceptanceMode,
  validateC2C2AcceptancePlan,
} from "./music-browser-c2c2-acceptance-mode.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const supabaseCli = require.resolve("supabase/dist/supabase.js");
const baseUrl = process.env.MEDCLIP_BASE_URL ?? "http://localhost:3000";
const acceptanceMode = parseC2C2AcceptanceMode(process.env.MEDCLIP_C2C2_ACCEPTANCE_MODE);
const acceptancePlan = validateC2C2AcceptancePlan({
  mode: acceptanceMode,
  intentionallyRefreshAfterSubmit: false,
});
const providerHostPattern = /(^|\.)(tokenhub\.tencentmaas\.com|aigc-output-audio-file-1326893053\.cos\.ap-guangzhou\.myqcloud\.com)$/i;
const preservedRealOperationId = "38e41da9-a547-487c-a9fb-68b182383a46";
const preservedRealTrackId = "24ce4d24-2fca-4d9f-87ca-ed54c064f274";
const expectedTitle = "MedClip 异步真实生成测试";
const expectedPrompt = "温暖清新的中文流行歌曲，轻柔钢琴与原声吉他，年轻自然的人声，节奏舒缓，结构简洁，仅用于 MedClip 异步真实生成验收。";
const expectedLyrics = `[Verse]
清晨的光落在窗前
新的故事写下第一篇
我们把声音留在今天
让旋律慢慢向前

[Chorus]
唱一首简单的歌
记录这一刻
让每一段声音
都有自己的颜色`;

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
  if (missing.length > 0) throw new Error(`MISSING_C2C2_ENVIRONMENT_${missing.join("_")}`);
  return {
    projectUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    userA: { email: process.env.MEDCLIP_TEST_USER_A_EMAIL, password: process.env.MEDCLIP_TEST_USER_A_PASSWORD },
    userB: { email: process.env.MEDCLIP_TEST_USER_B_EMAIL, password: process.env.MEDCLIP_TEST_USER_B_PASSWORD },
  };
}

function browserClient(projectUrl, anonKey) {
  return createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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

async function operationSnapshot(userId, operationId) {
  const rows = await runSQL(`select
    o.state,
    o.provider_call_count,
    o.final_track_id,
    (o.request_hash ~ '^[0-9a-f]{64}$') as request_hash_bound,
    t.user_id as track_user_id,
    t.published,
    t.audio_path,
    t.duration_seconds,
    coalesce((s.metadata ->> 'size')::bigint, 0) as storage_bytes
  from medclip_private.music_generation_operations o
  left join public.music_tracks t on t.id = o.final_track_id
  left join storage.objects s on s.bucket_id = 'music-audio' and s.name = t.audio_path
  where o.user_id = ${sqlLiteral(userId)}::uuid and o.operation_id = ${sqlLiteral(operationId)};`);
  return rows[0] ?? null;
}

async function preservedRealArtifactSnapshot() {
  const rows = await runSQL(`select
    (select count(*) from medclip_private.music_generation_operations where operation_id = ${sqlLiteral(preservedRealOperationId)})::int as operation_count,
    (select count(*) from public.music_tracks where id = ${sqlLiteral(preservedRealTrackId)}::uuid)::int as track_count;`);
  return rows[0] ?? { operation_count: -1, track_count: -1 };
}

async function cleanupProviderFreeArtifact(userClient, userId, operationId) {
  try {
    const snapshot = await operationSnapshot(userId, operationId);
    const trackId = snapshot?.final_track_id ?? null;
    if (snapshot?.audio_path) {
      const removed = await userClient.storage.from("music-audio").remove([snapshot.audio_path]);
      if (removed.error) throw removed.error;
    }
    await runSQL(`delete from medclip_private.music_generation_operations
      where user_id = ${sqlLiteral(userId)}::uuid
        and operation_id = ${sqlLiteral(operationId)};`);
    if (trackId) {
      const removedTrack = await userClient
        .from("music_tracks")
        .delete()
        .eq("id", trackId)
        .eq("user_id", userId);
      if (removedTrack.error) throw removedTrack.error;
    }
    const remainingOperation = await operationSnapshot(userId, operationId);
    const remainingTrack = trackId
      ? await userClient.from("music_tracks").select("id").eq("id", trackId)
      : { error: null, data: [] };
    return remainingOperation === null
      && remainingTrack.error === null
      && (remainingTrack.data?.length ?? 0) === 0;
  } catch {
    return false;
  }
}

async function loginThroughUI(page, account) {
  await page.goto(`${baseUrl}/auth`, { waitUntil: "networkidle" });
  await page.locator('.auth-form input[type="email"]').fill(account.email);
  await page.locator('.auth-form input[type="password"]').fill(account.password);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/", { timeout: 20_000 }),
    page.locator(".auth-submit").click(),
  ]);
}

async function browserSessionAccessToken(page) {
  return await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("sb-") || !key.endsWith("-auth-token")) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
        const token = parsed?.access_token ?? parsed?.currentSession?.access_token;
        if (typeof token === "string") return token;
      } catch { /* ignore unrelated storage */ }
    }
    return null;
  });
}

async function browserRoleFetch(page, env, body, authenticated = true) {
  const token = authenticated ? await browserSessionAccessToken(page) : null;
  if (authenticated) assert.equal(typeof token, "string", "BROWSER_SESSION_TOKEN_MISSING");
  return await page.evaluate(async ({ url, anonKey, token, body }) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: anonKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await response.json(); } catch { /* status is sufficient */ }
    return { status: response.status, data };
  }, {
    url: `${env.projectUrl}/functions/v1/ai-tasks`,
    anonKey: env.anonKey,
    token,
    body,
  });
}

async function storageSignFromBrowser(page, env, audioPath) {
  const token = await browserSessionAccessToken(page);
  assert.equal(typeof token, "string", "BROWSER_SESSION_TOKEN_MISSING");
  const encodedPath = audioPath.split("/").map(encodeURIComponent).join("/");
  return await page.evaluate(async ({ url, anonKey, token }) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 60 }),
    });
    return response.status;
  }, { url: `${env.projectUrl}/storage/v1/object/sign/music-audio/${encodedPath}`, anonKey: env.anonKey, token });
}

function parseAction(request) {
  if (!request.url().includes("/functions/v1/ai-tasks")) return null;
  try {
    const body = request.postDataJSON();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function createNetworkAudit(page) {
  const audit = {
    starts: [],
    statuses: [],
    providerRequests: 0,
    leakedProviderUrl: false,
    leakedSecret: false,
    leakedTrustedDiagnostics: false,
    internalHeaders: false,
    parsing: new Set(),
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (providerHostPattern.test(url.hostname)) audit.providerRequests += 1;
    if (Object.keys(request.headers()).some((key) => key.toLowerCase().startsWith("x-medclip-internal"))) {
      audit.internalHeaders = true;
    }
    const body = parseAction(request);
    if (body?.action === "music.generation_start") audit.starts.push({ at: performance.now(), body });
  });
  page.on("response", (response) => {
    const body = parseAction(response.request());
    if (!body) return;
    const parsing = (async () => {
      let data;
      try { data = await response.json(); } catch { return; }
      const serialized = JSON.stringify(data);
      if (/tokenhub\.tencentmaas\.com|aigc-output-audio-file-1326893053\.cos\.ap-guangzhou\.myqcloud\.com/i.test(serialized)) {
        audit.leakedProviderUrl = true;
      }
      if (/(?:api[_-]?key|authorization|ciphertext|encryption[_-]?key|\biv\b)/i.test(serialized)) {
        audit.leakedSecret = true;
      }
      if (/(?:provider[_-]?request[_-]?id|provider[_-]?trace[_-]?id|dns|upstream[_-]?status|raw[_-]?response)/i.test(serialized)) {
        audit.leakedTrustedDiagnostics = true;
      }
      if (body.action === "music.operation_status" && data?.ok === true && data.operation?.status) {
        audit.statuses.push({
          at: performance.now(),
          operationId: data.operation.operationId,
          status: data.operation.status,
        });
      }
    })().finally(() => audit.parsing.delete(parsing));
    audit.parsing.add(parsing);
  });
  audit.settle = async () => { await Promise.allSettled([...audit.parsing]); };
  return audit;
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`TIMEOUT_${label}`);
}

async function completedAudioAcceptance(page, env) {
  await page.locator(".async-music-completed .music-player").waitFor({ timeout: 60_000 });
  const audio = page.locator(".async-music-completed audio");
  const metadata = await audio.evaluate(async (element) => {
    if (element.readyState >= 1 && Number.isFinite(element.duration)) {
      return { loaded: true, duration: element.duration, src: element.currentSrc || element.src };
    }
    return await new Promise((resolve) => {
      const timeout = window.setTimeout(() => resolve({ loaded: false, duration: element.duration, src: element.currentSrc || element.src }), 20_000);
      element.addEventListener("loadedmetadata", () => {
        window.clearTimeout(timeout);
        resolve({ loaded: true, duration: element.duration, src: element.currentSrc || element.src });
      }, { once: true });
      element.addEventListener("error", () => {
        window.clearTimeout(timeout);
        resolve({ loaded: false, duration: element.duration, src: element.currentSrc || element.src });
      }, { once: true });
      element.load();
    });
  });
  assert.equal(metadata.loaded, true, "REAL_AUDIO_METADATA_LOAD_FAILED");
  assert.ok(Number.isFinite(metadata.duration) && metadata.duration > 0, "REAL_AUDIO_DURATION_INVALID");
  assert.equal(new URL(metadata.src).origin, new URL(env.projectUrl).origin, "PLAYBACK_NOT_FROM_MEDCLIP_STORAGE");
  assert.equal(providerHostPattern.test(new URL(metadata.src).hostname), false, "PLAYBACK_USED_PROVIDER_URL");
  await page.locator(".async-music-completed .music-player-control").click();
  await waitUntil(async () => await audio.evaluate((element) => element.currentTime > 0.1), 15_000, "REAL_AUDIO_PLAYBACK");
  await page.locator(".async-music-completed .music-player-control").click();
  return metadata;
}

async function main() {
  assert.equal(acceptancePlan.intentionallyRefreshAfterSubmit, false);
  const env = requireEnvironment();
  const userAClient = browserClient(env.projectUrl, env.anonKey);
  const userBClient = browserClient(env.projectUrl, env.anonKey);
  const userAAuth = await userAClient.auth.signInWithPassword(env.userA);
  assert.equal(userAAuth.error, null);
  const userAId = userAAuth.data.user?.id;
  assert.equal(typeof userAId, "string");
  const protectedBefore = await preservedRealArtifactSnapshot();
  const browser = await chromium.launch({ executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
  const contextA = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const pageA = await contextA.newPage();
  const auditA = createNetworkAudit(pageA);
  const navigationAudit = createC2C2NavigationAudit(acceptanceMode);
  pageA.on("framenavigated", (frame) => {
    if (frame === pageA.mainFrame()) navigationAudit.recordMainFrameNavigation();
  });
  let operationId = null;
  let trackId = null;
  let result = null;
  let providerFreeCleanup = acceptanceMode === C2C2_ACCEPTANCE_MODES.PROVIDER_FREE
    ? false
    : null;
  try {
    await loginThroughUI(pageA, env.userA);
    await pageA.goto(`${baseUrl}/create-music`, { waitUntil: "networkidle" });
    await pageA.locator(".ai-music-page").waitFor();
    await pageA.locator(".async-music-test-mode-note").waitFor({ timeout: 30_000 });
    const provider = pageA.locator('.async-music-foundation [role="radio"]').first();
    await waitUntil(async () => await provider.getAttribute("aria-checked") === "true", 30_000, "TOKENHUB_SELECTED");
    const availabilityA = await browserRoleFetch(pageA, env, { action: "music.generation_availability" });
    assert.equal(availabilityA.status, 200);
    assert.equal(availabilityA.data?.musicGeneration?.enabled, true);
    assert.equal(availabilityA.data?.musicGeneration?.testerModeEnabled, true);

    const contextBPreflight = await browser.newContext();
    const pageBPreflight = await contextBPreflight.newPage();
    await loginThroughUI(pageBPreflight, env.userB);
    const availabilityB = await browserRoleFetch(pageBPreflight, env, { action: "music.generation_availability" });
    assert.equal(availabilityB.status, 200);
    assert.equal(availabilityB.data?.musicGeneration?.enabled, false);
    assert.equal(availabilityB.data?.musicGeneration?.testerModeEnabled, false);
    await contextBPreflight.close();

    const anonymousContext = await browser.newContext();
    const anonymousPage = await anonymousContext.newPage();
    await anonymousPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const anonymousAvailability = await browserRoleFetch(anonymousPage, env, { action: "music.generation_availability" }, false);
    assert.equal(anonymousAvailability.status, 401);
    await anonymousContext.close();

    const titleInput = pageA.locator(".ai-music-form > label").nth(0).locator("input");
    const lyricsInput = pageA.locator(".ai-music-form > label").nth(1).locator("textarea");
    const promptInput = pageA.locator(".ai-settings input");
    await titleInput.fill(expectedTitle);
    await lyricsInput.fill(expectedLyrics);
    await promptInput.fill(expectedPrompt);
    assert.equal(await titleInput.inputValue(), expectedTitle);
    assert.equal(await lyricsInput.inputValue(), expectedLyrics);
    assert.equal(await promptInput.inputValue(), expectedPrompt);

    const generate = pageA.locator(".ai-generate-button");
    await waitUntil(async () => !(await generate.isDisabled()), 30_000, "GENERATE_ENABLED");
    const submittedAt = performance.now();
    const responsePromise = pageA.waitForResponse((response) => parseAction(response.request())?.action === "music.generation_start", { timeout: 30_000 });
    navigationAudit.markSubmitted();
    await generate.click();
    const response = await responsePromise;
    const ackMs = Math.round(performance.now() - submittedAt);
    const accepted = await response.json();
    assert.equal(response.status(), 202);
    assert.equal(accepted?.ok, true);
    assert.equal(accepted?.accepted, true);
    assert.equal(accepted?.status, "RESERVED");
    assert.match(accepted?.operationId ?? "", /^[0-9a-f-]{36}$/i);
    operationId = accepted.operationId;
    assert.equal(auditA.starts.length, 1, "PAID_START_COUNT_NOT_ONE");
    const originalStartBody = auditA.starts[0].body;

    await waitUntil(
      () => auditA.statuses.some((item) => item.operationId === operationId && item.status === "PROVIDER_IN_FLIGHT"),
      60_000,
      "PROVIDER_IN_FLIGHT",
    );
    const startsAfterSubmit = auditA.starts.length;
    await pageA.locator(".async-music-operation-ref code").filter({ hasText: operationId }).waitFor({ timeout: 30_000 });
    assert.equal(auditA.starts.length, startsAfterSubmit, "SECOND_START_AFTER_SUBMIT");

    await waitUntil(
      () => auditA.statuses.some((item) => item.operationId === operationId && ["COMPLETED", "FAILED", "UNKNOWN"].includes(item.status)),
      600_000,
      "REAL_MUSIC_TERMINAL_STATE",
    );
    const terminalStatus = [...auditA.statuses].reverse().find((item) => item.operationId === operationId && ["COMPLETED", "FAILED", "UNKNOWN"].includes(item.status))?.status;
    assert.equal(terminalStatus, "COMPLETED", `REAL_MUSIC_TERMINAL_${terminalStatus ?? "MISSING"}`);
    await pageA.locator(".async-music-completed").waitFor({ timeout: 60_000 });
    const audio = await completedAudioAcceptance(pageA, env);

    const snapshot = await operationSnapshot(userAId, operationId);
    assert.equal(snapshot?.state, "COMPLETED");
    assert.equal(Number(snapshot?.provider_call_count), 1);
    assert.equal(snapshot?.request_hash_bound, true);
    assert.equal(snapshot?.track_user_id, userAId);
    assert.equal(snapshot?.published, false);
    assert.equal(typeof snapshot?.final_track_id, "string");
    assert.equal(typeof snapshot?.audio_path, "string");
    assert.ok(Number(snapshot?.storage_bytes) > 0);
    trackId = snapshot.final_track_id;

    const contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pageB = await contextB.newPage();
    await loginThroughUI(pageB, env.userB);
    const crossOperation = await browserRoleFetch(pageB, env, { action: "music.operation_status", operationId });
    assert.equal(crossOperation.status, 404);
    const userBAuth = await userBClient.auth.signInWithPassword(env.userB);
    assert.equal(userBAuth.error, null);
    const crossTrack = await userBClient.from("music_tracks").select("id,audio_path").eq("id", trackId);
    assert.equal(crossTrack.error, null);
    assert.deepEqual(crossTrack.data, []);
    const crossSign = await storageSignFromBrowser(pageB, env, snapshot.audio_path);
    assert.ok([400, 403, 404].includes(crossSign));
    await contextB.close();

    const replay = await browserRoleFetch(pageA, env, originalStartBody);
    assert.equal(replay.status, 202);
    assert.equal(replay.data?.operationId, operationId);
    assert.equal(replay.data?.status, "COMPLETED");
    const conflictBody = structuredClone(originalStartBody);
    conflictBody.input.prompt = `${conflictBody.input.prompt} conflict`;
    const conflict = await browserRoleFetch(pageA, env, conflictBody);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data?.status, "OPERATION_CONFLICT");
    const finalSnapshot = await operationSnapshot(userAId, operationId);
    assert.equal(Number(finalSnapshot?.provider_call_count), 1);
    assert.equal(finalSnapshot?.final_track_id, trackId);

    await auditA.settle();
    assert.equal(auditA.providerRequests, 0);
    assert.equal(auditA.internalHeaders, false);
    assert.equal(auditA.leakedProviderUrl, false);
    assert.equal(auditA.leakedSecret, false);
    assert.equal(auditA.leakedTrustedDiagnostics, false);
    const pageHtml = await pageA.content();
    assert.equal(pageHtml.includes(env.userA.password), false);
    assert.equal(pageHtml.includes(env.userB.password), false);

    const observed = ["RESERVED", ...auditA.statuses.filter((item) => item.operationId === operationId).map((item) => item.status)]
      .filter((value, index, values) => index === 0 || value !== values[index - 1]);
    if (acceptanceMode === C2C2_ACCEPTANCE_MODES.PROVIDER_FREE) {
      for (const state of ["RESERVED", "PROVIDER_IN_FLIGHT", "FINALIZING", "COMPLETED"]) {
        assert.ok(observed.includes(state), `MISSING_${state}`);
      }
    }
    const navigation = navigationAudit.snapshot();
    assert.equal(navigation.pageReloadCount, 0, "PAGE_RELOAD_NOT_ZERO");
    assert.equal(navigation.navigationReloadAfterSubmit, 0, "POST_SUBMIT_NAVIGATION_NOT_ZERO");
    result = {
      result: "PASS",
      acceptanceMode,
      operationId,
      trackId,
      ackMs,
      observed,
      providerCallCount: 1,
      requestHashBound: true,
      pageReloadCount: navigation.pageReloadCount,
      navigationReloadAfterSubmit: navigation.navigationReloadAfterSubmit,
      secondStartAfterSubmit: 0,
      sameOperationReplay: "PASS",
      differentPayloadConflict: "PASS",
      browserProviderRequests: 0,
      browserProviderUrl: false,
      browserSecrets: false,
      browserTrustedDiagnostics: false,
      userBOperation: "BLOCKED",
      userBTrack: "BLOCKED",
      userBPlayback: "BLOCKED",
      trackPublished: false,
      playbackSource: "MEDCLIP_STORAGE",
      browserMediaLoad: "PASS",
      audioDurationSeconds: audio.duration,
      storageBytes: Number(snapshot.storage_bytes),
    };
  } finally {
    await Promise.allSettled([contextA.close(), browser.close()]);
    if (
      acceptanceMode === C2C2_ACCEPTANCE_MODES.PROVIDER_FREE
      && operationId
    ) {
      providerFreeCleanup = await cleanupProviderFreeArtifact(
        userAClient,
        userAId,
        operationId,
      );
    }
    await Promise.allSettled([
      userAClient.auth.signOut({ scope: "local" }),
      userBClient.auth.signOut({ scope: "local" }),
    ]);
  }
  const protectedAfter = await preservedRealArtifactSnapshot();
  assert.deepEqual(protectedAfter, protectedBefore, "REAL_C2C2_R2_ARTIFACT_CHANGED");
  if (acceptanceMode === C2C2_ACCEPTANCE_MODES.PROVIDER_FREE) {
    assert.equal(providerFreeCleanup, true, "C2C2_PROVIDER_FREE_CLEANUP_FAILED");
  } else {
    if (operationId) console.error(`C2C2_OPERATION_RETAINED=${operationId}`);
    if (trackId) console.error(`C2C2_TRACK_RETAINED=${trackId}`);
  }
  console.log(JSON.stringify({
    ...result,
    providerFreeCleanup: providerFreeCleanup === null ? "NOT_APPLICABLE" : "PASS",
    preservedRealOperation: "PASS",
    preservedRealTrack: "PASS",
  }, null, 2));
}

await main();
