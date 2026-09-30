$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function Get-EnvValue([string]$Text, [string]$Name) {
  $match = [regex]::Match($Text, "(?m)^$([regex]::Escape($Name))=(.*)$")
  if ($match.Success) { return $match.Groups[1].Value }
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

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand -and (Test-Path 'C:\Program Files\nodejs\node.exe')) {
  $env:Path = "C:\Program Files\nodejs;$env:Path"
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
}
if (-not $nodeCommand) { throw 'Node.js 24 ou superior não foi encontrado. Instale o Node.js e abra um novo terminal.' }
$nodeVersion = [version]((& $nodeCommand.Source --version).TrimStart('v'))
if ($nodeVersion.Major -lt 24) { throw "O projeto requer Node.js 24 ou superior. Versão encontrada: $nodeVersion" }

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
  $dbPassword = New-RandomHex 32
  $envText = Set-EnvValue $envText 'POSTGRES_PASSWORD' $dbPassword
  $dbUser = Get-EnvValue $envText 'POSTGRES_USER'
  $dbName = Get-EnvValue $envText 'POSTGRES_DB'
  if (-not $dbUser) { $dbUser = 'aether' }
  if (-not $dbName) { $dbName = 'aether' }
  $envText = Set-EnvValue $envText 'DATABASE_URL' "postgres://$($dbUser):$($dbPassword)@localhost:5432/$($dbName)"
}
if (-not (Get-EnvValue $envText 'ADMIN_EMAIL')) {
  $envText = Set-EnvValue $envText 'ADMIN_EMAIL' 'aetherstudio.figures@gmail.com'
}
[System.IO.File]::WriteAllText($envPath, $envText, [System.Text.UTF8Encoding]::new($false))

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$npmPath = if ($npmCommand) { $npmCommand.Source } else { '' }
if (-not $npmCommand -and (Test-Path 'C:\Program Files\nodejs\npm.cmd')) {
  $npmPath = 'C:\Program Files\nodejs\npm.cmd'
}
if (-not $npmPath) { throw 'npm.cmd não foi encontrado junto com o Node.js.' }

if (-not (Test-Path (Join-Path $projectRoot 'node_modules\vite'))) {
  Write-Host 'Instalando as dependências do projeto...'
  & $npmPath ci
  if ($LASTEXITCODE -ne 0) { throw 'A instalação das dependências falhou.' }
}

Write-Host 'Iniciando o PostgreSQL local...'
& $dockerCommand.Source compose up -d db
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível iniciar o PostgreSQL pelo Docker Compose.' }

$databaseReady = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  & $dockerCommand.Source compose exec -T db pg_isready *> $null
  if ($LASTEXITCODE -eq 0) { $databaseReady = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $databaseReady) { throw 'O PostgreSQL não ficou pronto em 60 segundos. Confira com: docker compose logs db' }

$envText = [System.IO.File]::ReadAllText($envPath)
$adminEmail = Get-EnvValue $envText 'ADMIN_EMAIL'
$dbUser = Get-EnvValue $envText 'POSTGRES_USER'
$dbName = Get-EnvValue $envText 'POSTGRES_DB'
if (-not $dbUser) { $dbUser = 'aether' }
if (-not $dbName) { $dbName = 'aether' }
$usersTableQuery = "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users')"
$usersTableResult = & $dockerCommand.Source compose exec -T db psql -U $dbUser -d $dbName -Atqc $usersTableQuery
$adminExists = $false
if ($LASTEXITCODE -eq 0 -and ($usersTableResult -join '').Trim() -eq 't') {
  $adminQuery = "SELECT EXISTS (SELECT 1 FROM users WHERE email = :'admin_email' AND is_admin = TRUE)"
  $adminResult = & $dockerCommand.Source compose exec -T db psql -U $dbUser -d $dbName -v "admin_email=$adminEmail" -Atqc $adminQuery
  $adminExists = $LASTEXITCODE -eq 0 -and ($adminResult -join '').Trim() -eq 't'
}
if (-not $adminExists -and -not (Get-EnvValue $envText 'ADMIN_BOOTSTRAP_PASSWORD')) {
  $adminPassword = Read-BootstrapPassword
  $envText = Set-EnvValue $envText 'ADMIN_BOOTSTRAP_PASSWORD' $adminPassword
  $adminPassword = $null
  [System.IO.File]::WriteAllText($envPath, $envText, [System.Text.UTF8Encoding]::new($false))
}

Write-Host 'Loja pronta para desenvolvimento em http://localhost:5173' -ForegroundColor Green
Write-Host 'No primeiro início, o servidor cria a conta administradora configurada no .env.'
Write-Host 'Depois de confirmar que consegue entrar, remova ADMIN_BOOTSTRAP_PASSWORD do .env.' -ForegroundColor Yellow
Write-Host 'Pressione Ctrl+C para encerrar os servidores.'
& $npmPath run dev
if ($LASTEXITCODE -ne 0) { throw 'O servidor da loja foi encerrado com erro.' }
