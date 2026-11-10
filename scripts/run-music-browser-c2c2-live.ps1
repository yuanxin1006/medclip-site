$ErrorActionPreference = "Stop"
$verifierExitCode = 1
$offExitCode = 1
$previousAcceptanceMode = $env:MEDCLIP_C2C2_ACCEPTANCE_MODE

try {
  & pnpm.cmd exec supabase secrets set MEDCLIP_MUSIC_TEST_RELEASE_MODE=TESTER_LIVE
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to enable the server-controlled TESTER_LIVE gate."
  }

  $env:MEDCLIP_C2C2_ACCEPTANCE_MODE = "REAL_PAID_PROVIDER_ACCEPTANCE"
  & D:\google\node.exe --env-file=.env.local scripts/verify-music-browser-c2c2-live.mjs
  $verifierExitCode = $LASTEXITCODE
} finally {
  $env:MEDCLIP_C2C2_ACCEPTANCE_MODE = $previousAcceptanceMode
  & pnpm.cmd exec supabase secrets set MEDCLIP_MUSIC_TEST_RELEASE_MODE=OFF
  $offExitCode = $LASTEXITCODE
}

if ($offExitCode -ne 0) {
  Write-Error "TESTER_LIVE could not be returned to OFF."
  exit 2
}

exit $verifierExitCode
