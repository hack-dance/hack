//! Exact environment expected from a verified pinned image plus public Compose overrides.
use super::*;

fn refused() -> CandidateError {
    error(
        "graph_config_mismatch",
        "Pinned image or container environment is malformed or differs; values omitted.",
    )
}
/// In-memory expectation bound to the pinned image and compiled public overrides.
/// Removal names must survive composition: an arbitrary bare inspected name is
/// not evidence that the reviewed configuration requested its removal.
#[derive(Default)]
pub(super) struct Expected {
    values: BTreeMap<String, String>,
    removed: BTreeSet<String>,
}

fn entries(
    value: &Value,
    removed: &BTreeSet<String>,
) -> Result<BTreeMap<String, String>, CandidateError> {
    if value.is_null() {
        return Ok(BTreeMap::new());
    }
    let array = value.as_array().ok_or_else(refused)?;
    let mut result = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for entry in array {
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
            result.insert(key.into(), value.into());
        } else if !removed.contains(key) {
            return Err(refused());
        }
    }
    Ok(result)
}
pub(super) fn compose(image: &Value, public: &Value) -> Result<Expected, CandidateError> {
    // Image defaults must be assignments; only compiled public overrides can
    // authorize bare removal markers in the engine's inspected configuration.
    let mut expected = Expected {
        values: entries(image, &BTreeSet::new())?,
        removed: BTreeSet::new(),
    };
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
                expected.values.insert(key.to_owned(), value.to_owned());
            } else {
                expected.values.remove(key);
                expected.removed.insert(key.to_owned());
            }
        }
    }
    Ok(expected)
}
pub(super) fn verify(expected: &Expected, actual: &Value) -> Result<(), CandidateError> {
    if entries(actual, &expected.removed)? != expected.values {
        return Err(refused());
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn engine_removal_captures() -> Vec<Value> {
    // Docker Engine 29.9.2/API 1.56: public python image defaults and synthetic
    // inputs only. No host paths, owner labels or private process environment.
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/native-bare-env-engine.json"
    ))
    .unwrap();
    assert_eq!(fixture["engineVersion"], "29.9.2");
    assert_eq!(fixture["apiVersion"], "1.56");
    fixture["captures"].as_array().unwrap().clone()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_engine_inspection_preserves_requested_bare_removals_and_other_defaults() {
        for capture in engine_removal_captures() {
            let expected = compose(
                &capture["imageEnvironment"],
                &capture["requestedEnvironment"],
            )
            .unwrap();
            assert_eq!(
                expected.removed,
                BTreeSet::from([capture["removedKey"].as_str().unwrap().to_owned()])
            );
            verify(&expected, &capture["inspectedEnvironment"]).unwrap();
            assert_eq!(
                capture["processObservation"],
                json!({"unset_absent":true,"plain_present":true,"other_defaults_present":true})
            );
            for entry in capture["imageEnvironment"].as_array().unwrap() {
                let (key, value) = entry.as_str().unwrap().split_once('=').unwrap();
                if key != capture["removedKey"].as_str().unwrap() {
                    assert_eq!(expected.values.get(key).map(String::as_str), Some(value));
                }
            }
        }
    }
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
                let failure = result.err().unwrap();
                assert!(!failure.message.contains("canary"));
            }
            assert!(verify(&Expected::default(), &bad).is_err());
        }
        assert!(compose(&json!(["MISSING"]), &Value::Null).is_err());
        assert!(verify(&Expected::default(), &json!(["MISSING"])).is_err());
    }
    #[test]
    fn explicit_bare_names_remove_image_defaults_but_empty_values_remain() {
        let expected = compose(
            &json!(["PATH=/bin", "REMOVE=image-default", "EMPTY=image-default"]),
            &json!(["REMOVE", "EMPTY=", "MISSING"]),
        )
        .unwrap();
        verify(&expected, &json!(["EMPTY=", "PATH=/bin"])).unwrap();
        verify(
            &expected,
            &json!(["EMPTY=", "PATH=/bin", "REMOVE", "MISSING"]),
        )
        .unwrap();
        for actual in [
            json!(["EMPTY=", "PATH=/bin", "REMOVE=image-default"]),
            json!(["EMPTY=", "PATH=/bin", "REMOVE="]),
            json!(["EMPTY=", "PATH=/bin", "UNREQUESTED"]),
            json!(["EMPTY=", "PATH=/bin", "REMOVE", "REMOVE"]),
            json!(["EMPTY=", "PATH=/bin", "REMOVE", "REMOVE=value"]),
        ] {
            assert!(verify(&expected, &actual).is_err());
        }
        assert!(compose(&Value::Null, &json!(["REMOVE", "REMOVE=second"])).is_err());
    }
}
