#pragma once

// Temporary "recording firmware" server: streams raw 16 kHz / 16-bit mono
// PCM to a single browser client over plain HTTP for the preset studio.
// Plain HTTP on the LAN by design (see README.md); never part of the
// production firmware.

#ifdef USE_ESP32

#include <atomic>
#include <cstdint>
#include <string>

#include <esp_http_server.h>

#include "esphome/components/binary_sensor/binary_sensor.h"
#include "esphome/components/microphone/microphone_source.h"
#include "esphome/components/ring_buffer/ring_buffer.h"

#include "esphome/core/component.h"

namespace esphome::capture_server {

static const uint32_t CAPTURE_STREAM_TASK_STACK = 6144;

// 32 KiB of internal RAM: ~1 s of 16 kHz / 16-bit mono. Absorbs httpd task
// scheduling jitter; on overflow whole mic chunks are dropped (counted)
// so the byte stream is never misaligned and nothing is inserted.
static constexpr size_t CAPTURE_RING_BUFFER_BYTES = 32 * 1024;
// Bytes per /api/stream chunk: 1920 B = 60 ms of audio.
static constexpr size_t CAPTURE_STREAM_CHUNK = 1920;
// Stack for the dedicated httpd task (stream handler uses a ~2 KiB buffer).
static constexpr uint32_t CAPTURE_HTTPD_STACK_SIZE = 8192;

static constexpr uint8_t CAPTURE_API_VERSION = 1;

class CaptureServer : public Component {
  SUB_BINARY_SENSOR(recording)

 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::AFTER_CONNECTION; }

  void set_microphone_source(microphone::MicrophoneSource *source) { this->mic_source_ = source; }
  void set_auth_key(const std::string &key) { this->auth_key_ = key; }
  void set_port(uint16_t port) { this->port_ = port; }
  void set_max_duration_s(uint32_t seconds) { this->max_duration_s_ = seconds; }
  void set_studio_url(const std::string &url) { this->studio_url_ = url; }
  void set_page_gzip(const uint8_t *data, size_t gz_len, size_t raw_len) {
    this->page_gzip_ = data;
    this->page_gzip_len_ = gz_len;
    this->page_raw_len_ = raw_len;
  }

  bool is_streaming() const { return this->streaming_.load(std::memory_order_acquire); }

 protected:
  static esp_err_t handle_root_(httpd_req_t *req);
  static esp_err_t handle_info_(httpd_req_t *req);
  static esp_err_t handle_stream_(httpd_req_t *req);

  // True when the request carries a valid bearer key. Sends 401 (or 429
  // while auth is locked after repeated failures) and returns false otherwise.
  bool check_auth_(httpd_req_t *req);
  void send_json_(httpd_req_t *req, int status, const char *body);
  void stream_pcm_(httpd_req_t *req);
  struct StreamCtx { CaptureServer *self; httpd_req_t *req; };
  static void stream_task_(void *arg);

  static bool constant_time_equal_(const std::string &a, const char *b, size_t b_len);

  microphone::MicrophoneSource *mic_source_{nullptr};
  std::string auth_key_;
  uint16_t port_{80};
  uint32_t max_duration_s_{1800};
  std::string studio_url_;
  const uint8_t *page_gzip_{nullptr};
  size_t page_gzip_len_{0};
  size_t page_raw_len_{0};

  httpd_handle_t server_{nullptr};
  std::shared_ptr<ring_buffer::RingBuffer> ring_buffer_{nullptr};

  // Set while a /api/stream response is being written (httpd task); gates the
  // mic callback so audio is only buffered while someone records.
  std::atomic<bool> streaming_{false};
  bool mic_started_{false};  // loop() only
  // Mic task only writes, httpd task only reads: chunks dropped since the
  // stream started (buffer overflow).
  std::atomic<uint32_t> cb_dropped_chunks_{0};
  // Failed auth attempts (httpd task only) and lock expiry (ms).
  uint32_t auth_failures_{0};
  uint32_t auth_lock_until_ms_{0};

  bool announce_logged_{false};
};

/// Recording state is exposed to Home Assistant through the
/// `binary_sensor` platform (`platform: capture_server`): ON while a
/// recording stream is active.
}  // namespace esphome::capture_server

#endif  // USE_ESP32
