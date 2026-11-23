//! Binary event messages for the page and the rate cap.
//!
//! Message: `u32 count`, then `count × { u16 x | p<<15, u16 y, u32 t_us }`, little-endian.

use libreeb::EventBatch;

/// Bytes per encoded event.
pub const EVENT_SIZE: usize = 8;

/// Encode the events where `keep` is true; `t_us` is relative to `t0_us`.
pub fn encode(batch: &EventBatch, keep: &[bool], t0_us: u64) -> Vec<u8> {
    let n = keep.iter().filter(|&&k| k).count();
    let mut m = Vec::with_capacity(4 + n * EVENT_SIZE);
    m.extend_from_slice(&(n as u32).to_le_bytes());
    for i in (0..batch.len()).filter(|&i| keep[i]) {
        let x = batch.x[i] | (u16::from(batch.p[i] != 0) << 15);
        m.extend_from_slice(&x.to_le_bytes());
        m.extend_from_slice(&batch.y[i].to_le_bytes());
        m.extend_from_slice(&(batch.t[i].saturating_sub(t0_us) as u32).to_le_bytes());
    }
    m
}

/// Smoothing time constant of the rate estimate, in sensor seconds.
const RATE_TAU_S: f64 = 0.25;

/// Random thinning to a rate budget (random, not stride, so no spatial pattern).
pub struct Decimator {
    budget: f64,
    rate: f64,
    rng: u64,
    last_t: Option<u64>,
}

impl Decimator {
    pub fn new(budget: f64) -> Self {
        Self { budget, rate: 0.0, rng: 0x9E37_79B9_7F4A_7C15, last_t: None }
    }

    /// Smoothed input rate in events/s.
    pub fn rate(&self) -> f64 {
        self.rate
    }

    /// Update the rate from this batch, then pick which events to keep.
    pub fn mask(&mut self, batch: &EventBatch) -> Vec<bool> {
        let n = batch.len();
        let mut cap_rate = self.rate;
        if let (Some(&first), Some(&last)) = (batch.t.first(), batch.t.last()) {
            let start = self.last_t.unwrap_or(first).min(last);
            let dt = (last - start) as f64 / 1e6;
            if dt > 0.0 {
                let inst = n as f64 / dt;
                let a = if self.last_t.is_none() || self.rate == 0.0 { 1.0 } else { 1.0 - (-dt / RATE_TAU_S).exp() };
                self.rate += a * (inst - self.rate);
                // A flicker burst is capped from its first batch; the smoothed rate lags it.
                cap_rate = self.rate.max(inst);
            }
            self.last_t = Some(last);
        }
        let p = if cap_rate > self.budget { self.budget / cap_rate } else { 1.0 };
        if p >= 1.0 {
            return vec![true; n];
        }
        let threshold = (p * u64::MAX as f64) as u64;
        (0..n).map(|_| self.next_u64() < threshold).collect()
    }

    fn next_u64(&mut self) -> u64 {
        // xorshift64
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng = x;
        x
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `n` events evenly spread over `[t, t + span_us)`.
    fn batch(t: u64, span_us: u64, n: usize) -> EventBatch {
        let mut b = EventBatch::new();
        for i in 0..n {
            b.push((i % 1280) as u16, (i % 720) as u16, t + span_us * i as u64 / n as u64, (i % 2) as u8);
        }
        b
    }

    #[test]
    fn encode_layout_and_polarity_bit() {
        let mut b = EventBatch::new();
        b.push(1279, 719, 1_000_123, 1);
        b.push(3, 4, 1_000_200, 0);
        let m = encode(&b, &[true, true], 1_000_000);
        assert_eq!(u32::from_le_bytes(m[0..4].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes([m[4], m[5]]), 1279 | 0x8000);
        assert_eq!(u16::from_le_bytes([m[6], m[7]]), 719);
        assert_eq!(u32::from_le_bytes(m[8..12].try_into().unwrap()), 123);
        assert_eq!(u16::from_le_bytes([m[12], m[13]]), 3);
        assert_eq!(m.len(), 4 + 2 * 8);
    }

    #[test]
    fn encode_skips_dropped_events() {
        let b = batch(0, 100, 3);
        let m = encode(&b, &[true, false, true], 0);
        assert_eq!(u32::from_le_bytes(m[0..4].try_into().unwrap()), 2);
        assert_eq!(m.len(), 4 + 2 * 8);
    }

    #[test]
    fn decimator_keeps_all_under_budget() {
        let mut d = Decimator::new(2e6);
        // 1 M ev/s in 10 ms batches for 1 s.
        for k in 0..100 {
            let mask = d.mask(&batch(k * 10_000, 10_000, 10_000));
            if k > 10 {
                assert!(mask.iter().all(|&m| m), "batch {k} dropped events, rate {}", d.rate());
            }
        }
    }

    #[test]
    fn decimator_caps_burst() {
        let mut d = Decimator::new(2e6);
        let mut kept = 0usize;
        // 8 M ev/s in 1 ms batches for 1 s, after 0.5 s of warm-up.
        for k in 0..1500u64 {
            let mask = d.mask(&batch(k * 1_000, 1_000, 8_000));
            if k >= 500 {
                kept += mask.iter().filter(|&&m| m).count();
            }
        }
        assert!((1_900_000..=2_100_000).contains(&kept), "kept {kept}");
    }

    #[test]
    fn decimator_caps_burst_onset() {
        let mut d = Decimator::new(2e6);
        for k in 0..1000u64 {
            d.mask(&batch(k * 1_000, 1_000, 100)); // 0.1 M ev/s for 1 s
        }
        // Step to 50 M ev/s; count kept events in the first second after the step.
        let mut kept = 0usize;
        for k in 1000..2000u64 {
            kept += d.mask(&batch(k * 1_000, 1_000, 50_000)).iter().filter(|&&m| m).count();
        }
        assert!(kept <= 2_200_000, "kept {kept} in the first second of a burst");
    }
}
