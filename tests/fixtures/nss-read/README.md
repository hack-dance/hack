# NSS read metadata evidence

`upstream-internal.pkcs11.json` encodes the text-only internal-module fixture from
Mozilla NSS at commit `8c60e757c30b1b239bae46532b4f6d4ebb1e1cad`
(the tree identifies itself as NSS 3.134 Beta). Only its public synthetic database
path was replaced with `@DATABASE_DIR@`. Trailing spaces and the final blank line
are intentional and preserved by JSON string escapes. There are no database bytes, libraries or real profiles here.

Source: [tests/dbtests/bigdb/pkcs11.txt](https://github.com/mozilla/nss/blob/8c60e757c30b1b239bae46532b4f6d4ebb1e1cad/tests/dbtests/bigdb/pkcs11.txt).
The fixture remains under the upstream [MPL 2.0](https://www.mozilla.org/MPL/2.0/).

The admission templates also follow these pinned producer contracts:

- [utilmod.c](https://github.com/mozilla/nss/blob/8c60e757c30b1b239bae46532b4f6d4ebb1e1cad/lib/util/utilmod.c#L815):
  `nssutil_AddSecmodDBEntry` writes one field per line and an extra record newline.
- [utilpars.c](https://github.com/mozilla/nss/blob/8c60e757c30b1b239bae46532b4f6d4ebb1e1cad/lib/util/utilpars.c#L1140):
  `NSSUTIL_MkNSSString` emits the serialized slotParams layout in the golden file.
  `_NSSUTIL_EvaluateConfigDir` and `_NSSUTIL_GetSecmodName` select the SQL and module
  database paths. Admission pins explicit `sql:` and refuses every alternate
  selector, legacy file and sidecar.
- [secmodt.h](https://github.com/mozilla/nss/blob/8c60e757c30b1b239bae46532b4f6d4ebb1e1cad/lib/pk11wrap/secmodt.h#L287):
  `SECMOD_INT_FLAGS` supplies the alternate default internal-module layout.
- [sftkpars.c](https://github.com/mozilla/nss/blob/8c60e757c30b1b239bae46532b4f6d4ebb1e1cad/lib/softoken/sftkpars.c#L34):
  `optimizeSpace` is a storage flag; the read guard admits it or empty flags.
  Update directory/prefix/identity selectors remain empty or absent.

Tests load the golden bytes independently of the production template constants,
substitute only a temporary database path, and use injected queries. Variants test
`optimizeSpace`, whitespace, and the source-defined default internal layout.
No NSS tool was run to generate these files. This source/fixture evidence does
not qualify every distribution, browser packaging, custom module or NSS version;
unrecognized metadata remains Unknown. Do not broaden admission from an arbitrary
profile or by invoking NSS to discover its libraries.
