//! Real-time CAN reverse engineering (Task 1.3).
//!
//! For every arbitration id the engine keeps per-bit flip counters `B_i` and
//! a bounded history of payloads, then splits each payload into fields and
//! classifies them as static, counter, CRC, boolean or continuous.
//!
//! - Bits are numbered MSB-first: bit 0 is the top bit of byte 0, bit 63 the
//!   bottom bit of byte 7 (big-endian, as most OEM signals are laid out).
//! - Magnitude `M_i = log10(B_i)` (READ, Marchetti & Stabili 2018). Inside a
//!   field, flips get more frequent toward the least significant bit, so the
//!   integer part of each bit's log10 flip *rate* never drops going right; a
//!   drop starts a new field. Bits that never flip are static.
//! - Block score θ = b × u, our concrete reading of ByCAN's boundary score b
//!   and uniformity u: b is how sharply flip activity stops at the field's two
//!   edges (1.0 when both neighbours are static or the payload ends), u is
//!   1 − coefficient of variation of the field's flip rates. CRCs and checksums
//!   score high (every bit flips about half the time); counters and physical
//!   signals score low (rates halve per bit).
//! - Classification also checks the field's values: a counter steps by +1
//!   (mod 2ⁿ) between frames.
//! - [`CanRe::diff`]: bits static in a baseline capture but active during an
//!   action capture (e.g. pressing the window switch), for Task 4.2's studio.

use std::collections::{BTreeMap, VecDeque};

use crate::hal::CanFrame;

/// Payload history kept per id for value-based checks.
pub const HISTORY: usize = 4_096;
/// Frames needed before an id is classified.
pub const MIN_FRAMES: u64 = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldClass {
    Static,
    Counter,
    Crc,
    Boolean,
    Continuous,
}

/// One contiguous bit field.
#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    /// First (most significant) bit, MSB-first numbering.
    pub start_bit: u8,
    pub len: u8,
    pub class: FieldClass,
    /// ByCAN-style block score θ = b × u (0..1).
    pub block_score: f64,
}

/// Per-bit statistics.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BitStat {
    /// Bᵢ: how many times the bit changed between consecutive frames.
    pub flips: u64,
    /// Bᵢ / (frames − 1).
    pub rate: f64,
    /// Mᵢ = log₁₀(Bᵢ); `None` for a bit that never flipped.
    pub magnitude: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IdAnalysis {
    pub id: u32,
    pub extended: bool,
    pub frames: u64,
    pub dlc: u8,
    pub bits: Vec<BitStat>,
    pub fields: Vec<Field>,
}

impl IdAnalysis {
    /// The field containing `bit`, if any.
    pub fn field_at(&self, bit: u8) -> Option<&Field> {
        self.fields
            .iter()
            .find(|f| bit >= f.start_bit && bit < f.start_bit + f.len)
    }
}

#[derive(Clone, Debug, Default)]
struct IdStats {
    frames: u64,
    dlc: u8,
    last: Option<u64>,
    flips: Vec<u64>,
    history: VecDeque<u64>,
}

/// Payload as a 64-bit big-endian word (byte 0 in the top bits).
fn word(data: &[u8]) -> u64 {
    let mut buf = [0u8; 8];
    buf[..data.len()].copy_from_slice(data);
    u64::from_be_bytes(buf)
}

fn bit(word: u64, i: u8) -> bool {
    word >> (63 - u32::from(i)) & 1 == 1
}

fn field_value(word: u64, start: u8, len: u8) -> u64 {
    let shift = 64 - u32::from(start) - u32::from(len);
    (word >> shift) & ((1u64 << len) - 1)
}

/// Live analyzer over any number of ids.
#[derive(Clone, Debug, Default)]
pub struct CanRe {
    ids: BTreeMap<(u32, bool), IdStats>,
}

impl CanRe {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn observe(&mut self, frame: &CanFrame) {
        let stats = self
            .ids
            .entry((frame.id(), frame.is_extended()))
            .or_insert_with(|| IdStats {
                flips: vec![0; 64],
                ..IdStats::default()
            });
        let w = word(frame.data());
        stats.frames += 1;
        stats.dlc = stats.dlc.max(frame.dlc());
        if let Some(prev) = stats.last {
            let changed = prev ^ w;
            for i in 0..64u8 {
                if bit(changed, i) {
                    stats.flips[usize::from(i)] += 1;
                }
            }
        }
        stats.last = Some(w);
        stats.history.push_back(w);
        if stats.history.len() > HISTORY {
            stats.history.pop_front();
        }
    }

    /// Ids seen so far.
    pub fn ids(&self) -> Vec<(u32, bool)> {
        self.ids.keys().copied().collect()
    }

