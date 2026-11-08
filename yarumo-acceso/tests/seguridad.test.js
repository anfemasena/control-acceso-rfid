const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(base,'server.js'),'utf8');
const schema=fs.readFileSync(path.join(base,'schema.sql'),'utf8');
const firmware=fs.readFileSync(path.join(base,'firmware/yarumo_lector_s3/yarumo_lector_s3.ino'),'utf8');
const {passhash,safeEq,sha256,dateBound,csvCell}=require('../server');

test('scrypt con sal única y comparación segura',()=>{
 const a=passhash('Una contraseña muy larga #1');const b=passhash('Una contraseña muy larga #1');
 assert.notEqual(a.salt,b.salt);assert.notEqual(a.hash,b.hash);
 assert.ok(safeEq(a.hash,passhash('Una contraseña muy larga #1',a.salt).hash));
 assert.equal(safeEq(a.hash,passhash('contraseña incorrecta',a.salt).hash),false);
 assert.equal(sha256('abc').length,64);
});
test('intervalos de reporte usan horario colombiano',()=>{
 assert.equal(dateBound('2026-11-08'),'2026-11-08T05:00:00.000Z');
 assert.equal(dateBound('2026-11-08',true),'2026-11-09T04:59:59.999Z');
 assert.throws(()=>dateBound('2026-02-30'),/Fecha inválida/);
 assert.throws(()=>dateBound('2026-13-01'),/Fecha inválida/);
});
test('CSV evita fórmulas inyectadas en planillas',()=>{
 assert.equal(csvCell('=HYPERLINK("https://malicioso")'),`"'=HYPERLINK(""https://malicioso"")"`);
 assert.equal(csvCell('Persona normal'),'"Persona normal"');
});
test('el backend usa PostgreSQL nuevo y aísla datos por organización',()=>{
 assert.match(server,/process\.env\.YARUMO_DATABASE_URL/);
 assert.doesNotMatch(server,/process\.env\.DATABASE_URL/);
 for(const table of ['ya_organizations','ya_admins','ya_devices','ya_people','ya_enrollments','ya_events']){
  assert.match(schema,new RegExp('CREATE TABLE IF NOT EXISTS '+table));
 }
 assert.match(server,/const org=s\.org_id/);
 assert.match(server,/WHERE org_id=\$1/);
 assert.match(server,/WHERE e\.org_id=\$1/);
 assert.match(server,/WHERE d\.org_id=\$1/);
 assert.match(server,/WHERE e\.org_id=\$1 AND e\.device_id=\$2/);
 assert.match(server,/const dev=await deviceAuth\(req\)/);
 assert.match(server,/token_hash=\$1 AND active=true/);
});
test('lectores no envían ni almacenan imágenes o plantillas biométricas en web',()=>{
 assert.match(firmware,/finger\.fingerFastSearch\(\)/);
 assert.match(firmware,/finger\.storeModel\(slot\)/);
 assert.match(firmware,/finger\.image2Tz\(1\)/);
 assert.match(firmware,/MAX_SLOT = 10/);
 assert.doesNotMatch(firmware,/getModel\s*\(/);
 assert.doesNotMatch(firmware,/setInsecure/);
 assert.match(server,/device_event_id/);
 assert.match(schema,/UNIQUE\(device_id,device_event_id\)/);
});
test('firmware nuevo no contiene URL ni credenciales de Fátima',()=>{
 assert.doesNotMatch(firmware,/control-acceso-nusefa\.onrender\.com/);
 assert.doesNotMatch(firmware,/Fatima2026/);
 assert.match(firmware,/ROOT_CA_PEM/);
 assert.match(firmware,/AS608_ESP_RX = 1/);
 assert.match(firmware,/AS608_ESP_TX = 2/);
});
