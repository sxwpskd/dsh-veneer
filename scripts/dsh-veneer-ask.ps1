<#
dsh-veneer-ask.ps1 - native confirmation for the session check.

The host calls this through `core/ask-native.js` after a session's first human
message revealed missing sandbox materialization items. The browser has no hook
at that moment, so the host asks with a small Windows Forms dialog.

Layout (2026-11-23, by the user's request): the body text, then the two buttons
(`Yes` / `No`), and BELOW the buttons a checkbox:
  [ ] Stop checking this workspace later (remove it from the managed list)

Exit codes:
   6  Fix now
   7  Ask later (button No / window closed)
   8  Fix now + checkbox checked
   9  Ask later + checkbox checked
  (other codes = failure: the dialog could not be shown)
The host turns 8/9 into "remove this workspace from the managed list" via the
config editor; the dialog itself never writes configuration.

Input is passed through the environment, never as command-line JSON:
  DSH_VENEER_ASK_TEXT      dialog body (host-built; falls back to ASCII below)
  DSH_VENEER_ASK_TITLE     window title (fallback: dsh-veneer)
  DSH_VENEER_ASK_YES       "fix now" button label (fallback: Yes)
  DSH_VENEER_ASK_NO        "later" button label (fallback: No)
  DSH_VENEER_ASK_STOP      checkbox label (fallback: the English text below)
  DSH_VENEER_ASK_ROOT      workspace root (fallback body + diagnostics)
  DSH_VENEER_ASK_MISSING   missing object count (fallback body)

Why env vars: this .ps1 is decoded as ANSI when it has no BOM, so the source must
stay pure ASCII and all user-visible Chinese text arrives from the host.

Windows PowerShell 5.1. Runs with -NoProfile -NonInteractive.
#>
$ErrorActionPreference = 'Stop'

try {
    $title = [string]$env:DSH_VENEER_ASK_TITLE
    if ($title -eq '') { $title = 'dsh-veneer' }
    $yesText = [string]$env:DSH_VENEER_ASK_YES
    if ($yesText -eq '') { $yesText = 'Yes' }
    $noText = [string]$env:DSH_VENEER_ASK_NO
    if ($noText -eq '') { $noText = 'No' }
    $stopText = [string]$env:DSH_VENEER_ASK_STOP
    if ($stopText -eq '') { $stopText = 'Stop checking this workspace later (remove it from the managed list).' }

    $root = [string]$env:DSH_VENEER_ASK_ROOT
    $missing = [string]$env:DSH_VENEER_ASK_MISSING
    $body = [string]$env:DSH_VENEER_ASK_TEXT

    if ($body -eq '') {
        $body = 'dsh-veneer found objects missing the sandbox materialization items.' + "`r`n`r`n" `
            + 'Workspace: ' + $root + "`r`n" `
            + 'Missing objects: ' + $missing + "`r`n`r`n" `
            + 'Fix them now?' + "`r`n" `
            + 'Yes = fix now (UAC will ask).' + "`r`n" `
            + 'No / close = ask later.'
    }

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $form = New-Object System.Windows.Forms.Form
    $form.Text = $title
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.ShowInTaskbar = $false
    $form.AutoScaleMode = 'Dpi'

    $label = New-Object System.Windows.Forms.Label
    $label.AutoSize = $true
    $label.MaximumSize = [System.Drawing.Size]::new(560, 0)
    $label.Location = [System.Drawing.Point]::new(14, 14)
    $label.Text = $body
    $form.Controls.Add($label)

    # Buttons right after the body; the checkbox goes BELOW the buttons.
    $btnTop = $label.Bottom + 14
    $btnHeight = 30
    $btnWidth = 96
    $formWidth = [Math]::Max(360, [Math]::Min(620, $label.Right + 14))

    $noButton = New-Object System.Windows.Forms.Button
    $noButton.Text = $noText
    $noButton.Size = [System.Drawing.Size]::new($btnWidth, $btnHeight)
    $noButton.Location = [System.Drawing.Point]::new(($formWidth - 14 - $btnWidth), $btnTop)
    $noButton.DialogResult = [System.Windows.Forms.DialogResult]::No
    $form.Controls.Add($noButton)

    $yesButton = New-Object System.Windows.Forms.Button
    $yesButton.Text = $yesText
    $yesButton.Size = [System.Drawing.Size]::new($btnWidth, $btnHeight)
    $yesButton.Location = [System.Drawing.Point]::new(($formWidth - 14 - $btnWidth - 8 - $btnWidth), $btnTop)
    $yesButton.DialogResult = [System.Windows.Forms.DialogResult]::Yes
    $form.Controls.Add($yesButton)

    $stopCheck = New-Object System.Windows.Forms.CheckBox
    $stopCheck.Text = $stopText
    $stopCheck.AutoSize = $true
    $stopCheck.MaximumSize = [System.Drawing.Size]::new(($formWidth - 28), 0)
    $stopCheck.Location = [System.Drawing.Point]::new(14, $btnTop + $btnHeight + 12)
    $form.Controls.Add($stopCheck)

    $form.ClientSize = [System.Drawing.Size]::new(
        $formWidth,
        ($stopCheck.Bottom + 14)
    )
    $form.AcceptButton = $yesButton
    $form.CancelButton = $noButton

    $answer = $form.ShowDialog()
    $stopped = ($stopCheck.Checked -eq $true)
    if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
        if ($stopped) { exit 8 } else { exit 6 }
    }
    if ($stopped) { exit 9 } else { exit 7 }
}
catch {
    # A broken dialog must be reported, never guessed (the host treats !=6/7/8/9 as failure).
    [Console]::Out.WriteLine('error: ask dialog failed: ' + $_.Exception.Message)
    exit 1
}
