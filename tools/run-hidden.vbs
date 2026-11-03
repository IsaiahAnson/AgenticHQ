' Runs node with the given arguments in a hidden window, for Task Scheduler (no console flash).
' wscript.exe tools\run-hidden.vbs tools\hq-sentinel.mjs pc
Set sh = CreateObject("WScript.Shell")
root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName))
args = ""
For Each a In WScript.Arguments
  args = args & " """ & a & """"
Next
sh.CurrentDirectory = root
sh.Run "conhost.exe --headless node" & args, 0, True
