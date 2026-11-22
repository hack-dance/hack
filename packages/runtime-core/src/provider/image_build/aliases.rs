//! Attempt-owned aliases for the classic worker's prefer-local lookup.
use super::*;

pub(super) const DOMAIN: &str = "127.0.0.1:1";
const ATTEMPT: &str = "hack-build-attempt";
const CACHE: &str = "hack-build-cache";

fn parse(reference: &str) -> Option<(&str, &str)> {
    let value = reference.strip_prefix("127.0.0.1:1/hack-build-attempt/")?;
    let (namespace, key) = value.split_once('/')?;
    let (key, nonce) = key.split_once(':')?;
    (hex64(namespace)
        && hex64(key)
        && nonce.len() == 32
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then_some((namespace, key))
}

pub(in crate::provider) fn allowed(reference: &str) -> bool {
    parse(reference).is_some()
}

fn scope(path: &Path) -> Option<(&str, &str)> {
    let scratch = path.parent()?;
    let key = scratch.file_name()?.to_str()?.strip_suffix(".client")?;
    let namespace = scratch.parent()?.file_name()?.to_str()?;
    (hex64(namespace) && hex64(key)).then_some((namespace, key))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Journal {
    incarnation: String,
    engine_id: String,
    aliases: BTreeMap<String, String>,
}

fn tag<P: BuildPool>(
    pool: &P,
    lease: &P::Lease,
    id: &str,
    reference: &str,
) -> Result<(), CandidateError> {
    if let Some(image) = pool.inspect(lease, reference)? {
        if image["Id"] == id {
            return Ok(());
        }
        return Err(refusal(
            "native_build_base_image",
            "A private base alias differs from the verified image.",
        ));
    }
    pool.tag_base(lease, id, reference)?;
    if pool
        .inspect(lease, reference)?
        .is_some_and(|image| image["Id"] == id)
    {
        Ok(())
    } else {
        Err(refusal(
            "native_build_base_image",
            "The worker base alias could not be verified.",
        ))
    }
}

pub(super) struct Aliases<'a, P: BuildPool> {
    pool: &'a P,
    path: PathBuf,
}

impl<'a, P: BuildPool> Aliases<'a, P> {
    pub(super) fn prepare(
        pool: &'a P,
        lease: &P::Lease,
        identity: &PoolIdentity,
        path: PathBuf,
        bases: &BTreeMap<String, BuildBase>,
    ) -> Result<(Self, BTreeMap<String, String>), CandidateError> {
        let (namespace, key) = scope(&path)
            .ok_or_else(|| refusal("native_build_receipt", "The build alias path is invalid."))?;
        let mut journal = Journal {
            incarnation: identity.incarnation.clone(),
            engine_id: identity.engine_id.clone(),
            aliases: BTreeMap::new(),
        };
        let mut contexts = BTreeMap::new();
        for (context, base) in bases {
            let mut nonce = [0u8; 16];
            File::open("/dev/urandom")
                .and_then(|mut file| file.read_exact(&mut nonce))
                .map_err(state::io)?;
            let alias = format!(
                "{DOMAIN}/{ATTEMPT}/{namespace}/{key}:{:x}",
                crate::Hex(nonce)
            );
            if pool.inspect(lease, &alias)?.is_some() {
                return Err(refusal(
                    "native_build_base_image",
                    "An attempt base alias already exists.",
                ));
            }
            let keeper = format!(
                "{DOMAIN}/{CACHE}:{}",
                base.image_id.trim_start_matches("sha256:")
            );
            tag(pool, lease, &base.image_id, &keeper)?;
            journal.aliases.insert(alias.clone(), base.image_id.clone());
            contexts.insert(context.clone(), alias);
        }
        if !journal.aliases.is_empty() {
            state::write(&path, &journal)?;
            // The journal survives an interrupted tag request and precedes every alias.
            for (alias, id) in &journal.aliases {
                if let Err(error) = tag(pool, lease, id, alias) {
                    let _ = sweep(pool, lease, identity, &path);
                    return Err(error);
                }
            }
        }
        Ok((Self { pool, path }, contexts))
    }
}

impl<P: BuildPool> Drop for Aliases<'_, P> {
    fn drop(&mut self) {
        if self.path.exists()
            && let Ok((lease, identity)) = self.pool.lease()
        {
            let _ = sweep(self.pool, &lease, &identity, &self.path);
        }
    }
}

pub(super) fn sweep<P: BuildPool>(
    pool: &P,
    lease: &P::Lease,
    identity: &PoolIdentity,
    path: &Path,
) -> Result<(), CandidateError> {
    crate::reject_aliased_state(path.parent().expect("journal parent"))?;
    let pending = path.with_extension("pending");
    match fs::symlink_metadata(&pending) {
        Ok(metadata)
            if metadata.is_file()
                && metadata.nlink() == 1
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o077 == 0 =>
        {
            fs::remove_file(pending).map_err(state::io)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(state::io(error)),
        Ok(_) => {
            return Err(refusal(
                "native_build_receipt",
                "The pending build alias journal is unsafe.",
            ));
        }
    }
    if !path.try_exists().map_err(state::io)? {
        return Ok(());
    }
    let journal: Journal = state::read_bounded(path, MAX_RECEIPT_BYTES)?;
    if journal.incarnation == identity.incarnation && journal.engine_id == identity.engine_id {
        for (alias, id) in journal.aliases {
            if parse(&alias) != scope(path) || !image_id(&id) {
                return Err(refusal(
                    "native_build_receipt",
                    "The recorded build alias is invalid.",
                ));
            }
            if let Some(image) = pool.inspect(lease, &alias)? {
                let keeper = format!("{DOMAIN}/{CACHE}:{}", id.trim_start_matches("sha256:"));
                if image["Id"] != id
                    || pool
                        .inspect(lease, &keeper)?
                        .is_none_or(|image| image["Id"] != id)
                {
                    return Err(refusal(
                        "native_build_receipt",
                        "The recorded build alias or its cache tag differs.",
                    ));
                }
                pool.untag_base(lease, &alias)?;
            }
        }
    }
    fs::remove_file(path).map_err(state::io)
}

/// Sweep only attempt journals whose key lock is free, including other projects.
pub(super) fn sweep_stranded<P: BuildPool>(
    root: &Path,
    pool: &P,
    lease: &P::Lease,
    identity: &PoolIdentity,
    current: &Path,
) {
    let Ok(namespaces) = fs::read_dir(root) else {
        return;
    };
    for ns in namespaces.filter_map(Result::ok) {
        if !ns.file_name().to_str().is_some_and(hex64)
            || !ns.file_type().is_ok_and(|kind| kind.is_dir())
        {
            continue;
        }
        let directory = ns.path();
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name();
            let Some(key) = name
                .to_str()
                .and_then(|name| name.strip_suffix(".client"))
                .filter(|key| hex64(key))
            else {
                continue;
            };
            let path = entry.path().join("base-aliases.json");
            if path == current
                || !entry.file_type().is_ok_and(|kind| kind.is_dir())
                || (!path.is_file() && !path.with_extension("pending").is_file())
            {
                continue;
            }
            let lock = directory.join(format!("{key}.lock"));
            if let Ok(Some(_held)) =
                Flock::open(&lock).and_then(|lock| Flock::try_lock(lock, libc::LOCK_EX))
            {
                let _ = sweep(pool, lease, identity, &path);
            }
        }
    }
}
