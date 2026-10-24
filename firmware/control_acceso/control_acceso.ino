#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ArduinoJson.h>
#include <LiquidCrystal_I2C.h>

constexpr uint8_t SS_PIN = 5;
constexpr uint8_t RST_PIN = 4;
constexpr uint8_t RELAY_PIN = 27;
constexpr uint8_t LCD_SDA_PIN = 21;
constexpr uint8_t LCD_SCL_PIN = 22;
constexpr uint8_t LCD_ADDRESS = 0x27;
constexpr uint32_t OPEN_TIME_MS = 3000;
constexpr uint32_t HTTP_TIMEOUT_MS = 45000;
constexpr uint8_t ACCESS_REQUEST_ATTEMPTS = 3;
constexpr uint32_t RETRY_DELAY_MS = 2500;

const char* WIFI_SSID = "NOMBRE_WIFI";
const char* WIFI_PASSWORD = "CLAVE_WIFI";
const char* SERVER_URL = "https://control-acceso-nusefa.onrender.com/api/access";
const char* DEVICE_NAME = "Puerta principal";

MFRC522 rfid(SS_PIN, RST_PIN);
LiquidCrystal_I2C lcd(LCD_ADDRESS, 20, 4);
WiFiClientSecure secureClient;

enum AccessStatus {
  ACCESS_ALLOWED,
  ACCESS_DENIED,
  ACCESS_ERROR
};

void showIdle() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("CONTROL ACCESO");
  lcd.setCursor(0, 1);
  lcd.print("NUSEFA PEREIRA");
  printLine(2, "Acerque tarjeta");
  printLine(3, "Sistema listo");
}

void printLine(uint8_t row, const String& text) {
  lcd.setCursor(0, row);
  String padded = text.substring(0, 20);
  while (padded.length() < 20) padded += " ";
  lcd.print(padded);
}

String movementLabel(const String& movement) {
  if (movement == "ingreso") return "ENTRA";
  if (movement == "salida") return "SALE";
  return "MOVIMIENTO";
}

void showAccessResult(bool allowed, const String& personName, const String& movement, const String& uid) {
  lcd.clear();
  if (allowed) {
    printLine(0, "ACCESO PERMITIDO");
    printLine(1, movementLabel(movement) + ": " + personName);
    printLine(2, "UID " + uid);
    printLine(3, "Puerta autorizada");
    return;
  }

  printLine(0, "ACCESO DENEGADO");
  printLine(1, personName);
  printLine(2, "UID " + uid);
  printLine(3, "Revise registro");
}

