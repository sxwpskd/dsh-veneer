<#
dsh-veneer-ask.ps1 - native two-step confirmation for the session check.

The host calls this through `core/ask-native.js` after a session's first human
message revealed missing sandbox materialization items. The browser has no hook
at that moment, so the host asks with a Windows Forms MessageBox.

Why TWO dialogs instead of one Yes/No/Cancel box (2026-11-23, ERRATA E-013):
a MessageBox returns `Cancel` both for its Cancel button and for the window's X,
so the user closing the box by habit would be read as "stop checking this
workspace" and silently add the workspace to `exclude`. Two plain Yes/No boxes
make the destructive choice explicit, and closing a box always means "later":

  box 1: fix now?     Yes -> 6  (the host starts the UAC-elevated apply run)
                      No / X -> continue to box 2
  box 2: auto-check this workspace later?  Yes -> 8 (host writes it into exclude)
                                          No / X -> 7 (ask later)

Any other exit code means failure (1 = the dialog could not be shown).

Input is passed through the environment, never as command-line JSON:
  DSH_VENEER_ASK_TEXT      box 1 body (host-built; falls back to ASCII below)
  DSH_VENEER_ASK_TEXT2     box 2 body (host-built; falls back to ASCII below)
  DSH_VENEER_ASK_ROOT      workspace root (fallback bodies + diagnostics)
  DSH_VENEER_ASK_MISSING   missing object count (fallback bodies)

Pure ASCII source on purpose: a .ps1 without a BOM is decoded as ANSI, so
non-ASCII bytes break parsing. The body texts arrive as environment variables
and may contain any characters.

Windows PowerShell 5.1. Runs with -NoProfile -NonInteractive.
#>
$ErrorActionPreference = 'Stop'

try {
    $title = 'dsh-veneer'
    $root = [string]$env:DSH_VENEER_ASK_ROOT
    $missing = [string]$env:DSH_VENEER_ASK_MISSING
    $body = [string]$env:DSH_VENEER_ASK_TEXT
    $body2 = [string]$env:DSH_VENEER_ASK_TEXT2

    if ($body -eq '') {
        # ASCII fallback when the host only passed the structured facts.
        $body = 'dsh-veneer found objects missing the sandbox materialization items.' + "`r`n`r`n" `
            + 'Workspace: ' + $root + "`r`n" `
            + 'Missing objects: ' + $missing + "`r`n`r`n" `
            + 'Fix them now? (Yes = fix now, UAC will ask; No = ask later)'
    }
    if ($body2 -eq '') {
        $body2 = 'Keep automatically checking this workspace later?' + "`r`n`r`n" `
            + 'Workspace: ' + $root + "`r`n" `
            + 'Missing objects: ' + $missing + "`r`n`r`n" `
            + 'Yes = stop checking this workspace (added to exclude).' + "`r`n" `
            + 'No / close = keep checking, handle it later.'
    }

    Add-Type -AssemblyName System.Windows.Forms

    $fix = [System.Windows.Forms.MessageBox]::Show(
        $body,
        $title,
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2
    )
    if ($fix -eq [System.Windows.Forms.DialogResult]::Yes) { exit 6 }

    $keep = [System.Windows.Forms.MessageBox]::Show(
        $body2,
        $title,
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2
    )
    if ($keep -eq [System.Windows.Forms.DialogResult]::Yes) { exit 8 }
    exit 7
}
catch {
    # A broken dialog must be reported, never guessed (the host treats !=6/7/8 as failure).
    [Console]::Out.WriteLine('error: ask dialog failed: ' + $_.Exception.Message)
    exit 1
}
