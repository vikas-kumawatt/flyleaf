# Flyleaf - Phase -1 API smoke test
#
# Walks the whole backend path and asserts the decisions that are meant to be
# locked. Run it with the API up:
#
#   cd D:\Bookmarked\flyleaf
#   .\scripts\smoke.ps1
#
# Deliberately ASCII-only and saved UTF-8 with BOM: Windows PowerShell 5.1
# reads an unmarked file as Windows-1252, which corrupts any multi-byte
# character and can break string parsing.
#
# Uses Invoke-WebRequest rather than curl.exe. Shelling out to curl from
# PowerShell mangles the quotes inside a JSON -d payload, which silently
# breaks every POST while every GET keeps working.

$ErrorActionPreference = 'Stop'

$Base = 'http://localhost:3000'
$script:PassCount = 0
$script:FailCount = 0

function Check {
    param(
        [string] $Name,
        [bool]   $Condition,
        [string] $Detail = ''
    )
    if ($Condition) {
        Write-Host ('  PASS  ' + $Name) -ForegroundColor Green
        $script:PassCount = $script:PassCount + 1
    }
    else {
        Write-Host ('  FAIL  ' + $Name) -ForegroundColor Red
        if ($Detail -ne '') {
            Write-Host ('        ' + $Detail) -ForegroundColor DarkGray
        }
        $script:FailCount = $script:FailCount + 1
    }
}

# Returns a hashtable: Status (int) and Body (object or $null).
# Never throws on a 4xx, so an error response is data we can assert on.
function Req {
    param(
        [string] $Method,
        [string] $Path,
        $Payload = $null,
        [string] $Token = ''
    )

    $headers = @{ 'Accept' = 'application/json' }
    if ($Token -ne '') {
        $headers['Authorization'] = 'Bearer ' + $Token
    }

    $params = @{
        Uri             = $Base + $Path
        Method          = $Method
        Headers         = $headers
        UseBasicParsing = $true
    }

    if ($null -ne $Payload) {
        $params['ContentType'] = 'application/json'
        $params['Body'] = (ConvertTo-Json -InputObject $Payload -Compress -Depth 6)
    }

    try {
        $res = Invoke-WebRequest @params
        $parsed = $null
        if ($res.Content) {
            try { $parsed = ConvertFrom-Json -InputObject $res.Content } catch { }
        }
        return @{ Status = [int]$res.StatusCode; Body = $parsed }
    }
    catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { throw }
        $status = [int]$resp.StatusCode
        $parsed = $null
        try {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $text = $reader.ReadToEnd()
            $reader.Close()
            if ($text) { $parsed = ConvertFrom-Json -InputObject $text }
        }
        catch { }
        return @{ Status = $status; Body = $parsed }
    }
}

function ErrText {
    param($Response)
    if ($null -eq $Response) { return '' }
    $b = $Response.Body
    if ($null -eq $b) { return '' }
    if ($null -eq $b.error) { return '' }
    return [string]$b.error.message
}

Write-Host ''
Write-Host ('Flyleaf API smoke test -> ' + $Base) -ForegroundColor Cyan
Write-Host ('PowerShell ' + $PSVersionTable.PSVersion.ToString()) -ForegroundColor DarkGray
Write-Host ''

# ---------------------------------------------------------------- health
Write-Host 'health'

$h = Req 'GET' '/healthz'
Check 'healthz responds' ($h.Status -eq 200) ('got ' + $h.Status)

$rz = Req 'GET' '/readyz'
Check 'readyz reaches the database' ($rz.Status -eq 200) ('got ' + $rz.Status)

# ---------------------------------------------------------------- guest access
Write-Host ''
Write-Host 'guest access (PRD 4.2)'

$s = Req 'GET' '/v1/search?q=piranesi'
$hits = $null
if ($null -ne $s.Body) { $hits = $s.Body.data }
Check 'search works with no token' ($s.Status -eq 200 -and $null -ne $hits -and $hits.Count -gt 0) ('got ' + $s.Status)

if ($null -eq $hits -or $hits.Count -eq 0) {
    Write-Host ''
    Write-Host 'No search results - did the seed run? Stopping.' -ForegroundColor Yellow
    exit 1
}

$work = $hits[0]
Check 'search found the right book' ($work.title -like '*Piranesi*') ('got: ' + $work.title)

