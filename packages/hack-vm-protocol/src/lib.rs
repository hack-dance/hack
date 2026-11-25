//! Bounded binary messages for the guest agent and its host runtime client.
//! See the crate README for the v1 field order, units, limits and transitions.
mod fields;
use fields::*;
use std::io::{Read, Write};

/// Maximum payload, excluding the four-byte network-order length.
pub const MAX_FRAME: usize = 65536;
/// Highest implemented command schema.
pub const VERSION: u16 = 1;

/// Choose the highest version implemented by both peers, without assuming
/// that either endpoint has the newest implementation.
pub fn common_version(local: (u16, u16), peer: (u16, u16)) -> Option<u16> {
    let min = local.0.max(peer.0).max(1);
    let max = local.1.min(peer.1);
    (min <= max).then_some(max)
}
/// Select a supported version for the guest handshake.
pub fn negotiate(min: u16, max: u16) -> Option<u16> {
    common_version((1, VERSION), (min, max))
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Fixed error categories that omit peer-controlled data.
pub enum Error {
    /// The exchange deadline elapsed. A submitted effect can still complete.
    Deadline,
    /// The transport refused connection establishment.
    Refused,
    /// The peer closed between frames.
    Closed,
    /// EOF occurred inside a frame.
    Truncated,
    /// Other transport failure.
    Io,
    /// An aggregate or field bound was exceeded.
    Size,
    /// The request belongs to another boot or agent incarnation and was never sent.
    StaleHandle,
    /// The message violates its schema or session identity.
    Invalid,
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind::*;
        match e.kind() {
            TimedOut | WouldBlock => Self::Deadline,
            ConnectionRefused => Self::Refused,
            UnexpectedEof => Self::Truncated,
            _ => Self::Io,
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "guest protocol {self:?}")
    }
}
impl std::error::Error for Error {}
/// Largest complete inventory supported by this wire version.
pub const MAX_JOBS: u16 = 16;
/// END completes one direction of a channel; its peer may still reply.
pub const END: u8 = 1;
/// Channel routing metadata and decoded message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame<T> {
    /// Zero for negotiation, positive for host-assigned command channels.
    pub channel: u32,
    /// Final message in this direction on this channel.
    pub end: bool,
    /// Typed body including its opcode.
    pub message: T,
}

/// Identity of one execution in one guest-agent incarnation.
#[derive(Clone, PartialEq, Eq)]
pub struct Handle {
    /// Lowercase hyphenated Linux boot UUID.
    pub boot: String,
    /// Lowercase hyphenated UUID minted at agent startup.
    pub incarnation: String,
    /// Increasing per-incarnation host counter, 32 lowercase hex digits.
    pub id: String,
}
impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let id = if self.id.len() == 32
            && self
                .id
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            self.id.as_str()
        } else {
            "invalid"
        };
        f.debug_struct("Handle")
            .field("id", &id)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Supported child signals.
