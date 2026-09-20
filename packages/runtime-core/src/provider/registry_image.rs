//! Anonymous, digest-pinned Docker Hub acquisition. No daemon, credential store or VM effects.
use super::image_load;
use crate::CandidateError;
use reqwest::{Url, blocking::Client, header::ACCEPT, redirect::Policy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const MAX_ARCHIVE: usize = 256 * 1024 * 1024;
const MAX_METADATA: usize = 1024 * 1024;
const ACCEPT_MANIFEST: &str = "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json";
fn error(message: &str) -> CandidateError {
    CandidateError::new("registry_image", message)
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn reference(value: &str) -> Result<(&str, &str), CandidateError> {
    let value = value.strip_prefix("docker.io/").unwrap_or(value);
    let (name, hash) = value
        .split_once('@')
        .ok_or_else(|| error("A public Docker Hub reference pinned with @sha256 is required."))?;
    let repo = name.split_once(':').map_or(name, |(repo, _)| repo);
    if !valid_digest(hash)
        || repo.len() > 200
        || repo.split('/').count() != 2
        || repo.split('/').any(|s| {
            s.is_empty()
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
        })
    {
        return Err(error(
            "Only namespace/repository@sha256 Docker Hub references are supported.",
        ));
    }
    Ok((repo, hash))
}
#[derive(Clone, Deserialize)]
struct Descriptor {
    digest: String,
    size: u64,
    #[serde(rename = "mediaType")]
    media_type: String,
    platform: Option<Platform>,
}
#[derive(Clone, Deserialize)]
struct Platform {
    os: String,
    architecture: String,
    variant: Option<String>,
}
#[derive(Deserialize)]
struct Manifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    #[serde(default)]
    manifests: Vec<Descriptor>,
    config: Option<Descriptor>,
    #[serde(default)]
    layers: Vec<Descriptor>,
}
fn parse_manifest(bytes: &[u8], expected: &str) -> Result<Manifest, CandidateError> {
    if bytes.len() > MAX_METADATA || digest(bytes) != expected {
        return Err(error("Registry manifest digest or size mismatch."));
    }
    let m: Manifest =
        serde_json::from_slice(bytes).map_err(|_| error("Invalid registry manifest."))?;
    if m.schema_version != 2 {
        return Err(error("Unsupported registry manifest schema."));
    }
    Ok(m)
}
fn arm64(m: &Manifest) -> Result<&Descriptor, CandidateError> {
    let mut selected = m.manifests.iter().filter(|d| {
        d.platform.as_ref().is_some_and(|p| {
            p.os == "linux"
                && p.architecture == "arm64"
                && p.variant.as_deref().is_none_or(|v| v == "v8")
        })
    });
    let first = selected
        .next()
        .ok_or_else(|| error("Pinned index has no Linux ARM64 image."))?;
    if selected.next().is_some() {
        return Err(error("Pinned index has ambiguous Linux ARM64 images."));
    }
    Ok(first)
}
fn bounded(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, CandidateError> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("Registry transfer failed or timed out."))?;
    if bytes.len() > limit {
        return Err(error("Registry response exceeds its byte limit."));
    }
    Ok(bytes)
}
fn redirect_allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|h| {
            h == "registry-1.docker.io"
                || h == "production.cloudflare.docker.com"
                || h == "production.cloudfront.docker.com"
                || h.ends_with(".r2.cloudflarestorage.com")
        })
}
struct Fetch {
    client: Client,
    token: Zeroizing<String>,
    deadline: Instant,
}
impl Fetch {
    fn bytes(
        &self,
        mut url: Url,
        limit: usize,
        authenticated: bool,
    ) -> Result<Vec<u8>, CandidateError> {
        for hop in 0..=4 {
            let remaining = self
                .deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| error("Registry acquisition deadline exceeded."))?;
            let mut request = self
                .client
                .get(url.clone())
                .timeout(remaining.min(Duration::from_secs(60)))
                .header(ACCEPT, ACCEPT_MANIFEST);
            // Never forward even anonymous bearer credentials to a blob CDN.
            if authenticated && url.host_str() == Some("registry-1.docker.io") {
                request = request.bearer_auth(self.token.as_str());
            }
            let response = request
                .send()
                .map_err(|_| error("Registry HTTPS request failed."))?;
            if response.status().is_redirection() {
                if hop == 4 {
                    return Err(error("Registry redirect limit exceeded."));
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| error("Invalid registry redirect."))?;
                let next = url
                    .join(location)
                    .map_err(|_| error("Invalid registry redirect."))?;
                if !redirect_allowed(&next) {
                    return Err(error("Registry redirect destination is not supported."));
                }
                url = next;
                continue;
            }
            if !response.status().is_success() {
                return Err(error(
                    "Public registry request was refused; no local credentials were used.",
                ));
            }
            if response.content_length().is_some_and(|n| n > limit as u64) {
                return Err(error("Registry response exceeds its byte limit."));
            }
            return bounded(response, limit);
        }
        Err(error("Registry redirect limit exceeded."))
    }
    fn object(
        &self,
        repo: &str,
        kind: &str,
        d: &Descriptor,
        limit: usize,
    ) -> Result<Vec<u8>, CandidateError> {
        if !valid_digest(&d.digest) || d.size == 0 || d.size > limit as u64 {
            return Err(error(
                "Registry descriptor exceeds its identity or size limits.",
            ));
        }
        let url = Url::parse(&format!(
            "https://registry-1.docker.io/v2/{repo}/{kind}/{}",
            d.digest
        ))
        .map_err(|_| error("Invalid registry object address."))?;
        let bytes = self.bytes(url, d.size as usize, true)?;
        verify_object(d, &bytes)?;
        Ok(bytes)
    }
}
fn verify_object(descriptor: &Descriptor, bytes: &[u8]) -> Result<(), CandidateError> {
    if bytes.len() as u64 != descriptor.size || digest(bytes) != descriptor.digest {
        return Err(error("Registry object digest or size mismatch."));
    }
    Ok(())
}

