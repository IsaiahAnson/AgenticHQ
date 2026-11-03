' Starts Agentic HQ from the repository root with no window (skips if :50000 already listens).
' wscript.exe tools\start-hq.vbs
' conhost --headless keeps Windows Terminal from showing a window; start-hq.cjs spawns server.js detached and hidden.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
sh.Run "conhost.exe --headless node tools\start-hq.cjs", 0, True
