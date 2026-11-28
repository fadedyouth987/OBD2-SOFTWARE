package au.com.rootcauseobd.fleet

import au.com.rootcauseobd.fleet.data.ElmProtocol
import org.junit.Assert.*
import org.junit.Test

class ElmProtocolTest {
    @Test
    fun parsesBatteryVoltage() {
        assertEquals(12.6, ElmProtocol.parseBatteryVoltage("12.6V")!!, 0.001)
        assertEquals(14.1, ElmProtocol.parseBatteryVoltage("14.1 V\n>")!!, 0.001)
        assertNull(ElmProtocol.parseBatteryVoltage("?"))
    }

    @Test
    fun parsesMode01Pids() {
        val rpm = ElmProtocol.parseMode01Pid(0x0C, "SEARCHING...\n41 0C 0C 38", timestampUs = 1000L)
        assertNotNull(rpm)
        assertEquals(782.0, rpm!!.value, 0.01)

        val speed = ElmProtocol.parseMode01Pid(0x0D, "41 0D 00", timestampUs = 1000L)
        assertEquals(0.0, speed!!.value, 0.01)

        val ect = ElmProtocol.parseMode01Pid(0x05, "41 05 82", timestampUs = 1000L)
        assertEquals(90.0, ect!!.value, 0.01)

        val maf = ElmProtocol.parseMode01Pid(0x10, "41 10 01 F4", timestampUs = 1000L)
        assertEquals(5.0, maf!!.value, 0.01)

        assertNull(ElmProtocol.parseMode01Pid(0x0D, "NO DATA"))
    }

    @Test
    fun parsesMode03Dtcs() {
        // CAN format: 43 <count=02> 04 20 (P0420) 24 63 (P2463)
        val dtcs = ElmProtocol.parseMode03Dtcs("43 02 04 20 24 63")
        assertEquals(listOf("P0420", "P2463"), dtcs)

        // Chassis & Network DTCs + 00 00 padding
        val mixed = ElmProtocol.parseMode03Dtcs("43 40 35 C1 00 00 00")
        assertEquals(listOf("C0035", "U0100"), mixed)

        assertTrue(ElmProtocol.parseMode03Dtcs("NO DATA").isEmpty())
    }
}
