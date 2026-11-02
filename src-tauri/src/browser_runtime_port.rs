/// Mirrors the shared launcher/browser parser. Invalid values never fall back.
pub(crate) fn parse(value: Option<&str>) -> Result<u16, &'static str> {
    let Some(value) = value else { return Ok(1430) };
    if value.is_empty()
        || value.len() > 5
        || value.starts_with('0')
        || !value.bytes().all(|c| c.is_ascii_digit())
    {
        return Err("Browser bridge port must be a canonical decimal integer from 1 to 65535");
    }
    value
        .parse::<u16>()
        .map_err(|_| "Browser bridge port must be a canonical decimal integer from 1 to 65535")
}
#[cfg(test)]
mod tests {
    #[test]
    fn canonical_port_range() {
        assert_eq!(super::parse(None), Ok(1430));
        for value in ["1", "1430", "1450", "65535"] {
            assert_eq!(
                super::parse(Some(value)),
                value.parse::<u16>().map_err(|_| "invalid")
            );
        }
        for value in [
            "", "0", "01", "+1", " 1430", "1430 ", "65536", "1.0", "1e3", "１２",
        ] {
            assert!(super::parse(Some(value)).is_err(), "{value}");
        }
    }
}
