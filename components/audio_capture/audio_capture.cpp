#include "audio_capture.h"

#ifdef USE_ESP32

#include <atomic>
#include <cerrno>
#include <cinttypes>
#include <cstring>

#include <esp_idf_version.h>
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(6, 0, 0)
#include <psa/crypto.h>
#define AUDIO_CAPTURE_CRYPTO_PSA
#else
#include "mbedtls/gcm.h"
#endif
#include <esp_random.h>
#include <esp_system.h>

#ifdef USE_WIFI
#include "esphome/components/wifi/wifi_component.h"
#endif
#include "esphome/components/hmac_sha256/hmac_sha256.h"

#include "esphome/core/application.h"
#include "esphome/core/hal.h"
#include "esphome/core/log.h"
#include "esphome/core/version.h"

namespace esphome::audio_capture {

static const char *const TAG = "audio_capture";

// Protocol v1 constants (mirrored in docs/capture_protocol.md).
static const char MAGIC[4] = {'T', 'M', 'X', 'C'};
static const uint8_t PROTO_VERSION = 1;
static const size_t NONCE_SIZE = 16;  // nonce_s / nonce_c length
static const size_t IV_SIZE = 12;     // 4-byte BE direction 0x00000001 + u64 LE counter
static const size_t KEY_SIZE = 32;
static const size_t TAG_SIZE = 16;
static const size_t RING_BUFFER_SIZE = 65536;
static const uint32_t HANDSHAKE_TIMEOUT_MS = 5000;
static const uint32_t STATS_INTERVAL_MS = 5000;
// Max audio payload bytes per encrypted frame. Divisible by 2, 3 and 4 so frames of
// 16/24/32-bit mono PCM are never split (~56 ms at 48 kHz / 24-bit).
static const size_t MAX_AUDIO_PAYLOAD = 8064;
// Emit a partial audio frame when the ring buffer runs dry only once this much is pending,
// to keep per-frame overhead low.
static const size_t MIN_IDLE_PAYLOAD = 3072;
// Cap work per loop() so the main loop is never starved.
static const size_t MAX_FRAMES_PER_LOOP = 6;
// Fixed-capacity encrypted TX backlog, allocated once. No PSRAM on the target, so the
// backlog must never grow: when it is full, audio stays in the ring buffer
// (backpressure) and the mic callback drops whole chunks, recording the gap.
static const size_t TX_CAPACITY = 24576;
// [u32 len][12 IV][u8 type][16 tag]
static const size_t FRAME_OVERHEAD = 4 + 12 + 1 + 16;
// Ring buffer chunk record header: [u32 data_len][u32 frames_dropped_before_this_chunk]
static const size_t CHUNK_HDR = 8;
static const size_t MAX_MARKER_LABEL = 120;

static uint32_t get_u32_le(const uint8_t *p) {
  return (uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16) | ((uint32_t) p[3] << 24);
}

static void put_u32_le(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t) v;
  p[1] = (uint8_t) (v >> 8);
  p[2] = (uint8_t) (v >> 16);
  p[3] = (uint8_t) (v >> 24);
}

static void put_u64_le(uint8_t *p, uint64_t v) {
  for (int i = 0; i < 8; i++) {
    p[i] = (uint8_t) (v >> (8 * i));
  }
}

static void hmac_sha256_oneshot(const uint8_t *key, size_t key_len, const uint8_t *parts[],
                                const size_t part_lens[], size_t num_parts, uint8_t out[32]) {
  hmac_sha256::HmacSHA256 hmac;
  hmac.init(key, key_len);
  for (size_t i = 0; i < num_parts; i++) {
    hmac.add(parts[i], part_lens[i]);
  }
  hmac.calculate();
  hmac.get_bytes(out);
}

