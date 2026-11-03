# 까비서 업데이트 (Windows PowerShell): 최신 코드 받기 → 이미지 다시 빌드 → 기동 → 상태 확인
# 사용: 저장소 폴더에서  powershell -ExecutionPolicy Bypass -File scripts\update.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path ".env")) {
  Write-Host ".env 가 없어요. Copy-Item .env.example .env 한 뒤 APP_CRYPTO_KEY 를 채우고 다시 실행하세요." -ForegroundColor Red
  exit 1
}
$port = 3000
$portLine = Get-Content .env | Where-Object { $_ -match '^\s*WEB_PORT\s*=\s*(\d+)' }
if ($portLine) { $port = [int]$Matches[1] }

Write-Host "1) 최신 코드 받기" -ForegroundColor Cyan
git pull --ff-only

Write-Host "2) 이미지 빌드 + 기동 (처음이면 5~10분)" -ForegroundColor Cyan
docker compose up -d --build

Write-Host "3) 상태 확인" -ForegroundColor Cyan
$deadline = (Get-Date).AddMinutes(3)
$ok = $false
do {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://localhost:$port/"
    if ($r.StatusCode -eq 200) { $ok = $true }
  } catch { }
} until ($ok -or (Get-Date) -gt $deadline)

docker compose ps
Write-Host ""
docker compose logs --tail=15 worker
Write-Host ""
if ($ok) {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" } | Select-Object -First 1).IPAddress
  Write-Host "web OK → 이 PC: http://localhost:$port" -ForegroundColor Green
  if ($ip) { Write-Host "       같은 와이파이의 휴대폰: http://$ip`:$port  (안 열리면 Windows 방화벽에서 $port 포트 허용)" -ForegroundColor Green }
} else {
  Write-Host "web 이 아직 응답하지 않아요. 아래 로그를 확인하세요:  docker compose logs --tail=50 web worker" -ForegroundColor Red
  exit 1
}
