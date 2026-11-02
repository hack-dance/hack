use super::*;

#[test]
fn host_request_and_reply_codecs_share_the_exact_guest_mode_and_reject_trailing_data() {
    let volume = format!("hkp-{}-{}-db", "a".repeat(64), "b".repeat(32));
    let root = Root {
        device: 0,
        inode: 1,
        uid: 0,
        gid: 0,
    };
    for seed in [false, true] {
        let request = Request::bound(
            &volume,
            seed,
            root,
            &format!("user.hack.storage.{}", "c".repeat(64)),
            &"d".repeat(64),
        )
        .unwrap();
        let bytes = request.encode();
        assert!(Request::parse(&bytes).unwrap().is_seed() == seed);
        let mut extra = bytes.clone();
        extra.extend_from_slice(b"extra\n");
        assert!(Request::parse(&extra).is_err());
    }
    let request = Request::root(&volume).unwrap();
    assert!(matches!(
        Request::parse(&request.encode()).unwrap().operation,
        Operation::Root
    ));
    assert!(
        matches!(Observation::decode(b"root:0:1:0:0\n").unwrap(), Observation::Root(selected) if selected == root)
    );
    for bytes in [
        b"root:0:0:0:0\n".as_slice(),
        b"root:00:1:0:0\n",
        b"root:0:1:0:0\nextra\n",
        b"seeded\nextra",
        b"verified\n\n",
    ] {
        assert!(Observation::decode(bytes).is_err());
    }
}

