import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { AI_PROVIDER_DEFINITIONS } from "./providers.ts";
import {
  aiProviderStatusLabel,
  maskAIProviderKey,
  safeAIProviderErrorMessage,
  safeAIProviderStatusMessage,
} from "./ui.ts";

const pageSource = readFileSync(new URL("../../app/ai-services/page.tsx", import.meta.url), "utf8");
const rootPageSource = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const cardSource = readFileSync(new URL("../../components/ai/AIProviderCard.tsx", import.meta.url), "utf8");
const anonymousGateSource = readFileSync(new URL("../../components/platform/AnonymousLandingGate.tsx", import.meta.url), "utf8");
const headerSource = readFileSync(new URL("../../components/platform/PlatformHeader.tsx", import.meta.url), "utf8");
const authProviderSource = readFileSync(new URL("../../components/auth/AuthProvider.tsx", import.meta.url), "utf8");
const deleteDialogSource = readFileSync(new URL("../../components/ai/DeleteProviderDialog.tsx", import.meta.url), "utf8");
const costNoticeSource = readFileSync(new URL("../../components/ai/AIServiceCostNotice.tsx", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("./types.ts", import.meta.url), "utf8");
const authPageSource = readFileSync(new URL("../../app/auth/page.tsx", import.meta.url), "utf8");
const homePageSource = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const musicPageSource = readFileSync(new URL("../../app/music/page.tsx", import.meta.url), "utf8");
const allBrowserSources = [pageSource, cardSource, deleteDialogSource, costNoticeSource, clientSource].join("\n");

// Render the actual TSX with only framework routing, CSS and auth state stubbed.
// Keep component branches and React hooks real; never initialize Supabase here.
const require = createRequire(import.meta.url);
const signedIn = { loading: false, user: { id: "home-test-user", email: "home@example.invalid" } };
type HomeAuthState = { loading: boolean; user: typeof signedIn.user | null };
function renderHome(source: string, auth: HomeAuthState, pathname = "/"): string {
  const load = (tsx: string): ComponentType => {
    const module = { exports: {} as { default: ComponentType } };
    const code = ts.transpileModule(tsx, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    const localRequire = (id: string): unknown => {
      if (id === "next/link") return { __esModule: true, default: "a" };
      if (id === "next/navigation") return { usePathname: () => pathname };
      if (id.endsWith("/AuthProvider")) return { useAuth: () => ({ ...auth, displayName: "Home user", error: null, signOut: async () => {} }) };
      if (id.endsWith("/AnonymousLandingGate")) return { __esModule: true, default: load(anonymousGateSource) };
      if (id.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
      if (id === "react" || id === "react/jsx-runtime") return require(id);
      throw new Error(`Unexpected homepage test dependency: ${id}`);
    };
    new Function("require", "module", "exports", code)(localRequire, module, module.exports);
    return module.exports.default;
  };
  return renderToStaticMarkup(createElement(load(source)));
}
function featureLinks(markup: string) {
  return [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].flatMap(([, attrs, content]) => {
    const heading = content.match(/<h3\b[^>]*>([^<]+)<\/h3>/);
    return heading ? [{ href: attrs.match(/href="([^"]+)"/)?.[1], title: heading[1] }] : [];
  });
}

test("AI services uses the China-priority product order", () => {
  assert.deepEqual(AI_PROVIDER_DEFINITIONS.map((provider) => provider.id), [
    "deepseek",
    "kimi",
    "doubao",
    "tencent_tokenhub",
  ]);
});

test("TokenHub is visible in credential management but is music-capability only", () => {
  const tokenHub = AI_PROVIDER_DEFINITIONS.find((provider) => provider.id === "tencent_tokenhub");
  assert.ok(tokenHub);
  assert.equal(tokenHub.requiresResourceId, false);
  assert.deepEqual(tokenHub.taskCapabilities, ["MUSIC_GENERATION"]);
  assert.match(tokenHub.description, /API Key/);
  assert.match(pageSource, /AI_PROVIDER_DEFINITIONS\.map/);
});

test("anonymous AI services uses the three-line MedClip brand copy", () => {
  assert.match(pageSource, /if \(!user\)/);
  assert.match(pageSource, /AnonymousLandingGate/);
  assert.match(anonymousGateSource, /href="\/auth"/);
  assert.match(anonymousGateSource, /<p className="platform-kicker">Medclip<\/p>/);
  assert.match(anonymousGateSource, /<h1>医剪<\/h1>/);
  assert.match(anonymousGateSource, /<p>医韵和声<\/p>/);
});

test("anonymous AI services still hides API Key management controls", () => {
  const anonymousStart = pageSource.indexOf('if (!user) {\n    return <main className="platform-page ai-services-page">');
  const anonymousEnd = pageSource.indexOf("\n  }\n\n  return", anonymousStart);
  assert.ok(anonymousStart >= 0 && anonymousEnd > anonymousStart);
  const anonymousBlock = pageSource.slice(anonymousStart, anonymousEnd);
  assert.match(anonymousBlock, /AnonymousLandingGate/);
  assert.doesNotMatch(anonymousBlock, /AIProviderCard|API Key|onPersist|onTestTransient/);
});

test("the anonymous root renders only the shared brand gate", () => {
  const html = renderHome(rootPageSource, { loading: false, user: null });
  assert.match(html, /<p[^>]*>Medclip<\/p>/);
  assert.match(html, /<h1[^>]*>医剪<\/h1>/);
  assert.match(html, /<p[^>]*>医韵和声<\/p>/);
  assert.match(html, /<a[^>]*href="\/auth"[^>]*>登录 \/ 注册<\/a>/);
  assert.doesNotMatch(html, /音乐作品|AI 歌曲生成|视频剪辑|AIProviderCard|api_key|href="\/(?:music|create-music|editor)"/i);
  assert.equal((html.match(/<a\b/g) ?? []).length, 1);
});

test("the root auth loading branch is neutral and does not expose product content", () => {
  for (const user of [null, signedIn.user]) {
    const html = renderHome(rootPageSource, { loading: true, user });
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /正在恢复登录状态/);
    assert.doesNotMatch(html, /音乐作品|AI 歌曲生成|视频剪辑|AIProviderCard|api_key|<a\b/i);
  }
});

test("root navigation hides primary module links while anonymous or auth is loading", () => {
  for (const auth of [{ loading: true, user: null }, { loading: true, user: signedIn.user }, { loading: false, user: null }]) {
    const html = renderHome(headerSource, auth);
    assert.doesNotMatch(html, /href="\/(?:music|create-music|editor)"/);
    if (auth.loading) assert.match(html, /正在检查登录/);
    else assert.match(html, /href="\/auth"/);
  }
  const html = renderHome(headerSource, signedIn);
  for (const path of ["music", "create-music", "editor", "ai-services"]) assert.ok(html.includes(`href="/${path}"`));
  assert.match(html, /Home user/);
  assert.doesNotMatch(html, /href="\/auth"/);
  // Preserve navigation on other routes, including the active-route indicator.
  assert.match(renderHome(headerSource, { loading: false, user: null }, "/music"), /<a[^>]*aria-current="page"[^>]*href="\/music"/);
});

test("logout clears the session before the root selects the anonymous gate", () => {
  assert.match(authProviderSource, /await signOutCurrentSession\(\);\s*await syncUser\(null\)/);
  assert.equal(featureLinks(renderHome(rootPageSource, signedIn)).length, 3);
  const after = renderHome(rootPageSource, { loading: false, user: null });
  assert.match(after, /<h1[^>]*>医剪<\/h1>/);
  assert.match(after, /href="\/auth"/);
  assert.doesNotMatch(after, /href="\/(?:music|create-music|editor)"/);
});

test("login and registration use the homepage as their default destination", () => {
  assert.match(authPageSource, /const DEFAULT_AUTH_DESTINATION = "\/"/);
  assert.doesNotMatch(authPageSource, /router\.replace\("\/music"\)/);
  assert.equal(authPageSource.match(/router\.replace\(DEFAULT_AUTH_DESTINATION\)/g)?.length, 3);
});

test("the music route remains available", () => {
  assert.match(musicPageSource, /export default function MusicPage/);
  assert.deepEqual(featureLinks(renderHome(homePageSource, signedIn)).filter(link => link.href === "/music"), [{ href: "/music", title: "音乐作品" }]);
});

test("the homepage preserves the primary module order", () => {
  assert.deepEqual(featureLinks(renderHome(homePageSource, signedIn)), [
    { href: "/music", title: "音乐作品" },
    { href: "/create-music", title: "AI 歌曲生成" },
    { href: "/editor", title: "视频剪辑" },
  ]);
});

test("authenticated connection metadata is loaded through the Edge Function list contract", () => {
  assert.match(pageSource, /listAIProviderConnections\(\)/);
  assert.match(pageSource, /AI_PROVIDER_DEFINITIONS\.map/);
  assert.match(clientSource, /invokeCredentialFunction\(\{ action: "list" \}\)/);
});

test("an unconnected provider uses an empty password input with autocomplete disabled", () => {
  assert.match(cardSource, /type=\{showKey \? "text" : "password"\}/);
  assert.match(cardSource, /autoComplete="new-password"/);
  assert.match(cardSource, /value=\{apiKey\}/);
  assert.match(cardSource, /useState\(""\)/);
});

test("saved providers render only a masked last4 value", () => {
  assert.equal(maskAIProviderKey("1234"), "•••• •••• •••• 1234");
  assert.match(cardSource, /maskAIProviderKey\(connection\.key_last4\)/);
  assert.doesNotMatch(typesSource, /api_key|ciphertext|\biv\b/i);
});

test("a full saved key is never rendered back into the replacement input", () => {
  assert.match(cardSource, /placeholder=\{connection \? "输入完整的新 API Key"/);
  assert.doesNotMatch(cardSource, /setApiKey\(connection/);
  assert.doesNotMatch(cardSource, /value=\{connection\./);
});

test("transient testing calls the fixed test transient backend contract", () => {
  assert.match(clientSource, /action: "test"/);
  assert.match(clientSource, /mode: "transient"/);
  assert.match(cardSource, /await onTestTransient\(apiKey, configurationResourceId\)/);
});

test("transient testing cannot create local connected state", () => {
  const transientStart = cardSource.indexOf("const testTransient");
  const savedStart = cardSource.indexOf("const testSaved");
  const transientBlock = cardSource.slice(transientStart, savedStart);
  assert.doesNotMatch(transientBlock, /setConnection|replaceConnection|setConnections/);
  assert.match(transientBlock, /凭证尚未保存/);
});

test("save success clears plaintext input and hides it", () => {
  const persistStart = cardSource.indexOf("const persist");
  const removeStart = cardSource.indexOf("const remove");
  const persistBlock = cardSource.slice(persistStart, removeStart);
  assert.match(persistBlock, /await onPersist/);
  assert.match(persistBlock, /clearSecretInput\(\)/);
  assert.ok(persistBlock.indexOf("clearSecretInput()") < persistBlock.indexOf("await onRefresh()"));
  assert.match(cardSource, /setApiKey\(""\)/);
  assert.match(cardSource, /setShowKey\(false\)/);
});

test("update uses the existing update action and clears the new key", () => {
  assert.match(pageSource, /updateAIProviderCredential\(provider\.id, apiKey/);
  assert.match(cardSource, /connection \? "更新连接" : "保存并连接"/);
  assert.match(cardSource, /clearSecretInput\(\)/);
});

test("delete requires an explicit confirmation dialog", () => {
  assert.match(cardSource, /setDeleteOpen\(true\)/);
  assert.match(deleteDialogSource, /aria-modal="true"/);
  assert.match(deleteDialogSource, /确认删除/);
  assert.match(deleteDialogSource, /取消/);
});

test("delete affects only the selected provider", () => {
  assert.match(pageSource, /deleteAIProviderCredential\(provider\.id\)/);
  assert.match(pageSource, /item\.provider !== provider\.id/);
  assert.doesNotMatch(pageSource, /deleteAll|全部删除|删除全部/);
});

test("Doubao requires its API-Key Resource ID / ApikeyID", () => {
  const doubao = AI_PROVIDER_DEFINITIONS.find((provider) => provider.id === "doubao");
  assert.equal(doubao?.requiresResourceId, true);
  assert.equal(doubao?.resourceIdLabel, "API Key 资源 ID（ApikeyID）");
  assert.match(cardSource, /resourceMissing/);
  assert.match(cardSource, /placeholder="apikey-\.\.\."/);
});

test("non-Doubao providers do not render a resource ID input", () => {
  assert.ok(AI_PROVIDER_DEFINITIONS.filter((provider) => provider.id !== "doubao").every((provider) => !provider.requiresResourceId));
  assert.match(cardSource, /provider\.requiresResourceId && <label/);
});

test("the browser UI has no custom Base URL field", () => {
  assert.doesNotMatch(cardSource, /name=["'](?:baseURL|baseUrl)["']/);
  assert.doesNotMatch(pageSource, /name=["'](?:baseURL|baseUrl)["']/);
});

test("the browser UI has no custom endpoint field", () => {
  assert.doesNotMatch(cardSource, /name=["'](?:endpoint|hostname)["']/);
  assert.doesNotMatch(pageSource, /name=["'](?:endpoint|hostname)["']/);
});

test("the browser UI has no custom timeout field", () => {
  assert.doesNotMatch(cardSource, /name=["']timeout/);
  assert.doesNotMatch(pageSource, /name=["']timeout/);
});

test("API keys are never persisted to localStorage", () => {
  assert.doesNotMatch(allBrowserSources, /localStorage/);
});

test("API keys are never persisted to sessionStorage", () => {
  assert.doesNotMatch(allBrowserSources, /sessionStorage/);
});

test("known backend errors map to fixed safe Chinese messages", () => {
  assert.equal(safeAIProviderStatusMessage("API_KEY_INVALID"), "API Key 无效或没有访问权限。");
  assert.equal(safeAIProviderStatusMessage("PROVIDER_CONFIGURATION_REQUIRED"), "Provider 配置不完整，请检查必填信息。");
  assert.equal(safeAIProviderStatusMessage("RATE_LIMITED"), "服务商请求频率受限，请稍后再试。");
  assert.equal(safeAIProviderStatusMessage("REGION_UNAVAILABLE"), "当前网络或地区暂时无法连接服务商。");
  assert.equal(safeAIProviderStatusMessage("NETWORK_ERROR"), "无法连接服务商，请稍后重试。");
  assert.equal(safeAIProviderStatusMessage("PROVIDER_UNAVAILABLE"), "服务商暂时不可用。");
  assert.equal(safeAIProviderStatusMessage("NOT_CONNECTED"), "尚未连接此服务。");
  assert.equal(safeAIProviderStatusMessage("INTERNAL_ERROR"), "服务暂时不可用。");
  assert.equal(safeAIProviderErrorMessage(new Error("raw upstream detail")), "服务暂时不可用。");
});

test("loading state disables duplicate provider submissions", () => {
  assert.match(cardSource, /const busy = busyAction !== null/);
  assert.match(cardSource, /disabled=\{busy \|\| secretMissing \|\| resourceMissing\}/);
  assert.match(deleteDialogSource, /disabled=\{busy\}/);
});

for (const providerId of ["deepseek", "kimi", "doubao", "tencent_tokenhub"] as const) {
  test(`${providerId} metadata renders through the unified provider card`, () => {
    assert.ok(AI_PROVIDER_DEFINITIONS.some((provider) => provider.id === providerId));
    assert.match(pageSource, /connection=\{connection\}/);
    assert.match(cardSource, /connection\.status/);
    assert.match(cardSource, /connection\.key_last4/);
    assert.match(cardSource, /connection\?\.last_validated_at/);
  });
}

test("the page gives a durable provider-account cost notice without hard-coded prices", () => {
  assert.match(costNoticeSource, /模型调用费用由服务商账户承担/);
  assert.match(costNoticeSource, /免费额度/);
  assert.match(costNoticeSource, /服务商后台为准/);
  assert.doesNotMatch(costNoticeSource, /¥|美元|每百万|全部免费/);
});

test("status labels cover disconnected, connected, failed, and reconnect states", () => {
  assert.equal(aiProviderStatusLabel(null), "未连接");
  assert.equal(aiProviderStatusLabel("connected"), "已连接");
  assert.equal(aiProviderStatusLabel("validation_failed"), "验证失败");
  assert.equal(aiProviderStatusLabel("needs_update"), "需要重新连接");
});
