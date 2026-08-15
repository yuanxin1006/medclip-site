$ErrorActionPreference = 'Stop'
$publicPath = Join-Path $PSScriptRoot 'public'
python -m http.server 8000 --directory $publicPath
