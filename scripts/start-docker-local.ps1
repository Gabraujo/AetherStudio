$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function Get-EnvValue([string]$Text, [string]$Name) {
  $match = [regex]::Match($Text, "(?m)^$([regex]::Escape($Name))=(.*)$")
  if ($match.Success) { return $match.Groups[1].Value.Trim() }
  return ''
}

function Set-EnvValue([string]$Text, [string]$Name, [string]$Value) {
  $pattern = "(?m)^$([regex]::Escape($Name))=.*$"
  if ([regex]::IsMatch($Text, $pattern)) {
    return [regex]::Replace($Text, $pattern, "$Name=$Value")
  }
  return "$($Text.TrimEnd())`r`n$Name=$Value`r`n"
}

function New-RandomHex([int]$ByteCount) {
  $bytes = New-Object byte[] $ByteCount
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

function Read-BootstrapPassword {
  while ($true) {
    $secure = Read-Host 'Crie a senha inicial do administrador (20 a 72 letras e números)' -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
      $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
      if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
    if ($value -cmatch '^[A-Za-z0-9]{20,72}$') { return $value }
    Write-Host 'Use de 20 a 72 caracteres, somente letras sem acento e números.' -ForegroundColor Yellow
  }
}

$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $dockerCommand) { throw 'Docker não foi encontrado. Instale e abra o Docker Desktop, aguarde o mecanismo iniciar e execute este script novamente.' }
& $dockerCommand.Source info *> $null
if ($LASTEXITCODE -ne 0) { throw 'O Docker Desktop está instalado, mas seu mecanismo não está em execução. Abra o Docker Desktop e tente novamente.' }

$envPath = Join-Path $projectRoot '.env'
$examplePath = Join-Path $projectRoot '.env.example'
if (-not (Test-Path -LiteralPath $envPath)) {
  Copy-Item -LiteralPath $examplePath -Destination $envPath
  Write-Host 'Arquivo .env criado a partir do exemplo.'
}
$envText = [System.IO.File]::ReadAllText($envPath)

if (-not (Get-EnvValue $envText 'SESSION_SECRET')) {
  $envText = Set-EnvValue $envText 'SESSION_SECRET' (New-RandomHex 48)
}
$dbPassword = Get-EnvValue $envText 'POSTGRES_PASSWORD'
if (-not $dbPassword -or $dbPassword -match '^replace_with_') {
  $envText = Set-EnvValue $envText 'POSTGRES_PASSWORD' (New-RandomHex 32)
}
if (-not (Get-EnvValue $envText 'ADMIN_EMAIL')) {
  $envText = Set-EnvValue $envText 'ADMIN_EMAIL' 'aetherstudio.figures@gmail.com'
}
[System.IO.File]::WriteAllText($envPath, $envText, [System.Text.UTF8Encoding]::new($false))

$composeFile = Join-Path $projectRoot 'docker-compose.local.yml'
$composeArgs = @('compose', '-f', $composeFile)
$dbComposeArgs = @($composeArgs + @('up', '-d', '--wait', '--wait-timeout', '120', 'db'))
Write-Host 'Iniciando o banco PostgreSQL em Docker...'
& $dockerCommand.Source @dbComposeArgs
if ($LASTEXITCODE -ne 0) { throw 'O banco não iniciou. Consulte: docker compose -f docker-compose.local.yml logs db' }

$usersTableQuery = "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users')"
$dbUser = Get-EnvValue $envText 'POSTGRES_USER'
$dbName = Get-EnvValue $envText 'POSTGRES_DB'
if (-not $dbUser) { $dbUser = 'aether' }
if (-not $dbName) { $dbName = 'aether' }
$usersTableResult = & $dockerCommand.Source @composeArgs exec -T db psql -U $dbUser -d $dbName -Atqc $usersTableQuery
$adminExists = $false
if ($LASTEXITCODE -eq 0 -and ($usersTableResult -join '').Trim() -eq 't') {
  $adminEmail = Get-EnvValue $envText 'ADMIN_EMAIL'
  $adminQuery = "SELECT EXISTS (SELECT 1 FROM users WHERE email = :'admin_email' AND is_admin = TRUE)"
  $adminResult = & $dockerCommand.Source @composeArgs exec -T db psql -U $dbUser -d $dbName -v "admin_email=$adminEmail" -Atqc $adminQuery
  $adminExists = $LASTEXITCODE -eq 0 -and ($adminResult -join '').Trim() -eq 't'
}
if (-not $adminExists -and -not (Get-EnvValue $envText 'ADMIN_BOOTSTRAP_PASSWORD')) {
  $adminPassword = Read-BootstrapPassword
  $envText = Set-EnvValue $envText 'ADMIN_BOOTSTRAP_PASSWORD' $adminPassword
  $adminPassword = $null
}
[System.IO.File]::WriteAllText($envPath, $envText, [System.Text.UTF8Encoding]::new($false))

Write-Host 'Construindo a imagem e iniciando loja e banco em Docker...'
& $dockerCommand.Source @composeArgs up -d --build --wait --wait-timeout 180
if ($LASTEXITCODE -ne 0) {
  throw 'A inicialização falhou. Consulte os detalhes com: docker compose -f docker-compose.local.yml logs app db'
}

Write-Host ''
Write-Host 'Loja pronta em http://localhost:3000' -ForegroundColor Green
Write-Host 'Para encerrar: docker compose -f docker-compose.local.yml down'
Write-Host 'Os dados continuam salvos nos volumes locais. Não use down -v se quiser preservá-los.' -ForegroundColor Yellow
