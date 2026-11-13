Start-Sleep -Seconds 1
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Desk2 {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string win);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$tray = [Desk2]::FindWindow('Shell_TrayWnd', $null)
$r = New-Object Desk2+RECT
[void][Desk2]::GetWindowRect($tray, [ref]$r)
# Bring the taskbar to the top of the z-order without moving it.
[void][Desk2]::SetWindowPos($tray, [IntPtr](-1), $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top), 0x0001 -bor 0x0002 -bor 0x0010)
Start-Sleep -Milliseconds 600

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(($r.Right - $r.Left), ($r.Bottom - $r.Top))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size(($r.Right - $r.Left), ($r.Bottom - $r.Top))))
$bmp.Save('F:\opencode\audio exchange\tools\sea\taskbar3.png', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output 'saved'
