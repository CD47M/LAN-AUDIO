package com.carl.lanaudio

import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale

object RunState {
    @Volatile
    var running: Boolean = false

    @Volatile
    var sendRunning: Boolean = false

    @Volatile
    var sendPeerRunning: Boolean = false

    @Volatile
    var receiveRunning: Boolean = false

    @Volatile
    var receivePeerRunning: Boolean = false

    @Volatile
    var sourceMode: Int = 0

    @Volatile
    var hasProjection: Boolean = false

    @Volatile
    var status: String = "未运行"

    private val lines = ArrayDeque<String>()
    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.CHINA)

    fun addLog(message: String) {
        synchronized(lines) {
            lines.addLast("[${fmt.format(Date())}] $message")
            while (lines.size > 120) lines.removeFirst()
        }
    }

    fun logText(): String = synchronized(lines) { lines.joinToString("\n") }

    fun clearLog() {
        synchronized(lines) { lines.clear() }
    }
}
