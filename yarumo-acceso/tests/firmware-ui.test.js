// Contratos del firmware: estas pruebas NO reemplazan compilar en Arduino ni probar el hardware.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const folder = path.resolve(__dirname, "../firmware/yarumo_lector_s3");
const firmware = fs.readFileSync(path.join(folder,"yarumo_lector_s3.ino"),"utf8");
const ui = fs.readFileSync(path.join(folder,"yarumo_ui.h"),"utf8");
const rtc = fs.readFileSync(path.join(folder,"yarumo_rtc.h"),"utf8");
const example = fs.readFileSync(path.join(folder,"config.example.h"),"utf8");

test("pantalla horizontal, tactil y pantalla de bienvenida Yarumo", () => {
  assert.match(firmware, /new Arduino_ST7789\([^\n]+LCD_RST,\s*1,/);
  assert.match(ui, /static void welcome\(\)/);
  assert.match(ui, /static void idle\(/);
  assert.match(ui, /static void offline\(/);
  assert.match(ui, /static bool readTouch\(/);
  assert.match(ui, /x=rawY;\s*y=rawX;/);
  assert.match(ui, /BOOT_BUTTON/);
  assert.match(ui, /CONFIGURAR WIFI/);
});

test("provisionamiento Wi-Fi local protegido y clave NVS", () => {
  assert.match(ui, /WiFi\.softAP\(apSSID\.c_str\(\),apPassword\.c_str\(\)\)/);
  assert.match(ui, /portal\.on\("\/save",HTTP_POST/);
  assert.match(ui, /fromPortalNetwork\(\)/);
  assert.match(ui, /prefs\.putString\("ssid",nextSSID\)/);
  assert.match(ui, /prefs\.putString\("pwd",nextPassword\)/);
  assert.match(ui, /PORTAL_TIMEOUT_MS = 600000/);
});

test("logo original comprimido descomprime a 64x64 sin excedentes", () => {
  const encoded = ui.match(/static const char \*logoRLE = "([0-9A-F]+)"/);
  assert.ok(encoded, "Falta logotipo de Yarumo");
  assert.equal(encoded[1].length % 2, 0);
  let pixels = 0;
  for (let n=0; n<encoded[1].length; n+=2) {
    const packed = parseInt(encoded[1].slice(n,n+2),16);
    assert.ok((packed & 3) < 3, "Color fuera de paleta");
    pixels += packed >> 2;
  }
  assert.equal(pixels, 4096);
});

test("hora NTP America/Bogota, RTC DS3231 opcional e invalidacion OSF", () => {
  assert.match(ui, /configTzTime\("COT5"/);
  assert.match(ui, /YarumoRTC::restore\(\)/);
  assert.match(ui, /YarumoRTC::saveFromSystemClock\(\)/);
  assert.match(ui, /sntp_set_time_sync_notification_cb/);
  assert.match(rtc, /status\s*&\s*0x80/);
  assert.match(rtc, /settimeofday/);
  assert.match(ui, /--:--:--/);
});

test("no sacrificar registros sin hora y no reformatear automaticamente", () => {
  assert.match(firmware, /if\(!clockReady\(\)\)\{/);
  assert.match(firmware, /LittleFS\.begin\(false\)/);
  assert.match(firmware, /#if YARUMO_ALLOW_INITIAL_FS_FORMAT/);
  assert.match(example, /#define YARUMO_ALLOW_INITIAL_FS_FORMAT 0/);
  assert.doesNotMatch(firmware, /LittleFS\.begin\(true\)/);
  assert.match(firmware, /d\["occurredAt"\]=utcNow\(\)/);
});

test("aislamiento de Yarumo, huellas locales y TLS verificado", () => {
  assert.match(firmware, /finger\.fingerFastSearch\(\)/);
  assert.match(firmware, /finger\.storeModel\(slot\)/);
  assert.match(firmware, /client\.setCACert\(ROOT_CA_PEM\)/);
  assert.doesNotMatch(firmware, /setInsecure|control-acceso-nusefa\.onrender\.com/);
  assert.match(example, /yarumo-acceso-92u0\.onrender\.com/);
});
