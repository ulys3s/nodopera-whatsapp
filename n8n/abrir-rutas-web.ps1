# Agrega al túnel de Cloudflare SOLO las 2 rutas públicas de "Formularios y pagos" (nodopera.com):
#   https://wa.nodopera.com/webhook/web-476f8f4d85    (formularios y tienda)   ->  n8n (localhost:5678)
#   https://wa.nodopera.com/webhook/mp-f38d583576c3   (avisos de Mercado Pago) ->  n8n (localhost:5678)
# Todo lo demás de wa.nodopera.com sigue en 404. Respalda config.yml, valida y reinicia el servicio.
# Ejecutar en PowerShell como administrador en la PC de la oficina.
$ErrorActionPreference = 'Stop'
$exe = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$cfg = "C:\Windows\System32\config\systemprofile\.cloudflared\config.yml"
$rutas = @('web-476f8f4d85', 'mp-f38d583576c3')
$t = Get-Content $cfg -Raw
$nuevas = $rutas | Where-Object { -not $t.Contains("^/webhook/$_`$") }
if (-not $nuevas) { Write-Host "Las rutas ya estaban abiertas." }
else {
  $bak = "$cfg.bak-$(Get-Date -Format yyyyMMdd)"
  if (Test-Path $bak) { $bak = "$cfg.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
  Copy-Item $cfg $bak
  $regla = ($nuevas | ForEach-Object { "  - hostname: wa.nodopera.com`r`n    path: ^/webhook/$_`$`r`n    service: http://localhost:5678`r`n" }) -join ''
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
foreach ($u in ($rutas | ForEach-Object { "https://wa.nodopera.com/webhook/$_" }) + 'https://wa.nodopera.com/webhook/otra-cosa') {
  & $exe tunnel --config $cfg ingress rule $u 2>&1 | Select-String -Pattern 'Matched|service|path' | ForEach-Object { "$u -> $_" }
}
"cloudflared: " + (Get-Service cloudflared).Status
