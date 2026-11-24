# Pocketspace for Android and iOS

## Implementation plan

1. Package the shared Pocketspace interface and sample files inside each app. Keep the existing presets, size and percentage targets, same-extension tuning, previews, lossless ZIP compression, and transfer archives.
2. Use each system’s Files and Photos pickers, save interface, and share sheet. Copy imports to private cache and pass opaque file identifiers to the shared interface. Release queued files and outputs when users remove them. Keep separate temporary copies available to share targets.
3. Encode videos on the device with Media3 Transformer on Android and AVFoundation on iOS. Produce MP4 copies, preserve audio and display orientation where supported, and show the measured output size when a target is missed.
4. Keep media and large ZIP outputs on disk. Stream ZIP inputs and outputs in bounded chunks and include the matching-file index in transfer archives.
5. Verify Android on the Pixel 9 emulator and iOS on an iPhone simulator or device. Check imports, tuning, preview, save and share, ZIP extraction, cancellation, and error recovery.

Mobile saves a copy through the system document interface. Android and iOS file providers vary in their support for atomic in-place replacement. Device codecs determine which videos and photos can be decoded. The system save picker can place a ZIP in a local or cloud-backed folder.

## Android

Open `mobile/android` in Android Studio with Android SDK 36 installed. The app supports Android 11 and later and uses the installed Android System WebView. Run the `app` configuration on a device or emulator. The Gradle 9.3.1 wrapper packages the current files from `dist`.

On Windows, use `mobile/android/build.ps1` to build in a temporary directory and retain one debug APK. Point `JAVA_HOME` at Android Studio’s bundled JDK and pass `-AndroidSdk` if the SDK location is unset. The default output is `mobile/android/Pocketspace-Android.apk`.

To use **Fit to Send**, add photos or videos with the system picker, then open **Fit to Send** under **Your files**. Set the total ZIP limit in MB (1 MB is 1,000,000 bytes) and check **Keep original** beside any file you want stored byte-for-byte. Tap **Prepare ZIP**, then **Share ZIP** to send the measured archive through Android’s share sheet. If fitting fails, increase the limit or keep fewer originals.

You can also share photos from an Android app and choose **Pocketspace** in the system share sheet. Fit to Send opens with the photos from that share.

After preparing a ZIP, choose a file under **In the ZIP** to preview the exact version that will be shared. Use **Keep original and refit** to preserve that file and recalculate the ZIP.

If the batch cannot fit in one ZIP, choose **Split into ZIPs**. Each numbered ZIP has its own size check. Select and share each part separately.

Enable **Remove location metadata from photos** to create fresh photo copies without the originals’ embedded metadata. Pocketspace flags detected location metadata on photos marked **Keep original**, which retain all their original bytes.

## iOS

Open `mobile/ios/Pocketspace.xcodeproj` in Xcode on a Mac. Select the Pocketspace scheme and an iPhone or iPad simulator, then run. The project targets iOS 16 and later. For a physical device, select your signing team in Signing & Capabilities. The Xcode build copies the current files from `dist` into the app bundle.

## Verification

Run the shared bridge tests with Node.js 22 or later:

```sh
node --test mobile/tests/*.test.mjs
```

For each app, import a JPEG and MP4 while offline. Compare Original and Compressed, play both video previews to completion, and seek before switching between them. Tune one file by percentage and target size. Import two files with the same extension and apply a tuning change to both. Save a copy, cancel and retry a save, share files, and extract a transfer ZIP to check the media and `pocketspace-manifest.json`. Remove a video during compression and confirm the queue can process another file.

### Local verification results

- Follow-up Pixel 9 regression pass used Android Files’ actual two-image share sheet. Fit to Send opened with both PNGs, and the 564,397-byte ZIP matched both originals under a 600,000-byte cap. A failed preview refit hid the previous ZIP and recovered after increasing the limit. An impossible split exposed no partial ZIPs, then recovered into 215,741- and 348,678-byte parts under a 400,000-byte cap.
- Canceling an active native video fit produced no shareable ZIP. Retrying produced a playable 202,401-byte MP4 in a 255,476-byte mixed ZIP, below the 550,738-byte cap. An unsupported GIF blocked metadata removal and could be included unchanged after selecting Keep original.
- A low-quality JPEG exposed a privacy sizing bug when its freshly encoded copy was larger than the source. The fixed build reduced the 86,197-byte privacy copy to 49,685 bytes and shared it in a 50,025-byte ZIP under a 50,456-byte cap. The cleaned entry matched its preview.

- On the Pixel 9 emulator, two JPEGs with synthetic EXIF GPS and XMP location metadata produced a 10,304-byte ZIP under a 30,000-byte limit. Pocketspace warned about the kept photo, which retained both metadata blocks and matched its input hash. The cleaned photo matched its preview and contained neither metadata block. Android’s chooser opened for the ZIP.

- The Pixel 9 emulator fit a photo and a video in a 253,387-byte ZIP under a 509,594-byte limit. The MP4 shrank from 634,438 to 200,312 bytes. Its ZIP entry matched the playable preview, and the kept photo's hash matched the input.

- The Pixel 9 emulator split two pinned JPEGs into separately shared ZIPs of 327,403 and 606,760 bytes, under a 700,000-byte limit for each. Both originals matched the extracted entries.

- On the Pixel 9 emulator, **Keep original and refit** changed the first photo’s preview from compressed to original. Both preview files matched the SHA-256 hashes of the files in the 642,835-byte shared ZIP, below the 650,000-byte limit.

- A native Android SEND intent with a MediaStore photo URI opened Fit to Send on the Pixel 9 emulator. The resulting ZIP was 1,379,959 bytes against a 1,400,000-byte limit, the kept PNG matched the input byte for byte, and Share ZIP brought Android’s chooser to the foreground.

- Fit to Send on the Pixel 9 emulator produced a shared ZIP of 89,720 bytes under a 90,000-byte limit. The archived 1,856-byte PNG selected as Keep original matched its input SHA-256. The other photo went from 606,616 to 87,600 bytes. Android’s chooser became the focused window after Share ZIP. The two generated photos were loaded through the WebView file input.

- The shared bridge passed all four tests. Android’s debug APK signature verified, and its bundled web assets matched the source files byte for byte.
- The Android APK ran offline on a Pixel 9 emulator with Android 16. The bundled JPEG compressed from 650,113 to 447,503 bytes and the bundled MP4 from 1,935,002 to 1,312,383 bytes. A 163,840-byte file imported through Files compressed to a 673-byte ZIP. The archive exported through Files contained both media files, the nested ZIP, and the manifest. The extracted text matched its source byte for byte. The system share sheet opened.
- Android testing also exercised picker cancellation and retry, Photo Picker video import, removal during video compression, and safe-area layout. A 75% target applied to two matching JPEGs produced two 161 KB copies. The MP4 reached 844 KB against a 900 KB target on retry.
- The updated Android APK played both previews of a Files-imported MP4 through to completion, with 120 presented frames each. The comparison kept the 2.65-second seek position when switching to Compressed. Bounded, open-ended, and suffix byte ranges matched both files byte for byte. The test used the Android 16 16 KB image and WebView 133, with the Qt window hidden, host graphics enabled, and the emulator hardware decoder disabled. The Windows headless emulator process crashed during earlier playback attempts.
- The iOS project references, shared scheme, Info.plist, app icon, and resource path passed static checks. Building and running the iOS app still requires macOS and Xcode.
