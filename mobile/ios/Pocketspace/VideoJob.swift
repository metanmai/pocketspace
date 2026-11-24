import AudioToolbox
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

enum VideoProfile: String {
    case detail, balanced, small

    var edge: Double {
        switch self {
        case .detail: return 2560
        case .balanced: return 1920
        case .small: return 1280
        }
    }

    var frameRate: Double { self == .detail ? 60 : 30 }

    var bitsPerPixel: Double {
        switch self {
        case .detail: return 0.085
        case .balanced: return 0.067
        case .small: return 0.046
        }
    }

    var fraction: Double {
        switch self {
        case .detail: return 0.86
        case .balanced: return 0.72
        case .small: return 0.54
        }
    }
}

final class VideoJob {
    private let lock = NSLock()
    private var cancelled = false

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    private func checkCancellation() throws {
        lock.lock()
        defer { lock.unlock() }
        if cancelled { throw NativeError.cancelled }
    }

    func compress(_ source: LocalFile, store: FileStore, profile: VideoProfile, target: Int64?,
                  progress: @escaping (Double) -> Void) async throws -> LocalFile {
        try checkCancellation()
        let asset = AVURLAsset(url: source.file)
        let duration = try await asset.load(.duration)
        let seconds = duration.seconds
        guard seconds.isFinite, seconds > 0,
              let video = try await asset.loadTracks(withMediaType: .video).first else {
            throw NativeError("video", "This file has no readable video track.")
        }
        let audio = try await asset.loadTracks(withMediaType: .audio).first
        let audioFormat = try await audio?.load(.formatDescriptions).first
        let audioDescription = audioFormat.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
        let transform = try await video.load(.preferredTransform)
        let dimensions = try await video.load(.naturalSize)
        let bounds = CGRect(origin: .zero, size: dimensions).applying(transform)
        let sourceRate = Double(try await video.load(.nominalFrameRate))
        let fps = min(profile.frameRate, sourceRate.isFinite && sourceRate > 0 ? sourceRate : profile.frameRate)
        let edge = max(bounds.width, bounds.height)
        guard edge.isFinite, edge > 0 else { throw NativeError.invalid }
        let scale = min(1, profile.edge / edge)
        let preset = max(24_000, min(bounds.width * bounds.height * scale * scale * fps * profile.bitsPerPixel,
                                      (Double(source.size) * 8 / seconds - (audio == nil ? 0 : 128_000)) * profile.fraction))
        let budget = target.map { Double($0) * 8 * 0.94 / seconds } ?? Double.infinity
        let audioRate = audio == nil ? 0 : Int(max(24_000, min(128_000, budget * 0.18)))
        var bitRate = Int(max(24_000, min(preset, budget - Double(audioRate))))
        let filename = source.file.deletingPathExtension().lastPathComponent + "-compressed.mp4"
        var best: LocalFile?
        defer { if let best { store.remove(best.token) } }

        for attempt in 0..<(target == nil ? 1 : 3) {
            do {
                try checkCancellation()
                let (token, output) = try store.allocate(filename)
                do {
                    let targetScale = scale * max(0.12, sqrt(Double(bitRate) / preset))
                    let width = max(2, Int(bounds.width * targetScale) / 2 * 2)
                    let height = max(2, Int(bounds.height * targetScale) / 2 * 2)
                    let composition = AVMutableVideoComposition()
                    composition.renderSize = CGSize(width: width, height: height)
                    composition.frameDuration = CMTime(value: CMTimeValue((60_000 / fps).rounded()), timescale: 60_000)
                    let instruction = AVMutableVideoCompositionInstruction()
                    instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
                    let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: video)
                    let placement = transform
                        .concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
                        .concatenating(CGAffineTransform(scaleX: Double(width) / bounds.width,
                                                        y: Double(height) / bounds.height))
                    layer.setTransform(placement, at: .zero)
                    instruction.layerInstructions = [layer]
                    composition.instructions = [instruction]

                    try await encode(asset, video: video, audio: audio, composition: composition,
                                     audioDescription: audioDescription, audioRate: audioRate,
                                     output: output, bitRate: bitRate, seconds: seconds) { value in
                        progress(min(0.99, (Double(attempt) + value) / (target == nil ? 1 : 3)))
                    }
                    try checkCancellation()
                    let result = try store.register(token, url: output, type: "video/mp4")
                    if let previous = best, previous.size <= result.size {
                        store.remove(result.token)
                    } else {
                        if let previous = best { store.remove(previous.token) }
                        best = result
                    }
                    guard let target, result.size > target, bitRate > 24_000 else { break }
                    bitRate = max(24_000, Int(Double(bitRate) * min(0.85, Double(target) / Double(result.size) * 0.9)))
                } catch {
                    store.remove(token)
                    throw error
                }
            } catch {
                try checkCancellation()
                guard best != nil else { throw error }
                break
            }
        }
        try checkCancellation()
        guard let result = best else { throw NativeError("video", "Unable to encode this video.") }
        best = nil
        progress(1)
        return result
    }

    private func encode(_ asset: AVAsset, video: AVAssetTrack, audio: AVAssetTrack?,
                        composition: AVVideoComposition, audioDescription: AudioStreamBasicDescription?,
                        audioRate: Int, output: URL, bitRate: Int, seconds: Double,
                        progress: @escaping (Double) -> Void) async throws {
        let reader = try AVAssetReader(asset: asset)
        let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let videoOutput = AVAssetReaderVideoCompositionOutput(videoTracks: [video], videoSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        ])
        videoOutput.videoComposition = composition
        videoOutput.alwaysCopiesSampleData = false
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(composition.renderSize.width),
            AVVideoHeightKey: Int(composition.renderSize.height),
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: bitRate]
        ])
        var streams = [Stream(output: videoOutput, input: videoInput, isVideo: true)]
        if let audio {
            let audioOutput = AVAssetReaderTrackOutput(track: audio, outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM
            ])
            let sampleRate = audioDescription?.mSampleRate ?? 44_100
            let channels = Int(audioDescription?.mChannelsPerFrame ?? 2)
            let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: sampleRate >= 8_000 && sampleRate <= 48_000 ? sampleRate : 48_000,
                AVNumberOfChannelsKey: max(1, min(2, channels)),
                AVEncoderBitRateKey: audioRate
            ])
            streams.append(Stream(output: audioOutput, input: audioInput, isVideo: false))
        }

        for stream in streams {
            guard reader.canAdd(stream.output), writer.canAdd(stream.input) else {
                throw NativeError("video", "The audio or video format is unsupported.")
            }
            reader.add(stream.output)
            writer.add(stream.input)
        }

        guard writer.startWriting(), reader.startReading() else {
            throw writer.error ?? reader.error ?? NativeError("video", "Unable to start video encoding.")
        }
        writer.startSession(atSourceTime: .zero)
        defer {
            if reader.status == .reading { reader.cancelReading() }
            if writer.status == .writing { writer.cancelWriting() }
        }

        var lastUpdate = -1.0
        while streams.contains(where: { !$0.finished }) {
            try checkCancellation()
            if writer.status == .failed || reader.status == .failed {
                throw writer.error ?? reader.error ?? NativeError("video", "Video encoding failed.")
            }
            var advanced = false
            for stream in streams where !stream.finished && stream.input.isReadyForMoreMediaData {
                advanced = true
                guard let sample = stream.output.copyNextSampleBuffer() else {
                    if reader.status == .failed {
                        throw reader.error ?? NativeError("video", "Unable to read the media track.")
                    }
                    stream.input.markAsFinished()
                    stream.finished = true
                    continue
                }
                guard stream.input.append(sample) else {
                    throw writer.error ?? NativeError("video", "Unable to write the media track.")
                }
                let time = sample.presentationTimeStamp.seconds
                if stream.isVideo, time - lastUpdate >= 0.15 {
                    lastUpdate = time
                    progress(max(0, min(1, time / seconds)))
                }
            }
            if !advanced { try await Task.sleep(nanoseconds: 5_000_000) }
        }
        await writer.finishWriting()
        try checkCancellation()
        guard writer.status == .completed else {
            throw writer.error ?? NativeError("video", "Unable to finish the compressed video.")
        }
    }

    private final class Stream {
        let output: AVAssetReaderOutput
        let input: AVAssetWriterInput
        let isVideo: Bool
        var finished = false

        init(output: AVAssetReaderOutput, input: AVAssetWriterInput, isVideo: Bool) {
            self.output = output
            self.input = input
            self.isVideo = isVideo
        }
    }
}