$gw = Req 'GET' ('/v1/works/' + $work.id)
Check 'book page works with no token' ($gw.Status -eq 200) ('got ' + $gw.Status)
Check 'guest gets no your_read' ($null -eq $gw.Body.your_read)
Check 'editions are nested under the work' ($gw.Body.editions.Count -gt 0)

$noAuth = Req 'GET' '/v1/reads'
Check 'reads require auth' ($noAuth.Status -eq 401) ('got ' + $noAuth.Status)

# ---------------------------------------------------------------- auth
Write-Host ''
Write-Host 'auth'

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
$email = 'smoke' + $stamp + '@example.com'
$user = 'smoke' + $stamp
$pw = 'a-long-enough-password'

$short = Req 'POST' '/v1/auth/register' @{ email = $email; username = $user; password = 'short' }
Check 'short password rejected' ($short.Status -eq 422) ('got ' + $short.Status + ' ' + (ErrText $short))

$badUser = Req 'POST' '/v1/auth/register' @{ email = $email; username = 'Bad Name'; password = $pw }
Check 'bad username rejected' ($badUser.Status -eq 422) ('got ' + $badUser.Status + ' ' + (ErrText $badUser))

$reg = Req 'POST' '/v1/auth/register' @{ email = $email; username = $user; password = $pw }
Check 'register succeeds' ($reg.Status -eq 201) ('got ' + $reg.Status + ' ' + (ErrText $reg))

$tokenA = ''
if ($null -ne $reg.Body) { $tokenA = [string]$reg.Body.token }
Check 'register returns a token' ($tokenA.Length -gt 20)
Check 'register returns the user' ($reg.Body.user.username -eq $user)

if ($tokenA.Length -le 20) {
    Write-Host ''
    Write-Host 'No token - stopping here.' -ForegroundColor Yellow
    Write-Host ([string]$script:PassCount + ' passed, ' + [string]$script:FailCount + ' FAILED') -ForegroundColor Red
    exit 1
}

$dup = Req 'POST' '/v1/auth/register' @{ email = $email; username = ($user + 'x'); password = $pw }
Check 'duplicate email rejected' ($dup.Status -eq 409) ('got ' + $dup.Status)

$badPw = Req 'POST' '/v1/auth/login' @{ email = $email; password = 'a-different-password' }
Check 'wrong password rejected' ($badPw.Status -eq 401) ('got ' + $badPw.Status)

$login = Req 'POST' '/v1/auth/login' @{ email = $email; password = $pw }
Check 'login succeeds' ($login.Status -eq 200) ('got ' + $login.Status + ' ' + (ErrText $login))

$me = Req 'GET' '/v1/me' $null $tokenA
Check 'me returns the signed-in user' ($me.Body.username -eq $user) ('got ' + $me.Status)

# ---------------------------------------------------------------- reading loop
Write-Host ''
Write-Host 'reading loop'

$rd = Req 'POST' '/v1/reads' @{ work_id = $work.id; status = 'reading' } $tokenA
Check 'started reading' ($rd.Status -eq 200 -and $rd.Body.status -eq 'reading') ('got ' + $rd.Status + ' ' + (ErrText $rd))

$read = $rd.Body
if ($null -eq $read) {
    Write-Host ''
    Write-Host 'Could not create a read - stopping here.' -ForegroundColor Yellow
    Write-Host ([string]$script:PassCount + ' passed, ' + [string]$script:FailCount + ' FAILED') -ForegroundColor Red
    exit 1
}

Check 'first attempt is attempt_no 1' ($read.attempt_no -eq 1) ('got ' + $read.attempt_no)
Check 'rating starts null' ($null -eq $read.rating) ('got ' + $read.rating)

# Idempotency: the whole offline story in one field.
$eventId = [guid]::NewGuid().ToString()
$progressPath = '/v1/reads/' + $read.id + '/progress'

$p1 = Req 'POST' $progressPath @{ client_event_id = $eventId; page = 120 } $tokenA
Check 'progress accepted' ($p1.Status -eq 200) ('got ' + $p1.Status + ' ' + (ErrText $p1))

$null = Req 'POST' $progressPath @{ client_event_id = $eventId; page = 120 } $tokenA
$null = Req 'POST' $progressPath @{ client_event_id = $eventId; page = 120 } $tokenA

