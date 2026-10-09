import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A closed tmux transport stand-in. It starts the shipping wrapper/client, not
 * a second controller. Only test-owned session metadata and captured children exist.
 */
export async function writeLifecycleMuxFixture(root: string): Promise<string> {
  const path = join(root, "tmux");
  const source = `#!${process.execPath}
import { readFile, writeFile, appendFile, unlink } from "node:fs/promises";
const args=process.argv.slice(2), file=process.env.HACK_TEST_MUX_STATE;
if (!file) process.exit(92);
await appendFile(file+".calls",JSON.stringify(args)+"\\n");
const selected=(flag)=>args[args.indexOf(flag)+1];
let state=await readFile(file,"utf8").then(JSON.parse).catch(()=>null);
switch(args[0]) {
case "new-session":
 if(state) process.exit(91);
 state={name:selected("-s"),cwd:selected("-c"),token:"",windows:{}};
 await writeFile(file,JSON.stringify(state)); break;
case "set-option":
 if(!state)process.exit(91);state.token=args.at(-1);await writeFile(file,JSON.stringify(state));break;
case "list-sessions":
 if(state)console.log([state.name,"0",state.cwd,Object.keys(state.windows).length,"1"].join("\\t"));break;
case "has-session":
 if(!state){console.error("can't find session: "+selected("-t").replace(/^=/,""));process.exit(1);}break;
case "show-options":
 if(!state)process.exit(91);console.log(state.token);break;
case "list-windows":
 if(!state)process.exit(91);for(const name of Object.keys(state.windows))console.log(name);break;
case "new-window": {
 if(!state)process.exit(91);
 const child=Bun.spawn(["/bin/sh","-c",args.at(-1)],{cwd:selected("-c"),detached:true,stdin:"ignore",stdout:"ignore",stderr:"ignore"});
 child.unref();state.windows[selected("-n")]={pid:child.pid};await writeFile(file,JSON.stringify(state));break;
}
case "list-panes": {
 if(!state)process.exit(91);const name=selected("-t").split(":").at(-1);if(state.windows[name])console.log(state.windows[name].pid);break;
}
case "send-keys": {
 if(!state)process.exit(91);const name=selected("-t").split(":").at(-1);const row=state.windows[name];if(row){try{process.kill(-row.pid,"SIGINT");}catch{}}break;
}
case "kill-session":
 if(!state)process.exit(91);for(const row of Object.values(state.windows)){try{process.kill(-row.pid,"SIGTERM");}catch{}}await unlink(file);break;
default:process.exit(93);
}
`;
  await writeFile(path, source, { flag: "wx", mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}
