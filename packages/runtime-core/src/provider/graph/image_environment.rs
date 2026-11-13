//! Exact environment expected from a verified pinned image plus public Compose overrides.
use super::*;

fn refused() -> CandidateError {
    error(
        "graph_config_mismatch",
        "Pinned image or container environment is malformed or differs; values omitted.",
    )
}
fn entries(value: &Value) -> Result<BTreeMap<String, String>, CandidateError> {
    if value.is_null() {
        return Ok(BTreeMap::new());
    }
    let array = value.as_array().ok_or_else(refused)?;
    let mut result = BTreeMap::new();
    for entry in array {
        let (key, value) = entry
            .as_str()
            .and_then(|v| v.split_once('='))
            .ok_or_else(refused)?;
        if key.is_empty()
            || key.contains('\0')
            || value.contains('\0')
            || result.insert(key.into(), value.into()).is_some()
        {
            return Err(refused());
        }
    }
    Ok(result)
}
pub(super) fn compose(
    image: &Value,
    public: &Value,
) -> Result<BTreeMap<String, String>, CandidateError> {
    let mut expected = entries(image)?;
    if !public.is_null() {
        let mut seen = std::collections::BTreeSet::new();
        for entry in public.as_array().ok_or_else(refused)? {
            let entry = entry.as_str().ok_or_else(refused)?;
            let (key, value) = entry
                .split_once('=')
                .map_or((entry, None), |(key, value)| (key, Some(value)));
            if key.is_empty()
                || key.contains('\0')
                || value.is_some_and(|value| value.contains('\0'))
                || !seen.insert(key)
            {
                return Err(refused());
            }
            if let Some(value) = value {
                expected.insert(key.to_owned(), value.to_owned());
            } else {
                expected.remove(key);
            }
        }
    }
    Ok(expected)
}
pub(super) fn verify(
    expected: &BTreeMap<String, String>,
    actual: &Value,
) -> Result<(), CandidateError> {
    if &entries(actual)? != expected {
        return Err(refused());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pinned_defaults_and_public_overrides_match_exactly_independent_of_order() {
        let expected = compose(
            &json!(["PATH=/bin", "MODE=image", "EMPTY=image"]),
            &json!(["MODE=public", "EMPTY=", "LITERAL=a=b"]),
        )
        .unwrap();
        verify(
            &expected,
            &json!(["EMPTY=", "LITERAL=a=b", "PATH=/bin", "MODE=public"]),
        )
        .unwrap();
        for actual in [
            json!(["EMPTY=", "LITERAL=a=b", "PATH=/bin", "MODE=image"]),
            json!(["EMPTY=", "LITERAL=a=b", "MODE=public"]),
            json!([
                "EMPTY=",
                "LITERAL=a=b",
                "PATH=/bin",
                "MODE=public",
                "EXTRA=unexpected"
            ]),
        ] {
            assert!(verify(&expected, &actual).is_err());
        }
        let inherited = compose(&json!(["PATH=/bin"]), &Value::Null).unwrap();
        verify(&inherited, &json!(["PATH=/bin"])).unwrap();
        let image_keys = compose(&json!(["app.mode=dev", "1KEY=image"]), &Value::Null).unwrap();
        verify(&image_keys, &json!(["1KEY=image", "app.mode=dev"])).unwrap();
        verify(&compose(&Value::Null, &Value::Null).unwrap(), &json!([])).unwrap();
    }
    #[test]
    fn malformed_or_duplicate_fields_refuse_without_value_diagnostics() {
        for bad in [
            json!(["KEY=canary", "KEY=second"]),
            json!(["=canary"]),
            json!(["KEY\u{0000}=canary"]),
            json!(["KEY=canary\u{0000}"]),
            json!([17]),
            json!({"KEY":"canary"}),
        ] {
            for result in [compose(&bad, &Value::Null), compose(&Value::Null, &bad)] {
                let failure = result.unwrap_err();
                assert!(!failure.message.contains("canary"));
            }
            assert!(verify(&BTreeMap::new(), &bad).is_err());
        }
        assert!(compose(&json!(["MISSING"]), &Value::Null).is_err());
        assert!(verify(&BTreeMap::new(), &json!(["MISSING"])).is_err());
    }
    #[test]
    fn explicit_bare_names_remove_image_defaults_but_empty_values_remain() {
        let expected = compose(
            &json!(["PATH=/bin", "REMOVE=image-default", "EMPTY=image-default"]),
            &json!(["REMOVE", "EMPTY=", "MISSING"]),
        )
        .unwrap();
        verify(&expected, &json!(["EMPTY=", "PATH=/bin"])).unwrap();
        for actual in [
            json!(["EMPTY=", "PATH=/bin", "REMOVE=image-default"]),
            json!(["EMPTY=", "PATH=/bin", "REMOVE="]),
        ] {
            assert!(verify(&expected, &actual).is_err());
        }
        assert!(compose(&Value::Null, &json!(["REMOVE", "REMOVE=second"])).is_err());
    }
}
