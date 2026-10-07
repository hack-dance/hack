//! Pure domain and route intent. This module does not resolve DNS or claim TLS/OAuth admission.
use crate::{Diagnostic, json::child, model, validate};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::net::{Ipv4Addr, Ipv6Addr};
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Routes {
    #[serde(
        default,
        deserialize_with = "model::present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    pub domain: Option<String>,
    #[serde(
        default,
        deserialize_with = "model::present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    pub origin: Option<String>,
    #[serde(default)]
    #[ts(optional, as = "Option<BTreeMap<String,RouteAlias>>")]
    pub aliases: BTreeMap<String, RouteAlias>,
    #[serde(
        default,
        deserialize_with = "model::present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    pub oauth_alias: Option<String>,
    #[serde(default)]
    #[ts(optional, as = "Option<BTreeMap<String,HttpRoute>>")]
    pub http: BTreeMap<String, HttpRoute>,
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(untagged, deny_unknown_fields)]
pub enum RouteAlias {
    Domain { domain: String },
    Origin { origin: String },
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HttpRoute {
    pub service: String,
    #[schemars(range(min = 1, max = 65535))]
    pub port: u16,
    #[serde(default)]
    #[ts(optional, as = "Option<HttpProtocol>")]
    pub protocol: HttpProtocol,
    pub hostname: String,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum HttpProtocol {
    #[default]
    Http,
    Https,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct OpenConfig {
    #[serde(default)]
    #[ts(optional, as = "Option<OpenPreference>")]
    pub prefer: OpenPreference,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum OpenPreference {
    #[default]
    Auto,
    Alias,
    Dev,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct LocalRoutes {
    #[serde(
        default,
        deserialize_with = "model::present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    pub domain: Option<String>,
}
// Local absence inherits; an explicitly empty object must not select the authored default.
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct LocalOpen {
    #[serde(
        default,
        deserialize_with = "model::present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "OpenPreference")]
    #[ts(optional, type = "OpenPreference")]
    pub prefer: Option<OpenPreference>,
}
#[derive(Debug, Clone, Copy, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum DomainOrigin {
    Default,
    Global,
    Project,
    PrimaryLocal,
    CheckoutLocal,
    Explicit,
}
#[derive(Debug, Clone, Copy, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum OpenPreferenceOrigin {
    Default,
    Project,
    PrimaryLocal,
    CheckoutLocal,
}
#[derive(Debug, Serialize, JsonSchema, TS)]
pub struct ResolvedHttpRoute {
    pub service: String,
    pub port: u16,
    pub protocol: HttpProtocol,
    pub origin: String,
    pub aliases: BTreeMap<String, String>,
}
#[derive(Debug, Serialize, JsonSchema, TS)]
pub struct RoutingResolution {
    pub domain: String,
    pub domain_origin: DomainOrigin,
    pub project_origin: String,
    pub aliases: BTreeMap<String, String>,
    pub oauth_alias: Option<String>,
    pub open_preference: OpenPreference,
    pub open_preference_origin: OpenPreferenceOrigin,
    pub open_origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub branch: Option<String>,
    pub routes: BTreeMap<String, ResolvedHttpRoute>,
}

pub(crate) fn label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn dns_labels(value: &str) -> bool {
    value.len() <= 253 && value.split('.').all(label)
}
pub(crate) fn domain(value: &str) -> bool {
    dns_labels(value) && (value == "hack" || value.contains('.')) && !numeric_last_label(value)
}
struct Origin {
    scheme: String,
    host: String,
    port: Option<u16>,
    ip: bool,
}
impl Origin {
    fn text(&self) -> String {
        format!(
            "{}://{}{}",
            self.scheme,
            self.host,
            self.port.map(|p| format!(":{p}")).unwrap_or_default()
        )
    }
}
fn numeric_last_label(host: &str) -> bool {
    let last = host.rsplit('.').next().unwrap_or_default();
    last.bytes().all(|b| b.is_ascii_digit())
        || last
            .strip_prefix("0x")
            .is_some_and(|value| value.bytes().all(|b| b.is_ascii_hexdigit()))
}
// URL origins serialize all IPv6 segments as hexadecimal, including IPv4-mapped addresses.
fn ipv6_host(address: Ipv6Addr) -> String {
    let segments = address.segments();
    let mut best_start = 0;
    let mut best_len = 0;
    let mut i = 0;
    while i < 8 {
        if segments[i] != 0 {
            i += 1;
            continue;
        }
        let start = i;
        while i < 8 && segments[i] == 0 {
            i += 1;
        }
        if i - start > best_len {
            best_start = start;
            best_len = i - start;
        }
    }
    let render = |values: &[u16]| {
        values
            .iter()
            .map(|v| format!("{v:x}"))
            .collect::<Vec<_>>()
            .join(":")
    };
    if best_len < 2 {
        render(&segments)
    } else {
        format!(
            "{}::{}",
            render(&segments[..best_start]),
            render(&segments[best_start + best_len..])
        )
    }
}
fn parse_origin(value: &str) -> Option<Origin> {
    if !value.is_ascii()
        || value
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return None;
    }
    let (scheme, authority) = value.split_once("://")?;
    if !matches!(scheme, "http" | "https")
        || authority.is_empty()
        || authority.contains(['@', '/', '?', '#', '*', '\\', '%'])
    {
        return None;
    }
    let (host, port, ip) = if let Some(rest) = authority.strip_prefix('[') {
        let (address, suffix) = rest.split_once(']')?;
        let address = address.parse::<Ipv6Addr>().ok()?;
        let port = if suffix.is_empty() {
            None
        } else {
            Some(suffix.strip_prefix(':')?)
        };
        (format!("[{}]", ipv6_host(address)), port, true)
    } else {
        let (host, port) = match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        };
        let host = host.to_ascii_lowercase();
        if let Ok(address) = host.parse::<Ipv4Addr>() {
            (address.to_string(), port, true)
        } else {
            if !dns_labels(&host) || numeric_last_label(&host) {
                return None;
            }
            (host, port, false)
        }
    };
    let port = match port {
        Some(value) => {
            if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let p = value.parse::<u16>().ok()?;
            if p == 0 {
                return None;
            }
            if (scheme == "http" && p == 80) || (scheme == "https" && p == 443) {
                None
            } else {
                Some(p)
            }
        }
        None => None,
    };
    Some(Origin {
        scheme: scheme.into(),
        host,
        port,
        ip,
    })
}
fn origin(value: &str) -> Option<String> {
    Some(parse_origin(value)?.text())
}
fn generated(project: &str, suffix: &str, branch: Option<&str>) -> Option<String> {
    if !label(project) {
        return None;
    }
    let hostname = match branch {
        Some(branch) => format!("{branch}.{project}.{suffix}"),
        None => format!("{project}.{suffix}"),
    };
    (dns_labels(&hostname) && !numeric_last_label(&hostname)).then(|| format!("https://{hostname}"))
}
fn expand(base: &str, hostname: &str) -> Option<String> {
    if hostname == "project" {
        return Some(base.into());
    }
    let mut origin = parse_origin(base)?;
    if origin.ip {
        return None;
    }
    origin.host = format!("{hostname}.{}", origin.host);
    if !dns_labels(&origin.host) {
        return None;
    }
    Some(origin.text())
}
pub(crate) fn normalize(
    routes: &mut Routes,
    services: &BTreeSet<String>,
    at: &dyn Fn(&str, &str) -> Diagnostic,
) -> Result<(), Diagnostic> {
    if routes.domain.as_ref().is_some_and(|v| !domain(v)) {
        return Err(at("invalid_domain", "/routes/domain"));
    }
    if let Some(value) = &mut routes.origin {
        *value = origin(value).ok_or_else(|| at("invalid_origin", "/routes/origin"))?;
    }
    let mut aliases = BTreeSet::new();
    for (name, alias) in &mut routes.aliases {
        let pointer = child("/routes/aliases", name);
        if !validate::name(name) {
            return Err(at("invalid_name", &pointer));
        }
        let normalized = match alias {
            RouteAlias::Domain { domain: value } => {
                if !domain(value) {
                    return Err(at("invalid_domain", &child(&pointer, "domain")));
                }
                format!("domain:{value}")
            }
            RouteAlias::Origin { origin: value } => {
                *value = origin(value)
                    .ok_or_else(|| at("invalid_origin", &child(&pointer, "origin")))?;
                format!("origin:{value}")
            }
        };
        if !aliases.insert(normalized) {
            return Err(at("route_collision", &pointer));
        }
    }
    if routes
        .oauth_alias
        .as_ref()
        .is_some_and(|name| !routes.aliases.contains_key(name))
    {
        return Err(at("unknown_route_alias", "/routes/oauth_alias"));
    }
    let mut hostnames = BTreeSet::new();
    for (name, route) in &routes.http {
        let pointer = child("/routes/http", name);
        if !validate::name(name) {
            return Err(at("invalid_name", &pointer));
        }
        if !services.contains(&route.service) {
            return Err(at("unknown_route_service", &child(&pointer, "service")));
        }
        if route.port == 0 {
            return Err(at("invalid_route", &child(&pointer, "port")));
        }
        if !dns_labels(&route.hostname) {
            return Err(at("invalid_domain", &child(&pointer, "hostname")));
        }
        if !hostnames.insert(route.hostname.as_str()) {
            return Err(at("route_collision", &pointer));
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub(crate) struct InputGeneration<'a> {
    pub global_domain: &'a Option<String>,
    pub explicit_domain: &'a Option<String>,
    pub branch: &'a Option<String>,
}
pub(crate) struct Context<'a> {
    pub compiled: &'a crate::Compiled,
    pub request: &'a crate::local::ResolveRequest,
    pub primary: Option<&'a crate::local::ParsedLocal>,
    pub checkout: Option<&'a crate::local::ParsedLocal>,
    pub overlay: &'a Option<String>,
}
fn at(
    positions: &BTreeMap<String, (usize, usize)>,
    role: crate::local::DocumentRole,
    code: &str,
    pointer: &str,
) -> crate::local::ResolveDiagnostic {
    crate::local::with_role(role, crate::diagnostic_at(positions, code, pointer))
}
struct ExpansionBudget {
    remaining: usize,
}
impl ExpansionBudget {
    fn charge(
        &mut self,
        bytes: usize,
        ctx: &Context<'_>,
        pointer: &str,
    ) -> Result<(), crate::local::ResolveDiagnostic> {
        self.remaining = self.remaining.checked_sub(bytes).ok_or_else(|| {
            at(
                &ctx.compiled.positions,
                crate::local::DocumentRole::Project,
                "plan_too_large",
                pointer,
            )
        })?;
        Ok(())
    }
    fn value(
        &mut self,
        value: &impl Serialize,
        ctx: &Context<'_>,
    ) -> Result<(), crate::local::ResolveDiagnostic> {
        let bytes = crate::environment::serialized_size(value).map_err(|_| {
            at(
                &ctx.compiled.positions,
                crate::local::DocumentRole::Project,
                "plan_too_large",
                "/routes",
            )
        })?;
        self.charge(bytes, ctx, "/routes")
    }
}
pub(crate) fn required(ctx: &Context<'_>) -> bool {
    let plan = &ctx.compiled.plan;
    let primary = if plan.worktree.inherit_local {
        ctx.primary
    } else {
        None
    };
    plan.routes.is_some()
        || plan.open.is_some()
        || ctx.request.global_domain.is_some()
        || ctx.request.explicit_domain.is_some()
        || ctx.request.branch.is_some()
        || [primary, ctx.checkout].iter().any(|input| {
            input.is_some_and(|local| local.config.routes.is_some() || local.config.open.is_some())
        })
}
pub(crate) fn resolve(
    ctx: Context<'_>,
) -> Result<Option<RoutingResolution>, crate::local::ResolveDiagnostic> {
    use crate::local::DocumentRole;
    let plan = &ctx.compiled.plan;
    let primary = if plan.worktree.inherit_local {
        ctx.primary
    } else {
        None
    };
    let locals = [
        (
            primary,
            DocumentRole::PrimaryLocal,
            DomainOrigin::PrimaryLocal,
            OpenPreferenceOrigin::PrimaryLocal,
        ),
        (
            ctx.checkout,
            DocumentRole::CheckoutLocal,
            DomainOrigin::CheckoutLocal,
            OpenPreferenceOrigin::CheckoutLocal,
        ),
    ];
    if !required(&ctx) {
        return Ok(None);
    }
    let mut budget = ExpansionBudget {
        remaining: crate::environment::MAX_PLAN_OUTPUT_BYTES,
    };
    budget.charge(4096, &ctx, "/routes")?;
    budget.value(plan, &ctx)?;
    budget.value(&ctx.compiled.declared_workloads, &ctx)?;
    budget.value(ctx.overlay, &ctx)?;
    let mut domain_value = "hack.local".to_owned();
    let mut domain_origin = DomainOrigin::Default;
    if let Some(value) = &ctx.request.global_domain {
        domain_value = value.clone();
        domain_origin = DomainOrigin::Global;
    }
    if let Some(value) = plan.routes.as_ref().and_then(|r| r.domain.as_ref()) {
        domain_value = value.clone();
        domain_origin = DomainOrigin::Project;
    }
    let mut preference = plan
        .open
        .as_ref()
        .map(|o| o.prefer.clone())
        .unwrap_or_default();
    let mut preference_origin = if plan.open.is_some() {
        OpenPreferenceOrigin::Project
    } else {
        OpenPreferenceOrigin::Default
    };
    let mut preference_location = at(
        &ctx.compiled.positions,
        DocumentRole::Project,
        "missing_open_alias",
        "/open/prefer",
    );
    for (input, role, domain_source, open_source) in locals {
        if let Some(input) = input {
            if let Some(value) = input.config.routes.as_ref().and_then(|r| r.domain.as_ref()) {
                domain_value = value.clone();
                domain_origin = domain_source;
            }
            if let Some(value) = input.config.open.as_ref().and_then(|o| o.prefer.as_ref()) {
                preference = value.clone();
                preference_origin = open_source;
                preference_location =
                    at(&input.positions, role, "missing_open_alias", "/open/prefer");
            }
        }
    }
    if let Some(value) = &ctx.request.explicit_domain {
        domain_value = value.clone();
        domain_origin = DomainOrigin::Explicit;
    }
    let project_origin = if let Some(value) = plan.routes.as_ref().and_then(|r| r.origin.as_ref()) {
        value.clone()
    } else {
        generated(&plan.name, &domain_value, ctx.request.branch.as_deref()).ok_or_else(|| {
            at(
                &ctx.compiled.positions,
                DocumentRole::Project,
                "invalid_origin",
                "/name",
            )
        })?
    };
    budget.charge(
        project_origin.len() * 2 + domain_value.len() + 128,
        &ctx,
        "/routes",
    )?;
    let mut aliases = BTreeMap::new();
    let mut bases = BTreeSet::from([project_origin.clone()]);
    if let Some(routes) = &plan.routes {
        for (name, alias) in &routes.aliases {
            let pointer = child("/routes/aliases", name);
            let value = match alias {
                RouteAlias::Domain { domain } => {
                    generated(&plan.name, domain, ctx.request.branch.as_deref()).ok_or_else(
                        || {
                            at(
                                &ctx.compiled.positions,
                                DocumentRole::Project,
                                "invalid_origin",
                                &pointer,
                            )
                        },
                    )?
                }
                RouteAlias::Origin { origin } => origin.clone(),
            };
            budget.charge(value.len() * 2 + name.len() + 128, &ctx, &pointer)?;
            if !bases.insert(value.clone()) {
                return Err(at(
                    &ctx.compiled.positions,
                    DocumentRole::Project,
                    "route_collision",
                    &pointer,
                ));
            }
            aliases.insert(name.clone(), value);
        }
    }
    let oauth_alias = plan.routes.as_ref().and_then(|r| r.oauth_alias.clone());
    let selected_alias = oauth_alias.as_ref().and_then(|name| aliases.get(name));
    let open_origin = match preference {
        OpenPreference::Alias => selected_alias.ok_or(preference_location)?.clone(),
        OpenPreference::Auto => selected_alias.unwrap_or(&project_origin).clone(),
        OpenPreference::Dev => project_origin.clone(),
    };
    let mut routes_out = BTreeMap::new();
    let mut claimed = BTreeSet::new();
    if let Some(routes) = &plan.routes {
        for (name, route) in &routes.http {
            let pointer = child("/routes/http", name);
            let origin = expand(&project_origin, &route.hostname).ok_or_else(|| {
                at(
                    &ctx.compiled.positions,
                    DocumentRole::Project,
                    "invalid_origin",
                    &child(&pointer, "hostname"),
                )
            })?;
            budget.charge(
                origin.len() * 2 + name.len() + route.service.len() + 128,
                &ctx,
                &pointer,
            )?;
            if !claimed.insert(origin.clone()) {
                return Err(at(
                    &ctx.compiled.positions,
                    DocumentRole::Project,
                    "route_collision",
                    &pointer,
                ));
            }
            let selected = plan.services.contains_key(&route.service);
            let mut route_aliases = BTreeMap::new();
            for (alias, base) in &aliases {
                let alias_origin = expand(base, &route.hostname).ok_or_else(|| {
                    at(
                        &ctx.compiled.positions,
                        DocumentRole::Project,
                        "invalid_origin",
                        &child(&pointer, "hostname"),
                    )
                })?;
                budget.charge(alias_origin.len() * 2 + alias.len() + 64, &ctx, &pointer)?;
                if !claimed.insert(alias_origin.clone()) {
                    return Err(at(
                        &ctx.compiled.positions,
                        DocumentRole::Project,
                        "route_collision",
                        &pointer,
                    ));
                }
                if selected {
                    route_aliases.insert(alias.clone(), alias_origin);
                }
            }
            if selected {
                routes_out.insert(
                    name.clone(),
                    ResolvedHttpRoute {
                        service: route.service.clone(),
                        port: route.port,
                        protocol: route.protocol.clone(),
                        origin,
                        aliases: route_aliases,
                    },
                );
            }
        }
    }
    Ok(Some(RoutingResolution {
        domain: domain_value,
        domain_origin,
        project_origin,
        aliases,
        oauth_alias,
        open_preference: preference,
        open_preference_origin: preference_origin,
        open_origin,
        branch: ctx.request.branch.clone(),
        routes: routes_out,
    }))
}
