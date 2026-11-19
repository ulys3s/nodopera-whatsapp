# Agrega al túnel de Cloudflare SOLO la ruta pública del Diagnóstico NodOpera:
#   https://wa.nodopera.com/webhook/diag-32990aa3fd  ->  n8n (localhost:5678)
# Todo lo demás de wa.nodopera.com sigue en 404. Respalda config.yml, valida y reinicia el servicio.
$ErrorActionPreference = 'Stop'
$exe = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$cfg = "C:\Windows\System32\config\systemprofile\.cloudflared\config.yml"
$t = Get-Content $cfg -Raw
if ($t -match 'diag-32990aa3fd') { Write-Host "La ruta ya estaba abierta." }
else {
  $bak = "$cfg.bak-$(Get-Date -Format yyyyMMdd)"
  if (Test-Path $bak) { $bak = "$cfg.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
  Copy-Item $cfg $bak
  $regla = "  - hostname: wa.nodopera.com`r`n    path: ^/webhook/diag-32990aa3fd$`r`n    service: http://localhost:5678`r`n"
  $ancla = "  - hostname: wa.nodopera.com`r`n    service: http_status:404"
  if (-not $t.Contains($ancla)) { $ancla = $ancla -replace "`r`n", "`n"; $regla = $regla -replace "`r`n", "`n" }
  if (-not $t.Contains($ancla)) { Write-Error "No encontré la regla 404 de wa.nodopera.com; no cambié nada." }
  [IO.File]::WriteAllText($cfg, $t.Replace($ancla, $regla + $ancla), (New-Object Text.UTF8Encoding $false))
  & $exe tunnel --config $cfg ingress validate
  if ($LASTEXITCODE -ne 0) { Copy-Item $bak $cfg -Force; Write-Error "Configuración inválida; restauré el respaldo $bak." }
  Write-Host "Respaldo: $bak"
  Restart-Service cloudflared
  Start-Sleep 6
}
foreach ($u in 'https://wa.nodopera.com/webhook/diag-32990aa3fd', 'https://wa.nodopera.com/webhook/otra-cosa', 'https://wa.nodopera.com/') {
  & $exe tunnel --config $cfg ingress rule $u 2>&1 | Select-String -Pattern 'Matched|service|path' | ForEach-Object { "$u -> $_" }
}
"cloudflared: " + (Get-Service cloudflared).Status