fn append(
    builder: &mut tar::Builder<Vec<u8>>,
    name: &str,
    bytes: &[u8],
) -> Result<(), CandidateError> {
    let mut h = tar::Header::new_gnu();
    h.set_size(bytes.len() as u64);
    h.set_mode(0o600);
    h.set_cksum();
    builder
        .append_data(&mut h, name, bytes)
        .map_err(|_| error("Cannot assemble image archive."))?;
    if builder.get_ref().len() > MAX_ARCHIVE {
        return Err(error("Image archive exceeds 256 MiB."));
    }
    Ok(())
}
#[derive(Debug, Serialize)]
pub struct AcquiredImage {
    pub source_digest: String,
    pub manifest_digest: String,
    pub image_id: String,
    pub archive_sha256: String,
    pub archive_bytes: u64,
}
/// Acquire one public pinned Linux ARM64 image into a new explicit archive. The output
/// must not exist. A failure never imports an image or changes candidate runtime state.
/// HTTPS requests have a 60s bound and the complete acquisition a 300s deadline.
/// SIGINT/process cancellation stops acquisition; no child transfer outlives the caller.
pub fn acquire(reference_text: &str, output: &Path) -> Result<AcquiredImage, CandidateError> {
    let (repo, pin) = reference(reference_text)?;
    if output.exists() {
        return Err(error("Image archive output already exists."));
    }
    let mut fetch = Fetch {
        client: Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| error("Cannot initialize registry TLS client."))?,
        token: Zeroizing::new(String::new()),
        deadline: Instant::now() + Duration::from_secs(300),
    };
    let mut token_url =
        Url::parse("https://auth.docker.io/token").map_err(|_| error("Invalid token endpoint."))?;
    token_url
        .query_pairs_mut()
        .append_pair("service", "registry.docker.io")
        .append_pair("scope", &format!("repository:{repo}:pull"));
    #[derive(Deserialize)]
    struct Token {
        token: String,
    }
    let token_bytes = Zeroizing::new(fetch.bytes(token_url, 64 * 1024, false)?);
    let token: Token = serde_json::from_slice(&token_bytes)
        .map_err(|_| error("Invalid anonymous registry token response."))?;
    if token.token.len() > 32 * 1024 || token.token.bytes().any(|b| b.is_ascii_control()) {
        return Err(error("Invalid anonymous registry token."));
    }
    fetch.token = Zeroizing::new(token.token);
    let url = Url::parse(&format!(
        "https://registry-1.docker.io/v2/{repo}/manifests/{pin}"
    ))
    .map_err(|_| error("Invalid manifest address."))?;
    let initial = fetch.bytes(url, MAX_METADATA, true)?;
    let mut manifest = parse_manifest(&initial, pin)?;
    let mut manifest_digest = pin.to_owned();
    if !manifest.manifests.is_empty() {
        let selected = arm64(&manifest)?;
        manifest_digest = selected.digest.clone();
        let bytes = fetch.object(repo, "manifests", selected, MAX_METADATA)?;
        manifest = parse_manifest(&bytes, &manifest_digest)?;
    }
    if !manifest.manifests.is_empty() || manifest.layers.is_empty() || manifest.layers.len() > 128 {
        return Err(error("Only a bounded single-image manifest is supported."));
    }
    let config = manifest
        .config
        .ok_or_else(|| error("Image config descriptor is missing."))?;
    let config_bytes = fetch.object(repo, "blobs", &config, MAX_METADATA)?;
    let mut builder = tar::Builder::new(Vec::new());
    let config_name = format!("{}.json", config.digest.trim_start_matches("sha256:"));
    append(&mut builder, &config_name, &config_bytes)?;
    let mut names = Vec::new();
    for (i, layer) in manifest.layers.iter().enumerate() {
        if !matches!(
            layer.media_type.as_str(),
            "application/vnd.oci.image.layer.v1.tar+gzip"
                | "application/vnd.docker.image.rootfs.diff.tar.gzip"
        ) {
            return Err(error("Only distributable gzip image layers are supported."));
        }
        let remaining = MAX_ARCHIVE
            .saturating_sub(builder.get_ref().len())
            .saturating_sub(4096);
        let bytes = fetch.object(repo, "blobs", layer, remaining)?;
        let name = format!("layer-{i}.tar.gz");
        append(&mut builder, &name, &bytes)?;
        names.push(name);
    }
    let manifest_bytes = serde_json::to_vec(
        &serde_json::json!([{"Config":config_name,"Layers":names,"RepoTags":[]}]),
    )
    .map_err(|_| error("Cannot encode image archive metadata."))?;
    append(&mut builder, "manifest.json", &manifest_bytes)?;
    let bytes = builder
        .into_inner()
        .map_err(|_| error("Cannot finish image archive."))?;
    image_load::validate_download(&bytes, &config.digest)?;
    if Instant::now() >= fetch.deadline {
        return Err(error("Registry acquisition deadline exceeded."));
    }
    let result = AcquiredImage {
        source_digest: pin.into(),
        manifest_digest,
        image_id: config.digest,
        archive_sha256: format!("{:x}", Sha256::digest(&bytes)),
        archive_bytes: bytes.len() as u64,
    };
    publish(output, |file| file.write_all(&bytes))?;
    Ok(result)
}

