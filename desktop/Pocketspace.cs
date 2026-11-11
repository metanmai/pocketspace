using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("Pocketspace")]
[assembly: AssemblyProduct("Pocketspace")]
[assembly: AssemblyVersion("1.0.0.0")]

internal sealed class Pocketspace : Form
{
    private const string AppHost = "pocketspace.example";
    private readonly WebView2 webView = new WebView2 { Dock = DockStyle.Fill, AllowExternalDrop = true };
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private Replacement replacement;
    private string replacementBatchId;
    private readonly Dictionary<string, Replacement> approved = new Dictionary<string, Replacement>();

    private sealed class ReplacementMessage
    {
        public string action { get; set; }
        public string id { get; set; }
        public string name { get; set; }
        public string extension { get; set; }
        public string originalHash { get; set; }
        public string outputHash { get; set; }
        public long originalSize { get; set; }
        public long outputSize { get; set; }
        public string data { get; set; }
        public ReplacementMessage[] files { get; set; }
    }

    private sealed class Replacement
    {
        public ReplacementMessage Request;
        public string Source;
        public string Staged;
        public FileStream Output;
        public long Written;
        public bool Working;
        public volatile bool Cancelled;
    }

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Pocketspace());
    }

    private Pocketspace()
    {
        Text = "Pocketspace";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        ClientSize = new Size(1160, 820);
        MinimumSize = new Size(420, 500);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(webView);
        Shown += Initialize;
    }

    private async void Initialize(object sender, EventArgs args)
    {
        try
        {
            string assets = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "dist");
            if (!File.Exists(Path.Combine(assets, "index.html")))
                throw new DirectoryNotFoundException("Keep the dist folder next to Pocketspace.exe.");

            string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                                          "Pocketspace", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            if (IsDisposed) return;
            await webView.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;

            var browser = webView.CoreWebView2;
            browser.Settings.AreDevToolsEnabled = false;
            browser.Settings.AreDefaultContextMenusEnabled = false;
            browser.Settings.IsStatusBarEnabled = false;
            browser.DownloadStarting += SaveDownload;
            browser.WebMessageReceived += HandleReplacementMessage;
            browser.NewWindowRequested += (source, request) => request.Handled = true;
            browser.NavigationStarting += (source, request) =>
            {
                Uri target;
                request.Cancel = !Uri.TryCreate(request.Uri, UriKind.Absolute, out target)
                    || target.Scheme != Uri.UriSchemeHttps || target.Host != AppHost || !target.IsDefaultPort;
            };
            browser.SetVirtualHostNameToFolderMapping(AppHost, assets, CoreWebView2HostResourceAccessKind.Deny);
            // WebView2 can report file sharing as available without completing the share request.
            await browser.AddScriptToExecuteOnDocumentCreatedAsync(
                "Object.defineProperty(window, 'pocketspaceHost', { value: 'windows' });");
            if (IsDisposed) return;
            browser.Navigate("https://" + AppHost + "/index.html");
        }
        catch (Exception error)
        {
            if (IsDisposed) return;
            string message = error is WebView2RuntimeNotFoundException
                ? "Install the Microsoft Edge WebView2 Runtime, then open Pocketspace again."
                : "Pocketspace couldn't start. " + error.Message;
            MessageBox.Show(this, message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private void HandleReplacementMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (args.Source != "https://" + AppHost + "/index.html" && args.Source != "https://" + AppHost + "/") return;
        ReplacementMessage message;
        try { message = json.Deserialize<ReplacementMessage>(args.WebMessageAsJson); }
        catch (ArgumentException) { return; }
        catch (InvalidOperationException) { return; }
        if (message == null || string.IsNullOrEmpty(message.id)) return;
        if (message.action == "replace-batch")
        {
            var paths = new List<string>();
            try
            {
                foreach (var attachment in args.AdditionalObjects)
                {
                    var file = attachment as CoreWebView2File;
                    var info = attachment as FileInfo;
                    paths.Add(file != null ? file.Path : info != null ? info.FullName : null);
                }
            }
            catch (Exception)
            {
                Reply(message.id, "error", "Windows couldn’t identify the files you added.");
                return;
            }
            BeginInvoke((Action)(() => ConfirmBatch(message, paths)));
        }
        else BeginInvoke((Action)(() => ProcessReplacement(message)));
    }

    private void ConfirmBatch(ReplacementMessage message, List<string> paths)
    {
        if (IsDisposed) return;
        if (replacement != null || message.files == null || message.files.Length != paths.Count || paths.Count > 20)
        {
            Reply(message.id, "error", "Windows couldn’t prepare this batch.");
            return;
        }
        approved.Clear();
        replacementBatchId = null;
        var sources = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var names = new List<string>();
        for (int index = 0; index < paths.Count; index++)
        {
            var file = message.files[index];
            string path = paths[index];
            if (file == null || string.IsNullOrEmpty(path) || string.IsNullOrEmpty(file.id)
                || !string.Equals(Path.GetFileName(path), file.name, StringComparison.OrdinalIgnoreCase)
                || file.originalSize <= file.outputSize || file.outputSize <= 0
                || !MatchesExtension(file.name, file.extension)
                || approved.ContainsKey(file.id) || !sources.Add(path)) continue;
            approved.Add(file.id, new Replacement { Request = file, Source = path });
            names.Add(file.name);
        }
        if (approved.Count == 0)
        {
            Reply(message.id, "error", "No eligible original files were found.");
            return;
        }
        string count = approved.Count == 1 ? "1 original file" : approved.Count + " original files";
        string list = string.Join("\n", names.GetRange(0, Math.Min(names.Count, 5)));
        if (names.Count > 5) list += "\n…and " + (names.Count - 5) + " more";
        string prompt = "Replace " + count + " with the compressed copies? This removes the original versions.\n\n" + list;
        if (MessageBox.Show(this, prompt, "Replace originals", MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
        {
            approved.Clear();
            Reply(message.id, "cancelled");
            return;
        }
        replacementBatchId = message.id;
        var ids = new string[approved.Count];
        approved.Keys.CopyTo(ids, 0);
        Reply(message.id, "approved", approvedIds: ids);
    }

    private async void ProcessReplacement(ReplacementMessage message)
    {
        if (IsDisposed) return;
        if (message.action == "replace-batch-end")
        {
            if (replacementBatchId == message.id)
            {
                approved.Clear();
                replacementBatchId = null;
            }
            return;
        }
        if (message.action == "replace-start")
        {
            Replacement next;
            if (replacement != null || !approved.TryGetValue(message.id, out next))
            {
                Reply(message.id, "error", "This file is no longer approved for replacement.");
                return;
            }
            approved.Remove(message.id);
            next.Request.originalHash = message.originalHash;
            next.Request.outputHash = message.outputHash;
            await StartReplacement(next);
            return;
        }

        var operation = replacement;
        if (operation == null || operation.Request.id != message.id) return;
        if (message.action == "replace-cancel")
        {
            operation.Cancelled = true;
            if (!operation.Working) Finish(operation, "cancelled");
            return;
        }
        if (operation.Working || operation.Output == null) return;
        operation.Working = true;
        try
        {
            if (message.action == "replace-chunk")
            {
                byte[] chunk = Convert.FromBase64String(message.data);
                if (chunk.Length == 0 || chunk.Length > 1048576 || chunk.Length > operation.Request.outputSize - operation.Written)
                    throw new IOException("Unexpected compressed file data.");
                await operation.Output.WriteAsync(chunk, 0, chunk.Length);
                operation.Written += chunk.Length;
                if (!operation.Cancelled) Reply(message.id, "chunk");
            }
            else if (message.action == "replace-finish")
            {
                if (operation.Written != operation.Request.outputSize) throw new IOException("The compressed file is incomplete.");
                operation.Output.Flush(true);
                operation.Output.Dispose();
                operation.Output = null;
                await Task.Run(() => CommitReplacement(operation));
                Finish(operation, "done");
            }
        }
        catch (Exception error)
        {
            Finish(operation, "error", "Couldn’t replace the original. " + error.Message);
        }
        finally
        {
            operation.Working = false;
            if (operation.Cancelled && replacement == operation) Finish(operation, "cancelled");
        }
    }

    private async Task StartReplacement(Replacement operation)
    {
        operation.Working = true;
        replacement = operation;
        try
        {
            await Task.Run(() =>
            {
                using (var source = OpenOriginal(operation.Source)) VerifyOriginal(source, operation);
            });
            if (operation.Cancelled || IsDisposed) return;
            string staged = Path.Combine(Path.GetDirectoryName(operation.Source), ".pocketspace-" + Guid.NewGuid().ToString("N") + ".tmp");
            operation.Output = new FileStream(staged, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true);
            operation.Staged = staged;
            Reply(operation.Request.id, "ready");
        }
        catch (Exception error)
        {
            Finish(operation, "error", "Couldn’t prepare the replacement. " + error.Message);
        }
        finally
        {
            operation.Working = false;
            if (operation.Cancelled && replacement == operation) Finish(operation, "cancelled");
        }
    }

    private static bool MatchesExtension(string name, string extension)
    {
        string suffix = Path.GetExtension(name).ToLowerInvariant();
        if (extension == "jpg") return suffix == ".jpg" || suffix == ".jpeg";
        return (extension == "png" || extension == "webp" || extension == "mp4" || extension == "webm") && suffix == "." + extension;
    }

    private static FileStream OpenOriginal(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Select the actual file instead of a link.");
        return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
    }

    private static bool HasFormat(FileStream file, string extension)
    {
        var header = new byte[12];
        int length = file.Read(header, 0, header.Length);
        file.Position = 0;
        if (length < header.Length) return false;
        switch (extension)
        {
            case "jpg": return header[0] == 0xff && header[1] == 0xd8 && header[2] == 0xff;
            case "png": return header[0] == 0x89 && header[1] == 0x50 && header[2] == 0x4e && header[3] == 0x47;
            case "webp": return System.Text.Encoding.ASCII.GetString(header, 0, 4) == "RIFF"
                && System.Text.Encoding.ASCII.GetString(header, 8, 4) == "WEBP";
            case "mp4": return System.Text.Encoding.ASCII.GetString(header, 4, 4) == "ftyp";
            case "webm": return header[0] == 0x1a && header[1] == 0x45 && header[2] == 0xdf && header[3] == 0xa3;
            default: return false;
        }
    }

    private static string ContentId(FileStream file, Replacement operation)
    {
        using (var chunkHash = SHA256.Create())
        using (var digest = SHA256.Create())
        {
            byte[] buffer = new byte[1048576];
            while (file.Position < file.Length)
            {
                if (operation.Cancelled) throw new OperationCanceledException();
                int used = 0;
                while (used < buffer.Length)
                {
                    int read = file.Read(buffer, used, buffer.Length - used);
                    if (read == 0) break;
                    used += read;
                }
                byte[] hash = chunkHash.ComputeHash(buffer, 0, used);
                digest.TransformBlock(hash, 0, hash.Length, null, 0);
            }
            digest.TransformFinalBlock(new byte[0], 0, 0);
            return BitConverter.ToString(digest.Hash).Replace("-", "").ToLowerInvariant();
        }
    }

    private static void VerifyOriginal(FileStream source, Replacement operation)
    {
        var request = operation.Request;
        if (source.Length != request.originalSize || !HasFormat(source, request.extension)
            || ContentId(source, operation) != request.originalHash)
            throw new IOException("The selected file differs from the original or uses a different format.");
    }

    private static void CommitReplacement(Replacement operation)
    {
        var request = operation.Request;
        using (var staged = File.OpenRead(operation.Staged))
        {
            if (staged.Length != request.outputSize || !HasFormat(staged, request.extension)
                || ContentId(staged, operation) != request.outputHash)
                throw new IOException("The saved copy failed verification.");
        }
        using (var source = OpenOriginal(operation.Source))
        {
            VerifyOriginal(source, operation);
            if (operation.Cancelled) throw new OperationCanceledException();
            File.Replace(operation.Staged, operation.Source, null);
        }
    }

    private void Reply(string id, string state, string message = null, string[] approvedIds = null)
    {
        if (!IsDisposed) webView.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { id, state, message, approvedIds }));
    }

    private void Finish(Replacement operation, string state, string message = null)
    {
        if (replacement != operation) return;
        replacement = null;
        try
        {
            if (operation.Output != null) operation.Output.Dispose();
            if (operation.Staged != null) File.Delete(operation.Staged);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        Reply(operation.Request.id, state, message);
    }

    protected override void OnFormClosing(FormClosingEventArgs args)
    {
        if (replacement != null)
        {
            if (replacement.Working)
            {
                replacement.Cancelled = true;
                args.Cancel = true;
            }
            else Finish(replacement, "cancelled");
        }
        base.OnFormClosing(args);
    }

    private void SaveDownload(object sender, CoreWebView2DownloadStartingEventArgs request)
    {
        var deferral = request.GetDeferral();
        request.Handled = true;
        request.Cancel = true;
        // Show the modal dialog after returning from WebView2's event callback.
        BeginInvoke((Action)(() =>
        {
            try
            {
                string filename = Path.GetFileName(request.ResultFilePath);
                using (var dialog = new SaveFileDialog
                {
                    FileName = filename,
                    DefaultExt = Path.GetExtension(filename).TrimStart('.'),
                    RestoreDirectory = true,
                    Title = "Save from Pocketspace"
                })
                {
                    if (dialog.ShowDialog(this) != DialogResult.OK) return;
                    request.ResultFilePath = dialog.FileName;
                    request.Cancel = false;
                }
            }
            finally
            {
                deferral.Complete();
            }
        }));
    }
}
