$ErrorActionPreference = 'Stop'
$exe = 'F:\opencode\audio exchange\release\exe\LANAudio.exe'
$ico = 'F:\opencode\audio exchange\tools\sea\appicon.ico'

Add-Type -Namespace Win32 -Name Res2 -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr BeginUpdateResourceW(string p, bool del);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool UpdateResourceW(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, int size);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool EndUpdateResourceW(IntPtr h, bool discard);
'@

$bytes = [System.IO.File]::ReadAllBytes($ico)

# Resource ids of the icons already in node.exe: find the group icon set.
# We simply stamp id 1 for both RT_ICON and RT_GROUP_ICON using integer ids.
$h = [Win32.Res2]::BeginUpdateResourceW($exe, $false)
if ($h -eq [IntPtr]::Zero) { throw "BeginUpdateResource failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

# RT_GROUP_ICON = 14, RT_ICON = 3 as integer MAKEINTRESOURCE.
$ok1 = [Win32.Res2]::UpdateResourceW($h, [IntPtr]14, [IntPtr]1, 0, $bytes, $bytes.Length)
$ok2 = [Win32.Res2]::UpdateResourceW($h, [IntPtr]3, [IntPtr]1, 0, $bytes, $bytes.Length)
$ok3 = [Win32.Res2]::EndUpdateResourceW($h, $false)
"group=$ok1 icon=$ok2 end=$ok3"
if (-not $ok3) { throw "EndUpdateResource failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
