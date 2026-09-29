// HF Runner のランチャー。
// Electron 本体 (HF Runner App.exe、約 235MB) は Smart App Control / SmartScreen の初回解析で
// プロセス生成まで数秒かかることがあるため、数十 KB のこの exe が先に起動画面を出してから本体を起動する。
// 本体のウィンドウ(Electron 側のスプラッシュ)が見えたら自分を閉じる。
// 見た目は src/main/splash.ts のスプラッシュと同じにして、切り替えが目立たないようにしている。
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;

[assembly: AssemblyTitle("HF Runner")]
[assembly: AssemblyProduct("HF Runner")]
[assembly: AssemblyDescription("HF Runner launcher")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

static class Program
{
    // 本体一式はランチャーの隣の app\ に入っている (scripts/nest-app.js)
    public const string AppExe = "HF Runner App.exe";
    public const string AppDir = "app";

    // 表示言語: OS の UI 言語が日本語なら日本語、それ以外は英語
    static readonly bool Japanese = System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ja";

    /** 今の言語の文言を返す (アプリ本体の L('日本語', 'English') と同じ形) */
    public static string L(string ja, string en)
    {
        return Japanese ? ja : en;
    }

    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, AppDir);
        string exe = Path.Combine(dir, AppExe);
        if (!File.Exists(exe))
        {
            MessageBox.Show(L(AppDir + "\\" + AppExe + " が見つかりません。\nHF Runner のフォルダをそのまま展開してください。", AppDir + "\\" + AppExe + " was not found.\nExtract the HF Runner folder as a whole."), "HF Runner", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        Application.Run(new SplashForm(exe, dir, args));
    }
}

class SplashForm : Form
{
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    static readonly Color Bg = ColorTranslator.FromHtml("#0f1216");
    static readonly Color Border = ColorTranslator.FromHtml("#2a313b");
    static readonly Color Fg = ColorTranslator.FromHtml("#e6e9ee");
    static readonly Color Muted = ColorTranslator.FromHtml("#8b95a5");
    static readonly Color Accent = ColorTranslator.FromHtml("#ffb000");
    static readonly Color AccentText = ColorTranslator.FromHtml("#1a1400");

    readonly string exe;
    readonly string dir;
    readonly string[] args;
    readonly float s; // DPI スケール
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly Timer timer = new Timer();
    Process child;
    int polls;

    public SplashForm(string exe, string dir, string[] args)
    {
        this.exe = exe;
        this.dir = dir;
        this.args = args;
        // CreateGraphics() はウィンドウハンドルを作ってしまい StartPosition が効かなくなるので、スクリーン DC から DPI を取る
        using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) s = g.DpiX / 96f;

        Text = "HF Runner";
        FormBorderStyle = FormBorderStyle.None;
        AutoScaleMode = AutoScaleMode.None;
        ClientSize = new Size(Px(380), Px(200));
        // Electron 側スプラッシュと同じく、カーソルのあるディスプレイの中央に出す
        Rectangle screen = Screen.FromPoint(Cursor.Position).Bounds;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(screen.X + (screen.Width - ClientSize.Width) / 2, screen.Y + (screen.Height - ClientSize.Height) / 2);
        BackColor = Bg;
        DoubleBuffered = true;
        ShowInTaskbar = true;
        try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

        timer.Interval = 30;
        timer.Tick += (o, e) => Tick();
        // 本体の起動は、この窓が表示されてから別スレッドで行う。
        // 本体 exe の初回解析で CreateProcess が数秒ブロックされるため、UI スレッドで呼ぶと自分の描画まで止まる
        Shown += (o, e) =>
        {
            timer.Start();
            ThreadPool.QueueUserWorkItem(_ => StartChild());
        };
        FormClosed += (o, e) => timer.Dispose();
    }

    int Px(float v) { return (int)Math.Round(v * s); }

    void StartChild()
    {
        try
        {
            var psi = new ProcessStartInfo(exe, Quote(args)) { WorkingDirectory = dir, UseShellExecute = false };
            Process p = Process.Start(psi);
            BeginInvoke((Action)(() => child = p));
        }
        catch (Exception ex)
        {
            BeginInvoke((Action)(() =>
            {
                MessageBox.Show(Program.L("HF Runner を起動できません。\n", "Could not start HF Runner.\n") + ex.Message, "HF Runner", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }));
        }
    }

    void Tick()
    {
        Invalidate();
        // 60 秒経っても本体が出なければ諦めて閉じる
        if (clock.ElapsedMilliseconds > 60000) { Close(); return; }
        if (child == null) return; // まだ CreateProcess 待ち (初回解析中)
        // 本体の終了 (二重起動時は即終了する) / 本体のウィンドウ表示 のどちらかで閉じる
        if (child.HasExited) { Close(); return; }
        if (++polls % 2 == 0 && HasVisibleWindow(child.Id)) Close();
    }

    static bool HasVisibleWindow(int pid)
    {
        bool found = false;
        EnumWindows((hWnd, l) =>
        {
            uint p;
            GetWindowThreadProcessId(hWnd, out p);
            if (p == pid && IsWindowVisible(hWnd)) { found = true; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static string Quote(string[] args)
    {
        var sb = new StringBuilder();
        foreach (string a in args)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append('"').Append(a.Replace("\"", "\\\"")).Append('"');
        }
        return sb.ToString();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        // 枠線 (Electron 側スプラッシュの 1px 枠と同じ)
        using (var pen = new Pen(Border)) g.DrawRectangle(pen, 0, 0, ClientSize.Width - 1, ClientSize.Height - 1);

        // カード: 幅 260 / ロゴ行 32 + 14 + バー 6 + 14 + メッセージ 17 ≒ 83 を縦中央に
        int cardW = Px(260);
        int left = (ClientSize.Width - cardW) / 2;
        int top = (ClientSize.Height - Px(83)) / 2;

        using (var titleFont = new Font("Segoe UI", 20f * s, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var markFont = new Font("Segoe UI", 15f * s, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var msgFont = new Font("Segoe UI", 12f * s, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var textBrush = new SolidBrush(Fg))
        using (var mutedBrush = new SolidBrush(Muted))
        using (var accentBrush = new SolidBrush(Accent))
        using (var accentTextBrush = new SolidBrush(AccentText))
        using (var barBrush = new SolidBrush(Border))
        {
            // ロゴ (角丸の四角 + ▶) と "HF Runner" を中央寄せ
            SizeF titleSize = g.MeasureString("HF Runner", titleFont);
            int mark = Px(32);
            int gap = Px(10);
            int rowW = mark + gap + (int)titleSize.Width;
            int rowX = (ClientSize.Width - rowW) / 2;
            using (GraphicsPath path = RoundedRect(new Rectangle(rowX, top, mark, mark), Px(8))) g.FillPath(accentBrush, path);
            DrawCentered(g, "▶", markFont, accentTextBrush, new Rectangle(rowX, top, mark, mark));
            g.DrawString("HF Runner", titleFont, textBrush, rowX + mark + gap, top + (mark - titleSize.Height) / 2);

            // 流れるバー (幅 40% のブロックが 1.2 秒で左から右へ)
            int barY = top + mark + Px(14);
            int barH = Px(6);
            var bar = new Rectangle(left, barY, cardW, barH);
            using (GraphicsPath path = RoundedRect(bar, barH / 2)) g.FillPath(barBrush, path);
            float t = (clock.ElapsedMilliseconds % 1200) / 1200f;
            int blockW = (int)(cardW * 0.4f);
            int blockX = left + (int)(-blockW + (cardW + blockW) * t);
            g.SetClip(bar);
            using (GraphicsPath path = RoundedRect(new Rectangle(blockX, barY, blockW, barH), barH / 2)) g.FillPath(accentBrush, path);
            g.ResetClip();

            // メッセージ
            DrawCentered(g, Program.L("起動しています…", "Starting…"), msgFont, mutedBrush, new Rectangle(0, barY + barH + Px(14), ClientSize.Width, Px(17)));
        }
    }

    static void DrawCentered(Graphics g, string text, Font font, Brush brush, Rectangle rect)
    {
        using (var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            g.DrawString(text, font, brush, rect, fmt);
    }

    static GraphicsPath RoundedRect(Rectangle r, int radius)
    {
        int d = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}
