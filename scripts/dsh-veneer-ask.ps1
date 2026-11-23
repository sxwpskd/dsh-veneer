<#
dsh-veneer-ask.ps1 - native three-button confirmation for the session check.

The host calls this through `core/ask-native.js` after a session's first human
message revealed missing sandbox materialization items. The browser has no hook
at that moment, so the host asks with a Windows Forms MessageBox.

Buttons (exit codes; the host maps them to actions):

  Yes     -> 6   fix now (the host will start the UAC-elevated apply run)
  No      -> 7   ask later (host only logs it)
  Cancel  -> 8   stop checking this workspace (host writes it into exclude)

Any other exit code means failure (1 = the dialog could not be shown).

Input is passed through the environment, never as command-line JSON:
  DSH_VENEER_ASK_TEXT     dialog body (the host builds it, including workspace
                          and missing count; falls back to an ASCII body below)
  DSH_VENEER_ASK_ROOT     workspace root (fallback body + diagnostics)
  DSH_VENEER_ASK_MISSING  missing object count (fallback body)

Pure ASCII source on purpose: a .ps1 without a BOM is decoded as ANSI, so
non-ASCII bytes break parsing. The body text itself arrives as an environment
variable and may contain any characters.

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
        $body = "dsh-veneer found objects missing the sandbox materialization items.`r`n`r`n" `
            + 'Workspace: ' + $root + "`r`n" `
            + 'Missing objects: ' + $missing + "`r`n`r`n" `
            + "Yes = fix now (UAC will ask).`r`n" `
            + "No = ask later.`r`n" `
            + "Cancel = stop checking this workspace."
    }

    Add-Type -AssemblyName System.Windows.Forms
    $answer = [System.Windows.Forms.MessageBox]::Show(
        $body,
        $title,
        [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
        [System.Windows.Forms.MessageBoxIcon]::Warning,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2
    )

    switch ($answer) {
        ([System.Windows.Forms.DialogResult]::Yes) { exit 6 }
        ([System.Windows.Forms.DialogResult]::No) { exit 7 }
        ([System.Windows.Forms.DialogResult]::Cancel) { exit 8 }
        default { exit 1 }
    }
}
catch {
    # A broken dialog must be reported, never guessed (the host treats !=6/7/8 as failure).
    [Console]::Out.WriteLine('error: ask dialog failed: ' + $_.Exception.Message)
    exit 1
}
