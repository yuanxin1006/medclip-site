$ErrorActionPreference = 'Stop'
$outPath = Join-Path $PSScriptRoot 'out'
if (-not (Test-Path -LiteralPath $outPath -PathType Container)) {
  throw 'Run pnpm exec next build --webpack before serving the static export.'
}
python -m http.server 8000 --directory $outPath