void AudioCaptureComponent::setup() {
  if (this->psk_.size() < 16) {
    ESP_LOGE(TAG, "PSK too short (>= 16 chars required); capture disabled");
    this->mark_failed();
    return;
  }
  this->ring_buffer_ =
      ring_buffer::RingBuffer::create(RING_BUFFER_SIZE, ring_buffer::RingBuffer::MemoryPreference::INTERNAL_FIRST);
  if (this->ring_buffer_ == nullptr) {
    ESP_LOGE(TAG, "Failed to allocate %u byte ring buffer; capture disabled", (unsigned) RING_BUFFER_SIZE);
    this->mark_failed();
    return;
  }
  this->tx_pending_.reserve(TX_CAPACITY);
  this->audio_pending_.reserve(MAX_AUDIO_PAYLOAD);
  this->mic_source_->add_data_callback([this](const microphone::AudioCapture &capture) {
    // Runs on the microphone task. Never block. Each chunk is stored as a record
    // [u32 len][u32 dropped_frames_before][pcm], written only if it fits entirely,
    // so PCM frames are never split and gaps are reported with exact length.
    if (!this->accepting_audio_.load(std::memory_order_acquire)) {
      return;
    }
    const size_t len = capture.data.size();
    if (len == 0) {
      return;
    }
    if (this->ring_buffer_->free() < CHUNK_HDR + len) {
      this->cb_gap_frames_ += (uint32_t) (len / this->stream_bytes_per_frame_);
      this->dropped_bytes_.fetch_add((uint32_t) len, std::memory_order_relaxed);
      return;
    }
    uint8_t hdr[CHUNK_HDR];
    put_u32_le(hdr, (uint32_t) len);
    put_u32_le(hdr + 4, this->cb_gap_frames_);
    this->ring_buffer_->write_without_replacement(hdr, CHUNK_HDR, 0, true);
    this->ring_buffer_->write_without_replacement(capture.data.data(), len, 0, true);
    this->cb_gap_frames_ = 0;
  });
}

void AudioCaptureComponent::dump_config() {
  ESP_LOGCONFIG(TAG, "Audio Capture v1:");
  ESP_LOGCONFIG(TAG, "  Port: %u", this->port_);
  ESP_LOGCONFIG(TAG, "  Enabled: %s", YESNO(this->enabled_));
}

