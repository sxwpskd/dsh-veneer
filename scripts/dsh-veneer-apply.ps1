<#
dsh-veneer-apply.ps1 - backfill the DSH sandbox materialization on an existing tree.

The host materializes its workspace grant once, on the workspace root. Objects
that already existed at that moment never receive the three settings, so the
confined shell cannot write them. This script is the half that the plugin
cannot do from inside the sandbox: it needs WRITE_DAC / WRITE_OWNER, i.e. a
normal, non-restricted PowerShell session.

It is a standalone tool. It NEVER trusts an external report: it reads the root
security descriptor itself and only fixes what the root has and a child lacks.

The three settings, copied from the root:

  - the workspace capability ACE (an Allow ACE for the root capability SID
    whose mask contains write) - required on every descendant;
  - the Everyone deny-delete-child ACE - required on directories only;
  - the Low integrity label - required when the root is Low.

"Already has it" includes ACEs that are INHERITED from a parent. That is the
fix for the duplicate-ACE problem: a backfill that copies the root ACE onto an
object which already inherits it leaves two identical ACEs behind.

Modes:

  plan    (default)   -Root <dir> [-Cap] [-DenyDC] [-Label] [-ListLimit N]
                      read-only scan; prints what would change
  apply               plan parameters plus -Apply
                      backs up, changes, then re-checks every object
  restore             -Root <dir> -Restore -RestoreDir <backupDir>
                      restores the DACLs saved by an apply run

Exit codes:
  0 ok
  2 bad arguments
  3 root not found / no backup
  6 refused (root has no capability ACE, or the root is a reparse point)
  7 backup failed (apply aborts before changing anything)
  8 one or more objects failed and were not fixed
  9 verification found objects still incomplete

Windows PowerShell 5.1. Source stays pure ASCII on purpose: a .ps1 without a
BOM is decoded as ANSI, and non-ASCII bytes break parsing.

Call style (verified 2026-11-20 - follow it exactly):

  powershell -NoProfile -ExecutionPolicy Bypass -File "<this>" -Root "<workspace>" [-Cap] [-DenyDC] [-Label] [-Apply]
  To restore:            ... -Root "<workspace>" -Restore -RestoreDir "<backup dir>"

  . Always pass -Root BY NAME and quoted. A bare `& "<this>"` inside a caller
    script took the next statement's first token as the root ("root not found: exit").
  . The same values may also come from the environment - DSH_VENEER_ROOT,
    DSH_VENEER_FLAGS ("Apply Restore Cap DenyDC Label"), DSH_VENEER_RESTORE,
    DSH_VENEER_LISTLIMIT, DSH_VENEER_LOG (append every line to that file).
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [switch]$Apply,
    [switch]$Restore,
    [string]$RestoreDir = '',
    [switch]$Cap,
    [switch]$DenyDC,
    [switch]$Label,
    [string]$ListLimit = ''
)

$ErrorActionPreference = 'Stop'

