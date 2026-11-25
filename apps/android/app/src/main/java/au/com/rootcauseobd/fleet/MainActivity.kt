package au.com.rootcauseobd.fleet

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import au.com.rootcauseobd.fleet.data.*
import au.com.rootcauseobd.fleet.ui.screens.SafetyConfirmDialog
import au.com.rootcauseobd.fleet.ui.theme.RootCauseAutelTheme

private data class FleetVehicle(
    val id: String,
    val name: String,
    val adapterId: String,
    val protocol: String,
    val batteryV: Double,
    val rpm: Int,
    val speedKmh: Int,
    val dtcSummary: String,
    val confidenceBand: String
)

private val FLEET_VEHICLES = listOf(
    FleetVehicle("FLT-104", "2023 Ford Ranger Wildtrak", "virtual-generic-uds", "HS-CAN 500k", 14.1, 780, 0, "P2463 · DPF Soot", "HIGH"),
    FleetVehicle("FLT-108", "2006 BMW E90 325i", "virtual-bmw-e90-dcan", "BMW D-CAN 500k", 13.8, 710, 0, "2AAF · Fuel Pump Plausibility", "MEDIUM"),
    FleetVehicle("FLT-112", "2002 Ford AU Falcon", "virtual-falcon-ba", "J1850 PWM", 12.1, 0, 0, "P0420 · Catalyst Efficiency", "HIGH")
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            var darkTheme by remember { mutableStateOf(true) }
            var selectedTab by remember { mutableStateOf(0) }
            var activeVehicle by remember { mutableStateOf(FLEET_VEHICLES.first()) }
            var safetyMode by remember { mutableStateOf(SafetyMode.SILENT) }
            var showConfirm by remember { mutableStateOf(false) }
            var wsStatus by remember { mutableStateOf("Simulation Ready") }
            val wsClient = remember { EdgeWsClient() }

            RootCauseAutelTheme(darkTheme = darkTheme) {
                Scaffold(
                    topBar = {
                        @OptIn(ExperimentalMaterial3Api::class)
                        TopAppBar(
                            title = {
                                Text("RootCause · ${activeVehicle.id} · ${activeVehicle.batteryV}V · $safetyMode")
                            }
                        )
                    },
                    bottomBar = {
                        NavigationBar {
                            listOf("Fleet", "Live PIDs", "Topology", "Service").forEachIndexed { idx, label ->
                                NavigationBarItem(
                                    selected = selectedTab == idx,
                                    onClick = { selectedTab = idx },
                                    icon = { Text(label.take(1)) },
                                    label = { Text(label) }
                                )
                            }
                        }
                    }
                ) { padding ->
                    Column(
                        modifier = Modifier.padding(padding).padding(16.dp).fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        when (selectedTab) {
                            0 -> {
                                Text("Fleet Vehicles ($wsStatus)", style = MaterialTheme.typography.titleMedium)
                                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    items(FLEET_VEHICLES) { v ->
                                        ElevatedCard(
                                            onClick = { activeVehicle = v },
                                            modifier = Modifier.fillMaxWidth()
                                        ) {
                                            Column(Modifier.padding(12.dp)) {
                                                Text("${v.id} · ${v.name}", style = MaterialTheme.typography.titleSmall)
                                                Text("${v.protocol} · ${v.batteryV}V · ${v.dtcSummary}")
                                            }
                                        }
                                    }
                                }
                                Button(
                                    onClick = {
                                        wsStatus = "Connecting to ws://127.0.0.1:8765..."
                                        wsClient.connect(
                                            pairingToken = "DEV-PAIR-2026",
                                            onFrame = { wsStatus = "Connected (${activeVehicle.adapterId})" },
                                            onError = { err -> wsStatus = "Offline Sim ($err)" }
                                        )
                                    },
                                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                ) {
                                    Text("Connect Edge Daemon (${activeVehicle.adapterId})")
                                }
                            }
                            1 -> {
                                Text("Live Mode 01 Telemetry · ${activeVehicle.name}", style = MaterialTheme.typography.titleMedium)
                                Card(Modifier.fillMaxWidth()) {
                                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                        Text("Engine RPM: ${activeVehicle.rpm} rpm")
                                        Text("Vehicle Speed: ${activeVehicle.speedKmh} km/h")
                                        Text("Battery Voltage: ${activeVehicle.batteryV} V")
                                        Text("Protocol: ${activeVehicle.protocol}")
                                    }
                                }
                            }
                            2 -> {
                                Text("ECU Topology & AI Copilot", style = MaterialTheme.typography.titleMedium)
                                listOf("PCM · HS-CAN", "TCM · HS-CAN", "ABS · HS-CAN", "BCM · MS-CAN").forEach { mod ->
                                    Card(Modifier.fillMaxWidth()) {
                                        Row(Modifier.padding(12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                            Text(mod)
                                            Text(if (mod.startsWith("PCM")) "1 FAULT (${activeVehicle.confidenceBand})" else "OK")
                                        }
                                    }
                                }
                                Text("Active DTC: ${activeVehicle.dtcSummary} (Confidence: ${activeVehicle.confidenceBand})")
                            }
                            else -> {
                                Text("Service, MVIS & Tamper Audit", style = MaterialTheme.typography.titleMedium)
                                Text("Odometer PCM/IPC: MATCH · Flash Counter: INFO: not supported")
                                Button(
                                    onClick = { showConfirm = true },
                                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                ) {
                                    Text("Mode 0x04 Clear DTCs (1.5s Hold)")
                                }
                                OutlinedButton(
                                    onClick = { darkTheme = !darkTheme },
                                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                ) {
                                    Text(if (darkTheme) "Switch to Daylight Glare Mode" else "Switch to Night Cab Mode")
                                }
                            }
                        }
                    }

                    if (showConfirm) {
                        SafetyConfirmDialog(
                            routine = GatedRoutine(
                                id = "obd_04",
                                protocol = "OBD",
                                serviceId = "0x04",
                                targetEcu = "ALL",
                                name = "Clear DTCs & Stored Values",
                                consequence = "Resets emission readiness monitors and clears stored DTCs.",
                                tier = SafetyTier.A
                            ),
                            speedKmh = activeVehicle.speedKmh,
                            rpm = activeVehicle.rpm,
                            batteryV = activeVehicle.batteryV,
                            onDismiss = { showConfirm = false },
                            onConfirmed = {
                                safetyMode = SafetyMode.ACTIVE_CONFIRMED
                                showConfirm = false
                            }
                        )
                    }
                }
            }
        }
    }
}
