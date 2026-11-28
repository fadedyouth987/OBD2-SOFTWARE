package au.com.rootcauseobd.fleet

import au.com.rootcauseobd.fleet.data.*
import org.junit.Assert.*
import org.junit.Test

class SafetyPolicyTest {
    @Test
    fun tierAFailsClosedOnUnknownOrStaleSpeed() {
        val unknown = SafetyPolicyEvaluator.evaluate(SafetyTier.A, LivePreconditions(speedKmh = null, speedAgeMs = null))
        assertFalse(unknown.allowed)
        assertEquals("PRECONDITION_UNKNOWN", unknown.code)

        val stale = SafetyPolicyEvaluator.evaluate(SafetyTier.A, LivePreconditions(speedKmh = 0, speedAgeMs = 2500L))
        assertFalse(stale.allowed)
        assertEquals("PRECONDITION_UNKNOWN", stale.code)
    }

    @Test
    fun tierABlocksMovingVehicleAndAllowsStationaryFreshSpeed() {
        val moving = SafetyPolicyEvaluator.evaluate(SafetyTier.A, LivePreconditions(speedKmh = 12, speedAgeMs = 200L))
        assertFalse(moving.allowed)
        assertEquals("SAFETY_BLOCKED", moving.code)

        val ok = SafetyPolicyEvaluator.evaluate(SafetyTier.A, LivePreconditions(speedKmh = 0, speedAgeMs = 500L))
        assertTrue(ok.allowed)
    }

    @Test
    fun tierBRequiresEngineOffAndMinBattery() {
        val running = SafetyPolicyEvaluator.evaluate(
            SafetyTier.B,
            LivePreconditions(speedKmh = 0, speedAgeMs = 100L, rpm = 750, batteryV = 13.8)
        )
        assertFalse(running.allowed)
        assertEquals("SAFETY_BLOCKED", running.code)

        val lowBatt = SafetyPolicyEvaluator.evaluate(
            SafetyTier.B,
            LivePreconditions(speedKmh = 0, speedAgeMs = 100L, rpm = 0, batteryV = 12.1)
        )
        assertFalse(lowBatt.allowed)
        assertEquals("SAFETY_BLOCKED", lowBatt.code)

        val unknownBatt = SafetyPolicyEvaluator.evaluate(
            SafetyTier.B,
            LivePreconditions(speedKmh = 0, speedAgeMs = 100L, rpm = 0, batteryV = null)
        )
        assertFalse(unknownBatt.allowed)
        assertEquals("PRECONDITION_UNKNOWN", unknownBatt.code)

        val ok = SafetyPolicyEvaluator.evaluate(
            SafetyTier.B,
            LivePreconditions(speedKmh = 0, speedAgeMs = 100L, rpm = 0, batteryV = 12.6)
        )
        assertTrue(ok.allowed)
    }
}
