//! Wire protocol between the web app and the edge daemon (Task 0.2).
//!
//! `messages` and `policy_types` are generated from `packages/schemas/` by
//! `tools/codegen` (A-DX-3); do not edit them. This module adds what the
//! generator cannot: schema validation on parse, the shared safety policy,
//! error hints (A-DX-4) and version compatibility (A-ENG-3).

#[rustfmt::skip]
pub mod messages;
#[rustfmt::skip]
pub mod policy_types;

use std::{collections::BTreeMap, fmt, sync::LazyLock};

pub use messages::{
    DiagProtocol, EdgeMessage, ErrorCode, ErrorResponse, ErrorResponseType, RequestId,
    PROTOCOL_VERSION, REQUEST_RESPONSE,
};
pub use policy_types::{GatedService, SafetyPolicy};

/// The wire schema, embedded so the daemon validates against exactly what it was built from.
pub const EDGE_WS_SCHEMA_JSON: &str =
    include_str!("../../../../packages/schemas/edge_ws.schema.json");
/// Rule 3: the only list of gated services. The web app imports the same file.
pub const SAFETY_POLICY_JSON: &str =
    include_str!("../../../../packages/schemas/safety_policy.json");
pub const SAFETY_POLICY_SCHEMA_JSON: &str =
    include_str!("../../../../packages/schemas/safety_policy.schema.json");
/// One-line fix-it text for every `ErrorCode` (A-DX-4).
pub const ERROR_HINTS_JSON: &str = include_str!("../../../../packages/schemas/error_hints.json");

/// Why an incoming message was rejected.
#[derive(Debug)]
pub enum ParseError {
    /// Not JSON, or JSON that serde could not map onto the generated types.
    Json(serde_json::Error),
    /// Valid JSON that breaks edge_ws.schema.json (first few violations).
    Schema(Vec<String>),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(e) => write!(f, "invalid JSON message: {e}"),
            Self::Schema(errors) => write!(f, "message breaks the schema: {}", errors.join("; ")),
        }
    }
}

impl std::error::Error for ParseError {}

fn compile(schema_json: &str, name: &str) -> jsonschema::Validator {
    let schema: serde_json::Value =
        serde_json::from_str(schema_json).unwrap_or_else(|e| panic!("{name} is not JSON: {e}"));
    jsonschema::draft7::new(&schema).unwrap_or_else(|e| panic!("{name} is not draft-07: {e}"))
}

static MESSAGE_VALIDATOR: LazyLock<jsonschema::Validator> =
    LazyLock::new(|| compile(EDGE_WS_SCHEMA_JSON, "edge_ws.schema.json"));

fn schema_errors(validator: &jsonschema::Validator, value: &serde_json::Value) -> Vec<String> {
    validator
        .iter_errors(value)
        .take(5)
        .map(|e| format!("{} at {}", e, e.instance_path()))
        .collect()
}

/// Checks a JSON value against edge_ws.schema.json.
pub fn validate_message(value: &serde_json::Value) -> Result<(), ParseError> {
    let errors = schema_errors(&MESSAGE_VALIDATOR, value);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(ParseError::Schema(errors))
    }
}

/// Parses one WebSocket text frame. Validates against the schema first, so
/// numeric bounds and every other constraint match the web app's Zod validators.
pub fn parse_message(text: &str) -> Result<EdgeMessage, ParseError> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(ParseError::Json)?;
    validate_message(&value)?;
    serde_json::from_value(value).map_err(ParseError::Json)
}

/// Serializes a message for the wire.
pub fn to_wire(message: &EdgeMessage) -> String {
    serde_json::to_string(message).expect("generated protocol types always serialize")
}

static POLICY: LazyLock<SafetyPolicy> = LazyLock::new(|| {
    let value: serde_json::Value =
        serde_json::from_str(SAFETY_POLICY_JSON).expect("safety_policy.json is not JSON");
    let errors = schema_errors(
        &compile(SAFETY_POLICY_SCHEMA_JSON, "safety_policy.schema.json"),
        &value,
    );
    assert!(
        errors.is_empty(),
        "safety_policy.json breaks its schema: {errors:?}"
    );
    serde_json::from_value(value).expect("safety_policy.json does not match the generated types")
});

/// The parsed safety policy. Panics at first use if the embedded file is invalid,
/// which `cargo test` catches before a build ships.
pub fn safety_policy() -> &'static SafetyPolicy {
    &POLICY
}

pub fn policy_version() -> &'static str {
    safety_policy().policy_version.as_str()
}

fn hex_byte(text: &str) -> u8 {
    u8::from_str_radix(text.trim_start_matches("0x"), 16).expect("policy hex bytes are validated")
}