bool AudioCaptureComponent::ensure_listen_socket_() {
  if (this->listen_socket_ != nullptr) {
    return true;
  }
  this->listen_socket_ = socket::socket_ip_loop_monitored(SOCK_STREAM, 0);
  if (this->listen_socket_ == nullptr) {
    ESP_LOGE(TAG, "Socket creation failed");
    return false;
  }
  int reuse = 1;
  this->listen_socket_->setsockopt(SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
  if (this->listen_socket_->setblocking(false) != 0) {
    ESP_LOGE(TAG, "Failed to set non-blocking mode");
    this->listen_socket_.reset();
    return false;
  }
  struct sockaddr_storage addr {};
  socklen_t addrlen = socket::set_sockaddr_any((struct sockaddr *) &addr, sizeof(addr), this->port_);
  if (addrlen == 0 || this->listen_socket_->bind((struct sockaddr *) &addr, addrlen) != 0 ||
      this->listen_socket_->listen(1) != 0) {
    ESP_LOGE(TAG, "Failed to bind/listen on port %u (errno %d)", this->port_, errno);
    this->listen_socket_.reset();
    return false;
  }
  ESP_LOGI(TAG, "Listening on port %u", this->port_);
  return true;
}

void AudioCaptureComponent::set_enabled(bool enabled) {
  if (enabled && !this->enabled_) {
    if (this->is_failed()) {
      ESP_LOGE(TAG, "Cannot enable: component failed (see boot log)");
      return;
    }
    this->enabled_ = true;
    if (!this->ensure_listen_socket_()) {
      this->enabled_ = false;
      return;
    }
    ESP_LOGI(TAG, "Capture enabled");
  } else if (!enabled && this->enabled_) {
    this->enabled_ = false;
    this->close_client_();
    this->listen_socket_.reset();
    if (this->mic_source_ != nullptr && !this->mic_source_->is_passive()) {
      this->mic_source_->stop();
    }
    if (this->client_connected_binary_sensor_ != nullptr) {
      this->client_connected_binary_sensor_->publish_state(false);
    }
    ESP_LOGI(TAG, "Capture disabled");
  } else if (enabled && this->enabled_) {
    this->ensure_listen_socket_();
  }
}

void AudioCaptureComponent::loop() {
  if (!this->enabled_ || this->is_failed()) {
    return;
  }
  if (!this->ensure_listen_socket_()) {
    return;
  }

  if (this->session_ == SessionState::IDLE) {
    this->accept_client_();
  } else if (this->session_ == SessionState::HANDSHAKE_RX) {
    this->poll_handshake_();
  } else {
    this->poll_stream_();
  }

  bool connected = this->is_client_connected();
  if (this->client_connected_binary_sensor_ != nullptr &&
      this->client_connected_binary_sensor_->state != connected) {
    this->client_connected_binary_sensor_->publish_state(connected);
  }
  if (this->dropped_bytes_sensor_ != nullptr) {
    float dropped = (float) this->dropped_bytes_.load(std::memory_order_relaxed);
    if (dropped != this->dropped_bytes_sensor_->get_raw_state()) {
      this->dropped_bytes_sensor_->publish_state(dropped);
    }
  }
}

bool AudioCaptureComponent::accept_client_() {
  if (!this->listen_socket_->ready()) {
    return false;
  }
  struct sockaddr_storage peer {};
  socklen_t peerlen = sizeof(peer);
  auto client = this->listen_socket_->accept((struct sockaddr *) &peer, &peerlen);
  if (client == nullptr) {
    return false;
  }
  if (this->client_ != nullptr) {
    // At most one client; reject extras immediately (destructor closes the socket).
    ESP_LOGW(TAG, "Rejecting second client (busy)");
    return true;
  }
  if (client->setblocking(false) != 0) {
    ESP_LOGW(TAG, "Failed to set client non-blocking; dropping");
    return true;
  }
  // Fresh session state.
  this->accepting_audio_.store(false, std::memory_order_release);
  this->ring_buffer_->reset();
  this->cb_gap_frames_ = 0;
  this->chunk_remaining_ = 0;
  this->pending_gap_frames_ = 0;
  this->audio_pending_.clear();
  this->tx_pending_.clear();
  this->tx_pending_off_ = 0;
  this->marker_queue_.clear();
  this->dropped_bytes_.store(0, std::memory_order_relaxed);
  this->sample_index_ = 0;
  this->tx_counter_ = 0;
  this->handshake_rx_bytes_ = 0;
  auto stream = this->mic_source_->get_audio_stream_info();
  this->stream_bits_per_sample_ = stream.get_bits_per_sample();
  this->stream_channels_ = stream.get_channels();
  this->stream_sample_rate_ = stream.get_sample_rate();
  this->stream_bytes_per_frame_ =
      (size_t) this->stream_channels_ * ((this->stream_bits_per_sample_ + 7) / 8);
  if (this->stream_bytes_per_frame_ == 0) {
    ESP_LOGW(TAG, "Bad stream info; dropping client");
    return true;
  }

  esp_fill_random(this->nonce_s_, sizeof(this->nonce_s_));
  uint8_t hello[5 + NONCE_SIZE];
  memcpy(hello, MAGIC, 4);
  hello[4] = PROTO_VERSION;
  memcpy(hello + 5, this->nonce_s_, NONCE_SIZE);
  if (client->write(hello, sizeof(hello)) != (ssize_t) sizeof(hello)) {
    ESP_LOGW(TAG, "Failed to send handshake hello; dropping client");
    return true;
  }
  this->client_ = std::move(client);
  this->session_ = SessionState::HANDSHAKE_RX;
  this->session_start_ms_ = millis();
  ESP_LOGI(TAG, "Client connected, handshake started");
  return true;
}

void AudioCaptureComponent::derive_session_keys_() {
  // session_key = HMAC(psk, "tmxcap1-key" || nonce_s || nonce_c)
  const uint8_t *parts[] = {(const uint8_t *) "tmxcap1-key", this->nonce_s_, this->nonce_c_};
  const size_t lens[] = {11, NONCE_SIZE, NONCE_SIZE};
  hmac_sha256_oneshot((const uint8_t *) this->psk_.data(), this->psk_.size(), parts, lens, 3, this->session_key_);
}

bool AudioCaptureComponent::constant_time_equal_(const uint8_t *a, const uint8_t *b, size_t len) {
  uint8_t diff = 0;
  for (size_t i = 0; i < len; i++) {
    diff |= (uint8_t) (a[i] ^ b[i]);
  }
  return diff == 0;
}

void AudioCaptureComponent::poll_handshake_() {
  if (millis() - this->session_start_ms_ > HANDSHAKE_TIMEOUT_MS) {
    ESP_LOGW(TAG, "Handshake timeout");
    this->close_client_();
    return;
  }
  size_t want = sizeof(this->handshake_rx_) - this->handshake_rx_bytes_;
  if (want == 0) {
    this->close_client_();
    return;
  }
  ssize_t n = this->client_->read(this->handshake_rx_ + this->handshake_rx_bytes_, want);
  if (n < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      return;  // wait for more data
    }
    ESP_LOGW(TAG, "Handshake read error (errno %d)", errno);
    this->close_client_();
    return;
  }
  if (n == 0) {
    ESP_LOGI(TAG, "Client closed during handshake");
    this->close_client_();
    return;
  }
  this->handshake_rx_bytes_ += (size_t) n;
  if (this->handshake_rx_bytes_ < sizeof(this->handshake_rx_)) {
    return;  // need 16-byte nonce_c + 32-byte auth tag
  }
  memcpy(this->nonce_c_, this->handshake_rx_, NONCE_SIZE);
  // expected = HMAC(psk, "tmxcap1-auth" || nonce_s || nonce_c)
  const uint8_t *parts[] = {(const uint8_t *) "tmxcap1-auth", this->nonce_s_, this->nonce_c_};
  const size_t lens[] = {12, NONCE_SIZE, NONCE_SIZE};
  uint8_t expected[KEY_SIZE];
  hmac_sha256_oneshot((const uint8_t *) this->psk_.data(), this->psk_.size(), parts, lens, 3, expected);
  if (!constant_time_equal_(expected, this->handshake_rx_ + NONCE_SIZE, KEY_SIZE)) {
    ESP_LOGW(TAG, "Handshake auth failed; closing");
    this->close_client_();
    return;
  }
  this->derive_session_keys_();
  // server proof = HMAC(psk, "tmxcap1-srv" || nonce_c || nonce_s)
  const uint8_t *srv_parts[] = {(const uint8_t *) "tmxcap1-srv", this->nonce_c_, this->nonce_s_};
  const size_t srv_lens[] = {11, NONCE_SIZE, NONCE_SIZE};
  uint8_t proof[KEY_SIZE];
  hmac_sha256_oneshot((const uint8_t *) this->psk_.data(), this->psk_.size(), srv_parts, srv_lens, 3, proof);
  ssize_t w = this->client_->write(proof, sizeof(proof));
  memset(proof, 0, sizeof(proof));
  if (w != (ssize_t) sizeof(proof)) {
    ESP_LOGW(TAG, "Failed to send server proof");
    this->close_client_();
    return;
  }
  // Start the microphone (refcounted by the I2S driver; shared safely with sound_level).
  if (!this->mic_source_->is_passive()) {
    this->mic_source_->start();
  }
  this->session_ = SessionState::STREAMING;
  this->accepting_audio_.store(true, std::memory_order_release);
  this->last_stats_ms_ = millis();
  ESP_LOGI(TAG, "Handshake OK, streaming %" PRIu32 " Hz / %u-bit / %u ch", this->stream_sample_rate_,
           this->stream_bits_per_sample_, this->stream_channels_);
  if (!this->send_header_frame_()) {
    this->close_client_();
  }
}

