# Pocketspace for Windows

Open **Pocketspace** from the Start menu on the machine where the shortcut was created, or double-click `Windows/Pocketspace.exe`. Keep the entire `Windows` folder together when moving the app. The Start menu shortcut points to the original location.

The app runs on 64-bit Windows with .NET Framework 4.6.2 or newer and the Microsoft Edge WebView2 Runtime. Media processing runs locally. Use **Choose files** or drop files into the window, then use the save buttons to pick an output location.

Choose **Tune** beside a file to pick a preset, enter a percentage reduction, or set a maximum size in KB or MB. **Update preview** encodes the file using those settings. Switch between **Original** and **Compressed** to compare, then save the copy. If the encoder misses a target, Pocketspace reports it and makes the smallest copy it produced available when it is smaller than the original.

In **Tune**, select **Apply to all … files** to reuse settings across files with the same extension, ignoring capitalization. A percentage is calculated from each original. With a fixed size cap, files already within the cap keep their existing settings.

Pocketspace re-encodes photos up to 64 megapixels. Large videos and lossless ZIPs use local scratch storage for encoded output. Files outside the supported photo and video formats use lossless ZIP compression automatically. You can also choose **Lossless ZIP** for media files. Lossless ZIP supports individual files under 4 GB and produces a copy only when the ZIP is smaller.

After compression, **Replace originals** in **Your files** uses the files you already added. Confirm once in Windows to replace every eligible original with its smaller same-format copy. Pocketspace verifies each original and its compressed bytes before replacing it. Format conversions and ZIPs are available through **Save copy**.

Open **Fit to Send** under **Your files** to fit photos and videos under one ZIP size limit. Use **Keep original** for files you want preserved byte for byte. After preparation, preview the exact files under **In the ZIP**. **Keep original and refit** updates the archive. If the batch cannot fit, **Split into ZIPs** lets you prepare and save numbered parts separately.

Enable **Remove location metadata from photos** to generate fresh photo copies without their original embedded metadata. Windows checks kept JPEG, PNG, and WebP photos for common location tags and flags originals it cannot check. Kept originals retain their bytes and metadata.

Use **Save ZIP** to pick a location in Windows, then attach the ZIP from your sharing app. To open files directly in Fit to Send, select them in File Explorer and choose **Show more options → Send to → Pocketspace**. The build installs this shortcut for the current Windows user. On another PC, you can drop files onto the packaged executable to open them the same way.

**Transfer & archive** also supports ZIPs of all original or compressed copies without a custom size limit.

## Build

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File desktop/build.ps1` from the project root. Close Pocketspace before rebuilding. The build downloads the pinned WebView2 SDK and copies the current web assets into the Windows package.

## Verification

Fit to Send was verified end to end in the rebuilt Windows executable with WebView2 and the native Save ZIP dialog:

- Two launch-path photos opened Fit to Send and saved to a 564,397-byte ZIP under a 600,000-byte limit. Both entries matched the originals byte for byte. The installed Send to shortcut points to this executable.
- An impossible refit hid the stale ZIP. Raising the cap restored the original preview, which matched both the input and the resaved archive entry.
- An impossible split exposed no partial archives. After raising the limit, both numbered archives saved individually at 215,741 and 348,678 bytes under a 400,000-byte cap.
- The compressed MP4 preview played and matched the archived bytes. The mixed ZIP was 111,641 bytes under a 247,376-byte cap, and its kept photo matched the input.
- A JPEG carrying test EXIF GPS data triggered the warning when kept. The original retained its bytes, and the cleaned preview matched the archived copy without that EXIF block.

The packaged app launched on Windows, compressed the bundled JPG by 31% and MP4 by 36% at the Balanced setting, generated a batch ZIP, and opened the native save dialog with the expected ZIP filename. The dialog was dismissed without writing a test file.

The updated web assets were tested in Edge with the bundled samples. The JPG went from 650,113 to 161,451 bytes at a 75% reduction target, and the MP4 reached 170,677 bytes at a 200 KB cap. The test also checked progress visibility, original and compressed previews, ZIP regeneration after tuning, and the warning for an unreachable target.

The rebuilt Windows app prepared valid ZIPs for both original and compressed samples through **Prepare ZIP to share**. The archive dialog closed normally after preparation.

The Windows package compressed padded 46 MB JPEG and 201 MB MP4 fixtures and verified that a 75 MB text file extracted unchanged from its ZIP. Batch tuning applied across `.jpg` and `.JPG`, skipped a file already within a fixed size cap, and left the MP4 output intact. The native replacement routine preserved a source whose bytes changed.

The packaged app showed one confirmation for two local fixtures and preserved both when cancelled. A disposable build with test consent replaced two JPEGs at their original paths, verified their output hashes, and skipped a ZIP-only source.

After removing the queue cap, a disposable Windows build accepted and compressed 25 JPEGs, included all 25 in a ZIP, and replaced all 25 originals with test consent.

After removing the bundled samples and processing messages, the Windows package still accepted a JPEG through the file input, compressed it, and opened the Tune preview.
