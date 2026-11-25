// Temporary "recording firmware" server: single-client raw PCM streaming
// over plain HTTP for the preset studio (see README.md).
#include "capture_server.h"

#ifdef USE_ESP32

#include <cerrno>
#include <cinttypes>
#include <cstring>

#include <sys/socket.h>

#include "esphome/components/network/util.h"

#include "esphome/core/application.h"
#include "esphome/core/hal.h"
#include "esphome/core/log.h"

namespace esphome::capture_server {

static const char *const TAG = "capture_server";

// Copy at most cap-1 chars with '"' and '\\' escaped and C0 controls as
// \u00XX so user-chosen names cannot break the JSON responses.
static void json_escape_(const std::string &in, char *out, size_t cap) {
  size_t o = 0;
  for (char c : in) {
    if (c == '"' || c == '\\') {
      if (o + 2 >= cap) {
        break;
      }
      out[o++] = '\\';
      out[o++] = c;
    } else if (static_cast<unsigned char>(c) < 0x20) {
      if (o + 6 >= cap) {
        break;
      }
      o += (size_t) snprintf(out + o, cap - o, "\\u%04x", c);
    } else {
      if (o + 1 >= cap) {
        break;
      }
      out[o++] = c;
    }
  }
  out[o] = '\0';
}

void CaptureServer::setup() {
  if (this->mic_source_ == nullptr) {
    ESP_LOGE(TAG, "No microphone configured; capture server disabled");
    this->mark_failed();
    return;
  }
  if (this->auth_key_.size() < 16) {
    // The codegen schema enforces this; this is belt and braces.
    ESP_LOGE(TAG, "Auth key too short; capture server disabled");
    this->mark_failed();
    return;
  }
  if (this->page_gzip_ == nullptr || this->page_gzip_len_ == 0) {
    ESP_LOGE(TAG, "Capture page missing; capture server disabled");
    this->mark_failed();
    return;
  }
  this->ring_buffer_ = ring_buffer::RingBuffer::create(
      CAPTURE_RING_BUFFER_BYTES, ring_buffer::RingBuffer::MemoryPreference::INTERNAL_FIRST);
  if (this->ring_buffer_ == nullptr) {
    ESP_LOGE(TAG, "Failed to allocate the 32 KiB ring buffer; capture server disabled");
    this->mark_failed();
    return;
  }

  // Registered once; the callback only touches the ring buffer while a
  // recording stream is active (the detector keeps running undisturbed).
  this->mic_source_->add_data_callback([this](const microphone::AudioCapture &capture) {
    // Runs on the microphone task. Never block. Each chunk is stored whole
    // or dropped whole so the PCM byte stream is never misaligned.
    if (!this->streaming_.load(std::memory_order_acquire)) {
      return;
    }
    const size_t len = capture.data.size();
    if (len == 0) {
      return;
    }
    if (this->ring_buffer_->free() < len ||
        this->ring_buffer_->write_without_replacement(capture.data.data(), len, 0, true) != len) {
      this->cb_dropped_chunks_.fetch_add(1, std::memory_order_relaxed);
    }
  });

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.stack_size = CAPTURE_HTTPD_STACK_SIZE;
  config.server_port = this->port_;
  config.lru_purge_enable = true;
  if (httpd_start(&this->server_, &config) != ESP_OK) {
    ESP_LOGE(TAG, "Failed to start the HTTP server on port %u; capture server disabled",
             this->port_);
    this->mark_failed();
    return;
  }
  const httpd_uri_t root = {
      .uri = "/", .method = HTTP_GET, .handler = CaptureServer::handle_root_, .user_ctx = this};
  const httpd_uri_t info = {.uri = "/api/info",
                            .method = HTTP_GET,
                            .handler = CaptureServer::handle_info_,
                            .user_ctx = this};
  const httpd_uri_t stream = {.uri = "/api/stream",
                              .method = HTTP_GET,
                              .handler = CaptureServer::handle_stream_,
                              .user_ctx = this};
  if (httpd_register_uri_handler(this->server_, &root) != ESP_OK ||
      httpd_register_uri_handler(this->server_, &info) != ESP_OK ||
      httpd_register_uri_handler(this->server_, &stream) != ESP_OK) {
    ESP_LOGE(TAG, "Failed to register URI handlers; capture server disabled");
    httpd_stop(this->server_);
    this->server_ = nullptr;
    this->mark_failed();
    return;
  }
  ESP_LOGI(TAG, "HTTP server started on port %u", this->port_);
}

void CaptureServer::loop() {
  if (this->is_failed()) {
    return;
  }
  if (!this->announce_logged_ && network::is_connected()) {
    this->announce_logged_ = true;
    const auto addrs = network::get_ip_addresses();
    if (!addrs.empty()) {
      char buf[network::IP_ADDRESS_BUFFER_SIZE];
      ESP_LOGI(TAG, "Capture page: http://%s:%u/ (open it via the QR code in the preset studio)",
               addrs[0].str_to(buf), this->port_);
    } else {
      ESP_LOGI(TAG, "Capture page ready on port %u (open it via the QR code in the preset studio)",
               this->port_);
    }
  }
  const bool streaming = this->streaming_.load(std::memory_order_acquire);
  // Start/stop the microphone source here (ESPHome main loop), not in the HTTP task.
  if (!this->mic_source_->is_passive() && streaming != this->mic_started_) {
    if (streaming) this->mic_source_->start();
    else this->mic_source_->stop();
    this->mic_started_ = streaming;
  }
  if (this->recording_binary_sensor_ != nullptr &&
      this->recording_binary_sensor_->state != streaming) {
    this->recording_binary_sensor_->publish_state(streaming);
  }
}

void CaptureServer::dump_config() {
  ESP_LOGCONFIG(TAG, "Capture Server (temporary recording firmware):");
  ESP_LOGCONFIG(TAG, "  Port: %u", this->port_);
  ESP_LOGCONFIG(TAG, "  Max duration: %u s", this->max_duration_s_);
  ESP_LOGCONFIG(TAG, "  Studio URL: %s", this->studio_url_.c_str());
  ESP_LOGCONFIG(TAG, "  Capture page: %u bytes gzipped (%u raw)", (unsigned) this->page_gzip_len_,
                (unsigned) this->page_raw_len_);
  if (this->is_failed()) {
    ESP_LOGCONFIG(TAG, "  FAILED (see boot log)");
    return;
  }
  const auto stream = this->mic_source_->get_audio_stream_info();
  ESP_LOGCONFIG(TAG, "  Mic stream: %" PRIu32 " Hz / %u-bit / %u ch", stream.get_sample_rate(),
                stream.get_bits_per_sample(), stream.get_channels());
}

bool CaptureServer::constant_time_equal_(const std::string &a, const char *b, size_t b_len) {
  // Compares over the secret length; a length mismatch also fails.
  uint8_t diff = (a.size() != b_len) ? 1 : 0;
  for (size_t i = 0; i < a.size(); i++) {
    const uint8_t bb = (i < b_len) ? static_cast<uint8_t>(b[i]) : 0;
    diff |= static_cast<uint8_t>(a[i] ^ bb);
  }
  return diff == 0;
}

void CaptureServer::send_json_(httpd_req_t *req, int status, const char *body) {
  switch (status) {
    case 401:
      httpd_resp_set_status(req, "401 Unauthorized");
      break;
    case 404:
      httpd_resp_set_status(req, "404 Not Found");
      break;
    case 409:
      httpd_resp_set_status(req, "409 Conflict");
      break;
    case 429:
      httpd_resp_set_status(req, "429 Too Many Requests");
      break;
    case 500:
      httpd_resp_set_status(req, "500 Internal Server Error");
      break;
    default:
      httpd_resp_set_status(req, "200 OK");
      break;
  }
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  httpd_resp_send(req, body, HTTPD_RESP_USE_STRLEN);
}

bool CaptureServer::check_auth_(httpd_req_t *req) {
  auto *self = static_cast<CaptureServer *>(req->user_ctx);
  const uint32_t now = millis();
  if (self->auth_lock_until_ms_ != 0 && (int32_t) (now - self->auth_lock_until_ms_) < 0) {
    self->send_json_(req, 429, "{\"error\":\"rate_limited\"}");
    return false;
  }
  bool ok = false;
  const size_t hdr_len = httpd_req_get_hdr_value_len(req, "Authorization");
  if (hdr_len > 0 && hdr_len < 256) {
    char val[256];
    if (httpd_req_get_hdr_value_str(req, "Authorization", val, sizeof(val)) == ESP_OK) {
      static const char PREFIX[] = "Bearer ";
      static const size_t PRE_LEN = sizeof(PREFIX) - 1;
      const size_t vlen = strlen(val);
      if (vlen > PRE_LEN && strncmp(val, PREFIX, PRE_LEN) == 0) {
        ok = constant_time_equal_(self->auth_key_, val + PRE_LEN, vlen - PRE_LEN);
      }
    }
  }
  if (ok) {
    self->auth_failures_ = 0;
    return true;
  }
  // Never log the key (or the presented value).
  self->auth_failures_++;
  if (self->auth_failures_ >= 10) {
    self->auth_failures_ = 0;
    self->auth_lock_until_ms_ = now + 30000;
    ESP_LOGW(TAG, "Too many failed auth attempts; auth locked for 30 s");
    self->send_json_(req, 429, "{\"error\":\"rate_limited\"}");
  } else {
    ESP_LOGW(TAG, "Unauthorized request (attempt %u/10)", (unsigned) self->auth_failures_);
    self->send_json_(req, 401, "{\"error\":\"unauthorized\"}");
  }
  return false;
}

esp_err_t CaptureServer::handle_root_(httpd_req_t *req) {
  auto *self = static_cast<CaptureServer *>(req->user_ctx);
  httpd_resp_set_type(req, "text/html");
  httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  httpd_resp_send(req, reinterpret_cast<const char *>(self->page_gzip_), self->page_gzip_len_);
  return ESP_OK;
}

esp_err_t CaptureServer::handle_info_(httpd_req_t *req) {
  auto *self = static_cast<CaptureServer *>(req->user_ctx);
  if (!self->check_auth_(req)) {
    return ESP_OK;
  }
  char name[64], friendly[96], url[192];
  json_escape_(App.get_name(), name, sizeof(name));
  json_escape_(App.get_friendly_name(), friendly, sizeof(friendly));
  json_escape_(self->studio_url_, url, sizeof(url));
  char body[512];
  const int n = snprintf(body, sizeof(body),
                         "{\"name\":\"%s\",\"friendly_name\":\"%s\",\"sample_rate\":16000,\"bits\":16,"
                         "\"channels\":1,\"max_duration_s\":%u,\"studio_url\":\"%s\",\"version\":1,"
                         "\"busy\":%s}",
                         name, friendly, (unsigned) self->max_duration_s_, url,
                         self->is_streaming() ? "true" : "false");
  if (n <= 0 || (size_t) n >= sizeof(body)) {
    self->send_json_(req, 500, "{\"error\":\"internal\"}");
    return ESP_OK;
  }
  self->send_json_(req, 200, body);
  return ESP_OK;
}

esp_err_t CaptureServer::handle_stream_(httpd_req_t *req) {
  auto *self = static_cast<CaptureServer *>(req->user_ctx);
  if (!self->check_auth_(req)) {
    return ESP_OK;
  }
  bool expected = false;
  if (!self->streaming_.compare_exchange_strong(expected, true)) {
    self->send_json_(req, 409, "{\"error\":\"busy\"}");
    return ESP_OK;
  }
  const auto stream = self->mic_source_->get_audio_stream_info();
  if (stream.get_sample_rate() != 16000 || stream.get_channels() != 1) {
    ESP_LOGE(TAG, "Microphone stream must be 16 kHz mono for capture, got %" PRIu32
                  " Hz / %u ch; not starting",
             stream.get_sample_rate(), stream.get_channels());
    self->streaming_.store(false, std::memory_order_release);
    self->send_json_(req, 500, "{\"error\":\"unsupported_format\"}");
    return ESP_OK;
  }
  self->ring_buffer_->reset();
  self->cb_dropped_chunks_.store(0, std::memory_order_relaxed);
  // The microphone source is started by loop() once it sees streaming_ (refcounted
  // with the detector, which keeps running).
  ESP_LOGI(TAG, "Recording stream started");
  httpd_resp_set_status(req, "200 OK");
  httpd_resp_set_type(req, "application/octet-stream");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  // Stream from a separate task so the HTTP server stays responsive (page, info,
  // "busy" for a second client) while recording.
  httpd_req_t *async_req = nullptr;
  if (httpd_req_async_handler_begin(req, &async_req) == ESP_OK) {
    auto *ctx = new StreamCtx{self, async_req};
    if (xTaskCreate(&CaptureServer::stream_task_, "capture_stream", CAPTURE_STREAM_TASK_STACK, ctx, 5, nullptr) == pdPASS) {
      return ESP_OK;
    }
    delete ctx;
    httpd_req_async_handler_complete(async_req);
    ESP_LOGW(TAG, "Could not start the stream task; streaming synchronously");
  }
  self->stream_pcm_(req);
  self->streaming_.store(false, std::memory_order_release);
  ESP_LOGI(TAG, "Recording stream ended");
  return ESP_OK;
}

void CaptureServer::stream_task_(void *arg) {
  auto *ctx = static_cast<StreamCtx *>(arg);
  ctx->self->stream_pcm_(ctx->req);
  httpd_req_async_handler_complete(ctx->req);
  ctx->self->streaming_.store(false, std::memory_order_release);
  ESP_LOGI(TAG, "Recording stream ended");
  delete ctx;
  vTaskDelete(nullptr);
}

void CaptureServer::stream_pcm_(httpd_req_t *req) {
  uint8_t buf[CAPTURE_STREAM_CHUNK];  // 60 ms of audio; the httpd task has an 8 KiB stack
  const int fd = httpd_req_to_sockfd(req);
  const uint32_t start_ms = millis();
  bool truncated = false;
  const char *reason = "";
  esp_err_t send_err = ESP_OK;
  size_t sent = 0;
  for (;;) {
    // Abort promptly (within ~1 s) when the browser aborts the fetch, even
    // if no audio is flowing: an orderly client close reads as 0.
    // Only an orderly close (0) means the client left; errors here are ignored
    // because continuous audio makes the next send fail if the peer is gone.
    char probe = 0;
    if (recv(fd, &probe, 1, MSG_PEEK | MSG_DONTWAIT) == 0) {
      reason = "client closed";
      break;
    }
    const size_t got = this->ring_buffer_->read(buf, sizeof(buf), pdMS_TO_TICKS(50));
    if (got > 0) {
      const esp_err_t err = httpd_resp_send_chunk(req, reinterpret_cast<const char *>(buf), got);
      if (err != ESP_OK) {
        reason = "send failed";
        send_err = err;
        break;  // client gone
      }
      sent += got;
    }
    if ((uint64_t) (millis() - start_ms) >= (uint64_t) this->max_duration_s_ * 1000u) {
      truncated = true;
      reason = "max duration reached";
      break;
    }
  }
  // Terminates the chunked response; fails silently if the client is gone.
  httpd_resp_send_chunk(req, nullptr, 0);
  const uint32_t dropped = this->cb_dropped_chunks_.load(std::memory_order_relaxed);
  ESP_LOGI(TAG, "Stream closed (%s%s%s) after %.1f s audio; dropped %u chunk(s) to backpressure",
           reason, send_err != ESP_OK ? ": " : "", send_err != ESP_OK ? esp_err_to_name(send_err) : "",
           sent / 32000.0f, (unsigned) dropped);
  (void) truncated;
}

}  // namespace esphome::capture_server

#endif  // USE_ESP32