    pub fn analyze_id(&self, id: u32, extended: bool) -> Option<IdAnalysis> {
        let s = self.ids.get(&(id, extended))?;
        let steps = s.frames.saturating_sub(1).max(1) as f64;
        let nbits = s.dlc * 8;
        let bits: Vec<BitStat> = s.flips[..usize::from(nbits)]
            .iter()
            .map(|&b| BitStat {
                flips: b,
                rate: b as f64 / steps,
                magnitude: (b > 0).then(|| (b as f64).log10()),
            })
            .collect();
        let fields = if s.frames < MIN_FRAMES {
            Vec::new()
        } else {
            segment(&bits, &s.history)
        };
        Some(IdAnalysis {
            id,
            extended,
            frames: s.frames,
            dlc: s.dlc,
            bits,
            fields,
        })
    }

    pub fn analyze(&self) -> Vec<IdAnalysis> {
        self.ids
            .keys()
            .filter_map(|&(id, ext)| self.analyze_id(id, ext))
            .collect()
    }

    /// Bits that never flipped in `baseline` but did during `action`, per id.
    pub fn diff(baseline: &CanRe, action: &CanRe) -> Vec<(u32, bool, Vec<u8>)> {
        let mut out = Vec::new();
        for (&(id, ext), act) in &action.ids {
            let base = baseline.ids.get(&(id, ext));
            let bits: Vec<u8> = (0..64u8)
                .filter(|&i| {
                    act.flips[usize::from(i)] > 0
                        && base.is_none_or(|b| b.flips[usize::from(i)] == 0)
                })
                .collect();
            if !bits.is_empty() {
                out.push((id, ext, bits));
            }
        }
        out
    }
}

/// floor(log10(rate)): READ's magnitude class for segmentation.
fn rate_class(rate: f64) -> i32 {
    rate.log10().floor() as i32
}

fn segment(bits: &[BitStat], history: &VecDeque<u64>) -> Vec<Field> {
    let n = bits.len();
    let mut fields = Vec::new();
    let mut i = 0;
    while i < n {
        if bits[i].flips == 0 {
            let start = i;
            while i < n && bits[i].flips == 0 {
                i += 1;
            }
            fields.push(Field {
                start_bit: start as u8,
                len: (i - start) as u8,
                class: FieldClass::Static,
                block_score: 0.0,
            });
            continue;
        }
        let start = i;
        i += 1;
        // Extend while the bit is active and its rate class does not drop.
        while i < n && bits[i].flips > 0 && rate_class(bits[i].rate) >= rate_class(bits[i - 1].rate)
        {
            i += 1;
        }
        let (start, end) = (start as u8, i as u8);
        let score = block_score(bits, start, end);
        let class = classify(bits, history, start, end - start, score);
        fields.push(Field {
            start_bit: start,
            len: end - start,
            class,
            block_score: score,
        });
    }
    fields
}

/// θ = b × u for bits `start..end`.
fn block_score(bits: &[BitStat], start: u8, end: u8) -> f64 {
    let (s, e) = (usize::from(start), usize::from(end));
    let edge = |inside: f64, outside: Option<&BitStat>| match outside {
        None => 1.0,
        Some(o) if inside <= 0.0 => {
            if o.rate == 0.0 {
                1.0
            } else {
                0.0
            }
        }
        Some(o) => (1.0 - o.rate / inside).clamp(0.0, 1.0),
    };
    let b = (edge(bits[s].rate, s.checked_sub(1).map(|j| &bits[j]))
        + edge(bits[e - 1].rate, bits.get(e)))
        / 2.0;
    let rates: Vec<f64> = bits[s..e].iter().map(|b| b.rate).collect();
    let mean = rates.iter().sum::<f64>() / rates.len() as f64;
    let var = rates.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / rates.len() as f64;
    let u = if mean > 0.0 {
        (1.0 - var.sqrt() / mean).clamp(0.0, 1.0)
    } else {
        0.0
    };
    b * u
}

