# Pocketspace for Windows

Open **Pocketspace** from the Start menu on the machine where the shortcut was created, or double-click `Windows/Pocketspace.exe`. Keep the entire `Windows` folder together when moving the app. The Start menu shortcut points to the original location.

The app runs on 64-bit Windows with .NET Framework 4.6.2 or newer and the Microsoft Edge WebView2 Runtime. Media processing runs locally. Use **Choose files** or drop files into the window, then use the save buttons to pick an output location.

Choose **Tune** beside a file to pick a preset, enter a percentage reduction, or set a maximum size in KB or MB. **Update preview** encodes the file using those settings. Switch between **Original** and **Compressed** to compare, then save the copy. If the encoder misses a target, Pocketspace reports it and makes the smallest copy it produced available when it is smaller than the original.

In **Tune**, select **Apply to all … files** to reuse settings across files with the same extension, ignoring capitalization. A percentage is calculated from each original. With a fixed size cap, files already within the cap keep their existing settings.

Pocketspace re-encodes photos up to 64 megapixels. Large videos and lossless ZIPs use local scratch storage for encoded output. Files outside the supported photo and video formats use lossless ZIP compression automatically. You can also choose **Lossless ZIP** for media files. Lossless ZIP supports individual files under 4 GB and produces a copy only when the ZIP is smaller.

After compression, **Replace originals** in **Your files** uses the files you already added. Confirm once in Windows to replace every eligible original with its smaller same-format copy. Pocketspace verifies each original and its compressed bytes before replacing it. Format conversions and ZIPs are available through **Save copy**.

To share files from Windows, open **Transfer & archive**, choose originals or compressed copies, then select **Prepare ZIP to share**. Save the ZIP and open it from your sharing app.

## Build

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File desktop/build.ps1` from the project root. Close Pocketspace before rebuilding. The build downloads the pinned WebView2 SDK and copies the current web assets into the Windows package.

## Verification

The packaged app launched on Windows, compressed the bundled JPG by 31% and MP4 by 36% at the Balanced setting, generated a batch ZIP, and opened the native save dialog with the expected ZIP filename. The dialog was dismissed without writing a test file.

The updated web assets were tested in Edge with the bundled samples. The JPG went from 650,113 to 161,451 bytes at a 75% reduction target, and the MP4 reached 170,677 bytes at a 200 KB cap. The test also checked progress visibility, original and compressed previews, ZIP regeneration after tuning, and the warning for an unreachable target.

The rebuilt Windows app prepared valid ZIPs for both original and compressed samples through **Prepare ZIP to share**. The archive dialog closed normally after preparation.

The Windows package compressed padded 46 MB JPEG and 201 MB MP4 fixtures and verified that a 75 MB text file extracted unchanged from its ZIP. Batch tuning applied across `.jpg` and `.JPG`, skipped a file already within a fixed size cap, and left the MP4 output intact. The native replacement routine preserved a source whose bytes changed.

The packaged app showed one confirmation for two local fixtures and preserved both when cancelled. A disposable build with test consent replaced two JPEGs at their original paths, verified their output hashes, and skipped a ZIP-only source.