/// A complete synced inode is linked into place without replacing a competing output.
fn publish(
    output: &Path,
    write: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> Result<(), CandidateError> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = parent.join(format!(
        ".hack-image-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)
        .map_err(|_| error("Cannot exclusively create the temporary image archive."))?;
    let result = (|| {
        write(&mut file)
            .and_then(|_| file.sync_all())
            .map_err(|_| error("Image archive write failed before publication."))?;
        fs::hard_link(&temporary, output).map_err(|_| {
            error("Cannot publish the image archive without replacing an existing output.")
        })?;
        fs::remove_file(&temporary).map_err(|_| {
            error("Complete image archive published; temporary link cleanup failed.")
        })?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| error("Complete image archive published; directory sync failed."))?;
        Ok(())
    })();
    // Only the exclusive temporary path created by this call is ever removed.
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publication_preserves_existing_output_and_failed_writes_leave_no_final_file() {
        static NEXT_TEST: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "hack-image-publish-{}-{}",
            std::process::id(),
            NEXT_TEST.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let output = root.join("image.tar");
        fs::write(&output, b"existing").unwrap();
        assert!(publish(&output, |file| file.write_all(b"replacement")).is_err());
        assert_eq!(fs::read(&output).unwrap(), b"existing");
        fs::remove_file(&output).unwrap();
        assert!(
            publish(&output, |file| {
                file.write_all(b"partial")?;
                Err(std::io::Error::other("injected write failure"))
            })
            .is_err()
        );
        assert!(!output.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        publish(&output, |file| file.write_all(b"complete")).unwrap();
        assert_eq!(fs::read(&output).unwrap(), b"complete");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn only_public_digest_pinned_repository_references_are_accepted() {
        let pin = format!("sha256:{}", "a".repeat(64));
        for prefix in [
            "imbios/bun-node",
            "imbios/bun-node:1.3.14-24-alpine",
            "docker.io/imbios/bun-node",
        ] {
            assert_eq!(
                reference(&format!("{prefix}@{pin}")).unwrap(),
                ("imbios/bun-node", pin.as_str())
            );
        }
        for value in [
            "imbios/bun-node:latest",
            "https://docker.io/a/b",
            "user:secret@docker.io/a/b",
            "example.com/a/b@sha256:bad",
            "../bad@sha256:bad",
        ] {
            assert!(reference(value).is_err());
        }
    }
    #[test]
    fn redirects_cannot_downgrade_or_reach_unrelated_or_local_origins() {
        for url in [
            "https://registry-1.docker.io/v2/",
            "https://production.cloudflare.docker.com/blob?opaque=private",
            "https://docker-images-prod.abc.r2.cloudflarestorage.com/blob",
        ] {
            assert!(redirect_allowed(&Url::parse(url).unwrap()));
        }
        for url in [
            "http://production.cloudflare.docker.com/blob",
            "https://127.0.0.1/blob",
            "https://registry-1.docker.io:444/blob",
            "https://registry-1.docker.io.evil.test/blob",
            "https://user:secret@registry-1.docker.io/blob",
        ] {
            assert!(!redirect_allowed(&Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn manifests_bind_exact_bytes_and_select_one_arm64_variant() {
        let descriptor = serde_json::json!({"mediaType":"application/vnd.oci.image.manifest.v1+json","size":12,"digest":format!("sha256:{}","a".repeat(64)),"platform":{"os":"linux","architecture":"arm64","variant":"v8"}});
        let bytes =
            serde_json::to_vec(&serde_json::json!({"schemaVersion":2,"manifests":[descriptor]}))
                .unwrap();
        let mut m = parse_manifest(&bytes, &digest(&bytes)).unwrap();
        assert!(arm64(&m).is_ok());
        assert!(parse_manifest(&bytes, &format!("sha256:{}", "0".repeat(64))).is_err());
        m.manifests.push(m.manifests[0].clone());
        assert!(arm64(&m).is_err());
        m.manifests.clear();
        assert!(arm64(&m).is_err());
        assert!(bounded(&b"12345"[..], 4).is_err());
        assert_eq!(bounded(&b"1234"[..], 4).unwrap(), b"1234");
    }
    #[test]
    fn compressed_objects_require_both_exact_size_and_digest() {
        let mut descriptor = Descriptor {
            digest: digest(b"compressed fixture"),
            size: 18,
            media_type: String::new(),
            platform: None,
        };
        assert!(verify_object(&descriptor, b"compressed fixture").is_ok());
        assert!(verify_object(&descriptor, b"compressed fixturE").is_err());
        descriptor.size = 17;
        assert!(verify_object(&descriptor, b"compressed fixture").is_err());
    }
    #[test]
    fn invalid_reference_refuses_without_creating_archive() {
        let output =
            std::env::temp_dir().join(format!("hack-registry-invalid-{}.tar", std::process::id()));
        assert!(acquire("PRIVATE_CANARY", &output).is_err());
        assert!(!output.exists());
        assert!(
            !acquire("PRIVATE_CANARY", &output)
                .unwrap_err()
                .message
                .contains("PRIVATE_CANARY")
        );
    }
    #[test]
    #[ignore = "Explicit public Docker Hub acquisition; no runtime import"]
    fn pinned_event_agent_image_downloads_without_docker() {
        let path = std::env::var("HACK_REGISTRY_TEST_ARCHIVE").expect("explicit new archive path");
        let receipt=acquire("imbios/bun-node:1.3.14-24-alpine@sha256:744fb75f37bbe5cca4ba5e9645c7e4454adb58e17752caf53dd61924123297dc",Path::new(&path)).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len() as u64, receipt.archive_bytes);
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            receipt.archive_sha256
        );
        image_load::validate_download(&bytes, &receipt.image_id).unwrap();
        println!("{}", serde_json::to_string(&receipt).unwrap());
    }
}
