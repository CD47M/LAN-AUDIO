$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$iconPath = $env:LANAUDIO_TRAY_ICON
$url = $env:LANAUDIO_TRAY_URL
if (-not $url) { $url = 'http://localhost:8080/' }

[System.Windows.Forms.Application]::EnableVisualStyles()
$notify = New-Object System.Windows.Forms.NotifyIcon

if ($iconPath -and (Test-Path $iconPath)) {
    $notify.Icon = New-Object System.Drawing.Icon($iconPath)
} else {
    $notify.Icon = [System.Drawing.SystemIcons]::Application
}
$notify.Text = 'LAN Audio - 局域网声音互传'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('打开电脑页面')
$openItem.add_Click({ Start-Process $url })

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$statusItem = $menu.Items.Add('状态：运行中')
$statusItem.Enabled = $false

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$quitItem = $menu.Items.Add('退出 LAN Audio')
$quitItem.add_Click({
    $notify.Visible = $false
    $notify.Dispose()
    Get-Process -Name 'LANAudio' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Start-Process $url })
$notify.add_BalloonTipClicked({ Start-Process $url })
$notify.ShowBalloonTip(3000, 'LAN Audio 已启动', '双击托盘图标打开页面，右键可退出。', [System.Windows.Forms.ToolTipIcon]::Info)

$watcher = New-Object System.Windows.Forms.Timer
$watcher.Interval = 3000
$watcher.add_Tick({
    $alive = Get-Process -Name 'LANAudio' -ErrorAction SilentlyContinue
    if (-not $alive) {
        $notify.Visible = $false
        $notify.Dispose()
        [System.Windows.Forms.Application]::Exit()
    }
})
$watcher.Start()

[System.Windows.Forms.Application]::Run()
