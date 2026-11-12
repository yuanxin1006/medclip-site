import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "file:///C:/Users/26484/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const supabaseCli = require.resolve("supabase/dist/supabase.js");
const baseUrl = process.env.MEDCLIP_BASE_URL ?? "http://localhost:3000";
const scenario = process.env.MEDCLIP_C2C1_BROWSER_SCENARIO ?? "happy";
const expectedScenarios = new Set(["happy", "provider_failure", "unknown_after_dispatch"]);
const c1dOperationId = "c1d_tokenhub_music_v26_url_20261009_live2";
const c1dTrackId = "cad2cb99-19a6-43bd-88e8-e61c53d2ba26";
const tokenHubHostPattern = /(^|\.)(tokenhub|tencentcloudapi|minimaxi|volces)\./i;

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
  if (missing.length) throw new Error(`MISSING_C2C1_ENVIRONMENT_${missing.join("_")}`);
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

async function signIn(client, account, label) {
  const result = await client.auth.signInWithPassword(account);
  if (result.error || !result.data.user) throw new Error(`${label}_AUTHENTICATION_FAILED`);
  return result.data.user;
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
  const rows = await runSQL(`select state, provider_call_count, final_track_id from medclip_private.music_generation_operations where user_id = ${sqlLiteral(userId)}::uuid and operation_id = ${sqlLiteral(operationId)};`);
  return rows[0] ?? null;
}

async function protectedArtifactSnapshot() {
  const rows = await runSQL(`select (select count(*) from medclip_private.music_generation_operations where operation_id = ${sqlLiteral(c1dOperationId)})::int as operation_count, (select count(*) from public.music_tracks where id = ${sqlLiteral(c1dTrackId)}::uuid)::int as track_count;`);
  return rows[0] ?? { operation_count: -1, track_count: -1 };
}

async function cleanupArtifacts(userClient, userId, artifacts) {
  let clean = true;
  for (const artifact of artifacts) {
    try {
      const snapshot = await operationSnapshot(userId, artifact.operationId);
      const trackId = snapshot?.final_track_id ?? artifact.trackId ?? null;
      if (trackId) {
        const track = await userClient.from("music_tracks").select("id,user_id,audio_path").eq("id", trackId).eq("user_id", userId).maybeSingle();
        if (track.error) throw track.error;
        if (track.data?.audio_path) {
          const removedAudio = await userClient.storage.from("music-audio").remove([track.data.audio_path]);
          if (removedAudio.error) throw removedAudio.error;
        }
      }
      await runSQL(`delete from medclip_private.music_generation_operations where user_id = ${sqlLiteral(userId)}::uuid and operation_id = ${sqlLiteral(artifact.operationId)};`);
      if (trackId) {
        const removedTrack = await userClient.from("music_tracks").delete().eq("id", trackId).eq("user_id", userId);
        if (removedTrack.error) throw removedTrack.error;
      }
      if (await operationSnapshot(userId, artifact.operationId)) clean = false;
    } catch {
      clean = false;
    }
  }
  return clean;
}