bool AudioCaptureComponent::flush_tx_() {
  while (this->tx_pending_off_ < this->tx_pending_.size()) {
    ssize_t n = this->client_->write(this->tx_pending_.data() + this->tx_pending_off_,
                                     this->tx_pending_.size() - this->tx_pending_off_);
    if (n > 0) {
      this->tx_pending_off_ += (size_t) n;
      continue;
    }
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      // Socket buffer full: compact (capacity is preserved, no reallocation) and retry later.
      if (this->tx_pending_off_ > 0) {
        this->tx_pending_.erase(this->tx_pending_.begin(), this->tx_pending_.begin() + this->tx_pending_off_);
        this->tx_pending_off_ = 0;
      }
      return true;
    }
    return false;  // hard error
  }
  this->tx_pending_.clear();
  this->tx_pending_off_ = 0;
  return true;
}

size_t AudioCaptureComponent::tx_free_() const { return TX_CAPACITY - this->tx_pending_.size(); }

bool AudioCaptureComponent::encrypt_and_queue_(uint8_t type, const uint8_t *p1, size_t l1, const uint8_t *p2,
                                               size_t l2) {
  const size_t pt_len = 1 + l1 + l2;
  const uint32_t enc_len = (uint32_t) (IV_SIZE + pt_len + TAG_SIZE);
  if (4 + enc_len > this->tx_free_()) {
    return false;  // caller must check tx_free_() first; never grow the buffer
  }
  // Frame layout in the TX buffer: [u32 len][IV][plaintext -> ciphertext in place][tag]
  const size_t base = this->tx_pending_.size();
  this->tx_pending_.resize(base + 4 + enc_len);  // within reserved capacity: no reallocation
  uint8_t *len_prefix = this->tx_pending_.data() + base;
  uint8_t *iv = len_prefix + 4;
  uint8_t *body = iv + IV_SIZE;
  uint8_t *tag = body + pt_len;
  put_u32_le(len_prefix, enc_len);
  // 12-byte GCM nonce = 4-byte BE direction (0x00000001 server->client) + u64 LE counter.
  iv[0] = 0;
  iv[1] = 0;
  iv[2] = 0;
  iv[3] = 1;
  put_u64_le(iv + 4, this->tx_counter_);
  body[0] = type;
  if (l1 > 0) {
    memcpy(body + 1, p1, l1);
  }
  if (l2 > 0) {
    memcpy(body + 1 + l1, p2, l2);
  }
  bool ok = false;
#ifdef AUDIO_CAPTURE_CRYPTO_PSA
  std::vector<uint8_t> pt(body, body + pt_len);  // PSA does not guarantee in-place operation
  psa_key_attributes_t attrs = PSA_KEY_ATTRIBUTES_INIT;
  psa_set_key_type(&attrs, PSA_KEY_TYPE_AES);
  psa_set_key_bits(&attrs, KEY_SIZE * 8);
  psa_set_key_usage_flags(&attrs, PSA_KEY_USAGE_ENCRYPT);
  psa_set_key_algorithm(&attrs, PSA_ALG_GCM);
  mbedtls_svc_key_id_t key_id = MBEDTLS_SVC_KEY_ID_INIT;
  if (psa_import_key(&attrs, this->session_key_, KEY_SIZE, &key_id) == PSA_SUCCESS) {
    size_t olen = 0;
    psa_status_t st = psa_aead_encrypt(key_id, PSA_ALG_GCM, iv, IV_SIZE, len_prefix, 4, pt.data(), pt_len, body,
                                       pt_len + TAG_SIZE, &olen);
    ok = st == PSA_SUCCESS && olen == pt_len + TAG_SIZE;
    psa_destroy_key(key_id);
  }
#else
  mbedtls_gcm_context gcm;
  mbedtls_gcm_init(&gcm);
  // mbedtls GCM supports exact in-place operation (input == output).
  ok = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, this->session_key_, KEY_SIZE * 8) == 0 &&
       mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT, pt_len, iv, IV_SIZE, len_prefix, 4, body, body,
                                 TAG_SIZE, tag) == 0;
  mbedtls_gcm_free(&gcm);
