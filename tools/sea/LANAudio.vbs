' Starts LAN Audio with no console window and shows the app icon in the
' notification area. Double-click this file (or a shortcut to it).
Option Explicit

Dim fso, shell, baseDir, exePath
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = fso.BuildPath(baseDir, "LANAudio.exe")

If Not fso.FileExists(exePath) Then
    MsgBox "找不到 LANAudio.exe，请把本文件和 LANAudio.exe 放在同一文件夹。", 16, "LAN Audio"
    WScript.Quit 1
End If

' 0 = hidden window, False = do not wait for it to finish.
shell.CurrentDirectory = baseDir
shell.Run """" & exePath & """", 0, False
