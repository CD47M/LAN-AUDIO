package com.carl.lanaudio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import kotlin.math.max

/**
 * Plays PCM received from the PC.
 * Uses the media stream so the phone's media volume controls it (the
 * navigation stream is often much quieter). ALLOW_CAPTURE_BY_NONE keeps our
 * own output out of AudioPlaybackCapture, avoiding an internal-audio loop.
 */
class AudioPlayer(private var volume: Float, private var boost: Boolean = false) {
    companion object {
        private const val TAG = "LanAudio"
    }

    private var track: AudioTrack? = null
    private var rate = 0
    private var channels = 0

    @Synchronized
    fun write(samples: ShortArray, sampleRate: Int, channelCount: Int) {
        if (volume <= 0.001f) return
        if (track == null || sampleRate != rate || channelCount != channels) {
            create(sampleRate, channelCount)
        }
        val t = track ?: return
        val data = if (boost) amplify(samples, 2f) else samples
        try {
            t.write(data, 0, data.size)
        } catch (e: Exception) {
            Log.w(TAG, "AudioTrack.write failed", e)
        }
    }

    private fun amplify(samples: ShortArray, gain: Float): ShortArray {
        val out = ShortArray(samples.size)
        for (i in samples.indices) {
            val v = samples[i] * gain
            out[i] = when {
                v >= 32767f -> 32767
                v <= -32768f -> -32768
                else -> v.toInt().toShort()
            }
        }
        return out
    }

    private fun create(sampleRate: Int, channelCount: Int) {
        release()
        rate = sampleRate
        channels = channelCount

        val mask = if (channelCount == 1) {
            AudioFormat.CHANNEL_OUT_MONO
        } else {
            AudioFormat.CHANNEL_OUT_STEREO
        }

        val minBuf = AudioTrack.getMinBufferSize(
            sampleRate,
            mask,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val target = (sampleRate * channelCount * 2 * 0.09f).toInt()
        val bufferSize = max(minBuf, target)

        try {
            val t = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(mask)
                        .build()
                )
                .setBufferSizeInBytes(bufferSize)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

            t.setVolume(volume)
            t.play()
            track = t
        } catch (e: Exception) {
            Log.e(TAG, "AudioTrack create failed", e)
            track = null
        }
    }

    @Synchronized
    fun setVolume(v: Float) {
        volume = v.coerceIn(0f, 1f)
        try {
            track?.setVolume(volume)
        } catch (_: Exception) {
        }
    }

    @Synchronized
    fun setBoost(enabled: Boolean) {
        boost = enabled
    }

    @Synchronized
    fun release() {
        val t = track
        track = null
        if (t != null) {
            try {
                t.pause()
            } catch (_: Exception) {
            }
            try {
                t.flush()
            } catch (_: Exception) {
            }
            try {
                t.stop()
            } catch (_: Exception) {
            }
            try {
                t.release()
            } catch (_: Exception) {
            }
        }
        rate = 0
        channels = 0
    }
}
