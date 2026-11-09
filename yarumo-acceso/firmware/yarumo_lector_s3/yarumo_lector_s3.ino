/*
 Yarumo Acceso - lector de asistencia independiente
 Waveshare ESP32-S3-Touch-LCD-1.47 + AS608 (UART), 10 huellas por dispositivo.
 La identificación biométrica se efectúa EN EL AS608. No se extraen plantillas.
 Interfaz horizontal, bienvenida Yarumo, reloj NTP y portal Wi-Fi táctil.
 NO cargar sobre el lector original del control RFID de NUSEFA.
*/
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Arduino_GFX_Library.h>
#include <Adafruit_Fingerprint.h>
#include <LittleFS.h>
#include <time.h>
#include "config.h"

// Pines libres del encabezado Waveshare. NO usar pines SPI/I2C de LCD ni de SD.
static constexpr int AS608_ESP_RX = 1; // AS608 TX -> GPIO1 ESP32-S3
static constexpr int AS608_ESP_TX = 2; // AS608 RX <- GPIO2 ESP32-S3
static constexpr int LCD_DC = 45, LCD_CS = 21, LCD_SCK = 38, LCD_MOSI = 39;
static constexpr int LCD_RST = 40, LCD_BL = 46;
static constexpr uint16_t MAX_SLOT = 10;
static constexpr uint32_t SENSOR_BAUD = 57600;
static constexpr uint32_t COMMAND_POLL_MS = 15000;
static constexpr uint32_t SYNC_POLL_MS = 5000;
static constexpr size_t MAX_OFFLINE_FILE = 120000;
static constexpr const char *QUEUE_PATH = "/events.ndjson";
static constexpr const char *TEMP_PATH = "/events.tmp";

HardwareSerial FingerSerial(1);
Adafruit_Fingerprint finger(&FingerSerial);
Arduino_DataBus *bus = new Arduino_ESP32SPI(LCD_DC, LCD_CS, LCD_SCK, LCD_MOSI);
Arduino_GFX *gfx = new Arduino_ST7789(bus, LCD_RST, 1, false, 172, 320, 34, 0, 34, 0);
#include "yarumo_ui.h"
uint32_t lastPoll = 0, lastSync = 0, lastScan = 0;
bool sensorReady = false;

void screen(const String &title, const String &detail, uint16_t color=RGB565_WHITE) {
  YarumoUI::notice(title,detail,color);
}

String newUUID() {
  uint8_t b[16];esp_fill_random(b,sizeof b);
  b[6]=(b[6]&0x0f)|0x40;b[8]=(b[8]&0x3f)|0x80;
  char out[37];snprintf(out,sizeof out,
   "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
   b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15]);
  return String(out);
}
bool clockReady() {return time(nullptr)>1700000000;}
String utcNow(){
 if(!clockReady())return "";
 time_t n=time(nullptr);struct tm utc;gmtime_r(&n,&utc);
 char b[32];strftime(b,sizeof b,"%Y-%m-%dT%H:%M:%SZ",&utc);return String(b);
}
bool configured(){
 return String(SERVER_BASE).startsWith("https://") && !String(SERVER_BASE).includes("SERVICIO-YARUMO-NUEVO") &&
        String(DEVICE_TOKEN).length()>=40 && !String(DEVICE_TOKEN).startsWith("TOKEN_EXCLUSIVO") &&
        String(ROOT_CA_PEM).indexOf("REEMPLAZAR")<0;
}

