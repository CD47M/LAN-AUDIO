using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// LAN Audio launcher: no console window, starts the backend exe in the
// background and shows a notification-area icon. Only one instance is allowed:
// a second double-click just focuses the existing page instead of starting a
// second backend (which would move to another port and split the room).
internal static class Program
{
    private const string AppTitle = "LAN Audio";
    private const int BasePort = 8080;
    private const int PortTries = 30;
    private static NotifyIcon _tray;
    private static Process _server;
    private static string _url = "http://localhost:8080/";
    private static string _api = "http://127.0.0.1:8080/";
    private static System.Windows.Forms.Timer _watch;
    private static System.Windows.Forms.Timer _hotkeyWatch;
    private static string _baseDir;
    private static Mutex _mutex;
    private static int _port = BasePort;
    private static string _lastHotkeyJson = "";
    private static HotkeyWindow _hotkeyWindow;
    private static readonly Dictionary<int, string[]> HotkeyActions = new Dictionary<int, string[]>();
    private static int _nextHotkeyId = 1;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const uint MOD_ALT = 0x0001;
    private const uint MOD_CONTROL = 0x0002;
    private const uint MOD_SHIFT = 0x0004;
    private const uint MOD_WIN = 0x0008;

    private sealed class HotkeyWindow : NativeWindow
    {
        public event Action<int> Hotkey;