void showConnectionError(const String& uid, const String& detail) {
  lcd.clear();
  printLine(0, "SIN RESPUESTA WEB");
  printLine(1, "No se abre puerta");
  printLine(2, "UID " + uid);
  printLine(3, detail);
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Conectando a WiFi");
  lcd.clear();
  printLine(0, "CONTROL ACCESO");
  printLine(1, "Conectando WiFi");
  printLine(2, WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("IP del ESP32: ");
  Serial.println(WiFi.localIP());
  printLine(1, "WiFi conectado");
  printLine(2, WiFi.localIP().toString());
  printLine(3, "Servidor listo");
  delay(1200);
}

String readUid() {
  String uid;
  for (byte index = 0; index < rfid.uid.size; index++) {
    if (rfid.uid.uidByte[index] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[index], HEX);
  }
  uid.toUpperCase();
  return uid;
}

AccessStatus requestAccess(const String& uid, String& personName, String& movement, String& errorDetail) {
  if (WiFi.status() != WL_CONNECTED) connectWifi();

  printLine(0, "Tarjeta leida");
  printLine(1, uid);
  printLine(2, "Consultando...");
  printLine(3, "Espere");

  JsonDocument request;
  request["uid"] = uid;
  request["device"] = DEVICE_NAME;
  // Identificador unico por lectura; se mantiene identico durante sus reintentos.
  request["requestId"] = String((uint32_t)esp_random(), HEX) + "-" +
      String((uint32_t)esp_random(), HEX) + "-" + String(millis(), HEX);
  String payload;
  serializeJson(request, payload);

  secureClient.setInsecure();

  for (uint8_t attempt = 1; attempt <= ACCESS_REQUEST_ATTEMPTS; attempt++) {
    HTTPClient http;
    const String serverUrl = SERVER_URL;
    bool started = serverUrl.startsWith("https://")
      ? http.begin(secureClient, SERVER_URL)
      : http.begin(SERVER_URL);
    if (!started) {
      errorDetail = "URL invalida";
      Serial.println("No se pudo iniciar HTTP");
      return ACCESS_ERROR;
    }

    http.setTimeout(HTTP_TIMEOUT_MS);
    http.addHeader("Content-Type", "application/json");

    printLine(2, "Consultando web");
    printLine(3, "Intento " + String(attempt) + "/" + String(ACCESS_REQUEST_ATTEMPTS));
    Serial.println("Enviando UID a servidor: " + uid);

    int statusCode = http.POST(payload);
    String responseBody = http.getString();
    http.end();

    if (statusCode != HTTP_CODE_OK) {
      errorDetail = statusCode > 0 ? "HTTP " + String(statusCode) : http.errorToString(statusCode);
      Serial.println("Error servidor: " + errorDetail);
      if (attempt < ACCESS_REQUEST_ATTEMPTS) {
        printLine(2, "Sin respuesta web");
        printLine(3, "Reintentando...");
        delay(RETRY_DELAY_MS);
      }
      continue;
    }

    JsonDocument response;
    DeserializationError error = deserializeJson(response, responseBody);
    if (error) {
      errorDetail = "JSON invalido";
      Serial.println("Respuesta JSON invalida: " + responseBody);
      if (attempt < ACCESS_REQUEST_ATTEMPTS) {
        printLine(2, "Respuesta invalida");
        printLine(3, "Reintentando...");
        delay(RETRY_DELAY_MS);
      }
      continue;
    }

    personName = response["name"] | "Desconocido";
    movement = response["movement"] | "";
    bool allowed = response["allowed"] | false;
    return allowed ? ACCESS_ALLOWED : ACCESS_DENIED;
  }

  return ACCESS_ERROR;
}

void openDoor(const String& movement) {
  printLine(3, movementLabel(movement) + " - Abriendo");
  digitalWrite(RELAY_PIN, HIGH);
  delay(OPEN_TIME_MS);
  digitalWrite(RELAY_PIN, LOW);
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);

  Wire.begin(LCD_SDA_PIN, LCD_SCL_PIN);
  lcd.init();
  lcd.backlight();
  printLine(0, "CONTROL ACCESO");
  printLine(1, "NUSEFA PEREIRA");
  printLine(2, "Iniciando...");
  printLine(3, "ESP32 + RFID");

  SPI.begin();
  rfid.PCD_Init();
  connectWifi();
  Serial.println("Acerque una tarjeta al RC522");
}

void loop() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) {
    delay(50);
    return;
  }

  String uid = readUid();
  String personName;
  String movement;
  String errorDetail;
  Serial.println("UID: " + uid);

  AccessStatus status = requestAccess(uid, personName, movement, errorDetail);

  if (status == ACCESS_ALLOWED) {
    showAccessResult(true, personName, movement, uid);
    Serial.println("Acceso permitido: " + personName + " - " + movement);
    openDoor(movement);
  } else if (status == ACCESS_DENIED) {
    showAccessResult(false, personName, movement, uid);
    Serial.println("Acceso denegado por servidor: " + personName);
    delay(2500);
  } else {
    showConnectionError(uid, errorDetail);
    Serial.println("Sin respuesta valida del servidor: " + errorDetail);
    delay(2500);
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  showIdle();
  delay(800);
}

