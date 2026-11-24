#pragma once

#ifdef USE_ESP32

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "esphome/components/binary_sensor/binary_sensor.h"
#include "esphome/components/microphone/microphone_source.h"
#include "esphome/components/ring_buffer/ring_buffer.h"
#include "esphome/components/sensor/sensor.h"
#include "esphome/components/socket/socket.h"
#include "esphome/components/switch/switch.h"

#include "esphome/core/automation.h"
#include "esphome/core/component.h"

namespace esphome::audio_capture {

// Protocol v1 framing (see docs/capture_protocol.md).
static const uint8_t FRAME_TYPE_HEADER = 0x01;
static const uint8_t FRAME_TYPE_AUDIO = 0x02;
static const uint8_t FRAME_TYPE_MARKER = 0x03;
static const uint8_t FRAME_TYPE_STATS = 0x04;

class AudioCaptureComponent : public Component {
  SUB_SENSOR(dropped_bytes)
  SUB_BINARY_SENSOR(client_connected)

 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::AFTER_CONNECTION; }

  void set_microphone_source(microphone::MicrophoneSource *source) { this->mic_source_ = source; }
  void set_port(uint16_t port) { this->port_ = port; }
  void set_buffer_size(size_t size) { this->buffer_size_ = size; }
  void set_psk(const std::string &psk) { this->psk_ = psk; }

  /// Runtime enable/disable. When disabled, the server socket is closed, any
  /// client is dropped and the microphone source is stopped.
  void set_enabled(bool enabled);
  bool is_enabled() const { return this->enabled_; }

  /// Queue a marker frame stamped with the current sample index.
  void add_marker(const std::string &label);

  bool is_client_connected() const { return this->client_ != nullptr && this->handshake_done(); }

 protected:
  // Session state machine for the single connected client.
  enum class SessionState : uint8_t {
    IDLE = 0,        // no client
    HANDSHAKE_RX,    // waiting for nonce_c + auth tag (5 s timeout)
    STREAMING,       // handshake done, sending frames
  };

  bool handshake_done() const { return this->session_ == SessionState::STREAMING; }
  bool ensure_listen_socket_();
  void close_client_();
  bool accept_client_();
  void poll_handshake_();
  void poll_stream_();
  void drain_mic_to_frames_();

  /// Try to push buffered frame bytes to the socket (non-blocking). False on hard error.
  bool flush_tx_();
  /// Encrypt one frame and append [len][iv][ciphertext|tag] to the tx backlog. False on crypto
  /// failure or when the backlog cap is hit (slow consumer).
  bool encrypt_and_queue_(uint8_t type, const uint8_t *p1, size_t l1, const uint8_t *p2, size_t l2);
  size_t tx_free_() const;
  bool emit_audio_frame_();
  bool send_header_frame_();
  bool send_stats_frame_();
  bool send_marker_frame_(uint64_t sample_index, const std::string &label);

  void derive_session_keys_();

  static bool constant_time_equal_(const uint8_t *a, const uint8_t *b, size_t len);

  microphone::MicrophoneSource *mic_source_{nullptr};
  uint16_t port_{6060};
  size_t buffer_size_{65536};
  std::string psk_;
  bool enabled_{false};  // default OFF; the switch platform applies restore mode

  std::unique_ptr<socket::Socket> listen_socket_{nullptr};
  std::unique_ptr<socket::Socket> client_{nullptr};
  SessionState session_{SessionState::IDLE};
  uint32_t session_start_ms_{0};

  // Handshake material.
  uint8_t nonce_s_[16]{};
  uint8_t nonce_c_[16]{};
  uint8_t session_key_[32]{};
  size_t handshake_rx_bytes_{0};
  uint8_t handshake_rx_[48]{};

  // Streaming state.
  std::shared_ptr<ring_buffer::RingBuffer> ring_buffer_{nullptr};
  uint64_t tx_counter_{0};      // strictly increasing GCM nonce counter
  uint64_t sample_index_{0};    // frames delivered to clients (loop context only)
  uint8_t stream_bits_per_sample_{32};
  uint8_t stream_channels_{1};
  uint32_t stream_sample_rate_{0};
  size_t stream_bytes_per_frame_{4};
  std::atomic<uint32_t> dropped_bytes_{0};  // written from the mic task
  std::atomic<bool> accepting_audio_{false};  // mic callback may write to the ring buffer
  uint32_t cb_gap_frames_{0};                 // mic task only: frames dropped since last stored chunk
  size_t chunk_remaining_{0};                 // loop only: PCM bytes left in current ring-buffer record
  uint32_t pending_gap_frames_{0};            // loop only: gap to apply before the current record
  uint32_t last_stats_ms_{0};
  uint32_t last_tx_progress_ms_{0};  // last time the TX backlog drained or advanced

  // Outgoing data: drained-but-unsent audio and encrypted backlog for partial writes.
  std::vector<uint8_t> audio_pending_;
  std::vector<uint8_t> tx_pending_;
  size_t tx_pending_off_{0};

  struct QueuedMarker {
    uint64_t sample_index;
    std::string label;
  };
  std::vector<QueuedMarker> marker_queue_;
};

/// Automation action `audio_capture.mark`: queues a labelled marker frame.
/// (In ESPHome 2026.11.0, Action lives directly in namespace esphome.)
template<typename... Ts> class MarkAction : public Action<Ts...> {
 public:
  explicit MarkAction(AudioCaptureComponent *parent) : parent_(parent) {}
  void set_label(const std::string &label) { this->label_ = label; }
  void play(Ts... x) override {
    if (this->parent_ != nullptr) {
      this->parent_->add_marker(this->label_);
    }
  }

 protected:
  AudioCaptureComponent *parent_;
  std::string label_;
};

/// Switch platform: toggles capture on/off at runtime.
class CaptureSwitch : public switch_::Switch, public Component {
 public:
  void setup() override;
  void dump_config() override;
  void set_parent(AudioCaptureComponent *parent) { this->parent_ = parent; }

 protected:
  void write_state(bool state) override;
  AudioCaptureComponent *parent_{nullptr};
};

}  // namespace esphome::audio_capture

#endif
