//! Safety layer (Task 1.2): the only thing between a request and the vehicle.
//!
//! - [`policy`]: typed view of `packages/schemas/safety_policy.json` (Rule 3:
//!   the only list of gated services).
//! - [`interlock`]: [`interlock::SafetyInterlock::check`], the one entry every
//!   transport calls before sending (A-ENG-4), plus single-use safety tokens,
//!   live preconditions (Rule 5: fail closed) and SecurityAccess halts.
//! - [`audit`]: every gated attempt, allowed or refused, is recorded (A-CEO-4).

pub mod audit;
pub mod interlock;
pub mod policy;

/// Formats a `SystemTime` as RFC 3339 UTC with millisecond precision.
pub fn rfc3339(time: std::time::SystemTime) -> String {
    let since = time
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = since.as_secs();
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60,
        since.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn rfc3339_known_dates() {
        assert_eq!(super::rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let t = UNIX_EPOCH + Duration::from_millis(1_795_000_000_250);
        assert_eq!(super::rfc3339(t), "2026-11-18T11:06:40.250Z");
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400); // 2000-02-29
        assert_eq!(super::rfc3339(leap), "2000-02-29T00:00:00.000Z");
    }
}
