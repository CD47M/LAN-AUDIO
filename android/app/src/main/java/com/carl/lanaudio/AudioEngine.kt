package com.carl.lanaudio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.NoiseSuppressor
import android.media.projection.MediaProjection
import android.util.Log
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.max

class AudioEngine(
    private val sourceMode: Int,
    private val targetRate: Int,
    private val micTargetRate: Int = targetRate,
    private val targetChannels: Int,
    private val aecEnabled: Boolean,
    private val nsEnabled: Boolean,
    private val projection: MediaProjection?,
    private val onFrame: (ShortArray, Int, Int, Int) -> Unit,
    private val onError: (String) -> Unit,
) {
    companion object {
        const val SOURCE_APP = 0
        const val SOURCE_MIC = 1
        const val SOURCE_BOTH = 2

        // Frame types understood by the PC page / peer phones.
        const val FRAME_APP = 1
        const val FRAME_MIC = 2

        private const val TAG = "LanAudio"
        private const val CAPTURE_RATE = 48000
        private const val FRAME = 960
        private const val CHUNK_FRAMES = 480
        private const val QUEUE_FRAMES = 40

        // Internal app audio is uploaded only while it is audible.  When the
        // capture is digital silence we keep sending for 300 ms, then stop
        // entirely; the next non-silent frame restarts the stream.  This cuts
        // idle upload from ~1.5 Mbps to zero.  Microphone frames are not
        // affected and still stream continuously while the mic is enabled.
        private const val APP_SILENCE_PEAK = 8
        private const val APP_SILENCE_HOLD_FRAMES = 15
    }

    private val running = AtomicBoolean(false)
    private var appRecord: AudioRecord? = null
    private var micRecord: AudioRecord? = null
    private var appQueue: ArrayBlockingQueue<ShortArray>? = null
    private var micQueue: ArrayBlockingQueue<ShortArray>? = null
    private var appThread: Thread? = null
    private var micThread: Thread? = null
    private var emitThread: Thread? = null
    private val effects = mutableListOf<AudioEffect>()
    private val micDsp = MicDsp()
    private val micDecimator = MicDecimator()
    private var appSilentFrames = 0
    @Volatile
    var captureDrops: Int = 0
        private set

    @Volatile
    var micGain: Float = 1f
        set(value) {
            field = value.coerceIn(0f, 5f)
            micDsp.gain = field
        }

    @Volatile
    var nrStrength: Float = 0f
        set(value) {
            field = value.coerceIn(0f, 100f)
            micDsp.strength = field
        }

    

    fun start() {
        if (running.get()) return
        running.set(true)
        try {
            if (sourceMode == SOURCE_APP || sourceMode == SOURCE_BOTH) startAppCapture()
            if (sourceMode == SOURCE_MIC || sourceMode == SOURCE_BOTH) startMicCapture()
            if (appQueue == null && micQueue == null) throw IllegalStateException("没有可用音源")
        } catch (e: Exception) {
            Log.e(TAG, "capture start failed", e)
            onError(e.message ?: "音频采集启动失败")
            stop()
            return
        }

        emitThread = Thread { emitLoop() }.also {
            it.isDaemon = true
            it.name = "frame-emitter"
            it.start()
        }
    }

    private fun startAppCapture() {
        val mp = projection ?: throw IllegalStateException("缺少屏幕/音频授权")
        val config = AudioPlaybackCaptureConfiguration.Builder(mp)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build()

        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(CAPTURE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
            .build()

        val min = AudioRecord.getMinBufferSize(
            CAPTURE_RATE,
            AudioFormat.CHANNEL_IN_STEREO,
            AudioFormat.ENCODING_PCM_16BIT,
        )

        val record = AudioRecord.Builder()
            .setAudioFormat(format)
            .setBufferSizeInBytes(max(min * 2, FRAME * 2 * 4))
            .setAudioPlaybackCaptureConfig(config)
            .build()

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            throw IllegalStateException("内部声音采集初始化失败（可能被系统或应用限制）")
        }

        appRecord = record
        appQueue = ArrayBlockingQueue(QUEUE_FRAMES)
        record.startRecording()
        appThread = Thread { readLoop(record, appQueue!!, 2) }.also {
            it.isDaemon = true
            it.name = "app-audio-reader"
            it.start()
        }
    }

    private fun startMicCapture() {
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(CAPTURE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build()

        val min = AudioRecord.getMinBufferSize(
            CAPTURE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )

        fun build(source: Int): AudioRecord = AudioRecord.Builder()
            .setAudioSource(source)
            .setAudioFormat(format)
            .setBufferSizeInBytes(max(min * 2, FRAME * 2 * 2))
            .build()

        // MIC is the most reliable source for a mic-only stream. Some devices
        // expose VOICE_COMMUNICATION as a muted/telephony-only route.
        var record = try {
            build(MediaRecorder.AudioSource.MIC)
        } catch (e: Exception) {
            Log.w(TAG, "MIC source failed, trying VOICE_COMMUNICATION", e)
            build(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
        }

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            record = build(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
        }

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            throw IllegalStateException("麦克风初始化失败")
        }

        try {
            if (aecEnabled && AcousticEchoCanceler.isAvailable()) {
                AcousticEchoCanceler.create(record.audioSessionId)?.let {
                    it.enabled = true
                    effects.add(it)
                }
            }
            if (nsEnabled && NoiseSuppressor.isAvailable()) {
                NoiseSuppressor.create(record.audioSessionId)?.let {
                    it.enabled = true
                    effects.add(it)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "audio effects unavailable", e)
        }

        micRecord = record
        micQueue = ArrayBlockingQueue(QUEUE_FRAMES)
        record.startRecording()
        micThread = Thread { readLoop(record, micQueue!!, 1) }.also {
            it.isDaemon = true
            it.name = "mic-reader"
            it.start()
        }
    }

    /**
     * Reads the capture device and emits exact 20 ms frames. The capture clock
     * (not a wall-clock timer) drives the stream, so the receiver buffer does
     * not slowly drain because of clock drift.
     */
    private fun readLoop(record: AudioRecord, queue: ArrayBlockingQueue<ShortArray>, channels: Int) {
        val frameSize = FRAME * channels
        val frame = ShortArray(frameSize)
        var filled = 0
        val temp = ShortArray(CHUNK_FRAMES * channels)

        while (running.get()) {
            val n = try {
                record.read(temp, 0, temp.size)
            } catch (e: Exception) {
                Log.w(TAG, "AudioRecord.read failed", e)
                -1
            }
            if (n <= 0) {
                if (n < 0) break
                continue
            }

            var offset = 0
            while (offset < n) {
                val need = frameSize - filled
                val take = minOf(need, n - offset)
                System.arraycopy(temp, offset, frame, filled, take)
                filled += take
                offset += take

                if (filled == frameSize) {
                    val copy = frame.copyOf()
                    if (!queue.offer(copy)) {
                        queue.poll()
                        queue.offer(copy)
                        captureDrops++
                        if (captureDrops == 1 || captureDrops % 100 == 0) {
                            Log.w(TAG, "capture queue drop $captureDrops")
                        }
                    }
                    filled = 0
                }
            }
        }
    }

    private fun emitLoop() {
        while (running.get()) {
            val primary = appQueue ?: micQueue ?: break
            val first = try {
                primary.poll(200, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                break
            } ?: continue

            var appFrame: ShortArray? = null
            var micFrame: ShortArray? = null

            if (appQueue === primary) {
                appFrame = first
                micFrame = try {
                    micQueue?.poll(10, TimeUnit.MILLISECONDS)
                } catch (_: InterruptedException) {
                    null
                }
            } else {
                micFrame = first
                appFrame = try {
                    appQueue?.poll(10, TimeUnit.MILLISECONDS)
                } catch (_: InterruptedException) {
                    null
                }
            }

            // Microphone and app audio travel as separate frames so the PC can
            // apply microphone-only gain / pan / noise reduction.
            appFrame?.let { emitApp(it) }
            micFrame?.let { emitMic(it) }
        }
    }

    private fun emitApp(app: ShortArray) {
        // Measure the raw capture before downmixing so quiet content is still
        // recognised.  Only near-digital silence is suppressed.
        var peak = 0
        for (sample in app) {
            val level = abs(sample.toInt())
            if (level > peak) peak = level
        }
        if (peak <= APP_SILENCE_PEAK) {
            if (appSilentFrames <= APP_SILENCE_HOLD_FRAMES) appSilentFrames++
            if (appSilentFrames > APP_SILENCE_HOLD_FRAMES) return
        } else {
            appSilentFrames = 0
        }

        val ratio = when (targetRate) {
            16000 -> 3
            24000 -> 2
            else -> 1
        }
        val outFrames = FRAME / ratio
        val out = ShortArray(outFrames * targetChannels)

        for (i in 0 until outFrames) {
            var l = 0f
            var r = 0f
            for (k in 0 until ratio) {
                val idx = i * ratio + k
                l += app[idx * 2] / 32768f
                r += app[idx * 2 + 1] / 32768f
            }
            l /= ratio
            r /= ratio

            if (targetChannels == 1) {
                out[i] = clamp((l + r) * 0.5f)
            } else {
                out[i * 2] = clamp(l)
                out[i * 2 + 1] = clamp(r)
            }
        }

        try {
            onFrame(out, targetRate, targetChannels, FRAME_APP)
        } catch (_: Exception) {
            // never let a dropped frame kill the stream
        }
    }

    private fun emitMic(mic: ShortArray) {
        val processed = try {
            micDsp.process(mic)
        } catch (e: Exception) {
            Log.w(TAG, "mic dsp failed, sending raw", e)
            mic
        }

        val ratio = when (micTargetRate) {
            16000 -> 3
            24000 -> 2
            else -> 1
        }

        if (ratio == 1) {
            try {
                onFrame(processed, micTargetRate, 1, FRAME_MIC)
            } catch (_: Exception) {
            }
            return
        }

        // Decimate with a proper low-pass first.  Simple block averaging let
        // high-frequency microphone noise alias back into the audible band,
        // which is heard as a constant hiss on the PC.
        val outFrames = FRAME / ratio
        val out = ShortArray(outFrames)
        val filtered = micDecimator.process(DoubleArray(processed.size) { processed[it].toDouble() })
        for (i in 0 until outFrames) {
            out[i] = clampD(filtered[i * ratio])
        }

        try {
            onFrame(out, micTargetRate, 1, FRAME_MIC)
        } catch (_: Exception) {
            // never let a dropped frame kill the stream
        }
    }

    private fun clampD(v: Double): Short = when {
        v >= 32767.0 -> 32767
        v <= -32768.0 -> -32768
        else -> v.toInt().toShort()
    }

    private fun clamp(v: Float): Short = when {
        v >= 1f -> 32767
        v <= -1f -> -32768
        else -> (v * (if (v < 0f) 32768f else 32767f)).toInt().toShort()
    }

    fun stop() {
        running.set(false)

        try {
            appRecord?.stop()
        } catch (_: Exception) {
        }
        try {
            micRecord?.stop()
        } catch (_: Exception) {
        }

        try {
            emitThread?.interrupt()
        } catch (_: Exception) {
        }
        try {
            appThread?.join(500)
        } catch (_: Exception) {
        }
        try {
            micThread?.join(500)
        } catch (_: Exception) {
        }
        try {
            emitThread?.join(500)
        } catch (_: Exception) {
        }

        try {
            appRecord?.release()
        } catch (_: Exception) {
        }
        try {
            micRecord?.release()
        } catch (_: Exception) {
        }
        appRecord = null
        micRecord = null
        appThread = null
        micThread = null
        emitThread = null
        appQueue = null
        micQueue = null

        for (effect in effects) {
            try {
                effect.release()
            } catch (_: Exception) {
            }
        }
        effects.clear()
    }
}
