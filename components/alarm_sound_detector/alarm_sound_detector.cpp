// ESPHome wrapper: mic callback -> ring buffer -> detector core -> triggers.
#include "alarm_sound_detector.h"

#ifdef USE_ESP32

#include <cmath>
#include <cinttypes>
#include <cstring>

#include "esphome/core/hal.h"
#include "esphome/core/log.h"

namespace esphome::alarm_sound_detector {

static const char *const TAG = "alarm_sound_detector";

void AlarmSoundDetector::setup() {
  if (this->mic_source_ == nullptr || this->tmpl_data_ == nullptr) {
    this->setup_error_ = "misconfigured (codegen should have set the microphone and template)";
    ESP_LOGE(TAG, "%s", this->setup_error_.c_str());
    this->mark_failed();
    return;
  }
  const auto stream = this->mic_source_->get_audio_stream_info();
  const uint32_t rate = stream.get_sample_rate();
  const uint8_t channels = stream.get_channels();
  const uint8_t bits = stream.get_bits_per_sample();
  if (rate != DET_SAMPLE_RATE || channels != 1) {
    this->setup_error_ = "microphone stream must be 16 kHz mono";
    ESP_LOGE(TAG, "%s, got %" PRIu32 " Hz / %u ch; detector disabled", this->setup_error_.c_str(),
             rate, channels);
    this->mark_failed();
    return;
  }
  if (bits != 16 && bits != 32) {
    this->setup_error_ = "microphone stream must be 16- or 32-bit";
    ESP_LOGE(TAG, "%s, got %u-bit; detector disabled", this->setup_error_.c_str(), bits);
    this->mark_failed();
    return;
  }
  this->stream_bytes_per_sample_ = static_cast<uint8_t>(bits / 8);

  if (!this->detector_.begin(this->tmpl_data_, this->tmpl_frames_, this->tmpl_bins_,
                             this->threshold_, this->near_threshold_, this->period_s_,
                             this->period_tol_s_, this->min_repetitions_)) {
    this->setup_error_ = "detector core rejected the template/parameters";
    ESP_LOGE(TAG, "%s; detector disabled", this->setup_error_.c_str());
    this->mark_failed();
    return;
  }
  this->ring_buffer_ = ring_buffer::RingBuffer::create(
      DETECTOR_RING_BUFFER_BYTES, ring_buffer::RingBuffer::MemoryPreference::INTERNAL_FIRST);
  if (this->ring_buffer_ == nullptr) {
    this->setup_error_ = "failed to allocate the 16 KiB ring buffer";
    ESP_LOGE(TAG, "%s; detector disabled", this->setup_error_.c_str());
    this->mark_failed();
    return;
  }
  this->read_buf_.reserve(DETECTOR_MAX_HOPS_PER_LOOP * DET_HOP * 4);
  this->cvt_buf_.assign(DET_HOP, 0.0f);

  this->detector_.set_listener([this](const StreamingDetector::Event &e) {
    switch (e.type) {
      case StreamingDetector::EventType::UNIT:
        ESP_LOGI(TAG, "Repetition, score %.3f", e.score);
        this->has_event_score_ = true;
        this->event_score_ = e.score;
        this->repetition_trigger_.trigger(e.score);
        break;
      case StreamingDetector::EventType::NEAR:
        ESP_LOGI(TAG, "Near miss, score %.3f", e.score);
        this->has_event_score_ = true;
        this->event_score_ = e.score;
        this->near_miss_trigger_.trigger(e.score);
        break;
      case StreamingDetector::EventType::ALARM_ON:
        ESP_LOGI(TAG, "Alarm started (repetition score %.3f)", e.score);
        this->alarm_start_trigger_.trigger();
        break;
      case StreamingDetector::EventType::ALARM_OFF:
        ESP_LOGI(TAG, "Alarm ended");
        this->alarm_end_trigger_.trigger();
        break;
    }
  });
  this->detector_.set_frame_listener([this](uint32_t /*frame*/, float score) {
    if (!this->has_interval_max_ || score > this->interval_max_) {
      this->has_interval_max_ = true;
      this->interval_max_ = score;
    }
  });

  // Non-passive: start the microphone in setup() (refcounted with sound_level).
  this->mic_source_->add_data_callback([this](const microphone::AudioCapture &capture) {
    // Runs on the microphone task: never block. Store each chunk whole or
    // drop it whole so the byte stream is never misaligned.
    const size_t len = capture.data.size();
    if (len == 0 || this->ring_buffer_ == nullptr) {
      return;
    }
    if (this->ring_buffer_->free() < len ||
        this->ring_buffer_->write_without_replacement(capture.data.data(), len, 0, true) != len) {
      this->dropped_bytes_.fetch_add(static_cast<uint32_t>(len), std::memory_order_relaxed);
    }
  });
  if (!this->mic_source_->is_passive()) {
    this->mic_source_->start();
  }
  this->last_stats_ms_ = millis();
  ESP_LOGI(TAG, "Listening for '%s' (%u x %u template)", this->tmpl_name_.c_str(),
           this->tmpl_frames_, this->tmpl_bins_);
}

void AlarmSoundDetector::dump_config() {
  ESP_LOGCONFIG(TAG, "Alarm Sound Detector:");
  ESP_LOGCONFIG(TAG, "  Template: '%s' (%u frames x %u bins)", this->tmpl_name_.c_str(),
                this->tmpl_frames_, this->tmpl_bins_);
  ESP_LOGCONFIG(TAG, "  Threshold: %.2f  Near: %.2f  Period: %.3fs +- %.3fs  Min repetitions: %u",
                this->threshold_, this->near_threshold_, this->period_s_, this->period_tol_s_,
                this->min_repetitions_);
  if (this->is_failed()) {
    ESP_LOGCONFIG(TAG, "  FAILED: %s", this->setup_error_.c_str());
    return;
  }
  const auto stream = this->mic_source_->get_audio_stream_info();
  ESP_LOGCONFIG(TAG, "  Stream: %" PRIu32 " Hz / %u-bit / %u ch", stream.get_sample_rate(),
                stream.get_bits_per_sample(), stream.get_channels());
  const float avg = this->hops_total_ > 0
                        ? static_cast<float>(this->proc_us_total_) / this->hops_total_
                        : 0.0f;
  ESP_LOGCONFIG(TAG, "  Processing average: %.1f us/hop over %u hops", avg, this->hops_total_);
}

void AlarmSoundDetector::loop() {
  if (this->is_failed() || !this->detector_.is_ready()) {
    return;
  }
  if (!this->mic_source_->is_running()) {
    if (!this->stream_warned_) {
      ESP_LOGW(TAG, "Microphone is not running; detector idle");
      this->stream_warned_ = true;
    }
    return;
  }
  this->stream_warned_ = false;
  this->process_available_();
  this->log_stats_();
}

void AlarmSoundDetector::process_available_() {
  // Consume at most ~10 hops per loop() pass so the main loop never stalls.
  // Partial trailing samples are stashed in tail_ so the stream stays aligned.
  size_t samples_left = DETECTOR_MAX_HOPS_PER_LOOP * DET_HOP;
  const size_t bytes_per_sample = this->stream_bytes_per_sample_;
  while (samples_left >= DET_HOP) {
    const size_t want = (samples_left > DET_HOP ? DET_HOP : samples_left) * bytes_per_sample;
    if (this->read_buf_.size() < this->tail_len_ + want) {
      this->read_buf_.resize(this->tail_len_ + want);
    }
    memcpy(this->read_buf_.data(), this->tail_, this->tail_len_);
    const size_t got =
        this->ring_buffer_->read(this->read_buf_.data() + this->tail_len_, want, 0);
    const size_t total = this->tail_len_ + got;
    const size_t whole = total - total % bytes_per_sample;
    this->tail_len_ = total - whole;
    if (this->tail_len_ > 0) {
      memcpy(this->tail_, this->read_buf_.data() + whole, this->tail_len_);
    }
    if (whole == 0) {
      break;
    }
    const uint32_t t0 = micros();
    if (bytes_per_sample == 2) {
      this->feed_bytes_16_(this->read_buf_.data(), whole);
    } else {
      this->feed_bytes_32_(this->read_buf_.data(), whole);
    }
    this->proc_us_total_ += micros() - t0;
    this->hops_total_ += static_cast<uint32_t>(whole / bytes_per_sample / DET_HOP);
    samples_left -= whole / bytes_per_sample;
    if (got < want) {
      break;  // ring buffer drained
    }
  }
}

void AlarmSoundDetector::feed_bytes_16_(const uint8_t *data, size_t len) {
  // Little-endian int16 mono, copied to aligned staging first.
  const size_t n = len / 2;
  if (this->pcm16_buf_.size() < n) {
    this->pcm16_buf_.resize(n);
  }
  memcpy(this->pcm16_buf_.data(), data, n * 2);
  this->detector_.feed_int16(this->pcm16_buf_.data(), n);
}

void AlarmSoundDetector::feed_bytes_32_(const uint8_t *data, size_t len) {
  // Little-endian int32 mono -> float.
  const size_t n = len / 4;
  if (this->cvt_buf_.size() < n) {
    this->cvt_buf_.resize(n);
  }
  for (size_t i = 0; i < n; i++) {
    int32_t v = static_cast<int32_t>(data[4 * i]) |
                (static_cast<int32_t>(data[4 * i + 1]) << 8) |
                (static_cast<int32_t>(data[4 * i + 2]) << 16) |
                (static_cast<int32_t>(data[4 * i + 3]) << 24);
    this->cvt_buf_[i] = static_cast<float>(v) / 2147483648.0f;
  }
  this->detector_.feed_float(this->cvt_buf_.data(), n);
}

void AlarmSoundDetector::log_stats_() {
  const uint32_t now = millis();
  if (now - this->last_stats_ms_ < 60000) {
    return;
  }
  this->last_stats_ms_ = now;
  const float avg = this->hops_total_ > 0
                        ? static_cast<float>(this->proc_us_total_) / this->hops_total_
                        : 0.0f;
  const uint32_t dropped = this->dropped_bytes_.exchange(0, std::memory_order_relaxed);
  ESP_LOGD(TAG, "avg processing %.1f us/hop over %u hops, dropped %u bytes in 60 s", avg,
           this->hops_total_, dropped);
  this->proc_us_total_ = 0;
  this->hops_total_ = 0;
}

bool AlarmSoundDetector::take_event_score(float *out) {
  if (!this->has_event_score_) {
    return false;
  }
  this->has_event_score_ = false;
  *out = this->event_score_;
  return true;
}

bool AlarmSoundDetector::take_interval_max(float *out) {
  if (!this->has_interval_max_) {
    return false;
  }
  this->has_interval_max_ = false;
  *out = this->interval_max_;
  return true;
}

// --- AlarmBinarySensor ---

void AlarmBinarySensor::setup() {
  if (this->parent_ != nullptr) {
    this->last_state_ = this->parent_->is_alarm_active();
    this->publish_state(this->last_state_);
  }
}

void AlarmBinarySensor::loop() {
  if (this->parent_ == nullptr || this->parent_->is_failed()) {
    return;
  }
  const bool s = this->parent_->is_alarm_active();
  if (s != this->last_state_) {
    this->last_state_ = s;
    this->publish_state(s);
  }
}

void AlarmBinarySensor::dump_config() { LOG_BINARY_SENSOR("", "Alarm Sound Detector Alarm", this); }

// --- MatchScoreSensor ---

float MatchScoreSensor::round3_(float v) { return std::round(v * 1000.0f) / 1000.0f; }

void MatchScoreSensor::setup() { this->last_report_ms_ = millis(); }

void MatchScoreSensor::loop() {
  if (this->parent_ == nullptr || this->parent_->is_failed()) {
    return;
  }
  float s;
  if (this->parent_->take_event_score(&s)) {
    this->publish_state(round3_(s));
  }
  const uint32_t now = millis();
  if (now - this->last_report_ms_ >= this->report_interval_ms_) {
    this->last_report_ms_ = now;
    if (this->parent_->take_interval_max(&s)) {
      this->publish_state(round3_(s));
    }
  }
}

void MatchScoreSensor::dump_config() {
  LOG_SENSOR("", "Alarm Sound Detector Match Score", this);
  ESP_LOGCONFIG(TAG, "  Report interval: %" PRIu32 " ms", this->report_interval_ms_);
}

}  // namespace esphome::alarm_sound_detector

#endif  // USE_ESP32