#endif
  if (!ok) {
    this->tx_pending_.resize(base);
    return false;
  }
  this->tx_counter_++;
  return true;
}

bool AudioCaptureComponent::send_header_frame_() {
  char json[256];
  int n = snprintf(json, sizeof(json),
                   "{\"sample_rate\":%" PRIu32 ",\"bits_per_sample\":%u,\"channels\":%u,"
                   "\"node\":\"%s\",\"esphome\":\"%s\",\"uptime_ms\":%" PRIu32 "}",
                   this->stream_sample_rate_, this->stream_bits_per_sample_, this->stream_channels_,
                   App.get_name().c_str(), ESPHOME_VERSION, millis());
  if (n <= 0 || (size_t) n >= sizeof(json)) {
    return false;
  }
  return this->encrypt_and_queue_(FRAME_TYPE_HEADER, (const uint8_t *) json, (size_t) n, nullptr, 0);
}

bool AudioCaptureComponent::send_stats_frame_() {
  int8_t rssi = 0;
  bool has_rssi = false;
#ifdef USE_WIFI
  if (wifi::global_wifi_component != nullptr) {
    rssi = wifi::global_wifi_component->wifi_rssi();
    has_rssi = true;
  }
#endif
  char json[192];
  int n;
  uint32_t dropped = this->dropped_bytes_.load(std::memory_order_relaxed);
  if (has_rssi) {
    n = snprintf(json, sizeof(json),
                 "{\"dropped_bytes\":%" PRIu32 ",\"rssi_dbm\":%d,\"free_heap\":%u,\"uptime_ms\":%" PRIu32 "}",
                 dropped, (int) rssi, (unsigned) esp_get_free_heap_size(), millis());
  } else {
    n = snprintf(json, sizeof(json),
                 "{\"dropped_bytes\":%" PRIu32 ",\"rssi_dbm\":null,\"free_heap\":%u,\"uptime_ms\":%" PRIu32 "}",
                 dropped, (unsigned) esp_get_free_heap_size(), millis());
  }
  if (n <= 0 || (size_t) n >= sizeof(json)) {
    return false;
  }
  return this->encrypt_and_queue_(FRAME_TYPE_STATS, (const uint8_t *) json, (size_t) n, nullptr, 0);
}

