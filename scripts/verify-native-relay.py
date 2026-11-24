#!/usr/bin/env python3
"""Validate the bounded Linux ARM64 ELF dependency relay before bundling it."""
import struct
import sys
from pathlib import Path


def validate_target(data: bytes, architecture: str) -> None:
    if len(data) < 64 or data[:7] != b"\x7fELF\x02\x01\x01" or data[7] not in (0, 3):
        raise ValueError("expected a little-endian ELF64 Linux executable")
    kind, machine, version = struct.unpack_from("<HHI", data, 16)
    if kind not in (2, 3) or machine != {"aarch64": 183, "x86_64": 62}[architecture] or version != 1:
        raise ValueError(f"guest executable must target Linux {architecture}")


def validate(data: bytes, architecture: str = "aarch64") -> None:
    if not 64 <= len(data) <= 2 * 1024 * 1024:
        raise ValueError("guest ELF size exceeds the supported bound")
    validate_target(data, architecture)
    phoff = struct.unpack_from("<Q", data, 32)[0]
    ehsize, phsize, count = struct.unpack_from("<HHH", data, 52)
    if ehsize != 64:
        raise ValueError(f"guest executable must target Linux {architecture}")
    if phsize != 56 or not 1 <= count <= 128 or phoff < 64 or phoff + count * phsize > len(data):
        raise ValueError("relay program headers are invalid")
    executable = False
    for index in range(count):
        kind, flags, offset, _, _, size, memory, _ = struct.unpack_from("<IIQQQQQQ", data, phoff + index * phsize)
        if offset + size > len(data) or (kind == 1 and size > memory):
            raise ValueError("relay program segment is invalid")
        if kind == 3:
            raise ValueError("relay must not require a dynamic interpreter")
        if kind == 1 and flags & 1 and size:
            executable = True
        if kind == 2:
            if not size or size % 16:
                raise ValueError("relay dynamic table is invalid")
            terminated = False
            for cursor in range(offset, offset + size, 16):
                tag, _ = struct.unpack_from("<QQ", data, cursor)
                if tag == 0:
                    terminated = True
                    break
                if tag == 1:
                    raise ValueError("relay must not require shared libraries")
            if not terminated:
                raise ValueError("relay dynamic table is unterminated")
    if not executable:
        raise ValueError("relay lacks an executable load segment")


if __name__ == "__main__":
    architecture = "aarch64"
    if len(sys.argv) == 5 and sys.argv[2] == "--guest-agent" and sys.argv[3] in ("aarch64", "x86_64"):
        label = "agent"
        architecture = sys.argv[3]
    elif len(sys.argv) == 2 or (len(sys.argv) == 3 and sys.argv[2] == "--storage-witness"):
        label = "storage witness" if len(sys.argv) == 3 else "dependency relay"
    else:
        sys.exit("Usage: verify-native-relay.py ELF [--storage-witness | --guest-agent ARCH PROVIDER_ELF]")
    try:
        if label == "agent":
            with Path(sys.argv[4]).open("rb") as provider:
                validate_target(provider.read(64), architecture)
        with Path(sys.argv[1]).open("rb") as source:
            validate(source.read(2 * 1024 * 1024 + 1), architecture)
    except (OSError, ValueError, struct.error) as error:
        sys.exit(f"Invalid native guest {label}: {error}")
    print(f"Verified static Linux {'ARM64' if architecture == 'aarch64' else architecture} {label}")
