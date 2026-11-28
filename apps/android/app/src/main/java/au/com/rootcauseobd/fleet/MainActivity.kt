package au.com.rootcauseobd.fleet

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import au.com.rootcauseobd.fleet.data.*
import au.com.rootcauseobd.fleet.ui.screens.AccountScreen
import au.com.rootcauseobd.fleet.ui.screens.SafetyConfirmDialog
import au.com.rootcauseobd.fleet.ui.theme.RootCauseAutelTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class TransportMode(val label: String) {
    EDGE_DAEMON("Edge Daemon (WS)"),
    BLUETOOTH_OBD("Bluetooth OBD-II")
}

private val CLEAR_DTCS_ROUTINE = GatedRoutine(
    id = "obd_04",
    protocol = DiagProtocol.OBD,
    serviceId = 0x04,
    txId = 0x7DF,
    rxId = 0x7E8,
    payloadHex = "04",
    targetEcu = "ALL (0x7DF)",
    name = "Clear DTCs & Stored Values",
    consequence = "Resets emission readiness monitors and clears stored DTCs.",
    tier = SafetyTier.A
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            RootCauseFleetApp()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RootCauseFleetApp() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var darkTheme by remember { mutableStateOf(true) }
    var selectedTab by remember { mutableIntStateOf(0) }
    var transportMode by remember { mutableStateOf(TransportMode.EDGE_DAEMON) }

    // Edge Daemon WebSocket state
    val wsClient = remember { EdgeWsClient() }
    var endpoint by remember { mutableStateOf(EdgeProtocolConstants.DEFAULT_ENDPOINT) }
    var pairingCode by remember { mutableStateOf("") }
    var wsState by remember { mutableStateOf(WsConnectionState.DISCONNECTED) }
    var sessionInfo by remember { mutableStateOf<EdgeIncomingMessage.HelloResponse?>(null) }
    var adapters by remember { mutableStateOf<List<AdapterInfo>>(emptyList()) }
    var activeAdapterId by remember { mutableStateOf<String?>(null) }
    var activeAdapterState by remember { mutableStateOf("DISCONNECTED") }
    var safetyMode by remember { mutableStateOf(SafetyMode.SILENT) }

    // Bluetooth OBD-II state
    val btClient = remember { BluetoothObdClient(context) }
    var btState by remember { mutableStateOf(BtConnectionState.DISCONNECTED) }
    var btDevices by remember { mutableStateOf<List<BtDeviceSummary>>(emptyList()) }
    var btDeviceInfo by remember { mutableStateOf<ElmProtocol.ElmDeviceInfo?>(null) }
    var btPermissionGranted by remember {
        mutableStateOf(
            Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) ==
                PackageManager.PERMISSION_GRANTED
        )
    }

    val btPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        btPermissionGranted = grants.values.all { it }
        if (btPermissionGranted) {
            btDevices = btClient.listPairedDevices()
        }
    }

    // RootCause account and plan licence (bought on the website, never in the app)
    val account = remember {
        CloudAccount(
            context = context,
            defaultServerUrl = BuildConfig.DEFAULT_CLOUD_API_URL,
            trustServerKeys = BuildConfig.DEBUG
        )
    }
    var accountState by remember { mutableStateOf(account.state()) }
    var accountBusy by remember { mutableStateOf(false) }
    var accountError by remember { mutableStateOf<String?>(null) }

    // Live telemetry, DTCs, alerts & safety workflow state
    val livePids = remember { mutableStateMapOf<Int, PidSample>() }
    var lastSpeedReceivedMs by remember { mutableStateOf<Long?>(null) }
    var batteryV by remember { mutableStateOf<Double?>(null) }
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var alerts by remember { mutableStateOf<List<EdgeIncomingMessage.HeuristicAlert>>(emptyList()) }
    var dtcCodes by remember { mutableStateOf<List<String>>(emptyList()) }
    var pendingGatedRoutine by remember { mutableStateOf<GatedRoutine?>(null) }
    var showConfirm by remember { mutableStateOf(false) }
    var statusBanner by remember { mutableStateOf<String?>(null) }
    var lastError by remember { mutableStateOf<String?>(null) }

    // Tick clock every 250ms while dialog or live view is active so speed_age_ms stays accurate (Rule 5)
    LaunchedEffect(Unit) {
        while (true) {
            delay(250)
            nowMs = System.currentTimeMillis()
        }
    }

    // Renew the plan licence when the app opens, if it's close to expiring.
    LaunchedEffect(Unit) {
        if (accountState.signedIn && accountState.sessionValid && account.licenceNeedsRefresh()) {
            accountBusy = true
            val refreshed = account.refreshLicence()
            accountState = refreshed
            accountError = refreshed.licenceError
            accountBusy = false
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            wsClient.close()
            btClient.disconnect()
        }
    }

    val livePreconditions = remember(livePids.toMap(), lastSpeedReceivedMs, batteryV, nowMs) {
        val speedVal = livePids[0x0D]?.value?.toInt()
        val rpmVal = livePids[0x0C]?.value?.toInt()
        val ageMs = lastSpeedReceivedMs?.let { (nowMs - it).coerceAtLeast(0L) }
        LivePreconditions(
            speedKmh = speedVal,
            speedAgeMs = ageMs,
            rpm = rpmVal,
            batteryV = batteryV
        )
    }

    // Re-checked on every clock tick so an expired licence stops unlocking features.
    val licence = accountState.licence?.takeIf { it.isCurrent(nowMs / 1000) }
    val canClearOverBluetooth = licence?.has(Licence.UDS_ACTIVE) == true
    val planLabel = licence?.let { Licence.TIER_LABEL[it.tier] ?: it.tier } ?: "Community"

    val topBarBattery = batteryV?.let { "%.1fV".format(it) } ?: "--.-V"
    val topBarConn = when (transportMode) {
        TransportMode.EDGE_DAEMON -> activeAdapterId ?: wsState.name
        TransportMode.BLUETOOTH_OBD -> btDeviceInfo?.stnVersion ?: btDeviceInfo?.elmVersion ?: btState.name
    }

    RootCauseAutelTheme(darkTheme = darkTheme) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Text(
                            "RootCause · $planLabel · $topBarConn · $topBarBattery · $safetyMode",
                            style = MaterialTheme.typography.titleMedium
                        )
                    }
                )
            },
            bottomBar = {
                NavigationBar {
                    listOf("Connect", "Live PIDs", "DTCs & Alerts", "Service", "Account").forEachIndexed { idx, label ->
                        NavigationBarItem(
                            selected = selectedTab == idx,
                            onClick = { selectedTab = idx },
                            icon = { Text(label.take(1), fontWeight = FontWeight.Bold) },
                            label = { Text(label) }
                        )
                    }
                }
            }
        ) { padding ->
            Column(
                modifier = Modifier
                    .padding(padding)
                    .padding(16.dp)
                    .fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                lastError?.let { err ->
                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            text = err,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(12.dp)
                        )
                    }
                }
                statusBanner?.let { banner ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = banner,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(12.dp)
                        )
                    }
                }

                when (selectedTab) {
                    0 -> {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            TransportMode.entries.forEach { mode ->
                                FilterChip(
                                    selected = transportMode == mode,
                                    onClick = { transportMode = mode },
                                    label = { Text(mode.label) },
                                    modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                                )
                            }
                        }

                        if (transportMode == TransportMode.EDGE_DAEMON) {
                            OutlinedTextField(
                                value = endpoint,
                                onValueChange = { endpoint = it },
                                label = { Text("Edge Daemon URL (adb reverse tcp:8765 tcp:8765)") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth()
                            )
                            OutlinedTextField(
                                value = pairingCode,
                                onValueChange = { pairingCode = it },
                                label = { Text("6-digit Pairing Code or Cloud JWT") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth()
                            )
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Button(
                                    onClick = {
                                        lastError = null
                                        statusBanner = "Connecting to $endpoint (protocol ${EdgeProtocolConstants.PROTOCOL_VERSION})…"
                                        wsClient.connect(
                                            endpoint = endpoint,
                                            clientToken = pairingCode,
                                            onState = { st ->
                                                scope.launch { wsState = st }
                                            },
                                            onMessage = { msg ->
                                                scope.launch {
                                                    when (msg) {
                                                        is EdgeIncomingMessage.HelloResponse -> {
                                                            sessionInfo = msg
                                                            statusBanner = "Paired · Daemon ${msg.daemonVersion} · Tier ${msg.leaseTier}"
                                                            wsClient.listAdapters()
                                                            // Hand the workshop's plan to the daemon; it verifies it
                                                            // against its own pinned keys and answers LeaseStatus.
                                                            if (licence != null) {
                                                                wsClient.installLease(licence.token)
                                                            }
                                                        }
                                                        is EdgeIncomingMessage.AdapterListResponse -> {
                                                            adapters = msg.adapters
                                                        }
                                                        is EdgeIncomingMessage.AdapterStatus -> {
                                                            activeAdapterId = if (msg.state == "CONNECTED") msg.adapterId else null
                                                            activeAdapterState = msg.state
                                                            msg.batteryV?.let { batteryV = it }
                                                            statusBanner = "Adapter ${msg.adapterId}: ${msg.state}"
                                                        }
                                                        is EdgeIncomingMessage.ObdPidStream -> {
                                                            val receivedNow = System.currentTimeMillis()
                                                            msg.samples.forEach { sample ->
                                                                livePids[sample.pid] = sample
                                                                if (sample.pid == 0x0D) {
                                                                    lastSpeedReceivedMs = receivedNow
                                                                }
                                                            }
                                                        }
                                                        is EdgeIncomingMessage.HeuristicAlert -> {
                                                            if (msg.severity != "INFO") {
                                                                alerts = (listOf(msg) + alerts).take(20)
                                                            }
                                                        }
                                                        is EdgeIncomingMessage.SafetyConfirmResponse -> {
                                                            val routine = pendingGatedRoutine
                                                            if (routine != null) {
                                                                statusBanner = "Token issued; sending ${routine.protocol} ${routine.serviceIdHex}…"
                                                                wsClient.sendDiagCommand(
                                                                    protocol = routine.protocol,
                                                                    serviceId = routine.serviceId,
                                                                    txId = routine.txId,
                                                                    rxId = routine.rxId,
                                                                    payloadHex = routine.payloadHex,
                                                                    safetyToken = msg.safetyToken
                                                                )
                                                                pendingGatedRoutine = null
                                                            }
                                                        }
                                                        is EdgeIncomingMessage.DiagCommandResponse -> {
                                                            statusBanner = if (msg.positive) {
                                                                "ECU Positive Response: ${msg.responseHex}"
                                                            } else {
                                                                "ECU Negative Response: ${msg.nrc?.name ?: msg.responseHex}"
                                                            }
                                                            if (msg.positive && msg.responseHex.startsWith("43", ignoreCase = true)) {
                                                                val spaced = msg.responseHex.chunked(2).joinToString(" ")
                                                                dtcCodes = ElmProtocol.parseMode03Dtcs(spaced)
                                                            }
                                                        }
                                                        is EdgeIncomingMessage.LeaseStatus -> {
                                                            statusBanner = "Daemon plan: ${Licence.TIER_LABEL[msg.leaseTier] ?: msg.leaseTier}" +
                                                                if (!msg.cloudKeysPinned) " (daemon has no pinned RootCause key yet)" else ""
                                                        }
                                                        is EdgeIncomingMessage.ErrorResponse -> {
                                                            lastError = "${msg.code}: ${msg.message}" +
                                                                if (msg.hint.isNotBlank()) " — ${msg.hint}" else ""
                                                        }
                                                        else -> Unit
                                                    }
                                                }
                                            },
                                            onError = { err ->
                                                scope.launch { lastError = err }
                                            }
                                        )
                                    },
                                    enabled = pairingCode.isNotBlank(),
                                    modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                                ) {
                                    Text(if (wsState == WsConnectionState.CONNECTED) "Reconnect" else "Pair & Connect")
                                }
                                OutlinedButton(
                                    onClick = {
                                        wsClient.close()
                                        wsState = WsConnectionState.DISCONNECTED
                                        activeAdapterId = null
                                        activeAdapterState = "DISCONNECTED"
                                        sessionInfo = null
                                        livePids.clear()
                                        lastSpeedReceivedMs = null
                                    },
                                    modifier = Modifier.heightIn(min = 48.dp)
                                ) {
                                    Text("Disconnect")
                                }
                            }

                            Text(
                                "Adapters (${adapters.size}) · State: $activeAdapterState",
                                style = MaterialTheme.typography.titleSmall
                            )
                            LazyColumn(
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.weight(1f)
                            ) {
                                items(adapters, key = { it.adapterId }) { adapter ->
                                    val isConnected = activeAdapterId == adapter.adapterId
                                    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
                                        Row(
                                            horizontalArrangement = Arrangement.SpaceBetween,
                                            modifier = Modifier.padding(12.dp).fillMaxWidth()
                                        ) {
                                            Column(Modifier.weight(1f)) {
                                                Text(adapter.displayName, style = MaterialTheme.typography.titleSmall)
                                                Text("${adapter.adapterId} · ${adapter.kind}", style = MaterialTheme.typography.bodySmall)
                                            }
                                            Button(
                                                onClick = {
                                                    if (isConnected) {
                                                        wsClient.disconnectAdapter(adapter.adapterId)
                                                    } else {
                                                        wsClient.connectAdapter(
                                                            adapterId = adapter.adapterId,
                                                            safetyMode = safetyMode
                                                        )
                                                    }
                                                },
                                                modifier = Modifier.heightIn(min = 48.dp)
                                            ) {
                                                Text(if (isConnected) "Stop" else "Use")
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            // Direct Bluetooth ELM327/STN mode
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Button(
                                    onClick = {
                                        lastError = null
                                        if (!btPermissionGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                                            btPermissionLauncher.launch(
                                                arrayOf(
                                                    Manifest.permission.BLUETOOTH_CONNECT,
                                                    Manifest.permission.BLUETOOTH_SCAN
                                                )
                                            )
                                        } else {
                                            btDevices = btClient.listPairedDevices()
                                            if (btDevices.isEmpty()) {
                                                statusBanner = "No paired Bluetooth devices found. Pair your ELM327/STN dongle in Android Settings."
                                            }
                                        }
                                    },
                                    modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                                ) {
                                    Text("Refresh Paired Dongles")
                                }
                                OutlinedButton(
                                    onClick = {
                                        btClient.disconnect()
                                        btState = BtConnectionState.DISCONNECTED
                                        btDeviceInfo = null
                                        livePids.clear()
                                        lastSpeedReceivedMs = null
                                    },
                                    modifier = Modifier.heightIn(min = 48.dp)
                                ) {
                                    Text("Disconnect")
                                }
                            }

                            Text(
                                "Bluetooth Status: $btState" +
                                    (btDeviceInfo?.let { " · ${it.stnVersion ?: it.elmVersion}" } ?: ""),
                                style = MaterialTheme.typography.titleSmall
                            )

                            LazyColumn(
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.weight(1f)
                            ) {
                                items(btDevices, key = { it.address }) { dev ->
                                    ElevatedCard(
                                        onClick = {
                                            lastError = null
                                            statusBanner = "Connecting Bluetooth SPP to ${dev.name}…"
                                            btClient.connect(
                                                scope = scope,
                                                address = dev.address,
                                                onState = { st -> scope.launch { btState = st } },
                                                onDeviceInfo = { info ->
                                                    scope.launch {
                                                        btDeviceInfo = info
                                                        statusBanner = "Connected: ${info.stnVersion ?: info.elmVersion}"
                                                    }
                                                },
                                                onPidSample = { sample ->
                                                    scope.launch {
                                                        livePids[sample.pid] = sample
                                                        if (sample.pid == 0x0D) {
                                                            lastSpeedReceivedMs = System.currentTimeMillis()
                                                        }
                                                    }
                                                },
                                                onBatteryV = { v -> scope.launch { batteryV = v } },
                                                onError = { err -> scope.launch { lastError = err } }
                                            )
                                        },
                                        modifier = Modifier.fillMaxWidth()
                                    ) {
                                        Column(Modifier.padding(12.dp)) {
                                            Text(dev.name, style = MaterialTheme.typography.titleSmall)
                                            Text(dev.address, style = MaterialTheme.typography.bodySmall)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    1 -> {
                        Text("Live OBD-II Mode 01 Telemetry", style = MaterialTheme.typography.titleMedium)
                        val speedAgeText = livePreconditions.speedAgeMs?.let { "${it} ms" } ?: "N/A"
                        Text(
                            "Speed freshness: $speedAgeText · Battery: $topBarBattery",
                            style = MaterialTheme.typography.bodySmall
                        )
                        if (livePids.isEmpty()) {
                            Card(Modifier.fillMaxWidth()) {
                                Text(
                                    "No live PID samples yet. Connect to an edge-daemon adapter or a Bluetooth ELM327/STN dongle.",
                                    modifier = Modifier.padding(16.dp)
                                )
                            }
                        } else {
                            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(livePids.values.sortedBy { it.pid }, key = { it.pid }) { sample ->
                                    Card(Modifier.fillMaxWidth()) {
                                        Row(
                                            horizontalArrangement = Arrangement.SpaceBetween,
                                            modifier = Modifier.padding(14.dp).fillMaxWidth()
                                        ) {
                                            Text("0x%02X · %s".format(sample.pid, sample.name))
                                            Text(
                                                "%.1f %s".format(sample.value, sample.unit),
                                                fontWeight = FontWeight.Bold
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    2 -> {
                        Text("Stored DTCs & Heuristic Alerts", style = MaterialTheme.typography.titleMedium)
                        Button(
                            onClick = {
                                lastError = null
                                if (transportMode == TransportMode.EDGE_DAEMON) {
                                    wsClient.sendDiagCommand(
                                        protocol = DiagProtocol.OBD,
                                        serviceId = 0x03,
                                        txId = 0x7DF,
                                        rxId = 0x7E8,
                                        payloadHex = "03"
                                    )
                                    statusBanner = "Requested Mode 0x03 stored DTCs…"
                                } else {
                                    scope.launch {
                                        btClient.readDtcs()
                                            .onSuccess { codes ->
                                                dtcCodes = codes
                                                statusBanner = "Read ${codes.size} DTC(s) via Bluetooth."
                                            }
                                            .onFailure { lastError = it.message }
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        ) {
                            Text("Read Stored DTCs (Mode 0x03)")
                        }

                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("Stored DTCs (${dtcCodes.size})", style = MaterialTheme.typography.titleSmall)
                                if (dtcCodes.isEmpty()) {
                                    Text("No DTCs read yet.", style = MaterialTheme.typography.bodySmall)
                                } else {
                                    dtcCodes.forEach { code -> Text("• $code", fontWeight = FontWeight.SemiBold) }
                                }
                            }
                        }

                        Text("Daemon Heuristic Alerts (${alerts.size})", style = MaterialTheme.typography.titleSmall)
                        LazyColumn(
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier.weight(1f)
                        ) {
                            items(alerts) { alert ->
                                Card(Modifier.fillMaxWidth()) {
                                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                        Text("[${alert.severity}] ${alert.title}", fontWeight = FontWeight.SemiBold)
                                        Text(alert.recommendedTest, style = MaterialTheme.typography.bodySmall)
                                    }
                                }
                            }
                        }
                    }

                    3 -> {
                        Text("Service & Safety Controls", style = MaterialTheme.typography.titleMedium)
                        val tierACheck = SafetyPolicyEvaluator.evaluate(SafetyTier.A, livePreconditions)
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("Safety Interlock (Rule 5)", style = MaterialTheme.typography.titleSmall)
                                Text(
                                    if (tierACheck.allowed) {
                                        "Tier A preconditions met (Speed = 0 km/h, fresh)."
                                    } else {
                                        "${tierACheck.code}: ${tierACheck.reason}"
                                    },
                                    style = MaterialTheme.typography.bodySmall
                                )
                            }
                        }
                        val planBlocksClear = transportMode == TransportMode.BLUETOOTH_OBD && !canClearOverBluetooth
                        if (planBlocksClear) {
                            Card(Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text("Plan: $planLabel", style = MaterialTheme.typography.titleSmall)
                                    Text(
                                        if (accountState.signedIn) {
                                            "Clearing codes needs a Pro plan or higher. Your workshop owner manages the plan on the RootCause website."
                                        } else {
                                            "Clearing codes needs a Pro plan or higher. Sign in on the Account tab to use your workshop's plan."
                                        },
                                        style = MaterialTheme.typography.bodySmall
                                    )
                                }
                            }
                        }
                        Button(
                            onClick = { showConfirm = true },
                            enabled = !planBlocksClear,
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

                    else -> {
                        AccountScreen(
                            state = accountState,
                            licence = licence,
                            busy = accountBusy,
                            error = accountError,
                            onSignIn = { server, email, password ->
                                accountBusy = true
                                accountError = null
                                scope.launch {
                                    try {
                                        val signedIn = account.signIn(server, email, password)
                                        accountState = signedIn
                                        accountError = signedIn.licenceError
                                    } catch (e: AccountException) {
                                        accountError = e.message
                                    } finally {
                                        accountBusy = false
                                    }
                                }
                            },
                            onRefresh = {
                                accountBusy = true
                                accountError = null
                                scope.launch {
                                    val refreshed = account.refreshLicence()
                                    accountState = refreshed
                                    accountError = refreshed.licenceError
                                    accountBusy = false
                                }
                            },
                            onSignOut = {
                                account.signOut()
                                accountState = account.state()
                                accountError = null
                            }
                        )
                    }
                }
            }

            if (showConfirm) {
                SafetyConfirmDialog(
                    routine = CLEAR_DTCS_ROUTINE,
                    preconditions = livePreconditions,
                    onDismiss = { showConfirm = false },
                    onConfirmed = {
                        safetyMode = SafetyMode.ACTIVE_CONFIRMED
                        showConfirm = false
                        lastError = null
                        if (transportMode == TransportMode.EDGE_DAEMON) {
                            pendingGatedRoutine = CLEAR_DTCS_ROUTINE
                            statusBanner = "Requesting single-use safety token from daemon…"
                            wsClient.requestSafetyConfirm(CLEAR_DTCS_ROUTINE)
                        } else {
                            scope.launch {
                                btClient.clearDtcs(livePreconditions, licence)
                                    .onSuccess { resp ->
                                        dtcCodes = emptyList()
                                        statusBanner = "Bluetooth Mode 0x04 Clear DTCs succeeded: $resp"
                                    }
                                    .onFailure { lastError = it.message }
                            }
                        }
                    }
                )
            }
        }
    }
}