bool AudioCaptureComponent::send_marker_frame_(uint64_t sample_index, const std::string &label) {
  std::string safe = label.substr(0, MAX_MARKER_LABEL);
  uint8_t idx[8];
  put_u64_le(idx, sample_index);
  return this->encrypt_and_queue_(FRAME_TYPE_MARKER, idx, 8, (const uint8_t *) safe.data(), safe.size());
}

bool AudioCaptureComponent::emit_audio_frame_() {
  // Send the frame-aligned part of audio_pending_. Returns false on backpressure / nothing to send.
  size_t n = this->audio_pending_.size();
  n -= n % this->stream_bytes_per_frame_;
  if (n == 0 || this->tx_free_() < FRAME_OVERHEAD + 8 + n) {
    return false;
  }
  uint8_t idx[8];
  put_u64_le(idx, this->sample_index_);
  if (!this->encrypt_and_queue_(FRAME_TYPE_AUDIO, idx, 8, this->audio_pending_.data(), n)) {
    return false;
  }
  this->sample_index_ += n / this->stream_bytes_per_frame_;
  this->audio_pending_.erase(this->audio_pending_.begin(), this->audio_pending_.begin() + n);
  return true;
}

void AudioCaptureComponent::drain_mic_to_frames_() {
  size_t frames_sent = 0;
  while (frames_sent < MAX_FRAMES_PER_LOOP) {
    bool emit = this->audio_pending_.size() >= MAX_AUDIO_PAYLOAD ||
                (this->pending_gap_frames_ > 0 && !this->audio_pending_.empty());
    if (!emit) {
      if (this->chunk_remaining_ == 0) {
        if (this->pending_gap_frames_ > 0) {
          // audio_pending_ is empty here: the next audio frame carries the jumped index.
          ESP_LOGW(TAG, "Audio gap of %" PRIu32 " frames (client/Wi-Fi too slow)", this->pending_gap_frames_);
          this->sample_index_ += this->pending_gap_frames_;
          this->pending_gap_frames_ = 0;
        }
        if (this->ring_buffer_->available() >= CHUNK_HDR) {
          uint8_t hdr[CHUNK_HDR];
          if (this->ring_buffer_->read(hdr, CHUNK_HDR, 0) != CHUNK_HDR) {
            ESP_LOGE(TAG, "Ring buffer desync; closing");
            this->close_client_();
            return;
          }
          this->chunk_remaining_ = get_u32_le(hdr);
          this->pending_gap_frames_ = get_u32_le(hdr + 4);
          continue;
        }
        // Ring buffer dry: flush a partial frame only if it is worth the overhead.
        if (this->audio_pending_.size() < MIN_IDLE_PAYLOAD) {
          return;
        }
        emit = true;
      } else {
        size_t want = std::min(MAX_AUDIO_PAYLOAD - this->audio_pending_.size(), this->chunk_remaining_);
        size_t base = this->audio_pending_.size();
        this->audio_pending_.resize(base + want);  // within reserved capacity
        size_t got = this->ring_buffer_->read(this->audio_pending_.data() + base, want, 0);
        this->audio_pending_.resize(base + got);
        this->chunk_remaining_ -= got;
        if (got > 0) {
          continue;
        }
        return;  // producer is mid-write of this chunk; come back next loop
      }
    }
    if (!this->emit_audio_frame_()) {
      return;  // TX backlog full: backpressure into the ring buffer
    }
    frames_sent++;
  }
}