fn volume() -> String {
    format!("hkp-{}-{}-database", "a".repeat(64), "b".repeat(32))
}
fn root() -> Root {
    Root {
        device: 0,
        inode: 42,
        uid: 501,
        gid: 20,
    }
}
fn request(mode: &str) -> Vec<u8> {
    let volume = volume();
    if mode == "root" {
        return format!("{MAGIC}\nroot\n{volume}\n").into_bytes();
    }
    format!(
        "{MAGIC}\n{mode}\n{volume}\n0\n42\n501\n20\nuser.hack.storage.{}\n{}\n",
        "c".repeat(64),
        "01".repeat(32)
    )
    .into_bytes()
}
#[derive(Default)]
struct Fake {
    calls: Vec<&'static str>,
    fail: Option<&'static str>,
    checks: usize,
    change_at: Option<usize>,
    value: Option<[u8; 32]>,
    wrong_uid: bool,
    change_second_read: bool,
    reads: usize,
}
impl Fake {
    fn call(&mut self, name: &'static str) -> Result<(), CandidateError> {
        self.calls.push(name);
        if self.fail == Some(name) {
            Err(CandidateError::new(
                "private-path-value",
                "private canary /owned/path",
            ))
        } else {
            Ok(())
        }
    }
}
impl Kernel for Fake {
    type Directory = Root;
    fn open(&mut self, _: &str) -> Result<Root, CandidateError> {
        self.call("open")?;
        Ok(root())
    }
    fn check(&mut self, _: &Root) -> Result<Root, CandidateError> {
        self.call("check")?;
        self.checks += 1;
        let mut selected = root();
        if self.change_at == Some(self.checks) {
            selected.inode += 1;
        }
        Ok(selected)
    }
    fn effective_identity(&self) -> (u32, u32) {
        (if self.wrong_uid { 502 } else { 501 }, 20)
    }
    fn create(&mut self, _: &Root, witness: &Witness) -> Result<(), CandidateError> {
        self.call("create")?;
        if self.value.is_some() {
            return Err(refused());
        }
        self.value = Some(witness.value);
        Ok(())
    }
    fn sync(&mut self, _: &Root) -> Result<(), CandidateError> {
        self.call("sync")
    }
    fn read(&mut self, _: &Root, _: &Witness) -> Result<[u8; 32], CandidateError> {
        self.call("read")?;
        self.reads += 1;
        let mut value = self.value.ok_or_else(refused)?;
        if self.change_second_read && self.reads == 2 {
            value[0] ^= 1;
        }
        Ok(value)
    }
    fn close(&mut self, _: Root) -> Result<(), CandidateError> {
        self.call("close")
    }
}
#[test]
fn original_seed_syncs_and_rereads_while_retained_verification_is_read_only() {
    let mut fake = Fake::default();
    assert_eq!(
        run(Request::parse(&request("root")).unwrap(), &mut fake)
            .unwrap()
            .encode(),
        "root:0:42:501:20\n"
    );
    fake.calls.clear();
    assert_eq!(
        run(Request::parse(&request("seed")).unwrap(), &mut fake)
            .unwrap()
            .encode(),
        "seeded\n"
    );
    assert_eq!(
        fake.calls,
        [
            "open", "check", "create", "sync", "check", "read", "check", "check", "read", "check",
            "close"
        ]
    );
    fake.calls.clear();
    assert_eq!(
        run(Request::parse(&request("verify")).unwrap(), &mut fake)
            .unwrap()
            .encode(),
        "verified\n"
    );
    assert!(!fake.calls.contains(&"create"));
    assert!(!fake.calls.contains(&"sync"));
    fake.calls.clear();
    assert!(run(Request::parse(&request("seed")).unwrap(), &mut fake).is_err());
    assert_eq!(fake.value, Some([1; 32]));
}
#[test]
fn missing_changed_second_read_root_drift_and_errors_never_repair_or_escape() {
    for change_at in 1..=5 {
        let mut fake = Fake {
            change_at: Some(change_at),
            value: Some([1; 32]),
            ..Fake::default()
        };
        assert!(run(Request::parse(&request("verify")).unwrap(), &mut fake).is_err());
        assert!(!fake.calls.contains(&"create"));
    }
    for mut fake in [
        Fake::default(),
        Fake {
            value: Some([2; 32]),
            ..Fake::default()
        },
        Fake {
            value: Some([1; 32]),
            change_second_read: true,
            ..Fake::default()
        },
        Fake {
            value: Some([1; 32]),
            wrong_uid: true,
            ..Fake::default()
        },
    ] {
        assert!(run(Request::parse(&request("verify")).unwrap(), &mut fake).is_err());
        assert!(!fake.calls.contains(&"create"));
    }
    for fail in ["open", "check", "create", "sync", "read", "close"] {
        let mut fake = Fake {
            fail: Some(fail),
            ..Fake::default()
        };
        let error = match run(Request::parse(&request("seed")).unwrap(), &mut fake) {
            Err(error) => error,
            Ok(_) => panic!("Fault must refuse"),
        };
        assert_eq!(error.code, "storage_root_witness_refused");
        assert_eq!(
            error.message,
            "Persistent root witness was refused; values omitted."
        );
        assert_eq!(
            fake.calls.iter().filter(|call| **call == "create").count(),
            usize::from(["create", "sync", "read", "close"].contains(&fail))
        );
    }
}
#[test]
fn descriptor_codec_refuses_extra_missing_noncanonical_or_unsafe_requests() {
    assert!(arguments(&["--storage-root-witness".into()]));
    for args in [
        vec![],
        vec!["--storage-root-witness".into(), "seed".into()],
        vec!["--slot".into(), "0".into(), "--storage-root-witness".into()],
        vec!["--storage-root-witness".into(), "--check-release".into()],
        vec!["--storage-root-witness\n".into()],
    ] {
        assert!(!arguments(&args));
    }
    let good = String::from_utf8(request("seed")).unwrap();
    for value in [
        good.replace("hack-storage-root-v1", "hack-storage-root-v2"),
        good.replace("\nseed\n", "\nrepair\n"),
        format!("{good}extra\n"),
        good.trim_end().into(),
        good.replace("\n42\n", "\n0\n"),
        good.replace("\n42\n", "\n042\n"),
        good.replace("\n501\n", "\n4294967296\n"),
        good.replace("user.hack.storage.", "trusted.hack.storage."),
        good.replace(&"01".repeat(32), &"00".repeat(32)),
        good.replace("database", "../database"),
        good.replace("database", "database\0"),
        good.replace("database", "dátabase"),
    ] {
        assert!(Request::parse(value.as_bytes()).is_err());
    }
    assert!(Request::parse(&[b'x'; MAX_REQUEST + 1]).is_err());
    for logical in ["a", "0", "a.b-c_d", &"a".repeat(63)] {
        let input = format!(
            "{MAGIC}\nroot\nhkp-{}-{}-{logical}\n",
            "a".repeat(64),
            "b".repeat(32)
        );
        assert!(Request::parse(input.as_bytes()).is_ok());
    }
    for logical in ["", ".", "..", "A", "a/b", &"a".repeat(64)] {
        assert!(!volume_valid(&format!(
            "hkp-{}-{}-{logical}",
            "a".repeat(64),
            "b".repeat(32)
        )));
    }
}
