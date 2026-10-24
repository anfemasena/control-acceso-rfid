// Pruebas de regresion NUSEFA: sin red, sin credenciales ni datos de produccion.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { Readable } = require("node:stream");

const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const firmwareCode = fs.readFileSync(
  path.join(__dirname, "..", "firmware", "control_acceso", "control_acceso.ino"), "utf8"
);
assert.match(serverCode, /SELECT data FROM app_state WHERE id = 'main' FOR UPDATE/);
assert.match(serverCode, /attendanceParts\(new Date\(event.createdAt\)\)/);
assert.doesNotMatch(serverCode, /currentDatabase\.events\s*=\s*currentDatabase\.events\.slice\(0,\s*2000\)/);
assert.match(firmwareCode, /request\["requestId"\]/);

// El servidor desplegado en Render no debe arrancar sin DATABASE_URL.
{
  const env = { RENDER_SERVICE_ID: "srv-prueba", DATA_DIR: os.tmpdir() };
  const fake = vm.createContext({
    require(n) { if (n === "pg") return { Pool: class {} }; return require(n); },
    process: { env },
    console, URL, Date, Intl, Buffer, __dirname: path.resolve(__dirname, ".."),
  });
  assert.throws(() => vm.runInContext(serverCode, fake), /DATABASE_URL obligatorio/);
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusefa-test-"));
let handler;
const fakeHttp = { createServer(fn) { handler = fn; return { listen() {} }; } };
const runtime = vm.createContext({
  require(n) {
    if (n === "http") return fakeHttp;
    if (n === "pg") return { Pool: class { constructor() { throw Error("PostgreSQL no debe usarse en esta prueba"); } } };
    return require(n);
  },
  process: { env: { DATA_DIR: directory, ADMIN_USER: "admin", ADMIN_PASSWORD: "clave-de-prueba", PORT: "39998" } },
  console, URL, Date, Intl, Buffer, __dirname: path.resolve(__dirname, ".."), String, Number, Boolean, Object, Array, Set,
});
vm.runInContext(serverCode, runtime, { filename: "server.js" });
assert.equal(typeof handler, "function");

function call(method, url, body, cookie) {
  return new Promise((resolve, reject) => {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.method = method;
    request.url = url;
    request.headers = { host: "localhost", ...(cookie ? { cookie } : {}) };
    const headers = {};
    const response = {
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      writeHead(status, extra = {}) {
        this.status = status;
        for (const [name, value] of Object.entries(extra)) headers[name.toLowerCase()] = value;
      },
      end(data = "") {
        try { resolve({ status: this.status, headers, body: data ? JSON.parse(data) : null }); }
        catch (e) { reject(e); }
      },
    };
    Promise.resolve(handler(request, response)).catch(reject);
  });
}

async function main() {
  try {
    const forbidden = await call("GET", "/api/storage-status");
    assert.equal(forbidden.status, 401, "El estado de almacenamiento requiere login");

    const login = await call("POST", "/api/login", { username: "admin", password: "clave-de-prueba" });
    assert.equal(login.status, 200);
    const cookie = login.headers["set-cookie"];
    assert.ok(cookie?.includes("access_session="));
    const info = await call("GET", "/api/storage-status", undefined, cookie);
    assert.equal(info.status, 200);
    assert.equal(info.body.storage, "archivo-local");

    const person = await call("POST", "/api/personnel", { name: "Persona de prueba" }, cookie);
    assert.equal(person.status, 201);
    const card = await call("POST", "/api/cards", { uid: "A1B2C3D4", personnelId: person.body.id }, cookie);
    assert.equal(card.status, 201);

    const first = await call("POST", "/api/access", { uid: "A1B2C3D4", device: "Puerta-1", requestId: "prueba-1" });
    assert.equal(first.status, 200);
    assert.equal(first.body.allowed, true);
    assert.equal(first.body.movement, "ingreso");

    const same = await call("POST", "/api/access", { uid: "A1B2C3D4", device: "Puerta-1", requestId: "prueba-1" });
    assert.equal(same.body.eventId, first.body.eventId, "Reintento debe preservar eventId");
    assert.equal(same.body.movement, "ingreso", "Reintento no puede alternar ingreso/salida");

    const double = await call("POST", "/api/access", { uid: "A1B2C3D4", device: "Puerta-1", requestId: "prueba-2" });
    assert.equal(double.body.eventId, first.body.eventId, "Doble lectura en 4 s debe ignorarse");

    const conflict = await call("POST", "/api/access", { uid: "BEEFBEEF", device: "Puerta-1", requestId: "prueba-1" });
    assert.equal(conflict.status, 409, "No permitir reutilizar requestId en distinta tarjeta");

    const localDate = vm.runInContext("attendanceParts(new Date('2026-10-23T02:30:00Z'))", runtime);
    assert.equal(localDate.key, "2026-10-22");
    assert.equal(localDate.weekday, 4);
    assert.equal(localDate.hour, 21);
    assert.equal(vm.runInContext("isInsideSchedule({days:['4'],startTime:'21:00',endTime:'22:00'}, new Date('2026-10-23T02:30:00Z'))", runtime), true);

    const dbPath = path.join(directory, "database.json");
    const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    assert.equal(db.events.length, 1);
    db.events = Array.from({ length: 2000 }, (_, i) => ({
      id: "hist-" + i, uid: "X" + i, device: "Anterior",
      personnelId: "", createdAt: "2025-01-01T12:00:00.000Z",
      movement: "denegado", allowed: false
    }));
    fs.writeFileSync(dbPath, JSON.stringify(db));

    const extra = await call("POST", "/api/access", { uid: "DEADBEEF", device: "Puerta-1", requestId: "nuevo-2001" });
    assert.equal(extra.status, 200);
    const after = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    assert.equal(after.events.length, 2001, "No eliminar eventos mas antiguos de 2000");
    console.log("APTO: login, historial >2000, reintentos, doble lectura, conflicto y huso Colombia");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
