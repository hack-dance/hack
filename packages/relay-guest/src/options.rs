#[derive(Debug, PartialEq, Eq)]
pub enum Mode {
    Application(i32),
    Listener {
        address: std::net::Ipv4Addr,
        port: u16,
    },
}
#[derive(Debug, PartialEq, Eq)]
pub struct Options {
    pub slot: u8,
    pub mode: Mode,
}
fn number(value: &str) -> Option<u32> {
    let parsed = value.parse::<u32>().ok()?;
    (parsed.to_string() == value).then_some(parsed)
}
pub fn options(args: &[String]) -> Option<Options> {
    let (base, address) = match args {
        [_, _, _, _] => (args, std::net::Ipv4Addr::LOCALHOST),
        [_, _, flag, _, address_flag, address]
            if flag == "--listen-port" && address_flag == "--listen-address" =>
        {
            let parsed = address.parse::<std::net::Ipv4Addr>().ok()?;
            if parsed.to_string() != *address {
                return None;
            }
            (&args[..4], parsed)
        }
        _ => return None,
    };
    let [slot_flag, slot, mode_flag, value] = base else {
        return None;
    };
    if slot_flag != "--slot" {
        return None;
    }
    let slot = number(slot)?;
    if slot > 31 || !valid_address(slot as u8, address) {
        return None;
    }
    let value = number(value)?;
    let mode = match mode_flag.as_str() {
        "--application-fd" if (3..=i32::MAX as u32).contains(&value) => {
            Mode::Application(value as i32)
        }
        "--listen-port" if (1..=u16::MAX as u32).contains(&value) => Mode::Listener {
            address,
            port: value as u16,
        },
        _ => return None,
    };
    Some(Options {
        slot: slot as u8,
        mode,
    })
}
pub fn valid_address(slot: u8, address: std::net::Ipv4Addr) -> bool {
    slot < 32
        && (address == std::net::Ipv4Addr::LOCALHOST
            || address == std::net::Ipv4Addr::new(127, 0, 0, slot + 2))
}
