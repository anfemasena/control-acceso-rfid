#pragma once
/*
  Yarumo Acceso - interfaz horizontal y configuración Wi-Fi local.
  ESP32-S3-Touch-LCD-1.47 (Waveshare), LCD 320x172 en giro 1,
  AXS5106L en I2C, GPIO 42(SDA)/41(SCL)/47(RST)/48(INT).
  El portal SOLO opera en la red WPA2 creada por el dispositivo.
  No contiene credenciales del servidor ni huellas biométricas.
*/
#include <Wire.h>
#include <WebServer.h>
#include <Preferences.h>
#include <time.h>
#include <esp_sntp.h>
#include "yarumo_rtc.h"

namespace YarumoUI {
  constexpr uint8_t TOUCH_ADDR = 0x63;
  constexpr uint8_t TOUCH_REG = 0x01;
  constexpr int TOUCH_SDA = 42, TOUCH_SCL = 41, TOUCH_RST = 47, TOUCH_INT = 48;
  constexpr int BOOT_BUTTON = 0;
  constexpr uint16_t GREEN = 0x35AA, ORANGE = 0xF3A4, DARK = 0x1A26;
  constexpr uint16_t PALE = 0xD6F3, MUTED = 0x83F0, RED = 0xF9C6;
  constexpr uint32_t RETRY_MS = 15000, PORTAL_TIMEOUT_MS = 600000;
  enum class Mode { WELCOME, OFFLINE, IDLE, PORTAL, NOTICE };
  static Arduino_GFX *lcd = nullptr;
  static WebServer portal(80);
  static Preferences prefs;
  static Mode mode = Mode::WELCOME;
  static volatile bool touchIRQ = false;
  static bool portalOn = false, routesReady = false, applyCredentials = false;
  static bool sensorOK = false, wasConnected = false;
  static volatile bool ntpPending = false;
  static void onNtpSync(struct timeval *) { ntpPending = true; }
  static String ssid, password, apSSID, apPassword, nextSSID, nextPassword;
  static uint32_t welcomeAt = 0, noticeUntil = 0, lastRetry = 0;
  static uint32_t lastClockDraw = 0, portalAt = 0, lastTouch = 0, bootHeldAt = 0;
  static String oldClock;

  static void IRAM_ATTR touchInterrupt() { touchIRQ = true; }

  static bool hasClock() { return time(nullptr) > 1700000000; }

  static String htmlEscape(const String &in) {
    String result; result.reserve(in.length() + 12);
    for (size_t i = 0; i < in.length(); i++) {
      switch (in[i]) {
        case '&': result += "&amp;"; break;
        case '<': result += "&lt;"; break;
        case '>': result += "&gt;"; break;
        case '"': result += "&quot;"; break;
        case '\'': result += "&#39;"; break;
        default: result += in[i];
      }
    }
    return result;
  }

