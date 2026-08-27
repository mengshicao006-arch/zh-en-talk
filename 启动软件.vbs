Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\zh-en-talk"
sh.Run "cmd.exe /k D:\zh-en-talk\start-dev.cmd", 1, False
