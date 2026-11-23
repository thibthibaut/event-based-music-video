//! EVK4 bias offsets and Metavision `.bias` files (`<offset>    % <name>` per line).

use libreeb::biases::BIAS_TABLE;

/// Position of `name` in `BIAS_TABLE`.
pub fn index_of(name: &str) -> Option<usize> {
    BIAS_TABLE.iter().position(|b| b.name == name)
}

/// libreeb's less-noisy starting offset per `BIAS_TABLE` entry.
pub fn defaults() -> Vec<i32> {
    BIAS_TABLE.iter().map(|b| b.default_offset).collect()
}

/// Apply each valid line to `offsets`, clamped to the recommended range.
/// Returns one warning per skipped line; blank lines are ignored.
pub fn parse(text: &str, offsets: &mut [i32]) -> Vec<String> {
    let mut warnings = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Some((value, name)) = line.split_once('%') else {
            warnings.push(format!("skipped bias line {line:?}"));
            continue;
        };
        match (value.trim().parse::<i32>(), index_of(name.trim())) {
            (Ok(v), Some(i)) if i < offsets.len() => {
                offsets[i] = v.clamp(BIAS_TABLE[i].rec_min, BIAS_TABLE[i].rec_max)
            }
            _ => warnings.push(format!("skipped bias line {line:?}")),
        }
    }
    warnings
}

/// One `<offset>    % <name>` line per `BIAS_TABLE` entry.
pub fn write(offsets: &[i32]) -> String {
    BIAS_TABLE.iter().zip(offsets).map(|(b, off)| format!("{off:<5}% {}\n", b.name)).collect()
}

/// `YYYY-MM-DD_HH-MM-SS` in local time, for recording and bias file names.
pub fn timestamp_name(now: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Local>::from(now).format("%Y-%m-%d_%H-%M-%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bias_file_round_trip() {
        let mut o = defaults();
        o[index_of("bias_diff_on").unwrap()] = 12;
        let mut back = defaults();
        assert!(parse(&write(&o), &mut back).is_empty());
        assert_eq!(back, o);
    }

    #[test]
    fn parse_reads_metavision_format() {
        let mut o = vec![0; BIAS_TABLE.len()];
        parse("-5    % bias_fo\n", &mut o);
        assert_eq!(o[index_of("bias_fo").unwrap()], -5);
    }

    #[test]
    fn parse_skips_junk_and_clamps() {
        let mut o = defaults();
        let w = parse("garbage\n3 % bias_nope\n99999 % bias_hpf\n", &mut o);
        assert_eq!(w.len(), 2);
        let i = index_of("bias_hpf").unwrap();
        assert_eq!(o[i], BIAS_TABLE[i].rec_max);
    }

    #[test]
    fn timestamp_name_format() {
        let n = timestamp_name(std::time::SystemTime::now());
        assert_eq!(n.len(), "2026-11-23_14-30-00".len());
        assert_eq!(&n[10..11], "_");
    }
}
