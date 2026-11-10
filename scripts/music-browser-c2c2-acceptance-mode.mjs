export const C2C2_ACCEPTANCE_MODES = Object.freeze({
  PROVIDER_FREE: "PROVIDER_FREE_BROWSER_ACCEPTANCE",
  REAL_PAID: "REAL_PAID_PROVIDER_ACCEPTANCE",
});

export function parseC2C2AcceptanceMode(value) {
  if (value === C2C2_ACCEPTANCE_MODES.PROVIDER_FREE) {
    return C2C2_ACCEPTANCE_MODES.PROVIDER_FREE;
  }
  if (value === C2C2_ACCEPTANCE_MODES.REAL_PAID) {
    return C2C2_ACCEPTANCE_MODES.REAL_PAID;
  }
  throw new Error("C2C2_ACCEPTANCE_MODE_REQUIRED");
}

export function validateC2C2AcceptancePlan({
  mode,
  intentionallyRefreshAfterSubmit = false,
}) {
  const parsedMode = parseC2C2AcceptanceMode(mode);
  if (
    parsedMode === C2C2_ACCEPTANCE_MODES.REAL_PAID
    && intentionallyRefreshAfterSubmit
  ) {
    throw new Error("REAL_PAID_REFRESH_FORBIDDEN");
  }
  return Object.freeze({
    mode: parsedMode,
    intentionallyRefreshAfterSubmit,
  });
}

export function createC2C2NavigationAudit(mode) {
  const parsedMode = parseC2C2AcceptanceMode(mode);
  let submitted = false;
  let pageReloadCount = 0;
  let navigationReloadAfterSubmit = 0;

  return Object.freeze({
    markSubmitted() {
      submitted = true;
    },
    recordMainFrameNavigation() {
      if (submitted) navigationReloadAfterSubmit += 1;
    },
    beforePageReload() {
      if (parsedMode === C2C2_ACCEPTANCE_MODES.REAL_PAID) {
        throw new Error("REAL_PAID_REFRESH_FORBIDDEN");
      }
      pageReloadCount += 1;
    },
    snapshot() {
      return Object.freeze({
        pageReloadCount,
        navigationReloadAfterSubmit,
      });
    },
  });
}
