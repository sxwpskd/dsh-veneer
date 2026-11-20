<#
dsh-veneer-inspect.ps1 - READ-ONLY descriptor reader used by the dsh-veneer plugin.

It never changes anything. It only calls Get-ChildItem, Get-Acl and icacls
(without any write parameter) and prints one JSON object on stdout.

Input (one argument): the JSON below, base64-encoded (UTF-8):

  { "mode": "inspect" | "expand", "root": "<abs path>", "limit": <n> }

Base64 on purpose: PowerShell 5.1 strips quotes from a -File argument, so a
raw JSON string arrives mangled. The script also accepts raw JSON.

  inspect  -> { objects: [ <root signature> ], ... }
  expand   -> { objects: [ <root signature>, <descendants...> ], skipped, errors, truncated }

A signature is:

  { path, isDir, cap, denyDC, denyDCInherit, label, error }

  cap           an Allow ACE for an S-1-4-* SID whose mask contains write
  denyDC        (directories only) a Deny ACE for S-1-1-0 with delete-child
  denyDCInherit that deny ACE is inherited from a parent
  label         "low" | "medium" | null
  error         "reparse-point" | "acl-unreadable" | null

Arrays are emitted without PowerShell's single-element unwrapping, so the
plugin always receives JSON arrays.

Windows PowerShell 5.1. Source is pure ASCII on purpose.
#>
# -Command takes the whole script as text; `& { }` scopes the functions so they
# have no named parameters to confuse the command line, then calls main with a
# **positional** argument (a named -InputJson would be ambiguous against the
# nested function parameter named $Input...; 2026-11-20 hit).
& {
    $ErrorActionPreference = 'Stop'

function Get-SidValue {
    param($Ace)
    try { return $Ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }
    catch { return [string]$Ace.IdentityReference }
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

function Get-CapSidOf {
    param([System.Security.AccessControl.FileSystemSecurity]$Acl)
    foreach ($ace in $Acl.Access) {
        if ($ace.AccessControlType -ne 'Allow') { continue }
        $sid = Get-SidValue -Ace $ace
        if (-not $sid.StartsWith('S-1-4-')) { continue }
        $rights = [int]$ace.FileSystemRights
        if ((($rights -band 0x2) -ne 0) -or (($rights -band 0x10000) -ne 0)) { return $sid }
    }
    return ''
}

function Test-HasCap {
    param($Acl, [string]$CapSid)
    if ($CapSid -eq '') { return $false }
    foreach ($ace in $Acl.Access) {
        if ($ace.AccessControlType -ne 'Allow') { continue }
        if ((Get-SidValue -Ace $ace) -ne $CapSid) { continue }
        $rights = [int]$ace.FileSystemRights
        if ((($rights -band 0x2) -ne 0) -or (($rights -band 0x10000) -ne 0)) { return $true }
    }
    return $false
}

function Test-HasDenyDc {
    param($Acl, [ref]$Inherited)
    foreach ($ace in $Acl.Access) {
        if ($ace.AccessControlType -ne 'Deny') { continue }
        if ((Get-SidValue -Ace $ace) -ne 'S-1-1-0') { continue }
        $rights = [int]$ace.FileSystemRights
        if ((($rights -band 0x40) -ne 0) -or (($rights -band 0x10000) -ne 0)) {
            if ($ace.IsInherited) { $Inherited.Value = $true }
            return $true
        }
    }
    return $false
}

# One object's signature. `LabelCache` is a hashtable keyed by "isDir|level":
# the integrity label comes from icacls, which dominates the cost on big trees.
function Get-Signature {
    param([System.IO.FileSystemInfo]$Item, [string]$CapSid, [bool]$IsReparse, $LabelCache)
    $sig = @{
        path = $Item.FullName
        isDir = [bool]$Item.PSIsContainer
        cap = $false
        denyDC = $false
        denyDCInherit = $false
        label = $null
        error = $null
    }
    if ($IsReparse) { $sig.error = 'reparse-point'; return $sig }
    try { $acl = Get-Acl -LiteralPath $Item.FullName }
    catch { $sig.error = 'acl-unreadable'; return $sig }

    $sig.cap = Test-HasCap -Acl $acl -CapSid $CapSid
    if ($sig.isDir) {
        $inh = $false
        $sig.denyDC = Test-HasDenyDc -Acl $acl -Inherited ([ref]$inh)
        $sig.denyDCInherit = $inh
    }
    $probe = $Item.FullName
    if (-not $sig.isDir) { $probe = Split-Path -Path $Item.FullName -Parent }
    $key = ([string]$sig.isDir) + '|' + $probe.ToLowerInvariant()
    if ($LabelCache.ContainsKey($key)) {
        $sig.label = $LabelCache[$key]
    }
    else {
        $sig.label = Get-LabelLevel -Path $Item.FullName
        $LabelCache[$key] = $sig.label
    }
    return $sig
}

function Emit-Json {
    param($Objects, $Skipped, $Errors, [bool]$Truncated)
    $list = New-Object System.Collections.ArrayList
    foreach ($item in @($Objects)) { [void]$list.Add($item) }
    $payload = @{
        objects = $list.ToArray()
        skipped = @($Skipped)
        errors = @($Errors)
        truncated = $Truncated
    }
    ConvertTo-Json -InputObject $payload -Depth 6 -Compress
}

function Invoke-Main {
    param($InputJson)
    try {
        $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($InputJson))
    }
    catch {
        $decoded = $InputJson
    }
    $payload = $decoded | ConvertFrom-Json
    $mode = [string]$payload.mode
    $root = [string]$payload.root
    $limit = [int]$payload.limit

    $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue
    if ($null -eq $rootItem) {
        Emit-Json @() @() @(@{ path = $root; reason = 'not-found' }) $false
        return
    }

    $labelCache = @{}
    $rootSig = Get-Signature -Item $rootItem -CapSid '' -IsReparse $false -LabelCache $labelCache
    $rootAcl = $null
    try { $rootAcl = Get-Acl -LiteralPath $rootItem.FullName } catch { $rootAcl = $null }
    $capSid = ''
    if ($rootAcl -ne $null) { $capSid = Get-CapSidOf -Acl $rootAcl }

    if ($mode -eq 'inspect') {
        $only = Get-Signature -Item $rootItem -CapSid $capSid -IsReparse $false -LabelCache $labelCache
        Emit-Json @($only) @() @() $false
        return
    }

    $objects = New-Object System.Collections.ArrayList
    $skipped = New-Object System.Collections.ArrayList
    $errors = New-Object System.Collections.ArrayList
    [void]$objects.Add($rootSig)

    $stack = New-Object System.Collections.Stack
    foreach ($child in (Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue)) { $stack.Push($child) }
    $truncated = $false
    while ($stack.Count -gt 0) {
        $item = $stack.Pop()
        if ($limit -gt 0 -and $objects.Count -ge $limit) { $truncated = $true; break }
        $isReparse = ((($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) -ne 0)
        if ($isReparse) {
            [void]$skipped.Add(@{ path = $item.FullName; reason = 'reparse-point' })
            continue
        }
        [void]$objects.Add((Get-Signature -Item $item -CapSid $capSid -IsReparse $false -LabelCache $labelCache))
        if ($item.PSIsContainer) {
            try {
                foreach ($kid in (Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) { $stack.Push($kid) }
            }
            catch {
                [void]$errors.Add(@{ path = $item.FullName; reason = 'list-failed' })
            }
        }
    }

    Emit-Json $objects.ToArray() $skipped.ToArray() $errors.ToArray() $truncated
}

# The only argument is the base64 payload (see the header for why).
# IMPORTANT: `& { ... }` above is a script block; a top-level `$args` does not
# reach it, so take the value from the environment (base64 only, so it always
# survives), and fall back to a positional argument when the file is dot-sourced.
$__VeneerPayload = ''
if ($env:DSH_VENEER_INPUT) { $__VeneerPayload = [string]$env:DSH_VENEER_INPUT }
if ($__VeneerPayload -eq '' -and $args.Count -ge 1) { $__VeneerPayload = [string]$args[0] }
Invoke-Main $__VeneerPayload

}
