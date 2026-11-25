// ESPHome wrapper around the portable template-matching detector core.
#pragma once

#ifdef USE_ESP32

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

#include "detector_core.h"

#include "esphome/components/binary_sensor/binary_sensor.h"
#include "esphome/components/microphone/microphone_source.h"
#include "esphome/components/ring_buffer/ring_buffer.h"
#include "esphome/components/sensor/sensor.h"

#include "esphome/core/automation.h"
#include "esphome/core/component.h"

namespace esphome::alarm_sound_detector {

// 16 KiB of internal RAM: ~0.5 s of 16 kHz / 16-bit mono; absorbs Wi-Fi stalls.
static constexpr size_t DETECTOR_RING_BUFFER_BYTES = 16 * 1024;
// Never spend longer than this much audio on one loop() pass.
static constexpr size_t DETECTOR_MAX_HOPS_PER_LOOP = 10;

class AlarmSoundDetector : public Component {
 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::AFTER_CONNECTION; }

  void set_microphone_source(microphone::MicrophoneSource *source) { this->mic_source_ = source; }
  void set_template(const int8_t *data, uint16_t frames, uint16_t bins, const std::string &name,
                    float period_s) {
    this->tmpl_data_ = data;
    this->tmpl_frames_ = frames;
    this->tmpl_bins_ = bins;
    this->tmpl_name_ = name;
    this->period_s_ = period_s;
  }
  void set_threshold(float v) { this->threshold_ = v; }
  void set_near_threshold(float v) { this->near_threshold_ = v; }
  void set_period_tolerance(float v) { this->period_tol_s_ = v; }
  void set_min_repetitions(uint8_t v) { this->min_repetitions_ = v; }

  Trigger<> *get_alarm_start_trigger() { return &this->alarm_start_trigger_; }
  Trigger<> *get_alarm_end_trigger() { return &this->alarm_end_trigger_; }
  Trigger<float> *get_repetition_trigger() { return &this->repetition_trigger_; }
  Trigger<float> *get_near_miss_trigger() { return &this->near_miss_trigger_; }

  bool is_alarm_active() const { return this->detector_.alarm_active(); }
  float last_score() const { return this->detector_.last_score(); }

  /// Latest repetition/near-miss score, consumed once by the score sensor.
  bool take_event_score(float *out);
  /// Max frame score since the previous call + whether any frame was scored.
  bool take_interval_max(float *out);

 protected:
  void process_available_();
  void feed_bytes_16_(const uint8_t *data, size_t len);
  void feed_bytes_32_(const uint8_t *data, size_t len);
  void log_stats_();

  microphone::MicrophoneSource *mic_source_{nullptr};
  std::shared_ptr<ring_buffer::RingBuffer> ring_buffer_;

  // Template + parameters from codegen (validated in __init__.py).
  const int8_t *tmpl_data_{nullptr};
  uint16_t tmpl_frames_{0};
  uint16_t tmpl_bins_{0};
  std::string tmpl_name_;
  float period_s_{3.125f};
  float threshold_{0.55f};
  float near_threshold_{0.35f};
  float period_tol_s_{0.25f};
  uint8_t min_repetitions_{2};

  StreamingDetector detector_;
  uint8_t stream_bytes_per_sample_{2};

  Trigger<> alarm_start_trigger_;
  Trigger<> alarm_end_trigger_;
  Trigger<float> repetition_trigger_;
  Trigger<float> near_miss_trigger_;

  // Score sensor handoff (polled from the sensor's loop(), same task).
  bool has_event_score_{false};
  float event_score_{0.0f};
  bool has_interval_max_{false};
  float interval_max_{0.0f};

  // Mic-task -> loop() handoff accounting.
  std::atomic<uint32_t> dropped_bytes_{0};

  // Staging + profiling (loop context only).
  std::vector<uint8_t> read_buf_;
  std::vector<int16_t> pcm16_buf_;  // aligned staging (mic bytes may be unaligned)
  std::vector<float> cvt_buf_;
  uint8_t tail_[4]{};  // leftover bytes of a partial sample from the last pass
  size_t tail_len_{0};
  uint32_t proc_us_total_{0};
  uint32_t hops_total_{0};
  uint32_t last_stats_ms_{0};
  bool stream_warned_{false};

  std::string setup_error_;
};

/// Binary sensor platform: reflects whether the alarm is currently active.
class AlarmBinarySensor : public binary_sensor::BinarySensor, public Component {
 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  void set_parent(AlarmSoundDetector *parent) { this->parent_ = parent; }

 protected:
  AlarmSoundDetector *parent_{nullptr};
  bool last_state_{false};
};

/// Sensor platform: publishes the repetition/near-miss score immediately on
/// each event, otherwise the max frame score seen during report_interval.
class MatchScoreSensor : public sensor::Sensor, public Component {
 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::AFTER_CONNECTION; }
  void set_parent(AlarmSoundDetector *parent) { this->parent_ = parent; }
  void set_report_interval_ms(uint32_t ms) { this->report_interval_ms_ = ms; }

 protected:
  static float round3_(float v);

  AlarmSoundDetector *parent_{nullptr};
  uint32_t report_interval_ms_{60000};
  uint32_t last_report_ms_{0};
};

}  // namespace esphome::alarm_sound_detector

#endif  // USE_ESP32
