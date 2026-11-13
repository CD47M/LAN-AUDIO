Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Desk {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
# Win+D to show the desktop so the taskbar is visible.
[Desk]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
[Desk]::keybd_event(0x44, 0, 0, [UIntPtr]::Zero)
[Desk]::keybd_event(0x44, 0, 2, [UIntPtr]::Zero)
[Desk]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Seconds 2

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, 64)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, ($b.Height - 64), 0, 0, (New-Object System.Drawing.Size($b.Width, 64)))
$bmp.Save('F:\opencode\audio exchange\tools\sea\taskbar2.png', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output 'saved'
