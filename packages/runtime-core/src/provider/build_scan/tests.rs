use super::*;

fn scan_with(
    dockerfile: &str,
    target: Option<&str>,
    args: &[(&str, &str)],
) -> Result<DockerfileScan, CandidateError> {
    let args: BTreeMap<String, String> = args
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    scan(&ScanRequest {
        dockerfile: dockerfile.as_bytes(),
        target,
        args: &args,
    })
}

fn images(dockerfile: &str) -> Vec<String> {
    names(&scan_with(dockerfile, None, &[]).unwrap())
}

fn names(scan: &DockerfileScan) -> Vec<String> {
    scan.images.iter().map(|i| i.context_name.clone()).collect()
}

fn code(dockerfile: &str) -> &'static str {
    scan_with(dockerfile, None, &[]).unwrap_err().code
}

#[test]
fn a_multi_stage_build_reports_base_images_and_not_stages() {
    let dockerfile = "\
ARG RUNTIME_VERSION=24
FROM example/toolchain:1.2 AS build
WORKDIR /src
COPY . .
RUN make

FROM node:${RUNTIME_VERSION}-slim AS runtime
COPY --from=build /src/out /app
COPY --from=busybox:1.37 /bin/busybox /bin/busybox
CMD [\"node\", \"/app/index.js\"]
";
    let scan = scan_with(dockerfile, None, &[]).unwrap();
    assert_eq!(
        names(&scan),
        ["example/toolchain:1.2", "node:24-slim", "busybox:1.37"]
    );
    assert_eq!(scan.target, 1);
    assert!(scan.stages.iter().all(|stage| stage.reachable));
    assert_eq!(scan.images[1].repository(), "library/node");
    assert_eq!(scan.images[1].reference.tag.as_deref(), Some("24-slim"));
}

#[test]
fn literal_build_arguments_override_global_defaults_and_chain() {
    let dockerfile = "\
ARG DISTRO=bookworm
ARG BASE=debian:${DISTRO}
FROM $BASE
";
    assert_eq!(images(dockerfile), ["debian:bookworm"]);
    let scan = scan_with(dockerfile, None, &[("DISTRO", "trixie")]).unwrap();
    assert_eq!(names(&scan), ["debian:trixie"]);
    // An argument overrides the whole default, verbatim.
    let scan = scan_with(dockerfile, None, &[("BASE", "alpine:3.22")]).unwrap();
    assert_eq!(names(&scan), ["alpine:3.22"]);
    // Quoted defaults lose their quotes as the frontend does.
    assert_eq!(
        images("ARG V=\"3.22\"\nARG R='alpine'\nFROM ${R}:$V\n"),
        ["alpine:3.22"]
    );
}

#[test]
fn stage_args_do_not_reach_from_lines() {
    // A stage ARG is not a global ARG, so the second FROM cannot resolve it.
    let dockerfile = "FROM alpine:3.22 AS one\nARG TAG=1\nFROM busybox:$TAG\n";
    assert_eq!(code(dockerfile), "native_build_dockerfile");
    // An undeclared build argument does not become a global ARG.
    assert!(scan_with("FROM busybox:$TAG\n", None, &[("TAG", "1")]).is_err());
}

#[test]
fn platform_arguments_known_for_arm64_resolve_and_uncertain_ones_refuse() {
    assert_eq!(
        images("FROM example/tool:${TARGETOS}-${TARGETARCH}\n"),
        ["example/tool:linux-arm64"]
    );
    assert_eq!(
        code("FROM example/tool:${TARGETVARIANT}\n"),
        "native_build_dockerfile"
    );
    assert_eq!(
        code("ARG SOURCE_DATE_EPOCH=1\nFROM example/tool:$SOURCE_DATE_EPOCH\n"),
        "native_build_dockerfile"
    );
}

#[test]
fn variable_modifiers_quotes_and_unknown_variables_refuse() {
    for dockerfile in [
        "ARG V=1\nFROM alpine:${V:-3}\n",
        "ARG V=1\nFROM alpine:${V:+3}\n",
        "FROM alpine:$UNDECLARED\n",
        "ARG V\nFROM alpine:$V\n",
        "FROM \"alpine\"\n",
        "ARG V=1\nFROM alpine:${V\n",
        "ARG V=${OTHER:-x}\nFROM alpine:$V\n",
    ] {
        assert_eq!(code(dockerfile), "native_build_dockerfile", "{dockerfile}");
    }
    // An unresolvable default is harmless while nothing uses it.
    assert_eq!(
        images("ARG V=${OTHER:-x}\nFROM alpine:3.22\n"),
        ["alpine:3.22"]
    );
}

#[test]
fn copy_from_resolves_stage_names_indexes_and_images() {
    let dockerfile = "\
FROM alpine:3.22 AS Base
FROM busybox:1.37
COPY --from=BASE /a /a
COPY --from=0 /b /b
COPY --from=scratch /c /c
COPY --from=example/assets:7 /d /d
COPY --link --chmod=0644 --from=example/assets:7 /e /e
";
    let scan = scan_with(dockerfile, None, &[]).unwrap();
    assert_eq!(
        names(&scan),
        ["alpine:3.22", "busybox:1.37", "example/assets:7"]
    );
    assert_eq!(scan.stages[0].name.as_deref(), Some("base"));
    for invalid in ["COPY --from=9 /a /a", "COPY --from=-1 /a /a"] {
        assert_eq!(
            code(&format!("FROM alpine:3.22\n{invalid}\n")),
            "native_build_dockerfile"
        );
    }
}

#[test]
fn from_values_are_literal_as_the_frontend_requires() {
    for line in [
        "COPY --from=$IMAGE /a /a",
        "COPY --from=${IMAGE} /a /a",
        "COPY --from=\"$IMAGE\" /a /a",
        "COPY --from=a\\$b /a /a",
        "RUN --mount=type=bind,from=$IMAGE,target=/x true",
    ] {
        let dockerfile = format!("ARG IMAGE=alpine:3.22\nFROM busybox:1.37\n{line}\n");
        assert_eq!(code(&dockerfile), "native_build_dockerfile", "{line}");
    }
}

#[test]
fn run_mounts_resolve_stage_names_and_images_but_not_indexes() {
    let dockerfile = "\
FROM golang:1.25 AS deps
FROM busybox:1.37
RUN --mount=type=cache,target=/cache \\
    --mount=type=bind,from=deps,source=/go,target=/go \\
    --mount=type=bind,FROM=example/data:2,target=/data \\
    --mount=type=bind,from=0,target=/zero \\
    true
";
    assert_eq!(
        images(dockerfile),
        ["golang:1.25", "busybox:1.37", "example/data:2", "0"]
    );
    // Quotes around the whole flag are removed before the mount options are read.
    assert_eq!(
        images("FROM busybox:1.37\nRUN --mount=\"type=bind,from=example/data:2,target=/d\" true\n"),
        ["busybox:1.37", "example/data:2"]
    );
}

#[test]
fn only_stages_reachable_from_the_target_contribute_images() {
    let dockerfile = "\
FROM example/lint:1 AS lint
FROM golang:1.25 AS build
COPY --from=example/proto:3 /p /p
FROM build AS test
RUN go test ./...
FROM gcr.io/distroless/static AS release
COPY --from=build /out /out
";
    let scan = scan_with(dockerfile, Some("TEST"), &[]).unwrap();
    assert_eq!(names(&scan), ["golang:1.25", "example/proto:3"]);
    assert_eq!(scan.target, 2);
    assert_eq!(
        scan.stages.iter().map(|s| s.reachable).collect::<Vec<_>>(),
        [false, true, true, false]
    );
    // The default target is the last stage, whose base is not Docker Hub.
    assert_eq!(
        scan_with(dockerfile, None, &[]).unwrap_err().code,
        "native_build_base_image"
    );
    assert_eq!(
        scan_with(dockerfile, Some("missing"), &[])
            .unwrap_err()
            .code,
        "native_build_dockerfile"
    );
}

#[test]
fn a_later_stage_name_used_by_an_earlier_from_is_an_image_and_refuses_as_ambiguous() {
    // The frontend matches FROM only against earlier stages, so `FROM base` here is the
    // image `library/base`; a pinned context named `base` would replace the stage.
    let dockerfile = "FROM base AS first\nFROM alpine:3.22 AS base\nFROM first\n";
    assert_eq!(code(dockerfile), "native_build_dockerfile");
    assert_eq!(code("FROM node AS node\n"), "native_build_dockerfile");
}

#[test]
fn duplicate_or_invalid_stage_names_refuse() {
    assert_eq!(
        code("FROM alpine:3.22 AS a\nFROM busybox:1.37 AS A\n"),
        "native_build_dockerfile"
    );
    assert_eq!(code("FROM alpine:3.22 AS 1st\n"), "native_build_dockerfile");
    assert_eq!(code("FROM alpine:3.22 AS\n"), "native_build_dockerfile");
}

#[test]
fn onbuild_triggers_of_internal_base_stages_are_scanned() {
    let dockerfile = "\
FROM alpine:3.22 AS template
ONBUILD COPY --from=example/plugin:5 /p /p
ONBUILD RUN --mount=type=bind,from=example/tools:6,target=/t true
FROM template AS child
FROM child
";
    assert_eq!(
        images(dockerfile),
        ["alpine:3.22", "example/plugin:5", "example/tools:6"]
    );
    // A trigger in the target stage itself only affects images built from it.
    assert_eq!(
        images("FROM alpine:3.22\nONBUILD COPY --from=example/plugin:5 /p /p\n"),
        ["alpine:3.22"]
    );
    for trigger in [
        "ONBUILD FROM alpine:3.22",
        "ONBUILD ONBUILD RUN true",
        "ONBUILD BOGUS x",
    ] {
        assert_eq!(
            code(&format!("FROM alpine:3.22\n{trigger}\n")),
            "native_build_dockerfile"
        );
    }
}

#[test]
fn platform_flags_must_name_arm64_or_the_build_platforms() {
    for accepted in [
        "--platform=linux/arm64",
        "--platform=linux/arm64/v8",
        "--platform=$BUILDPLATFORM",
        "--platform=${TARGETPLATFORM}",
    ] {
        assert_eq!(
            images(&format!("FROM {accepted} alpine:3.22\n")),
            ["alpine:3.22"],
            "{accepted}"
        );
    }
    assert_eq!(
        images("ARG ARCH=arm64\nFROM --platform=linux/${ARCH} alpine:3.22\n"),
        ["alpine:3.22"]
    );
    for refused in [
        "--platform=linux/amd64",
        "--platform=${BUILDPLATFORM:-linux/amd64}",
        "--platform=$UNSET",
        "--platform",
    ] {
        assert_eq!(
            code(&format!("FROM {refused} alpine:3.22\n")),
            "native_build_dockerfile",
            "{refused}"
        );
    }
    // An unreachable stage's platform does not matter.
    let dockerfile = "FROM --platform=linux/amd64 alpine:3.22 AS other\nFROM busybox:1.37\n";
    assert_eq!(images(dockerfile), ["busybox:1.37"]);
}

#[test]
fn overridden_platform_arguments_must_resolve_to_arm64() {
    // A global default replaces the frontend's platform value, so the spelling
    // alone no longer selects linux/arm64.
    for dockerfile in [
        "ARG BUILDPLATFORM=linux/amd64\nFROM --platform=$BUILDPLATFORM alpine:3.22\n",
        "ARG TARGETPLATFORM=linux/amd64\nFROM --platform=${TARGETPLATFORM} alpine:3.22\n",
        "ARG P=linux/amd64\nARG BUILDPLATFORM=$P\nFROM --platform=${BUILDPLATFORM} alpine:3.22\n",
        "ARG BUILDPLATFORM=${OTHER:-linux/arm64}\nFROM --platform=$BUILDPLATFORM alpine:3.22\n",
        "ARG TARGETARCH=amd64\nFROM --platform=linux/$TARGETARCH alpine:3.22\n",
    ] {
        assert_eq!(code(dockerfile), "native_build_dockerfile", "{dockerfile}");
    }
    // An override that resolves to linux/arm64 still selects it.
    assert_eq!(
        images("ARG TARGETPLATFORM=linux/arm64\nFROM --platform=$TARGETPLATFORM alpine:3.22\n"),
        ["alpine:3.22"]
    );
    // A bare global ARG keeps the frontend's value.
    assert_eq!(
        images(
            "ARG BUILDPLATFORM\nARG TARGETPLATFORM\nFROM --platform=$BUILDPLATFORM alpine:3.22 AS a\nFROM --platform=${TARGETPLATFORM} a\n"
        ),
        ["alpine:3.22"]
    );
}

#[test]
fn frontend_selection_directives_refuse() {
    for dockerfile in [
        "# syntax=docker/dockerfile:1\nFROM alpine:3.22\n",
        "#SYNTAX = example/frontend\nFROM alpine:3.22\n",
        "#!/usr/bin/env buildctl\n# syntax=example/frontend\nFROM alpine:3.22\n",
        "// syntax=example/frontend\nFROM alpine:3.22\n",
        "# check=error=true\n# syntax=example/frontend\nFROM alpine:3.22\n",
        "{\"syntax\": \"example/frontend\"}",
    ] {
        assert_eq!(code(dockerfile), "native_build_dockerfile", "{dockerfile}");
    }
    // An ordinary comment that mentions syntax later in the file is fine.
    assert_eq!(
        images("FROM alpine:3.22\n# syntax=example/frontend\n"),
        ["alpine:3.22"]
    );
}

#[test]
fn escape_directive_changes_continuations() {
    let dockerfile = "# escape=`\nFROM alpine:3.22 `\n  AS base\nRUN echo C:\\path\nFROM base\n";
    let scan = scan_with(dockerfile, None, &[]).unwrap();
    assert_eq!(names(&scan), ["alpine:3.22"]);
    assert_eq!(scan.stages[0].name.as_deref(), Some("base"));
    assert_eq!(
        code("# escape=x\nFROM alpine:3.22\n"),
        "native_build_dockerfile"
    );
    assert_eq!(
        code("# escape=`\n# escape=\\\nFROM alpine:3.22\n"),
        "native_build_dockerfile"
    );
    // A directive after an instruction or blank line is only a comment.
    assert_eq!(
        images("\n# escape=`\nFROM alpine:3.22 \\\n  AS base\n"),
        ["alpine:3.22"]
    );
}

#[test]
fn continuations_skip_comments_and_blank_lines() {
    let dockerfile = "\
FROM \\
# a comment inside the instruction
\x20\x20\x20
  alpine:3.22 \\
  AS base\r
COPY \\
  --from=example/assets:7 \\
  /a /a
";
    let scan = scan_with(dockerfile, None, &[]).unwrap();
    assert_eq!(names(&scan), ["alpine:3.22", "example/assets:7"]);
    assert_eq!(scan.stages[0].name.as_deref(), Some("base"));
}

#[test]
fn heredoc_bodies_are_not_instructions() {
    let dockerfile = "\
FROM alpine:3.22
RUN <<EOF
FROM example/not-an-instruction:1
COPY --from=example/not-a-copy:1 / /
EOF
RUN <<-'DONE' cat > /x && <<\"MORE\" cat > /y
\tFROM example/still-body:1
\tDONE
FROM example/also-body:2
MORE
COPY <<FILE /etc/config
FROM example/file-body:3
FILE
RUN [\"echo\", \"<<NOT_A_HEREDOC\"]
RUN echo \"<<NOT_EITHER\"
FROM busybox:1.37
COPY --from=0 / /
";
    let scan = scan_with(dockerfile, None, &[]).unwrap();
    assert_eq!(names(&scan), ["alpine:3.22", "busybox:1.37"]);
    assert_eq!(scan.stages.len(), 2);
    assert_eq!(
        code("FROM alpine:3.22\nRUN <<EOF\ntrue\n"),
        "native_build_dockerfile"
    );
    // `<<` inside other instructions is not a heredoc.
    assert_eq!(
        images("FROM alpine:3.22\nLABEL note=\"<<EOF\"\nFROM busybox:1.37\nCOPY --from=0 / /\n"),
        ["alpine:3.22", "busybox:1.37"]
    );
}

#[test]
fn unknown_instructions_flags_and_preamble_refuse() {
    for dockerfile in [
        "FROM alpine:3.22\nBOGUS value\n",
        "RUN true\nFROM alpine:3.22\n",
        "FROM --bogus=1 alpine:3.22\n",
        "FROM alpine:3.22\nCOPY --platform=linux/arm64 --from=busybox:1.37 / /\n",
        "FROM alpine:3.22\nCOPY --from=a --from=b / /\n",
        "FROM alpine:3.22\nCOPY --from / /\n",
        "FROM alpine:3.22\nADD --from=busybox:1.37 / /\n",
        "FROM alpine:3.22\nRUN --bogus true\n",
        "FROM alpine:3.22\nRUN [1, 2]\n",
        "ARG\nFROM alpine:3.22\n",
        "# only a comment\n",
        "",
    ] {
        assert_eq!(
            code(dockerfile),
            "native_build_dockerfile",
            "{dockerfile:?}"
        );
    }
    // Known flags are accepted.
    assert_eq!(
        images(
            "FROM alpine:3.22\nADD --link --checksum=sha256:00 --exclude=*.md https://example.com/a /a\n\
             RUN --network=none --security=sandbox true\n"
        ),
        ["alpine:3.22"]
    );
}

#[test]
fn only_public_docker_hub_references_are_admitted() {
    for reference in [
        "ghcr.io/example/app:1",
        "localhost:5000/app:1",
        "example.com/app",
        "UPPER/case:1",
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "a/b/c:1",
    ] {
        assert_eq!(
            code(&format!("FROM {reference}\n")),
            "native_build_base_image",
            "{reference}"
        );
    }
    assert_eq!(
        code("FROM alpine:3.22\nCOPY --from=ghcr.io/example/app:1 / /\n"),
        "native_build_base_image"
    );
}

#[test]
fn equivalent_spellings_share_one_pin_and_familiar_names_match_the_frontend() {
    let digest = format!("sha256:{}", "a".repeat(64));
    let dockerfile = format!(
        "FROM node AS one\nFROM docker.io/library/node:latest AS two\nFROM index.docker.io/library/node\n\
         FROM alpine@{digest}\nFROM example/app:1@{digest}\nFROM scratch\n"
    );
    let scan = scan_with(&dockerfile, Some("two"), &[]).unwrap();
    assert_eq!(names(&scan), ["node"]);
    let scan = scan_with(
        &format!("FROM node\nFROM docker.io/library/node:latest\nFROM alpine@{digest}\nFROM example/app:1@{digest}\nFROM scratch\n\
                  COPY --from=0 / /\nCOPY --from=1 / /\nCOPY --from=2 / /\nCOPY --from=3 / /\n"),
        None,
        &[],
    )
    .unwrap();
    assert_eq!(
        names(&scan),
        [
            "node".to_string(),
            format!("alpine@{digest}"),
            format!("example/app:1@{digest}")
        ]
    );
    assert_eq!(
        scan.images[0].reference.canonical(),
        "docker.io/library/node:latest"
    );
}

#[test]
fn size_count_and_encoding_bounds_refuse() {
    let large = format!("FROM alpine:3.22\n#{}\n", "x".repeat(MAX_DOCKERFILE_BYTES));
    assert_eq!(code(&large), "native_build_dockerfile");
    let invalid = scan(&ScanRequest {
        dockerfile: b"FROM alpine:3.22\n\xff\n",
        target: None,
        args: &BTreeMap::new(),
    });
    assert_eq!(invalid.unwrap_err().code, "native_build_dockerfile");
    let bom = scan(&ScanRequest {
        dockerfile: b"\xef\xbb\xbfFROM alpine:3.22\n",
        target: None,
        args: &BTreeMap::new(),
    });
    assert_eq!(names(&bom.unwrap()), ["alpine:3.22"]);

    let mut many = String::from("FROM alpine:3.22\n");
    for index in 0..MAX_IMAGE_REFERENCES {
        many.push_str(&format!("COPY --from=example/part:{index} / /\n"));
    }
    assert_eq!(code(&many), "native_build_dockerfile");
    let within: String = many
        .lines()
        .take(MAX_IMAGE_REFERENCES)
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(images(&within).len(), MAX_IMAGE_REFERENCES);

    let stages: String = (0..=MAX_STAGES).map(|_| "FROM alpine:3.22\n").collect();
    assert_eq!(code(&stages), "native_build_dockerfile");
}

#[test]
fn reserved_build_arguments_refuse_before_reading() {
    for name in [
        "BUILDKIT_SYNTAX",
        "BUILDKIT_INLINE_CACHE",
        "TARGETARCH",
        "BUILDPLATFORM",
        "TARGETSTAGE",
    ] {
        let error = scan_with("FROM alpine:3.22\n", None, &[(name, "x")]).unwrap_err();
        assert_eq!(error.code, "native_build_argument", "{name}");
    }
}

#[test]
fn messages_never_echo_dockerfile_text_or_argument_values() {
    let secret = "do-not-echo-7f3a";
    for (dockerfile, args) in [
        (format!("FROM ghcr.io/{secret}/app:1\n"), vec![]),
        (format!("ARG V={secret}\nFROM alpine:${{V:-x}}\n"), vec![]),
        (
            "ARG V\nFROM ghcr.io/$V:1\n".to_string(),
            vec![("V", secret)],
        ),
        (format!("FROM alpine:3.22\n{secret} instruction\n"), vec![]),
        (
            format!("FROM alpine:3.22\nCOPY --from=${secret} / /\n"),
            vec![],
        ),
    ] {
        let error = scan_with(&dockerfile, None, &args).unwrap_err();
        assert!(!error.message.contains(secret), "{}", error.message);
        assert!(!error.message.contains("ghcr"), "{}", error.message);
    }
}