/// The gated rule covering a request, if any. A rule with no sub-function
/// covers every sub-function of its service.
pub fn gated_rule(
    protocol: DiagProtocol,
    service_id: u8,
    sub_function: Option<u8>,
) -> Option<&'static GatedService> {
    let protocol = protocol.to_string();
    safety_policy().gated.iter().find(|rule| {
        rule.protocol.to_string() == protocol
            && hex_byte(&rule.service_id) == service_id
            && rule
                .sub_function
                .as_ref()
                .is_none_or(|sub| Some(hex_byte(sub)) == sub_function)
    })
}

/// The gated set in a canonical, language-neutral form such as
/// `"UDS 0x10/0x02 B"` or `"UDS 0x11/* A"`, sorted. The web app builds the
/// same list from the same file; the parity test compares the two.
pub fn gated_set_canonical() -> Vec<String> {
    let mut set: Vec<String> = safety_policy()
        .gated
        .iter()
        .map(|rule| {
            let sub = rule.sub_function.as_ref().map_or("*", |s| s.as_str());
            format!(
                "{} {}/{} {}",
                rule.protocol,
                rule.service_id.as_str(),
                sub,
                rule.tier
            )
        })
        .collect();
    set.sort();
    set
}

static HINTS: LazyLock<BTreeMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(ERROR_HINTS_JSON).expect("error_hints.json is a string map")
});

/// One-line fix-it text for an error code (A-DX-4). Every code has one; a test enforces it.
pub fn error_hint(code: ErrorCode) -> &'static str {
    HINTS
        .get(&code.to_string())
        .map_or("Check the edge daemon log for details.", String::as_str)
}

/// Builds an `ErrorResponse` with the standard hint for its code. `message`
/// is trimmed to the schema's 1–1000 characters.
pub fn error_response(
    request_id: Option<RequestId>,
    code: ErrorCode,
    message: &str,
    detail: Option<serde_json::Map<String, serde_json::Value>>,
) -> ErrorResponse {
    let mut message: String = message.chars().take(1000).collect();
    if message.is_empty() {
        message = code.to_string();
    }
    ErrorResponse {
        code,
        detail_json: detail,
        hint: error_hint(code)
            .try_into()
            .expect("hints are validated one-liners"),
        message: message
            .try_into()
            .expect("message trimmed to schema bounds"),
        request_id,
        type_: ErrorResponseType::ErrorResponse,
    }
}

fn parse_semver(version: &str) -> Option<(u64, u64, u64)> {
    // Digits only, no leading zeros: the same rule as the SemVer pattern in the schema.
    let number = |p: &str| {
        let canonical = p == "0" || (!p.starts_with('0') && !p.is_empty());
        (canonical && p.bytes().all(|b| b.is_ascii_digit())).then(|| p.parse::<u64>().ok())?
    };
    let mut parts = version.split('.').map(number);
    let triple = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(triple)
}

/// Whether two protocol or policy versions can talk (A-ENG-3): same major,
/// and for 0.x also the same minor. Symmetric, so the daemon and the web app
/// reach the same answer from either side.
pub fn versions_compatible(ours: &str, theirs: &str) -> bool {
    match (parse_semver(ours), parse_semver(theirs)) {
        (Some((a_major, a_minor, _)), Some((b_major, b_minor, _))) => {
            a_major == b_major && (a_major != 0 || a_minor == b_minor)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_loads_and_validates() {
        assert!(!safety_policy().gated.is_empty());
        assert!(versions_compatible(policy_version(), policy_version()));
    }

    #[test]
    fn gated_rule_matches_sub_functions() {
        // 0x10 0x02 (programming) is gated; 0x10 0x03 (extended) is not.
        let programming = gated_rule(DiagProtocol::Uds, 0x10, Some(0x02)).expect("gated");
        assert_eq!(programming.tier.to_string(), "B");
        assert!(gated_rule(DiagProtocol::Uds, 0x10, Some(0x03)).is_none());
        // A rule without a sub-function covers all of them.
        assert!(gated_rule(DiagProtocol::Uds, 0x31, Some(0x01)).is_some());
        assert!(gated_rule(DiagProtocol::Uds, 0x22, None).is_none());
        assert!(gated_rule(DiagProtocol::Obd, 0x04, None).is_some());
    }

    #[test]
    fn error_response_carries_hint() {
        let err = error_response(None, ErrorCode::SafetyBlocked, "", None);
        assert_eq!(err.message.as_str(), "SAFETY_BLOCKED");
        assert_eq!(err.hint.as_str(), error_hint(ErrorCode::SafetyBlocked));
        let wire = to_wire(&err.into());
        assert!(parse_message(&wire).is_ok(), "{wire}");
    }
}
