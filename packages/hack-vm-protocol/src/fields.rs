use super::{Error, Handle, Signal, Stream};

pub fn take<'a>(r: &mut &'a [u8], n: usize) -> Result<&'a [u8], Error> {
    let (value, rest) = r.split_at_checked(n).ok_or(Error::Invalid)?;
    *r = rest;
    Ok(value)
}
pub fn put(w: &mut Vec<u8>, data: &[u8]) -> Result<(), Error> {
    if data.len() > super::MAX_FRAME - w.len() {
        return Err(Error::Size);
    }
    w.extend_from_slice(data);
    Ok(())
}

pub trait Field {
    type Value;
    fn read(r: &mut &[u8]) -> Result<Self::Value, Error>;
    fn write(w: &mut Vec<u8>, value: &Self::Value) -> Result<(), Error>;
}
macro_rules! integer {
    ($codec:ident,$ty:ty) => {
        pub struct $codec;
        impl Field for $codec {
            type Value = $ty;
            fn read(r: &mut &[u8]) -> Result<$ty, Error> {
                Ok(<$ty>::from_be_bytes(
                    take(r, size_of::<$ty>())?
                        .try_into()
                        .map_err(|_| Error::Invalid)?,
                ))
            }
            fn write(w: &mut Vec<u8>, v: &$ty) -> Result<(), Error> {
                put(w, &v.to_be_bytes())
            }
        }
    };
}
integer!(U16, u16);
integer!(I32, i32);
integer!(U32, u32);
integer!(U64, u64);

fn len(r: &mut &[u8], limit: usize) -> Result<usize, Error> {
    let n = U16::read(r)? as usize;
    if n > limit {
        return Err(Error::Size);
    }
    Ok(n)
}
fn write_len(w: &mut Vec<u8>, n: usize, limit: usize) -> Result<(), Error> {
    if n > limit {
        return Err(Error::Size);
    }
    U16::write(w, &(n as u16))
}
fn bytes<'a>(r: &mut &'a [u8], limit: usize) -> Result<&'a [u8], Error> {
    let n = len(r, limit)?;
    take(r, n)
}
fn write_bytes(w: &mut Vec<u8>, v: &[u8], limit: usize) -> Result<(), Error> {
    write_len(w, v.len(), limit)?;
    put(w, v)
}

pub struct Bytes;
impl Field for Bytes {
    type Value = Vec<u8>;
    fn read(r: &mut &[u8]) -> Result<Self::Value, Error> {
        Ok(bytes(r, 32768)?.to_vec())
    }
    fn write(w: &mut Vec<u8>, v: &Self::Value) -> Result<(), Error> {
        write_bytes(w, v, 32768)
    }
}

pub struct Text<const N: usize>;
impl<const N: usize> Field for Text<N> {
    type Value = String;
    fn read(r: &mut &[u8]) -> Result<String, Error> {
        let v = std::str::from_utf8(bytes(r, N)?).map_err(|_| Error::Invalid)?;
        if v.contains('\0') {
            return Err(Error::Invalid);
        }
        Ok(v.to_owned())
    }
    fn write(w: &mut Vec<u8>, v: &String) -> Result<(), Error> {
        if v.contains('\0') {
            return Err(Error::Invalid);
        }
        write_bytes(w, v.as_bytes(), N)
    }
}

macro_rules! checked {
    ($codec:ident,$base:ty,$valid:expr) => {
        pub struct $codec;
        impl Field for $codec {
            type Value = <$base as Field>::Value;
            fn read(r: &mut &[u8]) -> Result<Self::Value, Error> {
                let v = <$base>::read(r)?;
                if !($valid)(&v) {
                    return Err(Error::Invalid);
                }
                Ok(v)
            }
            fn write(w: &mut Vec<u8>, v: &Self::Value) -> Result<(), Error> {
                if !($valid)(v) {
                    return Err(Error::Invalid);
                }
                <$base>::write(w, v)
            }
        }
    };
}
fn hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}
checked!(Uuid, Text<36>, |s: &str| s.len() == 36
    && s.bytes().enumerate().all(|(i, b)| {
        if matches!(i, 8 | 13 | 18 | 23) {
            b == b'-'
        } else {
            hex(b)
        }
    }));
