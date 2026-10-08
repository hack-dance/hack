import { chmod } from "node:fs/promises";

/** Transport stand-in only; compiled semantic qualification is a separately required gate. */
export async function managedEnvCompilerFixture(path: string): Promise<string> {
  const override = process.env.HACK_TEST_NATIVE_COMPILER_BINARY;
  if (override) {
    return override;
  }
  await Bun.write(
    path,
    `#!${process.execPath}
if (process.argv[2] === "--protocol") {
  console.log(JSON.stringify({transport_version:1,authored_version:1,plan_version:1,resolve_version:1,local_version:1,env_plan_version:1}));
} else {
  const raw = JSON.parse(await Bun.stdin.text());
  const project = raw.request_version ? JSON.parse(raw.project) : raw;
  const names = Object.keys(project.services ?? {});
  const result = {transport_version:1,ok:true,plan:{plan_version:1,services:Object.fromEntries(names.map(name=>[name,{}])),jobs:{}},semantic_hash:"a".repeat(64),declared_workloads:Object.fromEntries(names.map(name=>[name,"service"]))};
  if (raw.request_version) {
    const meta = raw.env_metadata;
    result.local_resolution = {overlay:meta.overlay,origin:"project",auto_branch:true,inherit_local:true,resolution_hash:"b".repeat(64)};
    result.environment_plan = {plan_version:1,overlay:meta.overlay,overlay_exists:meta.overlay_exists,complete:true,workloads:Object.fromEntries(names.map(name=>[name,Object.fromEntries(Object.entries(meta.workloads[name] ?? {}).map(([key,value])=>[key,{kind:"managed",key,scope:value.scope,secret:value.secret}]))])),warnings:[],diagnostics:[]};
  }
  console.log(JSON.stringify(result));
}
`
  );
  await chmod(path, 0o700);
  return path;
}