# Env first (see the header): PS 5.1 argument binding mangles -Root/-switches from
# a caller script. Trim: a value that came through binding can carry a newline.
if ($env:DSH_VENEER_ROOT -and -not $Root) { $Root = [string]$env:DSH_VENEER_ROOT }
$Root = ([string]$Root).Trim().Trim('"')
if ($env:DSH_VENEER_FLAGS) {
    foreach ($name in ([string]$env:DSH_VENEER_FLAGS).Split(' ')) {
        switch ($name.Trim()) {
            'Apply' { $Apply = $true }
            'Restore' { $Restore = $true }
            'Cap' { $Cap = $true }
            'DenyDC' { $DenyDC = $true }
            'Label' { $Label = $true }
            default { }
        }
    }
}
if ($env:DSH_VENEER_RESTORE -and -not $RestoreDir) { $RestoreDir = ([string]$env:DSH_VENEER_RESTORE).Trim() }
$limitValue = 50000
if ($ListLimit -ne '' -and ([string]$ListLimit).Trim() -match '^\d+$') { $limitValue = [int]$ListLimit }
if ($env:DSH_VENEER_LISTLIMIT -and ([string]$env:DSH_VENEER_LISTLIMIT).Trim() -match '^\d+$') {
    $limitValue = [int](([string]$env:DSH_VENEER_LISTLIMIT).Trim())
}
$ListLimit = $limitValue

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
# Report paths RELATIVE to the root: this script's output may be captured into a
# log or a report, and the plugin ships machine-independent code (tools/check.mjs
# rejects printing an absolute path).
function Get-Relative {
    param([string]$Path, [string]$Root)
    $p = ([string]$Path).TrimEnd('\')
    $r = ([string]$Root).TrimEnd('\')
    if ($p.Length -le $r.Length) { return '.' }
    if ($p.StartsWith($r, [System.StringComparison]::OrdinalIgnoreCase)) { return '.' + $p.Substring($r.Length) }
    return $p
}

function Write-Line {
    param([string]$Text)
    # [Console]::Out is the only sink that survives `& script > file` redirection
    # in PS 5.1 (2026-11-20: Write-Output into a file stage produced an empty file).
    [Console]::Out.WriteLine($Text)
    if ($env:DSH_VENEER_LOG) { Add-Content -LiteralPath $env:DSH_VENEER_LOG -Value $Text -Encoding UTF8 }
}

function Write-Err {
    param([string]$Text)
    $line = 'error: ' + $Text
    # 单流：错误也进同一个 sink（否则一个语句的 stdout 一个 stderr，日志会先落一个再落一个）。
    [Console]::Out.WriteLine($line)
    if ($env:DSH_VENEER_LOG) { Add-Content -LiteralPath $env:DSH_VENEER_LOG -Value $line -Encoding UTF8 }
}

function Test-Reparse {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $false }
    return ((($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) -ne 0)
}

function Get-SidValue {
    param($Ace)
    try { return $Ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }
    catch { return [string]$Ace.IdentityReference }
}

# Is this an ACE that grants write to a capability SID? (mask bit 0x2 = write
# data, 0x10000 = generic write; generic bits are checked because some tools
# write them unresolved)
function Test-CapMask {
    param($Ace)
    $rights = [int]$Ace.FileSystemRights
    return ((($rights -band 0x2) -ne 0) -or (($rights -band 0x10000) -ne 0))
}

function Get-CapSid {
    param([string]$Path)
    try { $acl = Get-Acl -LiteralPath $Path } catch { return $null }
    foreach ($ace in $acl.Access) {
        if ($ace.AccessControlType -ne 'Allow') { continue }
        $sid = Get-SidValue -Ace $ace
        if ($sid.StartsWith('S-1-4-') -and (Test-CapMask -Ace $ace)) { return $sid }
    }
    return $null
}

function Get-LabelLevel {
    param([string]$Path)
    $lines = & icacls.exe $Path 2>$null
    foreach ($line in $lines) {
        if ($line -match 'Mandatory Label\\Low Mandatory Level') { return 'low' }
        if ($line -match 'Mandatory Label\\Medium Mandatory Level') { return 'medium' }
    }
    return $null
}

function Set-Label {
    param([string]$Path, [bool]$IsDir, [string]$Level)
    $spec = $Level
    if ($IsDir) { $spec = '(OI)(CI)' + $Level }
    & icacls.exe $Path /setintegritylevel $spec | Out-Null
    return ([bool]($LASTEXITCODE -eq 0))
}

# One object's signature (the shape the plugin report documents).
function Get-Signature {
    param([System.IO.FileSystemInfo]$Item, [string]$CapSid, [bool]$WantCap)
    $sig = @{ path = $Item.FullName; isDir = [bool]$Item.PSIsContainer; cap = $false; denyDC = $false; label = $null; error = $null }
    try { $acl = Get-Acl -LiteralPath $Item.FullName }
    catch {
        $sig.error = 'acl-unreadable'
        return $sig
    }
    $capFound = $false
    if ($CapSid -ne $null) {
        foreach ($ace in $acl.Access) {
            if ($ace.AccessControlType -ne 'Allow') { continue }
            if ((Get-SidValue -Ace $ace) -ne $CapSid) { continue }
            if (Test-CapMask -Ace $ace) { $capFound = $true; break }
        }
    }
    if (-not $WantCap -or $CapSid -eq $null) { $capFound = $true }
    $sig.cap = $capFound
    if ($sig.isDir) {
        foreach ($ace in $acl.Access) {
            if ($ace.AccessControlType -ne 'Deny') { continue }
            if ((Get-SidValue -Ace $ace) -ne 'S-1-1-0') { continue }
            $rights = [int]$ace.FileSystemRights
            if ((($rights -band 0x40) -ne 0) -or (($rights -band 0x10000) -ne 0)) { $sig.denyDC = $true; break }
        }
    }
    $sig.label = Get-LabelLevel -Path $Item.FullName
    return $sig
}

# What this object still lacks. The plugin applies the same rule.
function Get-Missing {
    param($Sig, [string]$RootLabel, [bool]$WantCap, [string]$CapSid, [bool]$WantDeny, [bool]$WantLabel)
    $missing = @()
    if ($WantCap -and $CapSid -ne $null -and (-not $Sig.cap)) { $missing += 'cap' }
    if ($WantDeny -and $Sig.isDir -and (-not $Sig.denyDC)) { $missing += 'denyDC' }
    if ($WantLabel -and $RootLabel -eq 'low' -and $Sig.label -ne 'low') { $missing += 'label' }
    return , $missing
}

# Iterative walk (recursion inside PS 5.1 hits the pipeline hard on big trees).
function Get-Targets {
    param([string]$Root, [string]$CapSid, [bool]$WantCap, [int]$Limit)
    $result = @{ objects = (New-Object System.Collections.ArrayList); skipped = (New-Object System.Collections.ArrayList); errors = (New-Object System.Collections.ArrayList); truncated = $false }
    $stack = New-Object System.Collections.Stack
    foreach ($child in (Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue)) { $stack.Push($child) }
    while ($stack.Count -gt 0) {
        $item = $stack.Pop()
        if ($result.objects.Count -ge $Limit) { $result.truncated = $true; break }
        if ((($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) -ne 0) {
            [void]$result.skipped.Add(@{ path = $item.FullName; reason = 'reparse-point' })
            continue
        }
        [void]$result.objects.Add((Get-Signature -Item $item -CapSid $CapSid -WantCap $WantCap))
        if ($item.PSIsContainer) {
            try { foreach ($kid in (Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) { $stack.Push($kid) } }
            catch { [void]$result.errors.Add(@{ path = $item.FullName; reason = 'list-failed' }) }
        }
    }
    return $result
}

function Add-CapAce {
    param([string]$Path, [string]$CapSid, [bool]$IsDir)
    $acl = Get-Acl -LiteralPath $Path
    $sid = New-Object System.Security.Principal.SecurityIdentifier($CapSid)
    $rights = [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    if ($IsDir) {
        $rights = $rights -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Add-DenyDc {
    param([string]$Path)
    $acl = Get-Acl -LiteralPath $Path
    $world = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($world, [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles, [System.Security.AccessControl.InheritanceFlags]::ContainerInherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Deny)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# Direct set first. Only when that is denied (an object whose owner lacks
# WRITE_OWNER) add a temporary TakeOwnership ACE, set the label, then put the
# DACL back exactly as it was.
function Set-LabelRobust {
    param([string]$Path, [bool]$IsDir, [string]$Level)
    if (Set-Label -Path $Path -IsDir $IsDir -Level $Level) { return $true }
    $me = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($me, [System.Security.AccessControl.FileSystemRights]::TakeOwnership, [System.Security.AccessControl.InheritanceFlags]::None, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $before = Get-Acl -LiteralPath $Path
    $temp = Get-Acl -LiteralPath $Path
    $temp.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $temp
    $ok = Set-Label -Path $Path -IsDir $IsDir -Level $Level
    Set-Acl -LiteralPath $Path -AclObject $before
    return $ok
}

function Save-Backups {
    param([string]$Root, [string]$CapSid)
    $dir = Join-Path (Join-Path $Root '.dsh-veneer-backup') (Get-Date -Format 'yyyyMMdd-HHmmss')
    try { New-Item -ItemType Directory -Path $dir -Force | Out-Null } catch { return $null }
    $entries = New-Object System.Collections.ArrayList
    $index = 0
    foreach ($child in (Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue)) {
        if ((($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) -ne 0) { continue }
        # our own backup directory is not part of the tree
        if ($child.Name -eq '.dsh-veneer-backup') { continue }
        $index = $index + 1
        $file = Join-Path $dir ('acl-' + $index + '.txt')
        & icacls.exe $child.FullName /save $file /T /C /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { return $null }
        [void]$entries.Add(@{ path = $child.FullName; file = $file })
    }
    $manifest = @{ version = 1; root = $Root; capabilitySid = $CapSid; created = (Get-Date -Format 'o'); entries = $entries.ToArray() }
    try { ConvertTo-Json -InputObject $manifest -Depth 6 | Set-Content -LiteralPath (Join-Path $dir 'manifest.json') -Encoding UTF8 }
    catch { return $null }
    return @{ dir = $dir }
}

function Invoke-RestoreOnce {
    param([string]$Dir)
    $manifestPath = Join-Path $Dir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { Write-Err 'no manifest in the backup directory (the path is not printed on purpose)'; return 3 }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $failed = 0
    foreach ($entry in $manifest.entries) {
        & icacls.exe $entry.path /restore $entry.file /C | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Err 'restore FAILED (the path is not printed on purpose)'; $failed = $failed + 1 }
        else { Write-Line 'restored one top-level entry' }
    }
    if ($failed -gt 0) { return 8 }
    Write-Line 'restore complete'
    return 0
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
$rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction SilentlyContinue
if ($null -eq $rootItem) { Write-Err 'root not found (the path is not printed on purpose)'; exit 3 }
$root = $rootItem.FullName.TrimEnd('\')
if (Test-Reparse -Path $root) { Write-Err 'refused (the workspace root is a reparse point)'; exit 6 }
if ($Restore) {
    if ($RestoreDir -eq '') { Write-Err '-Restore needs -RestoreDir'; exit 2 }
    exit (Invoke-RestoreOnce -Dir $RestoreDir)
}

$wantAny = [bool]$Cap -or [bool]$DenyDC -or [bool]$Label
$wantCap = [bool]$Cap -or (-not $wantAny)
$wantDeny = [bool]$DenyDC -or (-not $wantAny)
$wantLabel = [bool]$Label -or (-not $wantAny)

$capSid = Get-CapSid -Path $root
$rootLabel = Get-LabelLevel -Path $root
if ($wantCap -and $capSid -eq $null) {
    Write-Err 'refused: the root has no workspace capability ACE (the host never materialized it)'
    exit 6
}

Write-Line 'root        (the workspace root; not printed on purpose)'
$capText = '(none)'
if ($capSid -ne $null) { $capText = $capSid }
Write-Line ('capability  ' + $capText)
$labelText = '(none)'
if ($rootLabel -ne $null) { $labelText = $rootLabel }
Write-Line ('root label  ' + $labelText)
if ($Apply) { Write-Line 'mode        APPLY' } else { Write-Line 'mode        plan (dry run)' }

$scan = Get-Targets -Root $root -CapSid $capSid -WantCap $wantCap -Limit $ListLimit
if ($scan.truncated) { Write-Line ('note        listing stopped at ' + $ListLimit + ' objects') }
foreach ($s in $scan.skipped) { Write-Line ('SKIP  ' + $s.reason + '  ' + (Get-Relative -Path $s.path -Root $root)) }
foreach ($e in $scan.errors) { Write-Line ('FAIL  list  ' + (Get-Relative -Path $e.path -Root $root)) }

$plan = New-Object System.Collections.ArrayList
$failures = New-Object System.Collections.ArrayList
foreach ($sig in $scan.objects) {
    if ($sig.error -ne $null) { [void]$failures.Add(@{ path = $sig.path; reason = $sig.error }); continue }
    $missing = Get-Missing -Sig $sig -RootLabel $rootLabel -WantCap $wantCap -CapSid $capSid -WantDeny $wantDeny -WantLabel $wantLabel
    if ($missing.Count -eq 0) { continue }
    [void]$plan.Add(@{ sig = $sig; missing = $missing })
}

$complete = $scan.objects.Count - $plan.Count - $failures.Count
Write-Line ('checked     ' + $scan.objects.Count + ' objects, ' + $complete + ' already complete, ' + $plan.Count + ' need a fix, ' + $scan.skipped.Count + ' skipped, ' + $failures.Count + ' unreadable')
foreach ($p in $plan) {
    $kind = 'FILE'
    if ($p.sig.isDir) { $kind = 'DIR ' }
    Write-Line ('  ' + $kind + ' ' + (Get-Relative -Path $p.sig.path -Root $root) + '  needs: ' + ($p.missing -join ', '))
}

if ($plan.Count -eq 0) {
    if ($failures.Count -gt 0) { exit 8 }
    Write-Line 'nothing to fix'
    exit 0
}
if (-not $Apply) {
    # `$args` is PowerShell's automatic variable: never assign to it.
    $flagArgs = @()
    if ($wantCap) { $flagArgs += '-Cap' }
    if ($wantDeny) { $flagArgs += '-DenyDC' }
    if ($wantLabel) { $flagArgs += '-Label' }
    Write-Line ''
    Write-Line 'dry run finished; nothing was changed.'
    Write-Line ('to apply:  powershell -NoProfile -ExecutionPolicy Bypass -File "<this script>" -Root "<the workspace>" ' + ($flagArgs -join ' ') + ' -Apply')
    exit 0
}

$backup = Save-Backups -Root $root -CapSid $capSid
if ($backup -eq $null) { Write-Err 'backup failed; nothing was changed'; exit 7 }
Write-Line ''
Write-Line ('backup      ' + (Get-Relative -Path $backup.dir -Root $root))
Write-Line ('restore     powershell -NoProfile -ExecutionPolicy Bypass -File "<this script>" -Root "<the workspace>" -Restore -RestoreDir "<the backup directory printed above>"')

$fixed = 0
foreach ($p in $plan) {
    $sig = $p.sig
    try {
        if ($p.missing -contains 'cap') { Add-CapAce -Path $sig.path -CapSid $capSid -IsDir $sig.isDir }
        if ($p.missing -contains 'denyDC') { Add-DenyDc -Path $sig.path }
        if ($p.missing -contains 'label') {
            if (-not (Set-LabelRobust -Path $sig.path -IsDir $sig.isDir -Level 'Low')) { throw 'label change denied' }
        }
        $fixed = $fixed + 1
        Write-Line ('FIXED ' + (Get-Relative -Path $sig.path -Root $root) + '  (' + ($p.missing -join ', ') + ')')
    }
    catch {
        [void]$failures.Add(@{ path = $sig.path; reason = $_.Exception.Message })
        Write-Line ('FAIL  ' + (Get-Relative -Path $sig.path -Root $root) + ': ' + $_.Exception.Message)
    }
}

$after = Get-Targets -Root $root -CapSid $capSid -WantCap $wantCap -Limit $ListLimit
$stillIncomplete = 0
foreach ($sig in $after.objects) {
    if ($sig.error -ne $null) { continue }
    $missing = Get-Missing -Sig $sig -RootLabel $rootLabel -WantCap $wantCap -CapSid $capSid -WantDeny $wantDeny -WantLabel $wantLabel
    if ($missing.Count -gt 0) {
        $stillIncomplete = $stillIncomplete + 1
        [void]$failures.Add(@{ path = $sig.path; reason = 'still missing: ' + ($missing -join ', ') })
    }
}

Write-Line ''
Write-Line ('fixed ' + $fixed + ', failed ' + $failures.Count + ', still incomplete ' + $stillIncomplete)
foreach ($f in $failures) { Write-Line ('FAIL  ' + (Get-Relative -Path $f.path -Root $root) + ': ' + $f.reason) }
if ($stillIncomplete -gt 0) { exit 9 }
if ($failures.Count -gt 0) { exit 8 }
exit 0
