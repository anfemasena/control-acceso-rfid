#pragma once
// Reloj opcional DS3231 para Yarumo Acceso (I2C compartido con AXS5106L).
// Sin RTC, el ESP32 usa NTP. Nunca se acepta una fecha con OSF activo.
#include <Wire.h>
#include <time.h>
#include <sys/time.h>

namespace YarumoRTC {
static constexpr uint8_t ADDRESS = 0x68;
static bool detected = false;

static uint8_t decode(uint8_t x) {return static_cast<uint8_t>((x >> 4) * 10 + (x & 15));}
static uint8_t encode(uint8_t x) {return static_cast<uint8_t>(((x / 10) << 4) | (x % 10));}

static bool readRegisters(uint8_t offset, uint8_t *out, uint8_t count) {
  Wire.beginTransmission(ADDRESS);
  Wire.write(offset);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(ADDRESS,count) != count) return false;
  for (uint8_t i = 0; i < count; ++i) out[i] = Wire.read();
  return true;
}

static bool writeRegister(uint8_t offset, uint8_t data) {
  Wire.beginTransmission(ADDRESS);
  Wire.write(offset);
  Wire.write(data);
  return Wire.endTransmission() == 0;
}

static bool restore() {
  uint8_t status=0, regs[7]={0};
  detected=readRegisters(0x0F,&status,1);
  if (!detected || (status & 0x80)) return false; // OSF: reloj detenido o sin configurar.
  if (!readRegisters(0x00,regs,7)) return false;
  if (regs[2] & 0x40) return false; // Solo modo 24 h.
  const int sec=decode(regs[0]&0x7F);
  const int min=decode(regs[1]&0x7F);
  const int hour=decode(regs[2]&0x3F);
  const int day=decode(regs[4]&0x3F);
  const int mon=decode(regs[5]&0x1F);
  const int year=2000+decode(regs[6]);
  if (sec>59 || min>59 || hour>23 || day<1 || day>31 ||
      mon<1 || mon>12 || year<2024 || year>2099) return false;
  struct tm local={};
  local.tm_sec=sec;local.tm_min=min;local.tm_hour=hour;
  local.tm_mday=day;local.tm_mon=mon-1;local.tm_year=year-1900;
  local.tm_isdst=0;
  time_t unixTime=mktime(&local); // TZ ya está establecida como COT5.
  if (unixTime < 1700000000) return false;
  struct tm verified={};localtime_r(&unixTime,&verified);
  if(verified.tm_year != year-1900 || verified.tm_mon != mon-1 ||
     verified.tm_mday != day || verified.tm_hour != hour ||
     verified.tm_min != min || verified.tm_sec != sec) return false;
  struct timeval tv={unixTime,0};
  return settimeofday(&tv,nullptr) == 0;
}

static bool saveFromSystemClock() {
  if (!detected || time(nullptr) < 1700000000) return false;
  time_t now=time(nullptr);struct tm t={};localtime_r(&now,&t);
  if(t.tm_year+1900>2099) return false;
  Wire.beginTransmission(ADDRESS);
  Wire.write((uint8_t)0x00);
  Wire.write(encode(t.tm_sec));
  Wire.write(encode(t.tm_min));
  Wire.write(encode(t.tm_hour));
  Wire.write(encode(t.tm_wday+1));
  Wire.write(encode(t.tm_mday));
  Wire.write(encode(t.tm_mon+1));
  Wire.write(encode(t.tm_year+1900-2000));
  if (Wire.endTransmission() != 0) return false;
  uint8_t status=0;
  if (!readRegisters(0x0F,&status,1))return false;
  return writeRegister(0x0F,status & 0x7F); // Limpiar OSF después de fijar hora.
}
} // namespace YarumoRTC
