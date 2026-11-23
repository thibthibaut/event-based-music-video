//! Hot pixel selection from per-pixel event counts.

/// Pixels whose count exceeds `factor` × the median of non-zero counts,
/// hottest first, at most `max`. `counts` is row-major with `width` columns.
pub fn hot_pixels(counts: &[u32], width: usize, factor: f32, max: usize) -> Vec<(u32, u32)> {
    let mut active: Vec<u32> = counts.iter().copied().filter(|&c| c > 0).collect();
    if active.is_empty() {
        return vec![];
    }
    active.sort_unstable();
    let thresh = factor * active[active.len() / 2] as f32;
    let mut hot: Vec<(u32, usize)> =
        counts.iter().enumerate().filter(|(_, &c)| c as f32 > thresh).map(|(i, &c)| (c, i)).collect();
    hot.sort_unstable_by(|a, b| b.cmp(a));
    hot.into_iter().take(max).map(|(_, i)| ((i % width) as u32, (i / width) as u32)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hot_pixels_picks_outliers() {
        let w = 10;
        let mut c = vec![5u32; 100];
        c[3] = 0;
        c[12] = 1000; // (2, 1)
        c[57] = 5000; // (7, 5)
        c[99] = 300; // (9, 9)
        assert_eq!(hot_pixels(&c, w, 50.0, 64), vec![(7, 5), (2, 1), (9, 9)]);
        assert_eq!(hot_pixels(&c, w, 50.0, 1), vec![(7, 5)]);
        assert!(hot_pixels(&[0; 4], 2, 50.0, 64).is_empty());
    }
}
