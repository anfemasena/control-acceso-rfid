const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {Pool} = require("pg");
const path = require("node:path");
const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.includes("localhost") && !dbUrl.includes("127.0.0.1")) throw Error("Solo probar contra PostgreSQL local");
const port = 39571;
const proc = spawn(process.execPath, ["server.js"], {
 cwd:path.resolve(__dirname,".."),
 env:{...process.env,DATABASE_URL:dbUrl,PORT:String(port),HOST:"127.0.0.1",ADMIN_USER:"ci-user",ADMIN_PASSWORD:"ci-secret-test"},
 stdio:["ignore","pipe","pipe"]
});
let logs="";
proc.stdout.on("data",x=>logs+=x.toString());
proc.stderr.on("data",x=>logs+=x.toString());
const pool = new Pool({connectionString:dbUrl});
async function call(method,endpoint,data,cookie) {
 const r = await fetch("http://127.0.0.1:"+port+endpoint,{
  method,
  headers:{...(data?{"Content-Type":"application/json"}:{}),...(cookie?{Cookie:cookie}:{})},
  body:data?JSON.stringify(data):undefined,
  signal:AbortSignal.timeout(15000)
 });
 return {status:r.status,body:await r.json(),headers:r.headers};
}
async function main(){
 try {
  let ready=false;
  for(let i=0;i<80;i++){
   if(proc.exitCode!==null)throw Error("Servidor finalizo: "+logs);
   try{if((await call("GET","/api/health")).status===200){ready=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,200));
  }
  assert.equal(ready,true,"Servidor no respondio: "+logs);
  assert.equal((await call("GET","/api/storage-status")).status,401);
  const login=await call("POST","/api/login",{username:"ci-user",password:"ci-secret-test"});
  assert.equal(login.status,200);
  const cookie=login.headers.get("set-cookie").split(";")[0];
  const st=await call("GET","/api/storage-status",null,cookie);
  assert.equal(st.body.storage,"postgresql");
  assert.equal(st.body.persistent,true);
  const person=await call("POST","/api/personnel",{name:"Alumno prueba"},cookie);
  assert.equal(person.status,201);
  assert.equal((await call("POST","/api/cards",{uid:"DECAFBAD",personnelId:person.body.id},cookie)).status,201);
  const repeated=await Promise.all(Array.from({length:8},()=>call("POST","/api/access",
   {uid:"DECAFBAD",device:"Puerta-1",requestId:"mismo-intento"})));
  for(const x of repeated){assert.equal(x.status,200);assert.equal(x.body.eventId,repeated[0].body.eventId);assert.equal(x.body.movement,"ingreso");}
  const entries=await Promise.all(Array.from({length:60},(_,i)=>call("POST","/api/access",
   {uid:(0xAB000000+i).toString(16).toUpperCase(),device:"Puerta-1",requestId:"unico-"+i})));
  entries.forEach(x=>assert.equal(x.status,200,JSON.stringify(x.body)));
  const check=await pool.query("SELECT jsonb_array_length(data->'events') AS n FROM public.app_state WHERE id='main'");
  assert.equal(Number(check.rows[0].n),61,"Deben conservarse 60 solicitudes y solo 1 reintento");
  assert.equal((await call("POST","/api/access",{uid:"11111111",device:"Puerta-1",requestId:"mismo-intento"})).status,409);
  console.log("PostgreSQL APTO: 60 solicitudes concurrentes, 8 reintentos deduplicados");
 } finally {proc.kill("SIGTERM");await pool.end();}
}
main().catch(e=>{console.error(e);console.error(logs.slice(-2000));process.exitCode=1});