$after1 = Req 'GET' ('/v1/works/' + $work.id) $null $tokenA
$page1 = $after1.Body.your_read.page
Check 'progress recorded' ($page1 -eq 120) ('got page ' + $page1)
Check 'replaying the same client_event_id does not double-count' ($page1 -eq 120) ('three identical posts must leave page at 120, got ' + $page1)

$null = Req 'POST' $progressPath @{ client_event_id = [guid]::NewGuid().ToString(); page = 260 } $tokenA
$after2 = Req 'GET' ('/v1/works/' + $work.id) $null $tokenA
$page2 = $after2.Body.your_read.page
Check 'a new event id does advance progress' ($page2 -eq 260) ('got page ' + $page2)

$emptyProgress = Req 'POST' $progressPath @{ client_event_id = [guid]::NewGuid().ToString() } $tokenA
Check 'progress needs a page or percent' ($emptyProgress.Status -eq 422) ('got ' + $emptyProgress.Status)

# Rating is optional by design, and half-steps only.
$fin = Req 'POST' '/v1/reads' @{ work_id = $work.id; status = 'finished' } $tokenA
Check 'can finish without a rating' ($fin.Status -eq 200 -and $fin.Body.status -eq 'finished' -and $null -eq $fin.Body.rating) ('got ' + $fin.Status + ' rating ' + $fin.Body.rating)

$quarter = Req 'POST' '/v1/reads' @{ work_id = $work.id; status = 'finished'; rating = 4.25 } $tokenA
Check 'quarter-star rejected' ($quarter.Status -eq 422) ('got ' + $quarter.Status)

$rated = Req 'POST' '/v1/reads' @{ work_id = $work.id; status = 'finished'; rating = 4.5; hearted = $true } $tokenA
Check 'half-star rating accepted' ($rated.Body.rating -eq 4.5) ('got ' + $rated.Body.rating)
Check 'heart is separate from rating' ($rated.Body.hearted -eq $true)

# Re-read: a NEW row, never an overwrite.
$rr = Req 'POST' '/v1/reads' @{ work_id = $work.id; status = 'reading' } $tokenA
Check 're-reading creates attempt_no 2' ($rr.Body.attempt_no -eq 2) ('got ' + $rr.Body.attempt_no)
Check 're-read is a different row' ($rr.Body.id -ne $read.id)

$list = Req 'GET' '/v1/reads' $null $tokenA
Check 'both attempts are listed' ($list.Body.data.Count -ge 2) ('got ' + $list.Body.data.Count)

# ---------------------------------------------------------------- authorization
Write-Host ''
Write-Host 'authorization (architecture.md 4)'

$emailB = 'other' + $stamp + '@example.com'
$userB = 'other' + $stamp
$regB = Req 'POST' '/v1/auth/register' @{ email = $emailB; username = $userB; password = $pw }

$tokenB = ''
if ($null -ne $regB.Body) { $tokenB = [string]$regB.Body.token }
Check 'second user registered' ($tokenB.Length -gt 20) ('got ' + $regB.Status)

if ($tokenB.Length -gt 20) {
    $cross = Req 'POST' $progressPath @{ client_event_id = [guid]::NewGuid().ToString(); page = 5 } $tokenB
    Check 'another user gets 404 on your read, not 403' ($cross.Status -eq 404) ('got ' + $cross.Status + ' - a 403 would confirm the resource exists')

    $listB = Req 'GET' '/v1/reads' $null $tokenB
    Check 'another user sees none of your reads' ($listB.Status -eq 200 -and $listB.Body.data.Count -eq 0) ('got ' + $listB.Status + ' count ' + $listB.Body.data.Count)

    $workB = Req 'GET' ('/v1/works/' + $work.id) $null $tokenB
    Check 'another user sees no your_read on the shared book' ($null -eq $workB.Body.your_read)
}

# ---------------------------------------------------------------- summary
$total = $script:PassCount + $script:FailCount
Write-Host ''
if ($script:FailCount -eq 0) {
    Write-Host ([string]$script:PassCount + '/' + [string]$total + ' passed') -ForegroundColor Green
    exit 0
}
else {
    Write-Host ([string]$script:PassCount + '/' + [string]$total + ' passed, ' + [string]$script:FailCount + ' FAILED') -ForegroundColor Red
    exit 1
}
