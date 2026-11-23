<#
dsh-veneer-ask.ps1 - native confirmation for the session check.

The host calls this through `core/ask-native.js` after a session's first human
message revealed missing sandbox materialization items. The browser has no hook
at that moment, so the host asks with a Windows Forms MessageBox.

ONE question only (2026-11-23, by the user's instruction): "fix now?"
  Yes        -> 6  (the host starts the UAC-elevated apply run)
  No / close -> 7  (ask later)

"Stop checking this workspace later" is NOT part of this dialog: closing a box
returns No, so a config write here could be triggered by an accidental close.
That choice lives in the plugin config page instead: a checkbox labelled
"cancel future checks for this workspace". Closing the box therefore only ever
means "later" - it never changes configuration.

Earlier history (for context): 0.4.1 replaced a Yes/No/Cancel box with two
Yes/No boxes; 0.4.6 folded that back into this single box because stopping the
checks moved to the panel.

Any other exit code means failure (1 = the dialog could not be shown).

Input is passed through the environment, never as command-line JSON:
  DSH_VENEER_ASK_TEXT      dialog body (host-built; falls back to ASCII below)
  DSH_VENEER_ASK_ROOT      workspace root (fallback body + diagnostics)
  DSH_VENEER_ASK_MISSING   missing object count (fallback body)

Pure ASCII source on purpose: a .ps1 without a BOM is decoded as ANSI, so
non-ASCII bytes break parsing. The body text arrives as an environment variable
and may contain any characters.

Windows PowerShell 5.1. Runs with -NoProfile -NonInteractive.
#>
$ErrorActionPreference = 'Stop'

try {
    $title = 'dsh-veneer'
    $root = [string]$env:DSH_VENEER_ASK_ROOT
    $missing = [string]$env:DSH_VENEER_ASK_MISSING
    $body = [string]$env:DSH_VENEER_ASK_TEXT

    if ($body -eq '') {
        # ASCII fallback when the host only passed the structured facts.
        $body = 'dsh-veneer found objects missing the sandbox materialization items.' + "`r`n`r`n" `
            + 'Workspace: ' + $root + "`r`n" `
            + 'Missing objects: ' + $missing + "`r`n`r`n" `
            + 'Fix them now?' + "`r`n" `
            + 'Yes = fix now (UAC will ask).' + "`r`n" `
            + 'No / close = ask later (to stop checking this workspace, use the plugin config page).'
    }

    Add-Type -AssemblyName System.Windows.Forms

    $answer = [System.Windows.Forms.MessageBox]::Show(
        $body,
        $title,
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2
    )
    if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { exit 6 }
    exit 7
}
catch {
    # A broken dialog must be reported, never guessed (the host treats !=6/7 as failure).
    [Console]::Out.WriteLine('error: ask dialog failed: ' + $_.Exception.Message)
    exit 1
}
