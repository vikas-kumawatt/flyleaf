# Export-Catalog.ps1 - dump the Flyleaf CATALOG ONLY from the laptop database,
# for deploy/catalog/restore-catalog.sh on the server (docs/deploy.md step 6).
#
#   cd D:\Bookmarked\flyleaf
#   .\deploy\catalog\Export-Catalog.ps1                       # -> .\catalog-export\flyleaf-catalog-<stamp>\
#   .\deploy\catalog\Export-Catalog.ps1 -IncludeRawPayloads   # also Open Library's raw JSON (large)
#
# What it takes and what it leaves behind is decided by
# deploy\config\catalog-tables.txt and explained in dump-catalog.sh: the
# schema of everything, the rows of the catalog tables only. No user, bench,
# activity, event, rating or moderation rows leave the laptop.
#
# How: the dump runs INSIDE the flyleaf-pg container (dump-catalog.sh, copied
# in), so pg_dump is the server's own version 18, and the file is written
# there and copied out with `docker cp`. Not through a pipe: Windows
# PowerShell 5.1 re-encodes binary output that passes through it, which would
# corrupt the archive.
#
# Needs: Docker Desktop with flyleaf-pg running, and free space in the Docker
# VM for the compressed dump (checked and printed before it starts) plus the
# same again on this disk. Size and time: unknown until run; both are printed
# at the end and recorded in manifest.txt.
#
# ASCII only, saved UTF-8 with BOM (see scripts\smoke.ps1 for why).

param(
    [string] $Container = 'flyleaf-pg',
    [string] $Database = 'flyleaf',
    [string] $OutDir = '',
    [switch] $IncludeRawPayloads,
    [string] $Compression = 'zstd:6'
)

$ErrorActionPreference = 'Stop'
$KitDir = Split-Path -Parent $PSScriptRoot
$RepoDir = Split-Path -Parent $KitDir
if ($OutDir -eq '') { $OutDir = Join-Path $RepoDir 'catalog-export' }

function Invoke-Docker {
    param([string[]] $Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw ('docker ' + ($Arguments -join ' ') + ' failed with exit code ' + $LASTEXITCODE)
    }
}

# Copies a text file with LF line endings and no BOM: bash in the container
# reads a CRLF script as commands ending in a carriage return.
function Copy-Unix {
    param([string] $From, [string] $To)
    $text = [IO.File]::ReadAllText($From) -replace "`r`n", "`n"
    [IO.File]::WriteAllText($To, $text, (New-Object Text.UTF8Encoding $false))
}

$started = Get-Date

$running = & docker inspect -f '{{.State.Running}}' $Container
if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
    throw ("Container '" + $Container + "' is not running. Start it: docker compose up -d postgres")
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('flyleaf-catalog-kit-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    Copy-Unix (Join-Path $KitDir 'catalog\dump-catalog.sh') (Join-Path $tmp 'dump-catalog.sh')
    Copy-Unix (Join-Path $KitDir 'config\catalog-tables.txt') (Join-Path $tmp 'catalog-tables.txt')

    Invoke-Docker @('exec', $Container, 'rm', '-rf', '/tmp/flyleaf-catalog', '/tmp/flyleaf-catalog-kit')
    Invoke-Docker @('exec', $Container, 'mkdir', '-p', '/tmp/flyleaf-catalog-kit')
    Invoke-Docker @('cp', (Join-Path $tmp 'dump-catalog.sh'), ($Container + ':/tmp/flyleaf-catalog-kit/dump-catalog.sh'))
    Invoke-Docker @('cp', (Join-Path $tmp 'catalog-tables.txt'), ($Container + ':/tmp/flyleaf-catalog-kit/catalog-tables.txt'))
}
finally {
    Remove-Item -Recurse -Force $tmp
}

$dumpArgs = @('exec', $Container, 'bash', '/tmp/flyleaf-catalog-kit/dump-catalog.sh',
    '--out', '/tmp/flyleaf-catalog',
    '--list', '/tmp/flyleaf-catalog-kit/catalog-tables.txt',
    '--db', $Database,
    '--compress', $Compression)
if ($IncludeRawPayloads) { $dumpArgs += '--include-optional' }

Write-Host ('Dumping the catalog of ' + $Database + ' inside ' + $Container + ' ...') -ForegroundColor Cyan
Invoke-Docker $dumpArgs

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $OutDir ('flyleaf-catalog-' + $stamp)
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Write-Host ('Copying out to ' + $dest + ' ...') -ForegroundColor Cyan
Invoke-Docker @('cp', ($Container + ':/tmp/flyleaf-catalog/.'), $dest)
Invoke-Docker @('exec', $Container, 'rm', '-rf', '/tmp/flyleaf-catalog', '/tmp/flyleaf-catalog-kit')

# The copy is checked against the hash taken inside the container.
$manifest = Get-Content (Join-Path $dest 'manifest.txt')
$want = ($manifest | Where-Object { $_ -like 'sha256 catalog.dump *' }) -replace '^sha256 catalog\.dump ', ''
$have = (Get-FileHash -Algorithm SHA256 (Join-Path $dest 'catalog.dump')).Hash.ToLower()
if ($want -ne $have) {
    throw ('catalog.dump was damaged on the way out of the container: ' + $have + ' vs ' + $want)
}

$bytes = (Get-Item (Join-Path $dest 'catalog.dump')).Length
$elapsed = [int]((Get-Date) - $started).TotalSeconds
Write-Host ''
Write-Host 'Catalog exported.' -ForegroundColor Green
Write-Host ('  folder:   ' + $dest)
Write-Host ('  size:     ' + [Math]::Round($bytes / 1MB, 1) + ' MB (' + $bytes + ' bytes)')
Write-Host ('  time:     ' + $elapsed + ' s')
Write-Host ('  sha256:   ' + $have + ' (matches the manifest)')
$manifest | Where-Object { $_ -like 'count *' -or $_ -like 'probe *' -or $_ -like 'tables_schema_only *' } |
    ForEach-Object { Write-Host ('  ' + $_) }
Write-Host ''
Write-Host 'Next (docs/deploy.md step 6):' -ForegroundColor Cyan
Write-Host ('  scp -r "' + $dest + '" <admin>@<host>:/srv/flyleaf/import/')
Write-Host ('  ssh <admin>@<host> sudo /opt/flyleaf/deploy/catalog/restore-catalog.sh /srv/flyleaf/import/flyleaf-catalog-' + $stamp)
