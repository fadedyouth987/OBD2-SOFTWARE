package au.com.rootcauseobd.fleet.ui.screens

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import au.com.rootcauseobd.fleet.data.GatedRoutine
import au.com.rootcauseobd.fleet.data.SafetyPolicyEvaluator
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A-DES-3: Names action, ECU, consequence, preconditions, and requires 1.5s hold-to-confirm. */
@Composable
fun SafetyConfirmDialog(
    routine: GatedRoutine,
    speedKmh: Int,
    rpm: Int,
    batteryV: Double,
    onDismiss: () -> Unit,
    onConfirmed: () -> Unit
) {
    val preconditionsOk = SafetyPolicyEvaluator.preconditionsMet(routine.tier, speedKmh, rpm, batteryV)
    var holdProgress by remember { mutableFloatStateOf(0f) }
    val scope = rememberCoroutineScope()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Tier ${routine.tier} Confirm (${routine.protocol} ${routine.serviceId})") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Action: ${routine.name}")
                Text("Target ECU: ${routine.targetEcu}")
                Text("Consequence: ${routine.consequence}")
                Text("Speed: $speedKmh km/h | RPM: $rpm | Batt: ${"%.1f".format(batteryV)} V")
                LinearProgressIndicator(progress = { holdProgress }, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            Button(
                enabled = preconditionsOk,
                onClick = {},
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .pointerInput(preconditionsOk) {
                        detectTapGestures(onPress = {
                            if (!preconditionsOk) return@detectTapGestures
                            val job = scope.launch {
                                val steps = 30
                                for (i in 1..steps) {
                                    delay(50) // 30 * 50ms = 1500ms
                                    holdProgress = i.toFloat() / steps
                                }
                                onConfirmed()
                            }
                            tryAwaitRelease()
                            job.cancel()
                            holdProgress = 0f
                        })
                    }
            ) {
                Text(if (preconditionsOk) "Hold 1.5s to Confirm" else "Precondition Failed")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") }
        }
    )
}
