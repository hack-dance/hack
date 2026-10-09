/** Fixed synthetic acceptance only. No user material or observation is printed. */
export const VM_FIXTURE_BYTES = Buffer.from(
  "synthetic-vm-file-only-$-no-user-secret"
);
export const VM_FIXTURE_TARGETS = [
  "/run/hack-vm-fixture/owner-$",
  "/run/hack-vm-fixture/private-$",
] as const;
export const VM_FIXTURE_OTHER = 65_534;

/** Run in the application, separately from the production observer's checks. */
export const VM_FIXTURE_GUEST = `
import {lstat,open,readFile,readdir} from "node:fs/promises";
import {constants} from "node:fs";
function fail(guard){try{process.stderr.write(JSON.stringify({stage:"vm-file-guest",guard}));}finally{process.exit(74);}}
const p=JSON.parse(process.argv[1]);
if(!(p&&["owner","denied","readonly","ungranted"].includes(p.kind)&&Array.isArray(p.rows)&&p.rows.length===2&&Number.isSafeInteger(p.uid)&&Number.isSafeInteger(p.gid)&&process.getuid()===p.uid&&process.getgid()===p.gid))fail("input");
for(const row of p.rows){
  if(p.kind==="ungranted"){
    try{await lstat(row.target);fail("implicit-grant");}catch(e){if(e?.code!=="ENOENT")fail("absence");}
    continue;
  }
  const s=await lstat(row.target,{bigint:true});
  const actual={dev:String(s.dev),ino:String(s.ino),ctime:String(s.ctimeNs),size:Number(s.size),mode:Number(s.mode&511n),uid:Number(s.uid),gid:Number(s.gid)};
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||JSON.stringify(actual)!==JSON.stringify(row.file))fail("identity");
  if(p.kind==="denied"){
    try{await readFile(row.target);fail("nonowner-read");}catch(e){if(e?.code!=="EACCES")fail("nonowner-error");}
  }else if(p.kind==="readonly"){
    try{const fd=await open(row.target,constants.O_WRONLY|constants.O_NOFOLLOW);await fd.close();fail("write-open");}catch(e){if(e?.code!=="EROFS")fail("write-error");}
  }else if(row.file.uid===p.uid&&row.file.gid===p.gid){
    const bytes=await readFile(row.target),digest=new Bun.CryptoHasher("sha256").update(bytes).digest("hex");bytes.fill(0);
    if(digest!==row.digest)fail("owner-read");
  }
}
if(p.kind!=="ungranted"){
  const names=await readdir("/run/hack-vm-fixture");
  if(JSON.stringify(names.sort())!==JSON.stringify(p.rows.map(r=>r.target.split("/").at(-1)).sort()))fail("single-files");
}
process.stdout.write("vm-file-guest-"+p.kind+"-passed");
`;
