/** Synthetic daemon/kernel only. The real source CLI owns every admission,
 * journal, private descriptor, process and generation transition. No guest runs. */
export function nativeComposeStorageDockerFixtureScript(root: string): string {
  return `
const storageRoot=${JSON.stringify(root)};
const storageArgs=process.argv.slice(2);
const storageVolumes=storageRoot+"/volumes",storageCarriers=storageRoot+"/carriers";
const readRows=async path=>await Bun.file(path).exists()?await Bun.file(path).json():[];
const writeRows=async(path,rows)=>await Bun.write(path,JSON.stringify(rows));
const argument=key=>storageArgs[storageArgs.indexOf(key)+1];
const emit=value=>console.log(JSON.stringify(value));
const engineId="fixture-engine";
const imageId="sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61";
const imageReference="oven/bun@"+imageId;
const labels=()=>Object.fromEntries(storageArgs.flatMap((value,index)=>value==="--label"?[storageArgs[index+1].split(/=(.*)/s).slice(0,2)]:[]));
const volumeMount=volume=>({Type:"volume",Name:volume.name,Source:"/var/lib/docker/volumes/"+volume.name+"/_data",Destination:"/storage/"+volume.storage,Driver:"local",RW:true,Propagation:""});
const workload=async()=>{
 if(!await Bun.file(storageRoot+"/engine").exists())return null;
 const doc=await Bun.file(storageRoot+"/engine").json(),tag=doc.services.web.labels;
 return {id:"c".repeat(64),createdAt:"2026-10-08T12:00:00Z",project:doc.name,instance:doc.name,owner:tag["io.hack.native-config.owner"],version:"1",generation:tag["io.hack.native-config.generation"],carrier:null,carrierOwner:null,carrierGeneration:null,running:true,mounts:(await readRows(storageVolumes)).map(volumeMount)};
};
if(storageArgs[0]==="info"){
 emit(argument("--format").includes(".OSType")?{id:engineId,os:"linux",arch:await Bun.file(storageRoot+"/helper-wrong-platform").exists()?"amd64":"arm64"}:engineId);process.exit(0);
}
if(storageArgs[0]==="image"&&storageArgs[1]==="inspect"){
 if(storageArgs.at(-1)!==imageReference)process.exit(98);
 if(await Bun.file(storageRoot+"/helper-unavailable").exists())process.exit(1);
 emit({id:imageId,os:"linux",arch:"arm64",volumes:null});process.exit(0);
}
if(storageArgs[0]==="volume"&&storageArgs[1]==="create"){
 const name=storageArgs.at(-1),tag=labels(),rows=await readRows(storageVolumes);
 if(!rows.some(row=>row.name===name)){
  rows.push({id:name,name,project:tag["com.docker.compose.project"],version:tag["io.hack.native-config.version"],instance:tag["io.hack.native-config.instance"],owner:tag["io.hack.native-config.owner"],storage:tag["io.hack.native-config.storage"],provision:tag["io.hack.native-config.storage-provision"],createdAt:new Date().toISOString(),attributes:{},root:{device:"1",inode:"42",uid:0,gid:0}});
  await writeRows(storageVolumes,rows);
 }
 console.log(name);process.exit(0);
}
if(storageArgs[0]==="volume"&&storageArgs[1]==="ls"&&argument("--format")==="{{json .Name}}"){
 for(const row of await readRows(storageVolumes))emit(row.name);process.exit(0);
}
if(storageArgs[0]==="volume"&&storageArgs[1]==="inspect"&&argument("--format").includes(".Mountpoint")){
 const rows=await readRows(storageVolumes);
 for(const name of storageArgs.slice(storageArgs.indexOf("--format")+2)){
  const row=rows.find(value=>value.name===name);if(!row)process.exit(1);
  emit({name:row.name,createdAt:row.createdAt,driver:"local",options:null,mountpoint:"/var/lib/docker/volumes/"+row.name+"/_data",project:row.project,instance:row.instance,owner:row.owner,version:row.version,storage:row.storage,provision:row.provision??null});
 }process.exit(0);
}
if(storageArgs[0]==="volume"&&storageArgs[1]==="inspect"){
 const rows=await readRows(storageVolumes);
 for(const name of storageArgs.slice(storageArgs.indexOf("--format")+2)){
  const row=rows.find(value=>value.name===name);if(!row)process.exit(1);
  emit({id:row.name,name:row.name,project:row.project,version:row.version,instance:row.instance,owner:row.owner,storage:row.storage,createdAt:row.createdAt});
 }process.exit(0);
}
if(storageArgs[0]==="create"){
 if(storageArgs[storageArgs.indexOf("--entrypoint")+2]!==imageReference)process.exit(98);
 const mounts=storageArgs.flatMap((value,index)=>value==="--mount"?[storageArgs[index+1]]:[]).map(text=>Object.fromEntries(text.split(",").map(value=>value.includes("=")?value.split(/=(.*)/s).slice(0,2):[value,true])));
 const program=mounts.find(row=>row.type==="bind"),volume=mounts.find(row=>row.type==="volume");
 const rows=await readRows(storageCarriers),sequence=Number(await Bun.file(storageRoot+"/carrier-sequence").exists()?await Bun.file(storageRoot+"/carrier-sequence").text():0)+1;
 await Bun.write(storageRoot+"/carrier-sequence",String(sequence));
 const id="e"+sequence.toString(16).padStart(63,"0"),readonly=volume.readonly===true;
 const host={Privileged:false,ReadonlyRootfs:true,NetworkMode:"none",Memory:268435456,NanoCpus:1000000000,PidsLimit:32,CapDrop:["ALL"],CapAdd:null,SecurityOpt:["no-new-privileges:true"],LogConfig:{Type:"none",Config:{}},RestartPolicy:{Name:"no"},Binds:null,Devices:null,DeviceRequests:null,PortBindings:{},OomKillDisable:false,Mounts:[{Type:"bind",Source:program.src,Target:program.dst,ReadOnly:true,BindOptions:{NonRecursive:true,Propagation:"rprivate"}},{Type:"volume",Source:volume.src,Target:volume.dst,ReadOnly:readonly,VolumeOptions:{NoCopy:true}}]};
 rows.push({id,createdAt:new Date().toISOString(),image:imageId,configImage:storageArgs[storageArgs.indexOf("--entrypoint")+2],user:argument("--user"),entrypoint:["/usr/local/bin/bun"],cmd:["--no-env-file","/hack-storage-witness-helper.mjs"],openStdin:true,tty:false,labels:labels(),host,mounts:[{Type:"bind",Source:program.src,Destination:program.dst,RW:false,Propagation:"rprivate"},{Type:"volume",Name:volume.src,Source:"/var/lib/docker/volumes/"+volume.src+"/_data",Destination:volume.dst,Driver:"local",RW:!readonly,Propagation:""}],state:{Status:"created",Running:false,Pid:0,ExitCode:0,Paused:false,Restarting:false,OOMKilled:false,Dead:false,Error:""},execIds:null});
 await writeRows(storageCarriers,rows);console.log(id);process.exit(0);
}
if(storageArgs[0]==="start"){
 const rows=await readRows(storageCarriers),row=rows.find(value=>value.id===storageArgs.at(-1));if(!row)process.exit(99);
 const request=JSON.parse(await Bun.stdin.text()),volumes=await readRows(storageVolumes),volume=volumes.find(value=>value.name===row.mounts[1].Name);
 const root=volume?.root??{device:"1",inode:"42",uid:0,gid:0};let outcome="refused";
 if(volume&&request.operation==="root")outcome="root";
 else if(volume&&JSON.stringify(request.root)===JSON.stringify(root)&&row.user===root.uid+":"+root.gid){
  if(request.operation==="seed"&&row.mounts[1].RW&&!Object.hasOwn(volume.attributes??{},request.name)){
   volume.attributes={...volume.attributes,[request.name]:request.valueHex};await writeRows(storageVolumes,volumes);outcome="seeded";
  }else if(request.operation==="verify"&&volume.attributes?.[request.name]===request.valueHex)outcome="verified";
 }
 await appendFile(storageRoot+"/storage-operations",request.operation+"\\n");
 await appendFile(storageRoot+"/storage-events",request.operation+"\\n");
 const exitCode=outcome==="refused"?1:0;row.state={...row.state,Status:"exited",ExitCode:exitCode};await writeRows(storageCarriers,rows);
 emit({kind:"directory-xattr",version:1,outcome,...(outcome!=="refused"?{root}:{}),...(outcome==="verified"?{valueHex:request.valueHex}:{})});process.exit(exitCode);
}
if(storageArgs[0]==="rm"){
 const rows=await readRows(storageCarriers),id=storageArgs.at(-1);if(!rows.some(row=>row.id===id))process.exit(99);
 await writeRows(storageCarriers,rows.filter(row=>row.id!==id));console.log(id);process.exit(0);
}
if(storageArgs[0]==="container"&&storageArgs[1]==="ls"&&argument("--format")==="{{json .ID}}"){
 const rows=await readRows(storageCarriers),filter=argument("--filter");
 for(const row of rows)if(!storageArgs.includes("--filter")||filter==="label=io.hack.storage-witness.carrier="+row.labels["io.hack.storage-witness.carrier"])emit(row.id);
 const row=await workload();if(row&&!storageArgs.includes("--filter"))emit(row.id);process.exit(0);
}
if(storageArgs[0]==="container"&&storageArgs[1]==="inspect"){
 const format=argument("--format"),selected=storageArgs.slice(storageArgs.indexOf("--format")+2),carriers=await readRows(storageCarriers);
 if(format.includes(".HostConfig")){
  for(const id of selected){const row=carriers.find(value=>value.id===id);if(!row)process.exit(1);emit(row);}process.exit(0);
 }
 if(format.includes(".Mounts")){
  const main=await workload();for(const id of selected){
   const row=carriers.find(value=>value.id===id);
   if(row)emit({id:row.id,createdAt:row.createdAt,mounts:row.mounts,running:false,project:null,instance:null,owner:null,version:null,generation:null,carrier:row.labels["io.hack.storage-witness.carrier"],carrierOwner:row.labels["io.hack.storage-witness.owner"],carrierGeneration:row.labels["io.hack.storage-witness.generation"]});
   else if(main&&main.id===id)emit(main);else process.exit(1);
  }process.exit(0);
 }
}
`;
}
