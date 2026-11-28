package au.com.rootcauseobd.fleet.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import au.com.rootcauseobd.fleet.data.AccountState
import au.com.rootcauseobd.fleet.data.Licence
import java.text.DateFormat
import java.util.Date

private val FEATURE_LABEL = mapOf(
    "UDS_ACTIVE" to "Clear codes and service functions",
    "CAN_RE_PRO" to "CAN Studio",
    "J2534" to "J2534 pass-thru",
    "IMMO_PROGRAM" to "Key programming",
)

/**
 * Sign-in and plan status. There is deliberately no way to buy or change a plan
 * here, and no price or purchase link: the workshop owner manages the plan on
 * the RootCause website (Google Play consumption-only app).
 */
@Composable
fun AccountScreen(
    state: AccountState,
    licence: Licence?,
    busy: Boolean,
    error: String?,
    onSignIn: (server: String, email: String, password: String) -> Unit,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
    ) {
        Text("RootCause account", style = MaterialTheme.typography.titleMedium)
        error?.let {
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(12.dp)
                )
            }
        }

        if (!state.signedIn) {
            SignInForm(state.serverUrl, busy, onSignIn)
        } else {
            PlanCard(state, licence)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(
                    onClick = onRefresh,
                    enabled = !busy && state.sessionValid,
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                ) { Text(if (busy) "Checking…" else "Check plan now") }
                OutlinedButton(onClick = onSignOut, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Sign out")
                }
            }
            if (!state.sessionValid) {
                Text(
                    "Your sign-in has expired. Sign out and back in to renew the plan; it keeps working until the date above.",
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }

        Text(
            "Plans are managed by your workshop owner on the RootCause website. This app can't buy or change a plan.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun SignInForm(defaultServer: String, busy: Boolean, onSignIn: (String, String, String) -> Unit) {
    var server by remember { mutableStateOf(defaultServer) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var showServer by remember { mutableStateOf(defaultServer.isBlank()) }

    Text(
        "Sign in with your workshop's RootCause account to use its plan. Without signing in you can still read codes and live data.",
        style = MaterialTheme.typography.bodySmall
    )
    OutlinedTextField(
        value = email,
        onValueChange = { email = it },
        label = { Text("Email") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        modifier = Modifier.fillMaxWidth()
    )
    OutlinedTextField(
        value = password,
        onValueChange = { password = it },
        label = { Text("Password") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        modifier = Modifier.fillMaxWidth()
    )
    if (showServer) {
        OutlinedTextField(
            value = server,
            onValueChange = { server = it },
            label = { Text("RootCause server") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth()
        )
    } else {
        TextButton(onClick = { showServer = true }, modifier = Modifier.heightIn(min = 48.dp)) {
            Text("Change server")
        }
    }
    Button(
        onClick = { onSignIn(server, email, password) },
        enabled = !busy && email.isNotBlank() && password.isNotEmpty() && server.isNotBlank(),
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
    ) { Text(if (busy) "Signing in…" else "Sign in") }
}

@Composable
private fun PlanCard(state: AccountState, licence: Licence?) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(state.workspaceName ?: "Your workshop", style = MaterialTheme.typography.titleSmall)
            Text(state.email ?: "", style = MaterialTheme.typography.bodySmall)
            val plan = licence?.let { Licence.TIER_LABEL[it.tier] ?: it.tier } ?: "Community (free)"
            Text("Plan: $plan", fontWeight = FontWeight.SemiBold)
            if (licence != null) {
                val until = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
                    .format(Date(licence.expiresAt * 1000))
                Text("Works offline until $until; the app renews it when it's online.", style = MaterialTheme.typography.bodySmall)
                val unlocked = licence.features.mapNotNull { FEATURE_LABEL[it] }
                Text(
                    if (unlocked.isEmpty()) "Reading codes and live data." else "Includes: " + unlocked.joinToString(", "),
                    style = MaterialTheme.typography.bodySmall
                )
            } else {
                Text("Reading codes and live data. Clearing codes needs a Pro plan or higher.", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
