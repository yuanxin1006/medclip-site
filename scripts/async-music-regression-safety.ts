export type AsyncRegressionSafety = {
  publicReleaseEnabled: boolean;
  deterministicPreDispatchBlocker?: boolean;
  trustedProviderFreeMock?: boolean;
};

export function assertAsyncRegressionRequestIsProviderFree({
  publicReleaseEnabled,
  deterministicPreDispatchBlocker = false,
  trustedProviderFreeMock = false,
}: AsyncRegressionSafety): void {
  if (publicReleaseEnabled && !deterministicPreDispatchBlocker && !trustedProviderFreeMock) {
    throw new Error("UNSAFE_PUBLIC_REAL_REGRESSION_REQUEST");
  }
}