  // Icono oficial Yarumo (hojas blancas y naranjas), de la identidad Yarumo POS.
  // Fuente: yarumo-icon.webp, reducido a 64x64 y paleta de 3 colores.
  // Comprimido con RLE: 197 bytes + 4 KiB RAM durante el dibujo.
  static const char *logoRLE = "FCFCFCFCFCFCFCFCFCFCFCFCFC7C056806900D58128C1150168C1518090C0A141A8C19100D0C0E0C1E8C1D0811081604228C3508369039043694350436705904565455045258064D084E60514E6855427449083A7C45102E80290C0D1006042A7C29040D0405100D042A742D04111011042E6C3106111011366835041108110436742D040D080D041A040E9C1504210812B00D1019100EB0051C111C06D011F011F011F011F011F011F011F011F011F011F011F011F409FCFCFCFCFCFCFCFCFCFCFCFCFCB0";
  static uint8_t logoMap[4096];
  static bool logoReady = false;
  static uint8_t hexDigit(char c) {
    return c<='9' ? c-'0' : c-'A'+10;
  }
  static void unpackLogo() {
    if(logoReady)return;
    size_t pos=0;
    for(size_t i=0;logoRLE[i] && logoRLE[i+1];i+=2) {
      uint8_t packed=(hexDigit(logoRLE[i])<<4)|hexDigit(logoRLE[i+1]);
      uint8_t count=packed>>2, color=packed&3;
      while(count-- && pos<4096)logoMap[pos++]=color;
    }
    logoReady=(pos==4096);
  }
  static void mark(int x, int y, int size) {
    unpackLogo();
    const uint16_t palette[] = {0x1A26,0xE77D,0xFCE5};
    for(int yy=0;yy<size;yy++) {
      int sourceY=(yy*64)/size, run=0;
      uint8_t previous=logoMap[sourceY*64];
      for(int xx=1;xx<=size;xx++){
        uint8_t color=xx<size?logoMap[sourceY*64+(xx*64)/size]:255;
        if(color!=previous){
          lcd->drawFastHLine(x+run,y+yy,xx-run,palette[previous<3?previous:0]);
          run=xx;previous=color;
        }
      }
    }
  }
  static void header() {
    lcd->fillScreen(DARK);
    mark(5, 4, 28);
    lcd->setTextColor(PALE); lcd->setTextSize(2);
    lcd->setCursor(47, 8); lcd->print("YARUMO");
    lcd->setTextColor(ORANGE); lcd->setTextSize(1);
    lcd->setCursor(141, 16); lcd->print("ACCESO");
    lcd->drawFastHLine(8, 37, 304, MUTED);
  }
  static void label(int x, int y, const String &s, uint16_t color, int size=1) {
    lcd->setCursor(x,y); lcd->setTextColor(color); lcd->setTextSize(size); lcd->print(s);
  }
  static void button(int x,int y,int w,int h,const String &text,uint16_t color=GREEN) {
    lcd->fillRoundRect(x,y,w,h,9,color);
    lcd->setTextSize(2); lcd->setTextColor(DARK);
    int tx = x + (w - static_cast<int>(text.length())*12)/2;
    lcd->setCursor(tx,y+(h-16)/2); lcd->print(text);
  }
  static String localClock(bool seconds=false) {
    if (!hasClock()) return seconds?"--:--:--":"--:--";
    time_t now=time(nullptr); struct tm local; localtime_r(&now,&local);
    char buf[24]; strftime(buf,sizeof(buf),seconds?"%H:%M:%S":"%H:%M",&local);
    return String(buf);
  }
  static void welcome() {
    mode=Mode::WELCOME; welcomeAt=millis();
    lcd->fillScreen(DARK);
    mark(44,28,100);
    label(157,46,"YARUMO",PALE,3);
    label(159,80,"ACCESO",ORANGE,2);
    label(61,132,"CONTROL BIOMETRICO",MUTED,2);
  }
  static void offline() {
    const String timeLabel=hasClock()?"Hora "+localClock(true):"Reloj sin sincronizar";
    if (mode==Mode::OFFLINE) {
      // Mantener el reloj en movimiento si existe DS3231 o NTP anterior.
      static String previous;
      if(previous==timeLabel)return;
      previous=timeLabel;
      lcd->fillRect(14,77,286,18,DARK);
      label(14,79,timeLabel,PALE,1);
      return;
    }
    mode=Mode::OFFLINE; header();
    label(14,51,"SIN CONEXION WIFI",ORANGE,2);
    label(14,79,timeLabel,PALE,1);
    button(13,104,294,50,"CONFIGURAR WIFI");
  }
  static void idle(bool force=false) {
    if (mode!=Mode::IDLE || force) {
      mode=Mode::IDLE; header();
      label(14,52,"REGISTRO DE ASISTENCIA",MUTED,1);
      label(14,137,"ACERQUE SU HUELLA",PALE,1);
      lcd->drawRoundRect(247,125,63,35,7,GREEN);
      label(256,137,"RED",GREEN,2);
      oldClock="";
    }
    if (millis()-lastClockDraw<450 && oldClock.length())return;
    lastClockDraw=millis();
    String now=localClock(true);
    if (now==oldClock) return;
    oldClock=now;
    lcd->fillRect(54,68,252,48,DARK);
    label(55,72,now.substring(0,5),PALE,5);
    label(229,87,now.substring(6),ORANGE,2);
    lcd->fillRect(14,118,205,13,DARK);
    label(14,119,sensorOK?"WIFI OK  -  SENSOR OK":"WIFI OK  -  REVISAR AS608",
          sensorOK?GREEN:ORANGE,1);
    if(!hasClock())label(55,111,"Sin hora: esperando NTP",ORANGE,1);
  }
  static void notice(const String &title,const String &detail,uint16_t color=PALE) {
    mode=Mode::NOTICE; noticeUntil=millis()+3000; header();
    label(12,55,title.substring(0,24),color,2);
    label(12,91,detail.substring(0,46),PALE,1);
    label(12,144,WiFi.status()==WL_CONNECTED?"WIFI CONECTADO":"WIFI DESCONECTADO",
          WiFi.status()==WL_CONNECTED?GREEN:ORANGE,1);
  }
  static void portalScreen() {
    mode=Mode::PORTAL; header();
    label(12,45,"CONFIGURACION WIFI",ORANGE,2);
    label(12,72,"Red: "+apSSID,PALE,1);
    label(12,86,"Clave: "+apPassword,PALE,1);
    label(12,102,"Abra http://192.168.4.1",MUTED,1);
    button(12,125,296,38,"CANCELAR",ORANGE);
  }
  static bool readTouch(int &x,int &y) {
    if(!touchIRQ) return false;
    noInterrupts();touchIRQ=false;interrupts();
    if(millis()-lastTouch<450)return false;
    Wire.beginTransmission(TOUCH_ADDR);
    Wire.write(TOUCH_REG);
    if(Wire.endTransmission(false)!=0)return false;
    uint8_t data[14]={0};
    int count=Wire.requestFrom((uint8_t)TOUCH_ADDR,(uint8_t)sizeof(data));
    if(count!=(int)sizeof(data))return false;
    for(int i=0;i<(int)sizeof(data);i++)data[i]=Wire.read();
    if(data[1]<1 || data[1]>2)return false;
    const int rawX=((data[2]&0x0F)<<8)|data[3];
    const int rawY=((data[4]&0x0F)<<8)|data[5];
    // Rotacion de 90 grados: coordenadas crudas de panel 172x320 a 320x172.
    x=rawY; y=rawX;
    if(x<0||x>=320||y<0||y>=172)return false;
    lastTouch=millis();
    return true;
  }
  static void touchBegin() {
    Wire.begin(TOUCH_SDA,TOUCH_SCL);
    Wire.setClock(400000);
    pinMode(TOUCH_RST,OUTPUT);
    digitalWrite(TOUCH_RST,LOW); delay(50);
    digitalWrite(TOUCH_RST,HIGH); delay(180);
    pinMode(TOUCH_INT,INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(TOUCH_INT),touchInterrupt,FALLING);
    pinMode(BOOT_BUTTON,INPUT_PULLUP);
  }
  static bool fromPortalNetwork() {
    IPAddress from=portal.client().remoteIP();
    return from[0]==192 && from[1]==168 && from[2]==4;
  }
  static void sendPortalPage(const String &message="") {
    if(!fromPortalNetwork()) {portal.send(403,"text/plain","Solo red de configuracion");return;}
    String page=R"HTML(<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Yarumo Acceso Wi-Fi</title>
<style>body{font:16px system-ui;background:#092d26;color:#fff;max-width:420px;margin:4em auto;padding:0 18px}
h1{color:#b5e3a8}label{display:block;margin-top:16px}
input{box-sizing:border-box;width:100%;font-size:18px;padding:13px;border:0;border-radius:7px;margin-top:7px}
button{margin-top:22px;background:#e9a34b;border:0;padding:14px;border-radius:7px;font-weight:bold;width:100%}
small{color:#dbebdf}</style></head><body><h1>Yarumo Acceso</h1><p>Configurar red Wi-Fi de 2.4 GHz</p>)HTML";
    if(message.length())page+="<p>"+htmlEscape(message)+"</p>";
    page+=R"HTML(<form method="post" action="/save">
<label>Nombre de red (SSID)<input name="ssid" maxlength="32" required autocomplete="off"></label>
<label>Contraseña de la red<input type="password" name="password" maxlength="63" autocomplete="off"></label>
<button type="submit">Guardar y conectar</button></form>
<p><small>La clave se guarda en el dispositivo, no se envia a Yarumo Acceso.
La red temporal de configuracion se apaga al conectar.</small></p></body></html>)HTML";
    portal.sendHeader("Cache-Control","no-store");
    portal.send(200,"text/html; charset=utf-8",page);
  }
  static void savePortal() {
    if(!fromPortalNetwork()) {portal.send(403,"text/plain","Prohibido");return;}
    String requested=portal.arg("ssid");
    String pass=portal.arg("password");
    if(requested.isEmpty()||requested.length()>32||pass.length()>63||
       (pass.length() && pass.length()<8)){
      sendPortalPage("Revise el SSID y la contrasena (8-63 caracteres o red abierta).");
      return;
    }
    nextSSID=requested;nextPassword=pass;
    applyCredentials=true;
    portal.send(200,"text/html; charset=utf-8",
      "<html><meta name='viewport' content='width=device-width'><h2>Datos guardados</h2>"
      "<p>Yarumo Acceso intentara conectarse a la red. Revise la pantalla.</p></html>");
  }
  static void initRoutes() {
    if(routesReady)return;
    portal.on("/",HTTP_GET,[](){sendPortalPage();});
    portal.on("/save",HTTP_POST,[](){savePortal();});
    portal.on("/generate_204",HTTP_GET,[](){portal.sendHeader("Location","http://192.168.4.1/",true);portal.send(302);});
    portal.on("/hotspot-detect.html",HTTP_GET,[](){portal.sendHeader("Location","http://192.168.4.1/",true);portal.send(302);});
    portal.onNotFound([](){portal.sendHeader("Location","http://192.168.4.1/",true);portal.send(302);});
    routesReady=true;
  }
  static void stopPortal() {
    if(!portalOn)return;
    portal.stop();
    WiFi.softAPdisconnect(true);
    portalOn=false;
  }
  static void beginPortal() {
    if(portalOn)return;
    WiFi.disconnect(false,false);
    WiFi.mode(WIFI_AP_STA);
    uint64_t chip=ESP.getEfuseMac();
    char suffix[8];snprintf(suffix,sizeof(suffix),"%04X",(unsigned)(chip & 0xFFFF));
    apSSID=String("Yarumo-")+suffix;
    apPassword=String("YA-")+String((uint32_t)esp_random(),HEX)+"9";
    if(!WiFi.softAP(apSSID.c_str(),apPassword.c_str())) {
      notice("ERROR RED AP","No se pudo iniciar configuracion",RED);return;
    }
    initRoutes();portal.begin();portalOn=true;portalAt=millis();portalScreen();
  }
  static void connectStation() {
    if(portalOn)return;
    if(ssid.isEmpty())return;
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid.c_str(),password.c_str());
    lastRetry=millis();
  }
  static void begin(Arduino_GFX *display,bool sensorReady) {
    lcd=display;sensorOK=sensorReady;
    prefs.begin("yarumo-wifi",false);
    ssid=prefs.getString("ssid",String(WIFI_SSID));
    password=prefs.getString("pwd",String(WIFI_PASSWORD));
    // Ignorar valores demostrativos del ejemplo hasta que se configure.
    if(ssid.startsWith("RED_WIFI_"))ssid="";
    touchBegin();
    setenv("TZ","COT5",1);tzset(); // America/Bogota UTC-5 sin horario de verano.
    bool rtcRestored=YarumoRTC::restore();
    Serial.println(rtcRestored?"DS3231: reloj recuperado":"RTC: a la espera de NTP");
    welcome();
    WiFi.setAutoReconnect(true);
    connectStation();
  }
  static void setSensorReady(bool ready) { sensorOK=ready; }
  static bool portalActive() { return portalOn; }
  static void tick() {
    // El callback SNTP ocurre en otra tarea; escribir I2C solo en el loop.
    if(ntpPending) {
      ntpPending=false;
      if(YarumoRTC::saveFromSystemClock()) Serial.println("DS3231 actualizado desde NTP");
    }
    if(portalOn)portal.handleClient();
    if(applyCredentials){
      applyCredentials=false;
      prefs.putString("ssid",nextSSID);
      prefs.putString("pwd",nextPassword);
      ssid=nextSSID;password=nextPassword;
      nextPassword="";
      stopPortal();
      notice("DATOS GUARDADOS","Conectando a la red...");
      connectStation();
    }
    int x=0,y=0;
    if(readTouch(x,y)){
      if(mode==Mode::OFFLINE && x>=13 && x<=307 && y>=104 && y<160)beginPortal();
      else if(mode==Mode::IDLE && x>=245 && y>=121)beginPortal();
      else if(mode==Mode::PORTAL && y>=120) {
        stopPortal();notice("CONFIGURACION","Cancelada");connectStation();
      }
    }
    if(digitalRead(BOOT_BUTTON)==LOW) {
      if(bootHeldAt==0)bootHeldAt=millis();
      else if(millis()-bootHeldAt>1200 && !portalOn){bootHeldAt=0;beginPortal();}
    }else bootHeldAt=0;
    if(portalOn){
      if(millis()-portalAt>PORTAL_TIMEOUT_MS) {
        stopPortal();notice("RED TEMPORAL","Tiempo agotado");connectStation();
      }
      return;
    }
    bool connected=WiFi.status()==WL_CONNECTED;
    if(connected&&!wasConnected){
      sntp_set_time_sync_notification_cb(onNtpSync);
      configTzTime("COT5","pool.ntp.org","time.google.com");
      wasConnected=true;
    }else if(!connected&&wasConnected){
      wasConnected=false;
    }
    if(!connected && !ssid.isEmpty() && millis()-lastRetry>RETRY_MS)connectStation();
    // Respetar bienvenida y notificaciones antes de pasar a reposo.
    if(mode==Mode::WELCOME && millis()-welcomeAt<2300)return;
    if(mode==Mode::NOTICE && (int32_t)(noticeUntil-millis())>0)return;
    if(!connected)offline();else idle();
  }
} // namespace YarumoUI
