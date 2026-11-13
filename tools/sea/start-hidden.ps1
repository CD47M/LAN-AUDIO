$exe = Join-Path $PSScriptRoot 'LANAudio.exe'
if (-not (Test-Path $exe)) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('找不到 LANAudio.exe，请把本文件和 LANAudio.exe 放在同一文件夹。', 'LAN Audio') | Out-Null
    exit 1
}

Start-Process -FilePath $exe -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
