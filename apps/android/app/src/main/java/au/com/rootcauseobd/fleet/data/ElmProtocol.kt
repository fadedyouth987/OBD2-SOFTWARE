package au.com.rootcauseobd.fleet.data

/**
 * Pure Kotlin ELM327 / STN11xx / STN21xx protocol helpers and OBD-II response parsers.
 * Mirrors the command sequence and error set in apps/edge-daemon/src/hal/stn_elm.rs.
 */
object ElmProtocol {
    /** Initialization AT commands sent on connect before protocol selection. */
    val INIT_COMMANDS: List<String> = listOf(
        "ATZ",   // Reset chip
        "ATE0",  // Echo off
        "ATL0",  // Linefeeds off
        "ATS1",  // Print spaces between bytes
        "ATH0",  // Headers off for standard OBD Mode 01/03 parsing
        "ATSP0"  // Auto protocol detection
    )

    val ERROR_TOKENS: List<String> = listOf(
        "NO DATA",
        "CAN ERROR",
        "BUS ERROR",
        "BUS BUSY",
        "UNABLE TO CONNECT",
        "STOPPED",
        "BUFFER FULL",
        "FB ERROR",
        "DATA ERROR",
        "<RX ERROR",
        "LV RESET",
        "ACT ALERT",
        "?"
    )

    data class ElmDeviceInfo(
        val elmVersion: String,
        val stnVersion: String?
    )

    fun isErrorResponse(raw: String): Boolean {
        val upper = raw.uppercase().trim()
        if (upper.isEmpty()) return true
        return ERROR_TOKENS.any { token ->
            if (token == "?") upper == "?" || upper.lines().any { it.trim() == "?" }
            else upper.contains(token)
        }
    }

    /** Parses `ATRV` output such as `"12.6V"` or `"14.2 V"` into volts. */
    fun parseBatteryVoltage(raw: String): Double? {
        val match = Regex("""(\d+(?:\.\d+)?)\s*V""", RegexOption.IGNORE_CASE).find(raw)
        return match?.groupValues?.get(1)?.toDoubleOrNull()
    }

    /** Extracts clean hex byte tokens from an ELM327 response line set, ignoring `SEARCHING...`. */
    fun extractHexBytes(raw: String): List<Int> {
        val bytes = mutableListOf<Int>()
        for (line in raw.lines()) {
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed.startsWith("SEARCHING", ignoreCase = true)) continue
            val clean = trimmed.replace(">", "").trim()
            if (clean.isEmpty()) continue
            // Handle ISO-TP multi-frame index prefix like "0: 43 02 ..."
            val body = if (clean.length > 2 && clean[1] == ':') clean.substring(2).trim() else clean
            val tokens = body.split(Regex("\\s+"))
            if (tokens.isNotEmpty() && tokens.all { it.length == 2 && it.all(Char::isHexDigit) }) {
                tokens.forEach { bytes.add(it.toInt(16)) }
            }
        }
        return bytes
    }

    /**
     * Parses a Mode 01 PID response (e.g. `41 0C 0C 38` for RPM) into a [PidSample].
     * Supported PIDs: 0x05 (ECT), 0x06 (STFT B1), 0x07 (LTFT B1), 0x0C (RPM),
     * 0x0D (Speed), 0x0F (IAT), 0x10 (MAF).
     */
    fun parseMode01Pid(pid: Int, raw: String, timestampUs: Long = System.currentTimeMillis() * 1000L): PidSample? {
        if (isErrorResponse(raw)) return null
        val bytes = extractHexBytes(raw)
        // Find the `41 <pid>` response header
        val idx = bytes.indices.firstOrNull { i ->
            i + 1 < bytes.size && bytes[i] == 0x41 && bytes[i + 1] == pid
        } ?: return null

        val data = bytes.subList(idx + 2, bytes.size)
        return when (pid) {
            0x05 -> data.getOrNull(0)?.let { a ->
                PidSample(timestampUs, pid, "Coolant Temp", (a - 40).toDouble(), "°C")
            }
            0x06 -> data.getOrNull(0)?.let { a ->
                PidSample(timestampUs, pid, "STFT B1", (a - 128) * 100.0 / 128.0, "%")
            }
            0x07 -> data.getOrNull(0)?.let { a ->
                PidSample(timestampUs, pid, "LTFT B1", (a - 128) * 100.0 / 128.0, "%")
            }
            0x0C -> if (data.size >= 2) {
                val rpm = ((data[0] * 256) + data[1]) / 4.0
                PidSample(timestampUs, pid, "Engine RPM", rpm, "rpm")
            } else null
            0x0D -> data.getOrNull(0)?.let { a ->
                PidSample(timestampUs, pid, "Vehicle Speed", a.toDouble(), "km/h")
            }
            0x0F -> data.getOrNull(0)?.let { a ->
                PidSample(timestampUs, pid, "Intake Air Temp", (a - 40).toDouble(), "°C")
            }
            0x10 -> if (data.size >= 2) {
                val maf = ((data[0] * 256) + data[1]) / 100.0
                PidSample(timestampUs, pid, "MAF", maf, "g/s")
            } else null
            else -> null
        }
    }

    /**
     * Parses a Mode 03 stored DTC response (`43 ...`) into SAE J2012 code strings (e.g. `P0420`, `P2463`).
     * Works for both CAN (which includes a DTC count byte after `43`) and non-CAN responses.
     */
    fun parseMode03Dtcs(raw: String): List<String> {
        if (isErrorResponse(raw)) return emptyList()
        val bytes = extractHexBytes(raw)
        val idx = bytes.indexOf(0x43)
        if (idx < 0) return emptyList()

        val payload = bytes.subList(idx + 1, bytes.size)
        if (payload.isEmpty()) return emptyList()

        // CAN ISO 15765-4 Mode 03 puts DTC count in payload[0], followed by 2*count bytes.
        val dtcBytes = if (payload.size >= 3 && payload.size == 1 + payload[0] * 2) {
            payload.subList(1, payload.size)
        } else if (payload.size % 2 == 1) {
            payload.subList(1, payload.size)
        } else {
            payload
        }

        val codes = mutableListOf<String>()
        var i = 0
        while (i + 1 < dtcBytes.size) {
            val b1 = dtcBytes[i]
            val b2 = dtcBytes[i + 1]
            i += 2
            if (b1 == 0 && b2 == 0) continue
            codes.add(decodeDtcPair(b1, b2))
        }
        return codes.distinct()
    }

    fun decodeDtcPair(b1: Int, b2: Int): String {
        val prefix = when ((b1 shr 6) and 0x03) {
            0 -> 'P'
            1 -> 'C'
            2 -> 'B'
            else -> 'U'
        }
        val d1 = (b1 shr 4) and 0x03
        val d2 = b1 and 0x0F
        val d3 = (b2 shr 4) and 0x0F
        val d4 = b2 and 0x0F
        return "%c%X%X%X%X".format(prefix, d1, d2, d3, d4)
    }

    private fun Char.isHexDigit(): Boolean =
        this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'
}