function parseAction(request) {
  if (!request.url().includes("/functions/v1/ai-tasks")) return null;
  try {
    const value = request.postDataJSON();
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function createNetworkAudit(page) {
  const audit = {
    starts: [],
    statusRequests: [],
    statuses: [],
    availabilityResponses: [],
    tokenHubRequests: 0,
    storageRequests: [],
    internalHeaders: false,
    trustedDiagnostics: false,
    maxOverlappingStatus: 0,
    pendingStatus: 0,
    errors: [],
    forbiddenControlAttempts: 0,
    parsing: new Set(),
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (tokenHubHostPattern.test(url.hostname)) audit.tokenHubRequests += 1;
    if (url.pathname.includes("/storage/v1/")) audit.storageRequests.push(request.url());
    const headers = request.headers();
    if (Object.keys(headers).some((key) => key.toLowerCase().startsWith("x-medclip-internal"))) audit.internalHeaders = true;
    const body = parseAction(request);
    if (body?.action === "music.generation_start") {
      audit.starts.push({ at: performance.now(), body });
      const rootKeys = Object.keys(body).sort();
      const inputKeys = body.input && typeof body.input === "object" ? Object.keys(body.input).sort() : [];
      if (JSON.stringify(rootKeys) !== JSON.stringify(["action", "input"])) audit.forbiddenControlAttempts += 1;
      if (inputKeys.some((key) => !["lyrics", "mode", "operationId", "prompt", "title"].includes(key))) audit.errors.push("START_INPUT_FIELDS");
    }
    if (body?.action === "music.operation_status") {
      audit.statusRequests.push({ at: performance.now(), operationId: body.operationId });
      audit.pendingStatus += 1;
      audit.maxOverlappingStatus = Math.max(audit.maxOverlappingStatus, audit.pendingStatus);
    }
  });
  const finish = (request) => {
    const body = parseAction(request);
    if (body?.action === "music.operation_status") audit.pendingStatus = Math.max(0, audit.pendingStatus - 1);
  };
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  page.on("response", (response) => {
    const request = response.request();
    const body = parseAction(request);
    if (!body) return;
    const parsing = (async () => {
      let data = null;
      try { data = await response.json(); } catch { return; }
      const serialized = JSON.stringify(data);
      if (/ciphertext|\biv\b|encryption[_-]?key|request[_-]?hash|raw[_-]?response|provider[_-]?url/i.test(serialized)) {
        audit.trustedDiagnostics = true;
      }
      if (body.action === "music.operation_status" && data?.ok === true && data.operation?.status) {
        audit.statuses.push({
          at: performance.now(),
          operationId: data.operation.operationId,
          status: data.operation.status,
          trackId: data.operation.trackId ?? null,
        });
      }
      if (body.action === "music.generation_availability") {
        audit.availabilityResponses.push({ status: response.status(), enabled: data?.musicGeneration?.enabled === true });
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`TIMEOUT_${label}`);
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

async function openCreateMusic(page, expectTesterMode = true) {
  await page.goto(`${baseUrl}/create-music`, { waitUntil: "networkidle" });
  await page.locator(".ai-music-page").waitFor();
  if (expectTesterMode) await page.locator(".async-music-test-mode-note").waitFor({ timeout: 20_000 });
  const provider = page.locator('.async-music-foundation [role="radio"]').first();
  await waitUntil(async () => await provider.getAttribute("aria-checked") === "true", 20_000, "TOKENHUB_SELECTED");
  await waitUntil(async () => !(await page.locator(".ai-generate-button").isDisabled()), 20_000, "GENERATE_ENABLED");
}

async function fillFixture(page, suffix) {
  const title = `MedClip 异步浏览器测试 ${suffix}`;
  const lyrics = "[Verse]\n清晨的光落在窗前\n新的故事写下第一篇\n\n[Chorus]\n唱一首简单的歌\n记录这一刻";
  const prompt = "温暖清新的中文流行歌曲，仅用于 MedClip 异步浏览器流程测试。";
  const titleInput = page.locator(".ai-music-form > label").nth(0).locator("input");
  const lyricsInput = page.locator(".ai-music-form > label").nth(1).locator("textarea");
  const promptInput = page.locator(".ai-settings input");
  await titleInput.fill(title);
  await lyricsInput.fill(lyrics);
  await promptInput.fill(prompt);
  assert.equal(await titleInput.inputValue(), title);
  assert.equal(await lyricsInput.inputValue(), lyrics);
  assert.equal(await promptInput.inputValue(), prompt);
  return { title, lyrics, prompt };
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

async function browserRoleFetch(page, env, path, body, authenticated) {
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
    try { data = await response.json(); } catch { /* safe status is enough */ }
    return { status: response.status, data };
  }, { url: new URL(path, env.projectUrl).toString(), anonKey: env.anonKey, token, body });
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

function safePageAudit(html, env) {
  for (const value of [env.userA.password, env.userB.password]) {
    assert.equal(html.includes(value), false, "BROWSER_HTML_EXPOSED_CREDENTIAL");
  }
  assert.doesNotMatch(html, /ciphertext|MEDCLIP_CREDENTIAL_ENCRYPTION_KEY|x-medclip-internal-live|x-medclip-internal-async/i);
}

async function submitAndWaitForStart(page, audit, doubleClick = false) {
  const before = audit.starts.length;
  const button = page.locator(".ai-generate-button");
  const startedAt = performance.now();
  const responsePromise = page.waitForResponse((response) => parseAction(response.request())?.action === "music.generation_start", { timeout: 20_000 });
  if (doubleClick) {
    await button.evaluate((element) => { element.click(); element.click(); });
  } else {
    await button.click();
  }
  const response = await responsePromise;
  const ackMs = performance.now() - startedAt;
  const data = await response.json();
  assert.equal(response.status(), 202);
  assert.equal(data?.ok, true);
  assert.equal(data?.accepted, true);
  assert.equal(data?.status, "RESERVED");
  await waitUntil(() => audit.starts.length === before + 1, 5_000, "ONE_START_REQUEST");
  return { operationId: data.operationId, ackMs };
}

async function completedAudioAcceptance(page, env) {
  await page.locator(".async-music-completed .music-player").waitFor({ timeout: 30_000 });
  const audio = page.locator(".async-music-completed audio");
  const result = await audio.evaluate(async (element) => {
    if (element.readyState >= 1 && Number.isFinite(element.duration)) {
      return { loaded: true, duration: element.duration, src: element.currentSrc || element.src };
    }
    return await new Promise((resolve) => {
      const timeout = window.setTimeout(() => resolve({ loaded: false, duration: element.duration, src: element.currentSrc || element.src }), 10_000);
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
  assert.equal(result.loaded, true);
  assert.ok(Number.isFinite(result.duration) && result.duration > 0);
  assert.equal(new URL(result.src).origin, new URL(env.projectUrl).origin);
  assert.equal(tokenHubHostPattern.test(new URL(result.src).hostname), false);
  return result;
}

async function runHappy(env, browser, userAClient, userBClient, userA, userB, artifacts) {
  const contextA = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const pageA = await contextA.newPage();
  const auditA = createNetworkAudit(pageA);
  const consoleErrors = [];
  pageA.on("pageerror", (error) => consoleErrors.push(error.message));
  pageA.on("console", (message) => { if (message.type() === "error" && !message.text().includes("Failed to load resource")) consoleErrors.push(message.text()); });
  await loginThroughUI(pageA, env.userA);
  await openCreateMusic(pageA, true);
  await fillFixture(pageA, "主流程");
  const first = await submitAndWaitForStart(pageA, auditA);
  artifacts.push({ operationId: first.operationId });
  const ackSnapshot = await operationSnapshot(userA.id, first.operationId);
  assert.notEqual(ackSnapshot?.state, "COMPLETED");
  await waitUntil(() => auditA.statuses.some((item) => item.operationId === first.operationId && item.status === "PROVIDER_IN_FLIGHT"), 30_000, "PROVIDER_IN_FLIGHT");
  const startsBeforeRefresh = auditA.starts.length;
  await pageA.reload({ waitUntil: "networkidle" });
  await pageA.locator(".async-music-operation-ref code").filter({ hasText: first.operationId }).waitFor({ timeout: 20_000 });
  await pageA.locator(".async-music-completed").waitFor({ timeout: 45_000 });
  assert.equal(auditA.starts.length, startsBeforeRefresh);
  const audioResult = await completedAudioAcceptance(pageA, env);
  const firstSnapshot = await operationSnapshot(userA.id, first.operationId);
  assert.equal(firstSnapshot?.state, "COMPLETED");
  assert.equal(firstSnapshot?.provider_call_count, 1);
  assert.equal(typeof firstSnapshot?.final_track_id, "string");
  artifacts[0].trackId = firstSnapshot.final_track_id;
  const ownTrack = await userAClient.from("music_tracks").select("id,user_id,title,audio_path,duration_seconds,published").eq("id", firstSnapshot.final_track_id).maybeSingle();
  assert.equal(ownTrack.error, null);
  assert.equal(ownTrack.data?.user_id, userA.id);
  assert.equal(ownTrack.data?.published, false);
  assert.equal(typeof ownTrack.data?.audio_path, "string");

  await pageA.locator(".async-music-reset").click();
  await fillFixture(pageA, "双击保护");
  const beforeDoubleStarts = auditA.starts.length;
  const second = await submitAndWaitForStart(pageA, auditA, true);
  artifacts.push({ operationId: second.operationId });
  await pageA.locator(".async-music-completed").waitFor({ timeout: 45_000 });
  assert.equal(auditA.starts.length, beforeDoubleStarts + 1);
  const secondSnapshot = await operationSnapshot(userA.id, second.operationId);
  assert.equal(secondSnapshot?.state, "COMPLETED");
  assert.equal(secondSnapshot?.provider_call_count, 1);
  artifacts[1].trackId = secondSnapshot.final_track_id;

  const contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pageB = await contextB.newPage();
  const auditB = createNetworkAudit(pageB);
  await loginThroughUI(pageB, env.userB);
  const crossStatus = await browserRoleFetch(pageB, env, "/functions/v1/ai-tasks", { action: "music.operation_status", operationId: first.operationId }, true);
  assert.equal(crossStatus.status, 404);
  assert.equal(crossStatus.data?.status, "OPERATION_NOT_FOUND");
  const availabilityB = await browserRoleFetch(pageB, env, "/functions/v1/ai-tasks", { action: "music.generation_availability" }, true);
  assert.equal(availabilityB.status, 200);
  assert.equal(availabilityB.data?.musicGeneration?.enabled, false);
  assert.equal(availabilityB.data?.musicGeneration?.testerModeEnabled, false);
  const bypassAttempt = await browserRoleFetch(pageB, env, "/functions/v1/ai-tasks", {
    action: "music.generation_start",
    mock: true,
    input: { operationId: randomUUID(), mode: "custom_lyrics", title: "blocked", lyrics: "blocked" },
  }, true);
  assert.equal(bypassAttempt.status, 400);
  await pageB.goto(`${baseUrl}/music`, { waitUntil: "networkidle" });
  assert.equal((await pageB.locator("body").innerText()).includes("MedClip 异步浏览器测试 主流程"), false);
  const crossTrack = await userBClient.from("music_tracks").select("id,audio_path").eq("id", firstSnapshot.final_track_id);
  assert.equal(crossTrack.error, null);
  assert.deepEqual(crossTrack.data, []);
  const crossSignStatus = await storageSignFromBrowser(pageB, env, ownTrack.data.audio_path);
  assert.ok(crossSignStatus === 400 || crossSignStatus === 403 || crossSignStatus === 404);

  const anonymousContext = await browser.newContext();
  const anonymousPage = await anonymousContext.newPage();
  await anonymousPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const anonymousStatus = await browserRoleFetch(anonymousPage, env, "/functions/v1/ai-tasks", { action: "music.operation_status", operationId: first.operationId }, false);
  assert.equal(anonymousStatus.status, 401);
  const ownStorage = await pageA.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key.startsWith("medclip:"))));
  const ownStorageText = JSON.stringify(ownStorage);
  assert.doesNotMatch(ownStorageText, /api[_-]?key|authorization|https?:\/\/|ciphertext|hmac|request[_-]?hash/i);
  safePageAudit(await pageA.content(), env);
  await auditA.settle();
  await auditB.settle();
  assert.deepEqual(auditA.errors, []);
  assert.deepEqual(auditB.errors, []);
  assert.equal(auditA.forbiddenControlAttempts, 0);
  assert.equal(auditB.forbiddenControlAttempts, 1);
  assert.equal(auditA.internalHeaders, false);
  assert.equal(auditA.trustedDiagnostics, false);
  assert.equal(auditA.maxOverlappingStatus, 1);
  assert.equal(auditA.tokenHubRequests + auditB.tokenHubRequests, 0);
  assert.deepEqual(consoleErrors, []);

  const firstStates = ["RESERVED", ...auditA.statuses.filter((item) => item.operationId === first.operationId).map((item) => item.status)]
    .filter((value, index, values) => index === 0 || value !== values[index - 1]);
  for (const state of ["RESERVED", "PROVIDER_IN_FLIGHT", "FINALIZING", "COMPLETED"]) assert.ok(firstStates.includes(state), `MISSING_${state}`);
  assert.ok(firstStates.indexOf("RESERVED") < firstStates.indexOf("PROVIDER_IN_FLIGHT"));
  assert.ok(firstStates.indexOf("PROVIDER_IN_FLIGHT") < firstStates.indexOf("FINALIZING"));
  assert.ok(firstStates.indexOf("FINALIZING") < firstStates.indexOf("COMPLETED"));
  const firstPollTimes = auditA.statusRequests.filter((item) => item.operationId === first.operationId).map((item) => item.at);
  const intervals = firstPollTimes.slice(1).map((time, index) => time - firstPollTimes[index]).filter((value) => value > 1_000);
  assert.ok(intervals.some((value) => value >= 2_500 && value <= 4_000), "POLL_INTERVAL_NOT_APPROX_3000");
  const statusCountAtComplete = auditA.statusRequests.filter((item) => item.operationId === second.operationId).length;
  await pageA.waitForTimeout(3_500);
  assert.equal(auditA.statusRequests.filter((item) => item.operationId === second.operationId).length, statusCountAtComplete);

  await Promise.all([contextA.close(), contextB.close(), anonymousContext.close()]);
  return {
    ackMs: Math.round(first.ackMs),
    states: firstStates,
    pollInterval: intervals.length ? Math.round(intervals.reduce((sum, value) => sum + value, 0) / intervals.length) : 0,
    audioDuration: audioResult.duration,
    userBOperation: "BLOCKED",
    userBTrack: "BLOCKED",
    userBPlayback: "BLOCKED",
    anonymousStatus: "BLOCKED",
    doubleClick: "PASS",
    refresh: "PASS",
  };
}

async function runTerminalScenario(env, browser, userA, artifacts, expectedStatus) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const audit = createNetworkAudit(page);
  await loginThroughUI(page, env.userA);
  await openCreateMusic(page, true);
  await fillFixture(page, expectedStatus === "FAILED" ? "失败场景" : "未知场景");
  const started = await submitAndWaitForStart(page, audit);
  artifacts.push({ operationId: started.operationId });
  await waitUntil(() => audit.statuses.some((item) => item.operationId === started.operationId && item.status === expectedStatus), 40_000, expectedStatus);
  await page.locator(`.async-music-stage.is-${expectedStatus === "FAILED" ? "error" : "caution"}`).waitFor({ timeout: 20_000 });
  const stageText = await page.locator(".async-music-stage").innerText();
  if (expectedStatus === "FAILED") {
    assert.match(stageText, /失败/);
    assert.doesNotMatch(stageText, /database|postgres|provider|tokenhub|stack|sql/i);
  } else {
    assert.match(stageText, /确认|暂时|不会自动重新生成/);
    assert.doesNotMatch(stageText, /生成失败/);
    await page.waitForTimeout(7_000);
  }
  const snapshot = await operationSnapshot(userA.id, started.operationId);
  assert.equal(snapshot?.state, expectedStatus);
  assert.equal(snapshot?.provider_call_count, 1);
  const startsAtTerminal = audit.starts.length;
  await page.waitForTimeout(3_500);
  assert.equal(audit.starts.length, startsAtTerminal);
  await audit.settle();
  assert.equal(audit.tokenHubRequests, 0);
  assert.equal(audit.internalHeaders, false);
  assert.equal(audit.trustedDiagnostics, false);
  assert.deepEqual(audit.errors, []);
  await context.close();
  return { operationId: started.operationId, status: expectedStatus, startCount: audit.starts.length };
}

async function main() {
  assert.ok(expectedScenarios.has(scenario), "INVALID_C2C1_SCENARIO");
  const env = requireEnvironment();
  const userAClient = browserClient(env.projectUrl, env.anonKey);
  const userBClient = browserClient(env.projectUrl, env.anonKey);
  const artifacts = [];
  let cleanup = false;
  const protectedBefore = await protectedArtifactSnapshot();
  const userA = await signIn(userAClient, env.userA, "USER_A");
  const userB = await signIn(userBClient, env.userB, "USER_B");
  const browser = await chromium.launch({ executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
  let result;
  try {
    result = scenario === "happy"
      ? await runHappy(env, browser, userAClient, userBClient, userA, userB, artifacts)
      : await runTerminalScenario(env, browser, userA, artifacts, scenario === "provider_failure" ? "FAILED" : "UNKNOWN");
  } finally {
    await browser.close();
    cleanup = await cleanupArtifacts(userAClient, userA.id, artifacts);
    await Promise.allSettled([userAClient.auth.signOut({ scope: "local" }), userBClient.auth.signOut({ scope: "local" })]);
  }
  const protectedAfter = await protectedArtifactSnapshot();
  assert.deepEqual(protectedAfter, protectedBefore, "REAL_C1D_ARTIFACT_CHANGED");
  assert.equal(cleanup, true, "C2C1_CLEANUP_FAILED");
  console.log(JSON.stringify({
    scenario,
    result,
    tokenHubProviderCalls: 0,
    paidMusicGeneration: 0,
    realProviderMediaDownloads: 0,
    cleanup: "PASS",
    realC1dArtifactPreserved: "PASS",
  }, null, 2));
}

await main();
