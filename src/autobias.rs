//! Automatic contrast-threshold setting: drive `bias_diff_on` / `bias_diff_off`
//! so each polarity gives a target event rate per ROI pixel.

/// Mean of `counts` after dropping the top `trim` fraction (hot pixels).
pub fn trimmed_mean(counts: &[u32], trim: f32) -> f32 {
    if counts.is_empty() {
        return 0.0;
    }
    let mut v = counts.to_vec();
    v.sort_unstable();
    let keep = ((v.len() as f32) * (1.0 - trim)).ceil().max(1.0) as usize;
    v[..keep].iter().map(|&c| c as f64).sum::<f64>() as f32 / keep as f32
}

/// Next bias offset: a higher threshold offset means fewer events. Steps by
/// `gain` per factor 2 of rate error, at least 1, clamped to `[min, max]`.
/// Returns `None` when within `tol` (relative) of the target.
pub fn next_offset(offset: i32, rate: f32, target: f32, gain: f32, tol: f32, min: i32, max: i32) -> Option<i32> {
    let ratio = rate.max(target * 1e-3) / target;
    if (ratio - 1.0).abs() <= tol {
        return None;
    }
    let step = (gain * ratio.log2()).round() as i32;
    let step = if step == 0 { ratio.log2().signum() as i32 } else { step };
    Some((offset + step).clamp(min, max))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trimmed_mean_ignores_hot() {
        let mut c = vec![10u32; 99];
        c.push(1_000_000);
        assert_eq!(trimmed_mean(&c, 0.01), 10.0);
        assert_eq!(trimmed_mean(&[], 0.01), 0.0);
    }

    #[test]
    fn next_offset_direction_and_clamp() {
        // too many events → raise threshold
        assert_eq!(next_offset(-40, 20.0, 5.0, 8.0, 0.15, -80, 145), Some(-24));
        // too few → lower it, clamped
        assert_eq!(next_offset(-75, 0.0, 5.0, 8.0, 0.15, -80, 145), Some(-80));
        // small error still moves by 1
        assert_eq!(next_offset(0, 5.9, 5.0, 2.0, 0.15, -80, 145), Some(1));
        // within tolerance → done
        assert_eq!(next_offset(0, 5.5, 5.0, 8.0, 0.15, -80, 145), None);
    }
}