int request(const String &path,const String &method,const String &payload,String &response) {
 if(WiFi.status()!=WL_CONNECTED||!clockReady()||!configured())return -1;
 WiFiClientSecure client;client.setCACert(ROOT_CA_PEM);
 HTTPClient http;
 if(!http.begin(client,String(SERVER_BASE)+path))return -2;
 http.setTimeout(11000);
 http.addHeader("Authorization",String("Bearer ")+DEVICE_TOKEN);
 http.addHeader("Accept","application/json");
 if(method=="POST")http.addHeader("Content-Type","application/json");
 const int code=method=="GET"?http.GET():http.POST(payload);
 response=http.getString();http.end();return code;
}
void recoverQueue(){
 // Tras un corte entre remove() y rename(), rescata los eventos confirmados restantes.
 if(!LittleFS.exists(QUEUE_PATH) && LittleFS.exists(TEMP_PATH))LittleFS.rename(TEMP_PATH,QUEUE_PATH);
 else if(LittleFS.exists(QUEUE_PATH) && LittleFS.exists(TEMP_PATH))LittleFS.remove(TEMP_PATH);
}
bool enqueue(uint16_t slot,uint16_t confidence){
 // No registrar una hora inventada: debe existir hora NTP o RTC valida.
 if(!clockReady()){screen("RELOJ SIN HORA","Conecte Wi-Fi o DS3231",RGB565_RED);return false;}
 recoverQueue();
 if(!LittleFS.exists(QUEUE_PATH)){
   File file=LittleFS.open(QUEUE_PATH,"w");if(!file)return false;file.close();
 }
 File f=LittleFS.open(QUEUE_PATH,"a");if(!f)return false;
 if(f.size()>MAX_OFFLINE_FILE){f.close();screen("Cola llena","Requiere recuperar la conexion",RGB565_RED);return false;}
 JsonDocument d;d["eventId"]=newUUID();d["slot"]=slot;d["confidence"]=confidence;
 d["occurredAt"]=utcNow();
 String line;serializeJson(d,line);f.println(line);f.flush();f.close();return true;
}
void syncEvents(){
 recoverQueue();
 if(!LittleFS.exists(QUEUE_PATH)||WiFi.status()!=WL_CONNECTED)return;
 File input=LittleFS.open(QUEUE_PATH,"r");if(!input)return;
 if(!input.available()){input.close();return;}
 String line=input.readStringUntil('\n');line.trim();
 if(line.isEmpty()){input.close();return;}
 String response;const int status=request("/api/device/events","POST",line,response);
 if(status!=200){input.close();return;} // no eliminar eventos si el servidor no confirmó
 JsonDocument reply;if(deserializeJson(reply,response)){input.close();return;}
 // Confirmación de recepción, incluida repetición idempotente.
 if(reply["id"].isNull()){input.close();return;}
 screen((reply["allowed"]|false)?"REGISTRO OK":"NO AUTORIZADO",reply["movement"].as<String>(),
   (reply["allowed"]|false)?RGB565_GREEN:RGB565_RED);
 File output=LittleFS.open(TEMP_PATH,"w");if(!output){input.close();return;}
 while(input.available()){String rest=input.readStringUntil('\n');if(rest.length())output.println(rest);}
 output.flush();output.close();input.close();
 LittleFS.remove(QUEUE_PATH);LittleFS.rename(TEMP_PATH,QUEUE_PATH);
}
bool scanImage(uint8_t bufferSlot,uint32_t maxWait=45000){
 uint32_t begin=millis();
 while(millis()-begin<maxWait){
   uint8_t p=finger.getImage();
   if(p==FINGERPRINT_OK){return finger.image2Tz(bufferSlot)==FINGERPRINT_OK;}
   if(p!=FINGERPRINT_NOFINGER)return false;
   delay(100);
 }
 return false;
}
bool enroll(uint16_t slot){
 if(slot<1||slot>MAX_SLOT)return false;
 screen("CAPTURA 1","Coloque el dedo en AS608");
 if(!scanImage(1))return false;
 screen("RETIRE DEDO","Preparando captura 2");
 uint32_t begin=millis();
 while(millis()-begin<15000 && finger.getImage()!=FINGERPRINT_NOFINGER)delay(130);
 delay(700);screen("CAPTURA 2","Mismo dedo de nuevo");
 if(!scanImage(2))return false;
 if(finger.createModel()!=FINGERPRINT_OK)return false;
 if(finger.storeModel(slot)!=FINGERPRINT_OK)return false;
 screen("HUELLA GUARDADA","Casilla "+String(slot),RGB565_GREEN);return true;
}
void pollCommands(){
 String response;
 if(request("/api/device/commands","GET","",response)!=200)return;
 JsonDocument d;if(deserializeJson(d,response))return;
 JsonArray commands=d["commands"].as<JsonArray>();
 for(JsonObject cmd:commands){
   const String id=cmd["id"].as<String>();const String kind=cmd["kind"].as<String>();const int slot=cmd["slot"]|0;
   bool result=false;
   if(kind=="enroll")result=enroll(slot);
   else if(kind=="delete" && slot>0 && slot<=MAX_SLOT)result=finger.deleteModel(slot)==FINGERPRINT_OK;
   JsonDocument ack;ack["success"]=result;ack["error"]=result?"":"Error de captura/sensor";
   String payload,reply;serializeJson(ack,payload);
   request("/api/device/commands/"+id+"/result","POST",payload,reply);
 }
}
void handleFinger(){
 if(!sensorReady || millis()-lastScan<2100)return;
 const uint8_t image=finger.getImage();
 if(image==FINGERPRINT_NOFINGER)return;
 if(image!=FINGERPRINT_OK)return;
 lastScan=millis();
 if(finger.image2Tz(1)!=FINGERPRINT_OK){screen("LECTURA INVALIDA","Repita la captura",RGB565_RED);return;}
 const uint8_t match=finger.fingerFastSearch();
 if(match==FINGERPRINT_OK){
   const uint16_t slot=finger.fingerID;
   if(slot<=MAX_SLOT){
     if(enqueue(slot,finger.confidence))screen("HUELLA VALIDADA","Casilla "+String(slot)+" · Registrando",RGB565_GREEN);
     else screen("REGISTRO PENDIENTE","Revise reloj o memoria",RGB565_RED);
   }
 }else if(match==FINGERPRINT_NOTFOUND){
   // Casilla 0 registra intento no reconocido, sin datos biométricos.
   enqueue(0,0);screen("DESCONOCIDO","Huella no registrada",RGB565_RED);
 }
 uint32_t begin=millis();while(millis()-begin<3000 && finger.getImage()!=FINGERPRINT_NOFINGER)delay(80);
}
void setup(){
 Serial.begin(115200);
 pinMode(LCD_BL,OUTPUT);digitalWrite(LCD_BL,HIGH);
 gfx->begin(); // Rotacion 1 -> orientacion horizontal 320 x 172.
 YarumoUI::begin(gfx,false); // Muestra la bienvenida incluso sin Wi-Fi.
 // No borrar registros automaticamente ante una particion corrupta.
 bool fsReady=LittleFS.begin(false);
#if YARUMO_ALLOW_INITIAL_FS_FORMAT
 if(!fsReady){
   Serial.println("FORMATEO INICIAL EXPLICITO DEL SISTEMA DE ARCHIVOS");
   fsReady=LittleFS.format() && LittleFS.begin(false);
 }
#endif
 if(!fsReady){
   screen("ERROR FLASH","No se pueden guardar eventos",RGB565_RED);
   while(true){YarumoUI::tick();delay(100);}
 }
 recoverQueue();
 FingerSerial.begin(SENSOR_BAUD,SERIAL_8N1,AS608_ESP_RX,AS608_ESP_TX);
 finger.begin(SENSOR_BAUD);
 sensorReady=finger.verifyPassword();
 YarumoUI::setSensorReady(sensorReady);
 if(!sensorReady)Serial.println("AS608 no responde: revisar alimentacion y UART");
 if(!configured())Serial.println("Configurar DEVICE_TOKEN y ROOT_CA_PEM antes de usar API");
}

void loop(){
 // El portal, la reconexion Wi-Fi y el reloj funcionan aun sin token de API.
 YarumoUI::tick();
 if(YarumoUI::portalActive()){delay(40);return;}
 if(!configured()){delay(80);return;}
 if(millis()-lastSync>SYNC_POLL_MS){syncEvents();lastSync=millis();}
 if(millis()-lastPoll>COMMAND_POLL_MS && sensorReady && WiFi.status()==WL_CONNECTED){
   pollCommands();lastPoll=millis();
 }
 handleFinger();
 delay(70);
}
