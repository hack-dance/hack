//! Inactive Linux root-witness helper contract. A descriptor supplies bytes, not
//! enrollment authority. Only the durable original-create owner may select Seed.
//! Retained reads select Verify and never repair an absent or changed witness.
//! Copying a whole root together with its xattrs is outside this continuity proof.
use crate::CandidateError;
use zeroize::Zeroize;

const MAGIC: &str = "hack-storage-root-v1";
pub(crate) const MAX_REQUEST: usize = 1024;
pub(crate) fn arguments(args: &[std::ffi::OsString]) -> bool {
    args.len() == 1 && args[0] == "--storage-root-witness"
}

fn refused() -> CandidateError {
    CandidateError::new(
        "storage_root_witness_refused",
        "Persistent root witness was refused; values omitted.",
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Root {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) uid: u32,
    pub(crate) gid: u32,
}
impl Root {
    fn valid(&self) -> bool {
        self.inode != 0
    }
}

pub(crate) struct Witness {
    name: [u8; 64],
    value: [u8; 32],
}
impl Drop for Witness {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}
impl Witness {
    fn parse(name: &str, value: &str) -> Result<Self, CandidateError> {
        let suffix = name
            .strip_prefix("user.hack.storage.")
            .ok_or_else(refused)?;
        if !hex(suffix, 64)
            || !hex(value, 64)
            || suffix.bytes().all(|byte| byte == b'0')
            || value.bytes().all(|byte| byte == b'0')
        {
            return Err(refused());
        }
        let mut witness = Self {
            name: [0; 64],
            value: [0; 32],
        };
        witness.name.copy_from_slice(suffix.as_bytes());
        for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
            let digit = |byte: u8| {
                if byte <= b'9' {
                    byte - b'0'
                } else {
                    byte - b'a' + 10
                }
            };
            witness.value[index] = digit(chunk[0]) * 16 + digit(chunk[1]);
        }
        Ok(witness)
    }
}

pub(crate) enum Operation {
    Root,
    Seed { root: Root, witness: Witness },
    Verify { root: Root, witness: Witness },
}
pub(crate) struct Request {
    volume: String,
    operation: Operation,
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn volume_valid(value: &str) -> bool {
    let Some(value) = value.strip_prefix("hkp-") else {
        return false;
    };
    if value.len() < 99 || value.len() > 161 || !value.is_ascii() {
        return false;
    }
    let logical = &value[98..];
    hex(&value[..64], 64)
        && value.as_bytes()[64] == b'-'
        && hex(&value[65..97], 32)
        && value.as_bytes()[97] == b'-'
        && !logical.is_empty()
        && logical.len() <= 63
        && (logical.as_bytes()[0].is_ascii_lowercase() || logical.as_bytes()[0].is_ascii_digit())
        && logical.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
}
fn number(value: &str) -> Result<u64, CandidateError> {
    if value.is_empty()
        || value.len() > 20
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(refused());
    }
    value.parse().map_err(|_| refused())
}
impl Request {
    /// Exact ASCII newline record from a bounded private pipe. Unknown keys,
    /// modes, alternate spelling, argv data and trailing records are refused.
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self, CandidateError> {
        if bytes.len() > MAX_REQUEST || !bytes.is_ascii() {
            return Err(refused());
        }
        let text = std::str::from_utf8(bytes).map_err(|_| refused())?;
        let fields: Vec<_> = text.split('\n').collect();
        if fields.first() != Some(&MAGIC) || fields.last() != Some(&"") {
            return Err(refused());
        }
        let volume = *fields.get(2).ok_or_else(refused)?;
        if !volume_valid(volume) {
            return Err(refused());
        }
        let operation = match fields.get(1).copied() {
            Some("root") if fields.len() == 4 => Operation::Root,
            Some(mode @ ("seed" | "verify")) if fields.len() == 10 => {
                let root = Root {
                    device: number(fields[3])?,
                    inode: number(fields[4])?,
                    uid: number(fields[5])?.try_into().map_err(|_| refused())?,
                    gid: number(fields[6])?.try_into().map_err(|_| refused())?,
                };
                if !root.valid() {
                    return Err(refused());
                }
                let witness = Witness::parse(fields[7], fields[8])?;
                if mode == "seed" {
                    Operation::Seed { root, witness }
                } else {
                    Operation::Verify { root, witness }
                }
            }
            _ => return Err(refused()),
        };
        Ok(Self {
            volume: volume.into(),
            operation,
        })
    }
}
pub(crate) enum Observation {
    Root(Root),
    Seeded,
    Verified,
}
impl Observation {
    /// Observation only. Neither this reply nor a successful helper exit can
    /// promote pending storage or authorize compute use without the owner commit.
    pub(crate) fn encode(&self) -> String {
        match self {
            Self::Root(root) => format!(
                "root:{}:{}:{}:{}\n",
                root.device, root.inode, root.uid, root.gid
            ),
            Self::Seeded => "seeded\n".into(),
            Self::Verified => "verified\n".into(),
        }
    }
}