checked!(Id, Text<32>, |s: &str| s.len() == 32 && s.bytes().all(hex));
checked!(Directory, Text<4096>, |s: &str| s.starts_with('/'));
checked!(Name, Text<255>, |s: &str| !s.is_empty() && !s.contains('='));

pub struct Execution;
impl Field for Execution {
    type Value = Handle;
    fn read(r: &mut &[u8]) -> Result<Handle, Error> {
        Ok(Handle {
            boot: Uuid::read(r)?,
            incarnation: Uuid::read(r)?,
            id: Id::read(r)?,
        })
    }
    fn write(w: &mut Vec<u8>, v: &Handle) -> Result<(), Error> {
        Uuid::write(w, &v.boot)?;
        Uuid::write(w, &v.incarnation)?;
        Id::write(w, &v.id)
    }
}

pub struct List<F, const N: usize>(std::marker::PhantomData<F>);
impl<F: Field, const N: usize> Field for List<F, N> {
    type Value = Vec<F::Value>;
    fn read(r: &mut &[u8]) -> Result<Self::Value, Error> {
        (0..len(r, N)?).map(|_| F::read(r)).collect()
    }
    fn write(w: &mut Vec<u8>, v: &Self::Value) -> Result<(), Error> {
        write_len(w, v.len(), N)?;
        for item in v {
            F::write(w, item)?
        }
        Ok(())
    }
}
pub type Inventory = List<Execution, { super::MAX_JOBS as usize }>;
checked!(Arguments, List<Text<4096>, 128>, |v: &Vec<String>| v
    .first()
    .is_some_and(|s| !s.is_empty()));

pub struct EnvPair;
impl Field for EnvPair {
    type Value = (String, String);
    fn read(r: &mut &[u8]) -> Result<Self::Value, Error> {
        Ok((Name::read(r)?, Text::<4096>::read(r)?))
    }
    fn write(w: &mut Vec<u8>, v: &Self::Value) -> Result<(), Error> {
        Name::write(w, &v.0)?;
        Text::<4096>::write(w, &v.1)
    }
}
checked!(Environment,List<EnvPair,128>,|v:&Vec<(String,String)>|v.iter().enumerate().all(|(i,(name,_))|v[..i].iter().all(|(other,_)|other!=name)));

macro_rules! choice {
    ($codec:ident,$value:ty; $($number:literal=>$variant:path),+) => {
        pub struct $codec;
        impl Field for $codec {
            type Value=$value;
            fn read(r:&mut &[u8])->Result<$value,Error>{match take(r,1)?[0] {$($number=>Ok($variant)),+, _=>Err(Error::Invalid)}}
            fn write(w:&mut Vec<u8>,v:&$value)->Result<(),Error>{put(w,&[match *v {$($variant=>$number),+}])}
        }
    }
}
const OFF: bool = false;
const ON: bool = true;
choice!(Flag,bool;0=>OFF,1=>ON);
choice!(SignalCode,Signal;1=>Signal::Interrupt,2=>Signal::Terminate,3=>Signal::Kill);
choice!(StreamCode,Stream;1=>Stream::Stdout,2=>Stream::Stderr);

checked!(ExitCode, I32, |n: &i32| (0..=255).contains(n));
checked!(SignalNumber, I32, |n: &i32| (1..=64).contains(n));
checked!(Jobs, U16, |n: &u16| (1..=super::MAX_JOBS).contains(n));
checked!(FrameSize, U32, |n: &u32| (128..=super::MAX_FRAME as u32)
    .contains(n));

checked!(Retention, U32, |n: &u32| (1..=65536).contains(n));
