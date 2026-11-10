import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  C2C2_ACCEPTANCE_MODES,
  createC2C2NavigationAudit,
  parseC2C2AcceptanceMode,
  validateC2C2AcceptancePlan,
} from "./music-browser-c2c2-acceptance-mode.mjs";

test("C2C2 acceptance mode is explicit and fail-closed", () => {
  assert.equal(
    parseC2C2AcceptanceMode("REAL_PAID_PROVIDER_ACCEPTANCE"),
    C2C2_ACCEPTANCE_MODES.REAL_PAID,
  );
  assert.equal(
    parseC2C2AcceptanceMode("PROVIDER_FREE_BROWSER_ACCEPTANCE"),
    C2C2_ACCEPTANCE_MODES.PROVIDER_FREE,
  );
  assert.throws(() => parseC2C2AcceptanceMode(undefined), /C2C2_ACCEPTANCE_MODE_REQUIRED/);
  assert.throws(() => parseC2C2AcceptanceMode("REAL_PAID"), /C2C2_ACCEPTANCE_MODE_REQUIRED/);
});

test("real paid refresh plan fails before Provider dispatch", () => {
  let providerDispatches = 0;
  assert.throws(() => {
    validateC2C2AcceptancePlan({
      mode: C2C2_ACCEPTANCE_MODES.REAL_PAID,
      intentionallyRefreshAfterSubmit: true,
    });
    providerDispatches += 1;
  }, /REAL_PAID_REFRESH_FORBIDDEN/);
  assert.equal(providerDispatches, 0);
});

test("real paid navigation guard rejects explicit reload", () => {
  const audit = createC2C2NavigationAudit(C2C2_ACCEPTANCE_MODES.REAL_PAID);
  audit.markSubmitted();
  assert.throws(() => audit.beforePageReload(), /REAL_PAID_REFRESH_FORBIDDEN/);
  assert.deepEqual(audit.snapshot(), {
    pageReloadCount: 0,
    navigationReloadAfterSubmit: 0,
  });
});

test("provider-free mode remains available without requesting refresh", () => {
  assert.deepEqual(
    validateC2C2AcceptancePlan({
      mode: C2C2_ACCEPTANCE_MODES.PROVIDER_FREE,
      intentionallyRefreshAfterSubmit: false,
    }),
    {
      mode: C2C2_ACCEPTANCE_MODES.PROVIDER_FREE,
      intentionallyRefreshAfterSubmit: false,
    },
  );
});

test("real C2C2 verifier contains no page reload and records zero-navigation evidence", () => {
  const source = readFileSync(
    new URL("./verify-music-browser-c2c2-live.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\.reload\s*\(/);
  assert.match(source, /pageReloadCount/);
  assert.match(source, /navigationReloadAfterSubmit/);
  assert.match(source, /SECOND_START_AFTER_SUBMIT/);
});

test("C2C1 provider-free refresh recovery coverage remains intact", () => {
  const source = readFileSync(
    new URL("./verify-music-browser-c2c1.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /pageA\.reload\s*\(/);
  assert.match(source, /REFRESH|refresh/i);
});

test("paid wrapper selects real-paid mode and always restores release mode OFF", () => {
  const source = readFileSync(
    new URL("./run-music-browser-c2c2-live.ps1", import.meta.url),
    "utf8",
  );
  assert.match(source, /REAL_PAID_PROVIDER_ACCEPTANCE/);
  assert.match(source, /finally\s*\{/);
  assert.match(source, /MEDCLIP_MUSIC_TEST_RELEASE_MODE=OFF/);
});
