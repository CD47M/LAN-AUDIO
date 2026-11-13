package com.carl.lanaudio

import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.NetworkInterface

object Discovery {
    data class Found(val host: String, val port: Int, val room: String)

    private const val DISCOVERY_PORT = 8082
    private const val PROBE = "LANAUDIO_DISCOVER"

    fun discover(timeoutMs: Int = 1800): Found? {
        var socket: DatagramSocket? = null
        return try {
            socket = DatagramSocket().apply {
                broadcast = true
                soTimeout = 250
            }

            val payload = PROBE.toByteArray(Charsets.UTF_8)
            val targets = LinkedHashSet<InetAddress>()
            targets.add(InetAddress.getByName("255.255.255.255"))

            try {
                for (nic in NetworkInterface.getNetworkInterfaces()) {
                    if (!nic.isUp || nic.isLoopback) continue
                    for (addr in nic.interfaceAddresses) {
                        addr.broadcast?.let { targets.add(it) }
                    }
                }
            } catch (_: Exception) {
                // broadcast to 255.255.255.255 still works on most LANs
            }

            for (target in targets) {
                try {
                    socket.send(DatagramPacket(payload, payload.size, target, DISCOVERY_PORT))
                } catch (_: Exception) {
                    // ignore individual interface failures
                }
            }

            val deadline = System.currentTimeMillis() + timeoutMs
            val buf = ByteArray(2048)
            while (System.currentTimeMillis() < deadline) {
                val packet = DatagramPacket(buf, buf.size)
                try {
                    socket.receive(packet)
                } catch (_: Exception) {
                    continue
                }
                val text = String(packet.data, packet.offset, packet.length, Charsets.UTF_8)
                try {
                    val obj = JSONObject(text)
                    if (obj.optString("service") != "lanaudio") continue
                    val host = packet.address?.hostAddress ?: continue
                    return Found(
                        host = host,
                        port = obj.optInt("port", 8080),
                        room = obj.optString("room", "8888"),
                    )
                } catch (_: Exception) {
                    // not our reply
                }
            }
            null
        } catch (_: Exception) {
            null
        } finally {
            try {
                socket?.close()
            } catch (_: Exception) {
            }
        }
    }
}
