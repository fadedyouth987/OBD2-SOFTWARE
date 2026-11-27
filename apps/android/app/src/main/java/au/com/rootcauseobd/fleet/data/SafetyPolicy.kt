package au.com.rootcauseobd.fleet.data

import kotlinx.serialization.Serializable

/** Rule 7: Single spelling everywhere. */
@Serializable
enum class SafetyMode { SILENT, ACTIVE_CONFIRMED }

enum class SafetyTier { A, B }

data class GatedRoutine(
    val id: String,
    val protocol: DiagProtocol,
    val serviceId: Int,
    val txId: Int,
    val rxId: Int,
    val payloadHex: String,
    val targetEcu: String,
    val name: String,
    val consequence: String,
    val tier: SafetyTier
) {
    val serviceIdHex: String get() = "0x%02X".format(serviceId)

    fun ackText(): String =
        "$name on $targetEcu (${protocol.name} $serviceIdHex): $consequence"
}

/**
 * Live vehicle readings used to check safety preconditions.
 * Null values represent unknown readings and MUST fail closed (Rule 5).
 */
data class LivePreconditions(
    val speedKmh: Int? = null,
    val speedAgeMs: Long? = null,
    val rpm: Int? = null,
    val batteryV: Double? = null
)

data class PreconditionCheckResult(
    val allowed: Boolean,
    val code: String? = null,
    val reason: String? = null
)

object SafetyPolicyEvaluator {
    const val MAX_SPEED_AGE_MS: Long = 2_000L
    const val MIN_TIER_B_BATTERY_V: Double = 12.5

    /**
     * Evaluates Tier A / Tier B preconditions per packages/schemas/safety_policy.json (policy 1.0.0).
     * Rule 5: Unknown or stale (>2s) speed always fails closed with PRECONDITION_UNKNOWN.
     */
    fun evaluate(tier: SafetyTier, live: LivePreconditions): PreconditionCheckResult {
        if (live.speedKmh == null || live.speedAgeMs == null) {
            return PreconditionCheckResult(
                allowed = false,
                code = "PRECONDITION_UNKNOWN",
                reason = "Vehicle speed (PID 0x0D) is unknown."
            )
        }
        if (live.speedAgeMs < 0L || live.speedAgeMs > MAX_SPEED_AGE_MS) {
            return PreconditionCheckResult(
                allowed = false,
                code = "PRECONDITION_UNKNOWN",
                reason = "Vehicle speed reading is stale (${live.speedAgeMs} ms > ${MAX_SPEED_AGE_MS} ms)."
            )
        }
        if (live.speedKmh != 0) {
            return PreconditionCheckResult(
                allowed = false,
                code = "SAFETY_BLOCKED",
                reason = "Vehicle must be stationary (speed is ${live.speedKmh} km/h)."
            )
        }

        if (tier == SafetyTier.B) {
            if (live.rpm == null) {
                return PreconditionCheckResult(
                    allowed = false,
                    code = "PRECONDITION_UNKNOWN",
                    reason = "Engine RPM is unknown (required for Tier B)."
                )
            }
            if (live.rpm != 0) {
                return PreconditionCheckResult(
                    allowed = false,
                    code = "SAFETY_BLOCKED",
                    reason = "Engine must be off (RPM is ${live.rpm})."
                )
            }
            if (live.batteryV == null) {
                return PreconditionCheckResult(
                    allowed = false,
                    code = "PRECONDITION_UNKNOWN",
                    reason = "Battery voltage is unknown (required for Tier B)."
                )
            }
            if (live.batteryV < MIN_TIER_B_BATTERY_V) {
                return PreconditionCheckResult(
                    allowed = false,
                    code = "SAFETY_BLOCKED",
                    reason = "Battery voltage %.1f V is below %.1f V minimum.".format(
                        live.batteryV,
                        MIN_TIER_B_BATTERY_V
                    )
                )
            }
        }

        return PreconditionCheckResult(allowed = true)
    }

    fun preconditionsMet(tier: SafetyTier, live: LivePreconditions): Boolean =
        evaluate(tier, live).allowed
}