pub enum Signal {
    Interrupt,
    Terminate,
    Kill,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Independently retained process output.
pub enum Stream {
    Stdout,
    Stderr,
}

/// Wire implementations are sealed; field limits apply before allocation.
pub trait Message: private::Sealed + Sized {
    #[doc(hidden)]
    fn encode(&self, writer: &mut Vec<u8>, channel: u32, end: bool) -> Result<(), Error>;
    #[doc(hidden)]
    fn decode(reader: &mut &[u8]) -> Result<Frame<Self>, Error>;
}
mod private {
    pub trait Sealed {}
}

// Each field codec defines its Rust type, encoding and validation in both
// directions. Keeping the opcode and ordered fields together prevents drift.
macro_rules! field_doc {
    (min) => {
        "Lowest supported schema version."
    };
    (max) => {
        "Highest supported schema version."
    };
    (capabilities) => {
        "Offered or selected optional feature bits. Unknown offers are ignored."
    };
    (handle) => {
        "Immutable execution identity."
    };
    (argv) => {
        "Program and arguments, including argv[0]."
    };
    (env) => {
        "Explicit environment entries."
    };
    (cwd) => {
        "Absolute guest working directory."
    };
    (stdin) => {
        "Initial standard input bytes."
    };
    (signal) => {
        "Signal to deliver or observed terminating signal."
    };
    (stream) => {
        "Pipe to read."
    };
    (offset) => {
        "Absolute requested byte offset."
    };
    (version) => {
        "Negotiated schema version."
    };
    (max_frame) => {
        "Largest accepted payload in bytes."
    };
    (max_jobs) => {
        "Maximum number of unreleased executions."
    };
    (output_retention) => {
        "Retained bytes per output pipe."
    };
    (boot) => {
        "Linux boot UUID."
    };
    (incarnation) => {
        "Agent incarnation UUID."
    };
    (arch) => {
        "Guest CPU architecture."
    };
    (kernel) => {
        "Guest kernel release."
    };
    (agent_version) => {
        "Guest agent package version."
    };
    (unix_ms) => {
        "Wall clock in Unix milliseconds."
    };
    (code) => {
        "Normal exit code, zero through 255."
    };
    (start_offset) => {
        "Absolute offset of the first returned byte."
    };
    (bytes) => {
        "Binary stream contents."
    };
    (eof) => {
        "True when this chunk reaches a closed pipe end."
    };
    (truncated) => {
        "True when some stream history has been discarded."
    };
    (handles) => {
        "Complete current inventory of unreleased handles."
    };
}
macro_rules! messages {
    ($name:ident, $family:literal; $( $(#[$doc:meta])* $tag:literal => $variant:ident { $( $field:ident : $codec:ty ),* } ),+ $(,)?) => {
        #[derive(Clone,PartialEq,Eq)]
        #[doc=concat!(stringify!($name), " messages in the guest protocol.")]
        pub enum $name { $( $(#[$doc])* $variant { $( #[doc=field_doc!($field)] $field: <$codec as Field>::Value ),* } ),+ }
        impl std::fmt::Debug for $name {
            fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
                f.write_str(match self { $(Self::$variant {..} => stringify!($variant)),+ })
            }
        }
        impl private::Sealed for $name {}
        impl Message for $name {
            fn encode(&self,w:&mut Vec<u8>,channel:u32,end:bool)->Result<(),Error>{
                match self {$(Self::$variant { $($field),* } => {
                    put(w,&[$family,$tag,u8::from(end)])?; put(w,&channel.to_be_bytes())?;
                    $(<$codec>::write(w,$field)?;)*
                }),+} Ok(())
            }
            fn decode(r:&mut &[u8])->Result<Frame<Self>,Error>{
                if take(r,1)? != [$family] {return Err(Error::Invalid)}
                let opcode=take(r,1)?[0]; let end=Flag::read(r)?; let channel=U32::read(r)?;
                let message=match opcode { $($tag => Self::$variant { $($field:<$codec>::read(r)?),* }),+, _=>return Err(Error::Invalid) }; Ok(Frame{channel,end,message})
            }
        }
    }
}
messages!(Request,1;
    /// Offer an inclusive range of supported schema versions.
    1=>Hello{min:U16,max:U16,capabilities:U64},
    /// Read guest identity and operating-system facts.
    2=>Facts{},
    /// Reserve a handle and launch argv in cwd with explicit env and initial stdin.
    3=>Start{handle:Execution,argv:Arguments,env:Environment,cwd:Directory,stdin:Bytes},
    /// Read the retained process outcome.
    4=>Inspect{handle:Execution},
    /// Deliver a signal to the owned child.
    5=>Signal{handle:Execution,signal:SignalCode},
    /// Read one stream starting at a byte offset.
    6=>Output{handle:Execution,stream:StreamCode,offset:U64},
    /// Discard a recorded result and retire the ID under the incarnation watermark.
    7=>Release{handle:Execution},
    /// List all unreleased handles owned by this agent.
    8=>List{}
);
messages!(Response,2;
    /// Selected version and identities for this connection.
    1=>Welcome{version:U16,capabilities:U64,max_frame:FrameSize,max_jobs:Jobs,output_retention:Retention,boot:Uuid,incarnation:Uuid},
    /// Architecture, kernel release, agent package version, UTC milliseconds and identities.
    2=>Facts{arch:Text<64>,kernel:Text<256>,agent_version:Text<64>,unix_ms:U64,boot:Uuid,incarnation:Uuid},
    /// No record in the current incarnation at the moment of inspection.
    3=>Absent{},
    /// An owned process has no observed terminal result yet.
    4=>Running{},
    /// The reserved command failed to spawn.
    5=>SpawnFailed{},
    /// The result has been released; the ID cannot start another command.
    6=>Released{},
    /// Process terminated with its normal exit code.
    7=>Exited{code:ExitCode},
    /// Process terminated by a Linux signal number.
    8=>Signaled{signal:SignalNumber},
    /// Retained bytes at requested offset, end-of-pipe indicator and loss indicator.
    9=>Output{start_offset:U64,bytes:Bytes,eof:Flag,truncated:Flag},
    /// The requested effect was accepted.
    10=>Ack{},
    /// The execution belongs to another incarnation or its outcome is uncertain.
    11=>Unknown{},
    /// State or ID conflicts with the request.
    12=>Conflict{},
    /// Agent capacity exhausted.
    13=>Full{},
    /// Invalid request or incompatible handshake.
    14=>Invalid{},
    /// Current unreleased handles, suitable for reconnect reconciliation.
    15=>Handles{handles:Inventory}
);

/// Read one complete frame, distinguishing stream EOF from a truncated message.
pub fn read_frame<T: Message>(mut stream: impl Read) -> Result<Frame<T>, Error> {
    let mut prefix = [0; 4];
    loop {
        match stream.read(&mut prefix[..1]) {
            Ok(0) => return Err(Error::Closed),
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        }
    }
    stream.read_exact(&mut prefix[1..])?;
    let n = u32::from_be_bytes(prefix) as usize;
    if !(7..=MAX_FRAME).contains(&n) {
        return Err(Error::Size);
    }
    let mut buf = vec![0; n];
    stream.read_exact(&mut buf)?;
    let mut rest = &buf[..];
    let value = T::decode(&mut rest)?;
    if !rest.is_empty() {
        return Err(Error::Invalid);
    }
    Ok(value)
}
/// Validate and write a routed frame. Invalid input never produces a partial frame.
pub fn write_frame<T: Message>(
    stream: impl Write,
    channel: u32,
    end: bool,
    value: &T,
) -> Result<(), Error> {
    write_frame_limited(stream, channel, end, value, MAX_FRAME)
}

/// Apply the peer's negotiated aggregate limit before writing to the socket.
pub fn write_frame_limited<T: Message>(
    mut stream: impl Write,
    channel: u32,
    end: bool,
    value: &T,
    limit: usize,
) -> Result<(), Error> {
    let mut buf = Vec::new();
    value.encode(&mut buf, channel, end)?;
    if buf.len() > limit {
        return Err(Error::Size);
    }
    stream.write_all(&(buf.len() as u32).to_be_bytes())?;
    stream.write_all(&buf)?;
    Ok(())
}

#[cfg(unix)]
pub mod client;