fn classify(
    bits: &[BitStat],
    history: &VecDeque<u64>,
    start: u8,
    len: u8,
    score: f64,
) -> FieldClass {
    if len == 1 {
        return FieldClass::Boolean;
    }
    // Counter: steps by +1 (mod 2^len) between consecutive frames.
    if history.len() >= 2 {
        let modulus = 1u64 << len;
        let steps = history.len() - 1;
        let ones = history
            .iter()
            .zip(history.iter().skip(1))
            .filter(|(a, b)| {
                (field_value(**b, start, len) + modulus - field_value(**a, start, len)) % modulus
                    == 1
            })
            .count();
        if ones as f64 >= 0.95 * steps as f64 {
            return FieldClass::Counter;
        }
    }
    let field = &bits[usize::from(start)..usize::from(start + len)];
    let mean = field.iter().map(|b| b.rate).sum::<f64>() / f64::from(len);
    if len >= 4 && score >= 0.75 && (0.35..=0.65).contains(&mean) {
        return FieldClass::Crc;
    }
    FieldClass::Continuous
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::{
        hal::{virtual_bus::VirtualBus, CanFilter, VehicleBusAdapter},
        sim::profiles::generic_uds,
    };

    #[test]
    fn bit_numbering_and_values() {
        let w = word(&[0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0F]);
        assert!(bit(w, 0) && !bit(w, 1) && bit(w, 63));
        assert_eq!(field_value(w, 60, 4), 0xF);
        assert_eq!(field_value(word(&[0x12, 0x34]), 4, 8), 0x23);
    }

    #[test]
    fn magnitudes_follow_flip_counts() {
        let mut re = CanRe::new();
        for i in 0..101u8 {
            re.observe(&CanFrame::std(0x100, &[i]));
        }
        let a = re.analyze_id(0x100, false).unwrap();
        // LSB (bit 7) flips 100 times: M = log10(100) = 2.
        assert_eq!(a.bits[7].flips, 100);
        assert_eq!(a.bits[7].magnitude, Some(2.0));
        assert_eq!(a.bits[0].magnitude, None);
        assert_eq!(a.field_at(1).unwrap().class, FieldClass::Counter);
    }

    /// Task 1.3 gate: a simulated window-switch toggle log yields the expected
    /// bitfield classes, and baseline-vs-action isolates the switch bit.
    #[tokio::test(start_paused = true)]
    async fn window_switch_toggle_log() {
        let bus = VirtualBus::from_profile_id(generic_uds::ID).unwrap();
        let mut sniffer = bus.adapter();
        sniffer.open(500_000).await.unwrap();
        sniffer
            .set_filter(&[
                CanFilter::exact(0x0C9, false),
                CanFilter::exact(0x3F1, false),
            ])
            .await
            .unwrap();

        let (mut baseline, mut action) = (CanRe::new(), CanRe::new());
        let start = tokio::time::Instant::now();
        let mut t_ms = 0u64;
        // 5 s with the switch released, then 5 s pressing it every 500 ms.
        // RPM wanders like an idling engine the whole time.
        while t_ms < 10_000 {
            let frame = sniffer
                .recv_frame(Duration::from_millis(200))
                .await
                .unwrap();
            t_ms = (tokio::time::Instant::now() - start).as_millis() as u64;
            bus.with_vehicle(|v| {
                v.rpm = 780.0
                    + 60.0 * ((t_ms as f64) / 700.0).sin()
                    + 25.0 * ((t_ms as f64) / 130.0).sin();
                v.window_switch = t_ms >= 5_000 && (t_ms / 500) % 2 == 1;
            });
            if t_ms < 5_000 {
                &mut baseline
            } else {
                &mut action
            }
            .observe(&frame);
        }
        // Body frame 0x3F1: window switch (byte 1 bit 0 = bit 15) is a boolean,
        // byte 3 low nibble (bits 28-31) a counter, everything else static.
        let body = action.analyze_id(0x3F1, false).unwrap();
        assert_eq!(body.field_at(15).unwrap().class, FieldClass::Boolean);
        let counter = body.field_at(28).unwrap();
        assert_eq!(
            (counter.start_bit, counter.len, counter.class),
            (28, 4, FieldClass::Counter)
        );
        for b in [0u8, 8, 14, 16, 24, 27] {
            assert_eq!(
                body.field_at(b).unwrap().class,
                FieldClass::Static,
                "bit {b}"
            );
        }

        // Engine frame 0x0C9: RPM bits are continuous, byte 6 a CRC, byte 7 low nibble a counter.
        let engine = baseline.analyze_id(0x0C9, false).unwrap();
        for f in engine
            .fields
            .iter()
            .filter(|f| f.start_bit < 16 && f.class != FieldClass::Static)
        {
            assert_eq!(f.class, FieldClass::Continuous, "RPM field {f:?}");
        }
        assert!(engine
            .fields
            .iter()
            .any(|f| f.start_bit < 16 && f.class == FieldClass::Continuous));
        let crc = engine.field_at(48).unwrap();
        assert_eq!(
            (crc.start_bit, crc.len, crc.class),
            (48, 8, FieldClass::Crc),
            "{:?}",
            engine.fields
        );
        assert!(crc.block_score > 0.75);
        assert_eq!(engine.field_at(60).unwrap().class, FieldClass::Counter);
        assert_eq!(
            engine.field_at(16).unwrap().class,
            FieldClass::Static,
            "speed stays 0"
        );

        // Baseline vs action: only the window-switch bit is new.
        assert_eq!(
            CanRe::diff(&baseline, &action),
            vec![(0x3F1, false, vec![15])]
        );
    }
}
