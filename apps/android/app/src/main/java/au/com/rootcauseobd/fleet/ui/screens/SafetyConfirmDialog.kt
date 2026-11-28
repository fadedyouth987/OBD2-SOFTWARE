package au.com.rootcauseobd.fleet.ui.screens

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import au.com.rootcauseobd.fleet.data.GatedRoutine
import au.com.rootcauseobd.fleet.data.LivePreconditions
import au.com.rootcauseobd.fleet.data.SafetyPolicyEvaluator
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * A-DES-3: Names action, ECU, consequence, live preconditions (Rule 5 fail-closed),
 * and requires an uninterrupted 1.5s hold-to-confirm without Button clickable conflict.
 */
@Composable
fun SafetyConfirmDialog(
    routine: GatedRoutine,
    preconditions: LivePreconditions,
    onDismiss: () -> Unit,
    onConfirmed: () -> Unit
) {
    val check = SafetyPolicyEvaluator.evaluate(routine.tier, preconditions)
    var holdProgress by remember { mutableFloatStateOf(0f) }
    var holding by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val speedText = preconditions.speedKmh?.let { "$it km/h" } ?: "Unknown"
    val ageText = preconditions.speedAgeMs?.let { "${it}ms ago" } ?: "No reading"
    val rpmText = preconditions.rpm?.let { "$it rpm" } ?: "Unknown"
    val battText = preconditions.batteryV?.let { "%.1f V".format(it) } ?: "Unknown"

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text("Tier ${routine.tier} Confirm (${routine.protocol.name} ${routine.serviceIdHex})")
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Action: ${routine.name}", fontWeight = FontWeight.SemiBold)
                Text("Target ECU: ${routine.targetEcu}")
                Text("Consequence: ${routine.consequence}")
                HorizontalDivider()
                Text(
                    "Speed: $speedText ($ageText)\nRPM: $rpmText | Battery: $battText",
                    style = MaterialTheme.typography.bodySmall
                )
                if (!check.allowed) {
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer,
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            text = "${check.code}: ${check.reason}",
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(10.dp)
                        )
                    }
                }
                LinearProgressIndicator(
                    progress = { holdProgress },
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            val containerColor = if (check.allowed) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            }
            val contentColor = if (check.allowed) {
                MaterialTheme.colorScheme.onPrimary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            }

            // Use Surface + awaitEachGesture instead of Button(onClick={}) so clickable
            // doesn't consume pointer events before the 1.5s hold completes.
            Surface(
                color = containerColor,
                contentColor = contentColor,
                shape = RoundedCornerShape(24.dp),
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .pointerInput(check.allowed) {
                        if (!check.allowed) return@pointerInput
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false)
                            holding = true
                            val holdJob = scope.launch {
                                val steps = 30
                                for (i in 1..steps) {
                                    delay(50) // 30 * 50ms = 1500ms
                                    holdProgress = i.toFloat() / steps
                                }
                                holding = false
                                onConfirmed()
                            }
                            waitForUpOrCancellation()
                            if (holdJob.isActive) {
                                holdJob.cancel()
                            }
                            holding = false
                            holdProgress = 0f
                        }
                    }
            ) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp)
                ) {
                    Text(
                        text = when {
                            !check.allowed -> check.code ?: "Blocked"
                            holding -> "Keep Holding…"
                            else -> "Hold 1.5s to Confirm"
                        },
                        style = MaterialTheme.typography.labelLarge
                    )
                }
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.heightIn(min = 48.dp)
            ) {
                Text("Cancel")
            }
        }
    )
}