void AudioCaptureComponent::poll_stream_() {
  // Protocol is server->client only after the handshake: any client bytes, or an
  // orderly shutdown (read == 0), ends the session.
  if (this->client_->ready()) {
    uint8_t probe;
    ssize_t n = this->client_->read(&probe, 1);
    if (n == 0) {
      ESP_LOGI(TAG, "Client disconnected");
      this->close_client_();
      return;
    } else if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
      ESP_LOGI(TAG, "Client connection lost (errno %d)", errno);
      this->close_client_();
      return;
    } else if (n > 0) {
      ESP_LOGW(TAG, "Unexpected client data; closing");
      this->close_client_();
      return;
    }
  }
  if (!this->flush_tx_()) {
    ESP_LOGW(TAG, "Client write failed; closing");
    this->close_client_();
    return;
  }
  // Markers queued via add_marker() go first so their sample index stays tight.
  while (!this->marker_queue_.empty() && this->tx_free_() >= FRAME_OVERHEAD + 8 + MAX_MARKER_LABEL) {
    auto &m = this->marker_queue_.front();
    if (!this->send_marker_frame_(m.sample_index, m.label)) {
      this->close_client_();
      return;
    }
    ESP_LOGI(TAG, "Marker @%" PRIu64 ": %s", m.sample_index, m.label.c_str());
    this->marker_queue_.erase(this->marker_queue_.begin());
  }

  this->drain_mic_to_frames_();
  if (this->session_ != SessionState::STREAMING) {
    return;  // drain hit an error and closed the client
  }
  if (!this->flush_tx_()) {
    ESP_LOGW(TAG, "Client write failed; closing");
    this->close_client_();
    return;
  }
  if (millis() - this->last_stats_ms_ >= STATS_INTERVAL_MS) {
    this->last_stats_ms_ = millis();
    if (this->tx_free_() >= FRAME_OVERHEAD + 192 && (!this->send_stats_frame_() || !this->flush_tx_())) {
      this->close_client_();
    }
  }
}

void AudioCaptureComponent::add_marker(const std::string &label) {
  if (!this->is_client_connected()) {
    ESP_LOGW(TAG, "Marker ignored (no client): %s", label.c_str());
    return;
  }
  // Stamp with the next undrained frame index (loop context, consistent with drain accounting).
  uint64_t at = this->sample_index_ + this->audio_pending_.size() / this->stream_bytes_per_frame_;
  if (this->marker_queue_.size() >= 8) {
    ESP_LOGW(TAG, "Marker queue full; ignoring: %s", label.c_str());
    return;
  }
  this->marker_queue_.push_back({at, label});
}

void AudioCaptureComponent::close_client_() {
  this->accepting_audio_.store(false, std::memory_order_release);
  this->client_.reset();
  this->session_ = SessionState::IDLE;
  this->audio_pending_.clear();
  this->tx_pending_.clear();
  this->tx_pending_off_ = 0;
  this->marker_queue_.clear();
  memset(this->session_key_, 0, sizeof(this->session_key_));
  memset(this->nonce_c_, 0, sizeof(this->nonce_c_));
  memset(this->nonce_s_, 0, sizeof(this->nonce_s_));
  if (this->mic_source_ != nullptr && !this->mic_source_->is_passive() && this->enabled_) {
    // Balance the start() from the handshake; the I2S driver refcounts listeners
    // so sound_level keeps running undisturbed.
    this->mic_source_->stop();
  }
  ESP_LOGI(TAG, "Client session closed");
}

// --- CaptureSwitch ---

void CaptureSwitch::setup() {
  bool initial = this->get_initial_state_with_restore_mode().value_or(false);
  if (this->parent_ != nullptr) {
    this->parent_->set_enabled(initial);
  }
  this->publish_state(initial && this->parent_ != nullptr && this->parent_->is_enabled());
}

void CaptureSwitch::dump_config() { LOG_SWITCH("", "Audio Capture Switch", this); }

void CaptureSwitch::write_state(bool state) {
  if (this->parent_ == nullptr) {
    return;
  }
  this->parent_->set_enabled(state);
  this->publish_state(this->parent_->is_enabled());
}

}  // namespace esphome::audio_capture

#endif