trait Kernel {
    type Directory;
    fn open(&mut self, volume: &str) -> Result<Self::Directory, CandidateError>;
    fn check(&mut self, held: &Self::Directory) -> Result<Root, CandidateError>;
    fn effective_identity(&self) -> (u32, u32);
    fn create(&mut self, held: &Self::Directory, witness: &Witness) -> Result<(), CandidateError>;
    fn sync(&mut self, held: &Self::Directory) -> Result<(), CandidateError>;
    fn read(
        &mut self,
        held: &Self::Directory,
        witness: &Witness,
    ) -> Result<[u8; 32], CandidateError>;
    fn close(&mut self, held: Self::Directory) -> Result<(), CandidateError>;
}
fn matches(value: &[u8; 32], expected: &[u8; 32]) -> bool {
    value
        .iter()
        .zip(expected)
        .fold(0, |difference, (left, right)| difference | (left ^ right))
        == 0
}
fn run(request: Request, kernel: &mut impl Kernel) -> Result<Observation, CandidateError> {
    fn execute(request: Request, kernel: &mut impl Kernel) -> Result<Observation, CandidateError> {
        let held = kernel.open(&request.volume)?;
        let selected = kernel.check(&held)?;
        if !selected.valid() {
            return Err(refused());
        }
        let seed = matches!(&request.operation, Operation::Seed { .. });
        let outcome = match request.operation {
            Operation::Root => {
                if kernel.check(&held)? != selected {
                    return Err(refused());
                }
                Observation::Root(selected)
            }
            Operation::Seed { root, witness } | Operation::Verify { root, witness } => {
                if selected != root || kernel.effective_identity() != (root.uid, root.gid) {
                    return Err(refused());
                }
                // The mode was already captured before any kernel await/effect.
                // Seed never replaces an xattr; Verify never invokes create.
                if seed {
                    kernel.create(&held, &witness)?;
                    kernel.sync(&held)?;
                }
                for _ in 0..2 {
                    if kernel.check(&held)? != root
                        || !matches(&kernel.read(&held, &witness)?, &witness.value)
                    {
                        return Err(refused());
                    }
                    if kernel.check(&held)? != root {
                        return Err(refused());
                    }
                }
                if seed {
                    Observation::Seeded
                } else {
                    Observation::Verified
                }
            }
        };
        kernel.close(held)?;
        Ok(outcome)
    }
    execute(request, kernel).map_err(|_| refused())
}

#[cfg(target_os = "linux")]
#[path = "storage_root_witness/linux.rs"]
mod linux;
#[cfg(target_os = "linux")]
pub(crate) fn execute(request: Request) -> Result<Observation, CandidateError> {
    run(request, &mut linux::Linux)
}

#[cfg(test)]
#[path = "storage_root_witness/tests.rs"]
mod tests;