        public HotkeyWindow()
        {
            CreateHandle(new CreateParams());
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0312) // WM_HOTKEY
            {
                try
                {
                    Action<int> handler = Hotkey;
                    if (handler != null) handler(m.WParam.ToInt32());
                }
                catch { /* never crash the tray loop */ }
                return;
            }
            base.WndProc(ref m);
        }
    }

    [STAThread]
    private static void Main()
    {
        bool createdNew;
        // Global\ works across sessions. Wait a moment for a competing launch
        // (Windows can fire two starts for one double-click).
        _mutex = new Mutex(true, @"Global\LANAudio.Launcher.v3", out createdNew);
        if (!createdNew)
        {
            // Another instance owns the app. Wait for its backend, then just
            // open the page and exit. Never spawn a second backend.
            int port = WaitForRunningPort(25000);
            if (port > 0)
            {
                OpenPage(port);
            }
            else
            {
                MessageBox.Show("LAN Audio 已在运行，但服务暂未就绪。\n请等待几秒后双击托盘图标打开页面。",
                    AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            return;
        }

        _baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string exe = Path.Combine(_baseDir, "lan-audio-backend-2026.exe");
        if (!File.Exists(exe))
        {
            MessageBox.Show("找不到 lan-audio-backend-2026.exe，请把启动器放在同一文件夹。", AppTitle,
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (s, e) => LogStartup("UI exception: " + e.Exception);

        // Reuse an already-serving backend (e.g. started from another folder).
        int running = FindRunningPort();
        if (running > 0)
        {
            _port = running;
            ShowTray(attachOnly: true, port: running);
            OpenPage(running);
            Application.Run();
            return;
        }

        if (!StartBackend(exe))
        {
            // Backend could not start: clean up so the next double-click retries.
            ReleaseMutex();
            return;
        }

        int ready = WaitForServer(25000);
        if (ready <= 0)
        {
            LogStartup("backend did not answer in time");
            MessageBox.Show("服务启动超时。请检查防火墙是否允许 lan-audio-backend-2026.exe 访问网络，\n" +
                "或稍后再次双击启动。", AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            KillBackend();
            ReleaseMutex();
            return;
        }

        _port = ready;
        ShowTray(attachOnly: false, port: ready);
        OpenPage(ready);
        Application.Run();
    }

    /** Start the backend, retrying once; returns true only if a process runs. */
    private static bool StartBackend(string exe)
    {
        for (int attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                var psi = new ProcessStartInfo(exe)
                {
                    WorkingDirectory = _baseDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                var proc = Process.Start(psi);
                if (proc == null) throw new InvalidOperationException("Process.Start returned null");

                // Give it a moment; a SEA exe that fails immediately exits fast.
                if (proc.WaitForExit(1500))
                {
                    LogStartup("backend exited immediately, code " + proc.ExitCode + " (attempt " + (attempt + 1) + ")");
                    continue;
                }
                _server = proc;
                LogStartup("backend started pid " + proc.Id);
                return true;
            }
            catch (Exception ex)
            {
                LogStartup("backend start failed: " + ex.Message + " (attempt " + (attempt + 1) + ")");
                Thread.Sleep(400);
            }
        }
        return false;
    }

    private static void KillBackend()
    {
        try
        {
            if (_server != null && !_server.HasExited)
            {
                _server.Kill();
                _server.WaitForExit(3000);
            }
        }
        catch { /* ignore */ }
        _server = null;
    }

    private static void ReleaseMutex()
    {
        try { if (_mutex != null) _mutex.ReleaseMutex(); } catch { /* ignore */ }
    }

    private static int FindRunningPort()
    {
        for (int port = BasePort; port < BasePort + PortTries; port++)
        {
            if (IsRunning(port)) return port;
        }
        return 0;
    }

    /** Poll until the first instance has its backend listening. */
    private static int WaitForRunningPort(int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        int delay = 100;
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            int port = FindRunningPort();
            if (port > 0) return port;
            Thread.Sleep(delay);
            if (delay < 500) delay += 50;
        }
        return 0;
    }

    private static bool IsRunning(int port)
    {
        try
        {
            // Probe the socket first: a closed port fails instantly, so only
            // the few ports that are actually listening pay the HTTP cost.
            using (var client = new System.Net.Sockets.TcpClient())
            {
                var ar = client.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(250)) return false;
                client.EndConnect(ar);
            }

            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/info");
            req.Timeout = 1500;
            req.ReadWriteTimeout = 1500;
            req.Proxy = null;
            req.KeepAlive = false;
            req.ServicePoint.Expect100Continue = false;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream()))
            {
                string body = sr.ReadToEnd();
                return resp.StatusCode == HttpStatusCode.OK && body.IndexOf("lanaudio", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch
        {
            return false;
        }
    }

    private static int WaitForServer(int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            // The backend binds BasePort first and only walks upwards when it is
            // taken, so check a short range instead of all 30 ports each pass.
            for (int port = BasePort; port < BasePort + 4; port++)
            {
                if (IsRunning(port)) return port;
            }
            Thread.Sleep(150);
            if (_server != null && _server.HasExited) break;
        }
        return 0;
    }

    private static void OpenPage(int port)
    {
        _url = "http://localhost:" + port + "/";
        try { Process.Start(new ProcessStartInfo(_url) { UseShellExecute = true }); }
        catch { /* best effort */ }
    }

    private static void ShowTray(bool attachOnly, int port)
    {
        _port = port;
        _url = "http://localhost:" + port + "/";
        _api = "http://127.0.0.1:" + port + "/";
        StartHotkeys();
        _tray = new NotifyIcon
        {
            Text = "LAN Audio - 局域网声音互传",
            Visible = true,
        };

        string ico = Path.Combine(_baseDir ?? ".", "lanaudio.ico");
        if (File.Exists(ico))
        {
            try { _tray.Icon = new Icon(ico); } catch { _tray.Icon = SystemIcons.Application; }
        }
        else
        {
            _tray.Icon = SystemIcons.Application;
        }

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开电脑页面", null, (s, e) => OpenPage(port));
        menu.Items.Add("状态：运行中（端口 " + port + "）").Enabled = false;
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出 LAN Audio", null, (s, e) => Quit());

        _tray.ContextMenuStrip = menu;
        _tray.DoubleClick += (s, e) => OpenPage(port);

        _tray.ShowBalloonTip(2500, "LAN Audio 已启动",
            "服务在后台运行。双击托盘图标打开页面，右键可退出。", ToolTipIcon.Info);

        _watch = new System.Windows.Forms.Timer { Interval = 2000 };
        _watch.Tick += (s, e) =>
        {
            // Only treat "backend gone" as fatal when this launcher started it.
            // An attached launcher must not kill itself on a transient miss.
            if (attachOnly) return;
            bool gone = _server != null && _server.HasExited;
            if (!gone) return;

            // The backend may have been restarted by hand; re-check the port
            // before deciding to quit.
            if (FindRunningPort() > 0)
            {
                _server = null;
                return;
            }
            LogStartup("backend exited unexpectedly, quitting launcher");
            Quit();
        };
        _watch.Start();
    }

    private static void LogStartup(string message)
    {
        try
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "LAN Audio");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "launcher.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " [start] " + message + Environment.NewLine);
        }
        catch { /* ignore */ }
    }

    /* ---------- global hotkeys (server-side config, native registration) ---------- */

    private static void StartHotkeys()
    {
        try
        {
            _hotkeyWindow = new HotkeyWindow();
            _hotkeyWindow.Hotkey += OnHotkey;
        }
        catch (Exception ex)
        {
            LogHotkey("hotkey window: " + ex.Message);
            return;
        }

        LogHotkey("hotkey watcher started");
        _hotkeyWatch = new System.Windows.Forms.Timer { Interval = 1500 };
        _hotkeyWatch.Tick += (s, e) => SyncHotkeys();
        _hotkeyWatch.Start();
        SyncHotkeys(); // UI thread: RegisterHotKey/UnregisterHotKey stay paired
    }

    private static void OnHotkey(int id)
    {
        string[] action;
        if (!HotkeyActions.TryGetValue(id, out action)) return;
        string target = action[0];
        string name = action[1];
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try
            {
                var json = new JavaScriptSerializer().Serialize(new Dictionary<string, object>
                {
                    { "target", target },
                    { "action", name },
                });
                HttpPostJson(_api + "api/hotkey", json);
            }
            catch (Exception ex) { LogHotkey(ex.Message); }
        });
    }

    private static void SyncHotkeys()
    {
        try
        {
            string body = HttpGetText(_api + "api/hotkeys");
            if (body == null) { LogHotkey("hotkey GET failed"); return; }

            var serializer = new JavaScriptSerializer();
            var root = serializer.Deserialize<Dictionary<string, object>>(body);
            if (root == null) return;
            Dictionary<string, object> config = null;
            object cfg;
            if (root.TryGetValue("config", out cfg)) config = cfg as Dictionary<string, object>;
            if (config == null) config = root;
            string configJson = serializer.Serialize(config);
            if (configJson == _lastHotkeyJson) return;
            LogHotkey("hotkey config changed (" + body.Length + " bytes)");

            var entries = new List<string[]>(); // combo, target, action
            object groupObj;
            if (config.TryGetValue("targets", out groupObj))
            {
                var targets = groupObj as Dictionary<string, object>;
                if (targets != null)
                {
                    foreach (var kv in targets)
                    {
                        var item = kv.Value as Dictionary<string, object>;
                        if (item == null) continue;
                        string combo = GetString(item, "hotkey");
                        if (!string.IsNullOrWhiteSpace(combo)) entries.Add(new[] { combo, kv.Key, "" });
                    }
                }
            }
            if (config.TryGetValue("actions", out groupObj))
            {
                var actions = groupObj as Dictionary<string, object>;
                if (actions != null)
                {
                    foreach (var kv in actions)
                    {
                        var item = kv.Value as Dictionary<string, object>;
                        if (item == null) continue;
                        string combo = GetString(item, "hotkey");
                        if (!string.IsNullOrWhiteSpace(combo)) entries.Add(new[] { combo, "", kv.Key });
                    }
                }
            }

            UnregisterAllHotkeys();
            var errors = new Dictionary<string, string>();
            var registered = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var entry in entries)
            {
                string combo = entry[0];
                uint mods;
                uint vk;
                if (!TryParseHotkey(combo, out mods, out vk))
                {
                    errors[combo] = "无法识别：" + combo;
                    continue;
                }
                if (!seen.Add(combo))
                {
                    errors[combo] = "快捷键重复：" + combo;
                    continue;
                }
                int id = _nextHotkeyId++;
                if (!RegisterHotKey(_hotkeyWindow.Handle, id, mods, vk))
                {
                    int err = Marshal.GetLastWin32Error();
                    errors[combo] = "注册失败（可能被其他程序占用，错误 " + err + "）：" + combo;
                    continue;
                }
                HotkeyActions[id] = new[] { entry[1], entry[2] };
                registered.Add(combo);
            }

            _lastHotkeyJson = configJson;
            LogHotkey("hotkey entries=" + entries.Count + " registered=" + string.Join(",", registered));
            var status = new Dictionary<string, object>
            {
                { "registered", registered },
                { "errors", errors },
            };
            HttpPostJson(_api + "api/hotkeys/status", serializer.Serialize(status));
        }
        catch (Exception ex)
        {
            LogHotkey(ex.Message);
        }
    }

    private static void UnregisterAllHotkeys()
    {
        if (_hotkeyWindow == null) return;
        foreach (int id in new List<int>(HotkeyActions.Keys))
        {
            try { UnregisterHotKey(_hotkeyWindow.Handle, id); } catch { /* ignore */ }
        }
        HotkeyActions.Clear();
        _nextHotkeyId = 1;
    }

    private static bool TryParseHotkey(string text, out uint mods, out uint vk)
    {
        mods = 0;
        vk = 0;
        if (string.IsNullOrWhiteSpace(text)) return false;
        string[] parts = text.Split('+');
        string key = null;
        foreach (string raw in parts)
        {
            string part = raw.Trim();
            if (part.Length == 0) continue;
            string lower = part.ToLowerInvariant();
            if (lower == "ctrl" || lower == "control") { mods |= MOD_CONTROL; continue; }
            if (lower == "alt") { mods |= MOD_ALT; continue; }
            if (lower == "shift") { mods |= MOD_SHIFT; continue; }
            if (lower == "win" || lower == "windows" || lower == "meta") { mods |= MOD_WIN; continue; }
            key = part;
        }
        if (key == null) return false;
        bool hasModifier = mods != 0;

        if (key.Length == 1)
        {
            char c = char.ToUpperInvariant(key[0]);
            if (c >= 'A' && c <= 'Z') vk = (uint)((int)Keys.A + (c - 'A'));
            else if (c >= '0' && c <= '9') vk = (uint)((int)Keys.D0 + (c - '0'));
            else return false;
        }
        else if (key.Length >= 2 && (key[0] == 'F' || key[0] == 'f'))
        {
            int num;
            if (int.TryParse(key.Substring(1), NumberStyles.Integer, CultureInfo.InvariantCulture, out num)
                && num >= 1 && num <= 24)
            {
                vk = (uint)((int)Keys.F1 + (num - 1));
            }
            else return false;
        }
        else
        {
            switch (key.ToLowerInvariant())
            {
                case "space": vk = (uint)Keys.Space; break;
                case "enter":
                case "return": vk = (uint)Keys.Enter; break;
                case "tab": vk = (uint)Keys.Tab; break;
                case "escape":
                case "esc": vk = (uint)Keys.Escape; break;
                case "backspace": vk = (uint)Keys.Back; break;
                case "insert": vk = (uint)Keys.Insert; break;
                case "delete":
                case "del": vk = (uint)Keys.Delete; break;
                case "home": vk = (uint)Keys.Home; break;
                case "end": vk = (uint)Keys.End; break;
                case "pageup": vk = (uint)Keys.PageUp; break;
                case "pagedown": vk = (uint)Keys.PageDown; break;
                case "up": vk = (uint)Keys.Up; break;
                case "down": vk = (uint)Keys.Down; break;
                case "left": vk = (uint)Keys.Left; break;
                case "right": vk = (uint)Keys.Right; break;
                case "pause": vk = (uint)Keys.Pause; break;
                case "printscreen": vk = (uint)Keys.PrintScreen; break;
                default: return false;
            }
        }

        if (!hasModifier && !(vk >= (uint)Keys.F1 && vk <= (uint)Keys.F24)) return false;
        return vk != 0;
    }

    private static string GetString(Dictionary<string, object> dict, string key)
    {
        object value;
        if (dict != null && dict.TryGetValue(key, out value) && value != null) return Convert.ToString(value);
        return "";
    }

    private static string HttpGetText(string url)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 1200;
            req.ReadWriteTimeout = 1200;
            req.Proxy = null;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                return sr.ReadToEnd();
            }
        }
        catch
        {
            return null;
        }
    }

    private static void HttpPostJson(string url, string json)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.ContentType = "application/json; charset=utf-8";
            req.Timeout = 1200;
            req.ReadWriteTimeout = 1200;
            req.Proxy = null;
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            req.ContentLength = bytes.Length;
            using (var stream = req.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            using (var resp = (HttpWebResponse)req.GetResponse()) { /* drain */ }
        }
        catch (Exception ex)
        {
            LogHotkey("POST " + url + ": " + ex.Message);
        }
    }

    private static void LogHotkey(string message)
    {
        try
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "LAN Audio");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "launcher.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine);
        }
        catch { /* ignore */ }
    }

    private static void Quit()
    {
        if (_hotkeyWatch != null) { _hotkeyWatch.Stop(); _hotkeyWatch.Dispose(); _hotkeyWatch = null; }
        UnregisterAllHotkeys();
        try
        {
            if (_hotkeyWindow != null)
            {
                _hotkeyWindow.DestroyHandle();
                _hotkeyWindow = null;
            }
        }
        catch { /* ignore */ }
        if (_watch != null) { _watch.Stop(); _watch.Dispose(); }
        if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
        try
        {
            if (_server != null && !_server.HasExited)
            {
                _server.Kill();
                _server.WaitForExit(3000);
            }
        }
        catch { /* ignore */ }
        try { if (_mutex != null) _mutex.ReleaseMutex(); } catch { /* ignore */ }
        Application.Exit();
    }
}
