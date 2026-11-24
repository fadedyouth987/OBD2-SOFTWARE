package au.com.rootcauseobd.fleet.data

/** Rule 7: Single spelling everywhere. */
enum class SafetyMode { SILENT, ACTIVE_CONFIRMED }

enum class SafetyTier { A, B }

data class GatedRoutine(
    val id: String,
    val protocol: String,
    val serviceId: String,
    val targetEcu: String,
    val name: String,
    val consequence: String,
    val tier: SafetyTier
)

object SafetyPolicyEvaluator {
    fun preconditionsMet(tier: SafetyTier, speedKmh: Int, rpm: Int, batteryV: Double): Boolean {
        val speedOk = speedKmh == 0
        val rpmOk = tier == SafetyTier.A || rpm == 0
        val battOk = tier == SafetyTier.A || batteryV >= 12.5
        return speedOk && rpmOk && battOk
    }
}
