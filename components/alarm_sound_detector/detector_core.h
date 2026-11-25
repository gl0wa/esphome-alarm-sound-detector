// Portable template-matching detector core.
//
// This file (with detector_core.cpp) is a direct port of
// tools/detector/ref.py — THE SPEC. It must build both on the ESP32
// (ESPHome external component) and on a plain host C++ compiler for the
// equivalence tests in tests/detector/. It therefore includes no ESPHome
// headers; only the C++ standard library.
//
// Signal path (identical to ref.py):
//   int16/float samples @ 16 kHz -> 512-sample periodic-Hann frames, 256 hop
//   -> power spectrum -> 10*log10(p + 1e-10) for bins [bin_lo..bin_hi]
//      (per-preset band; TM6 default 13..144 = 400-4500 Hz)
//   -> per-bin min-tracking noise floor (instant fall, +3 dB/s rise)
//   -> quantised to uint8 in 0.5 dB steps (round half up, clamp 0..255)
//   -> NCC of the last W frames against the int8 template (ncc_quantized)
//   -> StreamingDetector event logic (candidate peaks, refractory period,
//      repetition chain with k in {1,2} periods — or no periodicity check
//      when period_s <= 0 — alarm on/off with release_s).
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

namespace esphome::alarm_sound_detector {

// ---- Constants (must match tools/detector/ref.py) ----------------------------
static constexpr uint32_t DET_SAMPLE_RATE = 16000;
static constexpr uint16_t DET_N_FFT = 512;  // 32 ms window
static constexpr uint16_t DET_HOP = 256;    // 16 ms hop
// Default band (TM6 preset): ceil(400 * 512 / 16000) .. floor(4500 * 512 / 16000).
static constexpr uint16_t DET_BIN_LO = 13;
static constexpr uint16_t DET_BIN_HI = 144;
static constexpr uint16_t DET_N_BINS = DET_BIN_HI - DET_BIN_LO + 1;  // 132
static constexpr uint16_t DET_BIN_MAX = DET_N_FFT / 2;              // Nyquist bin
static constexpr float DET_FEAT_STEP_DB = 0.5f;
static constexpr float DET_FLOOR_RISE_DB_PER_FRAME =
    3.0f * DET_HOP / DET_SAMPLE_RATE;  // 3 dB/s * HOP/SR = 0.048 dB/frame
static constexpr float DET_PEAK_WINDOW_S = 0.4f;
static constexpr float DET_REFRACTORY_S = 1.5f;
// TM6 release: alarm ends release_s after the last chained unit.
static constexpr float DET_RELEASE_S_TM6 = 2.0f * 3.125f + 1.0f;  // 7.25 s

// period_s <= 0 selects single/no-periodicity mode: any units within
// release_s chain towards min_repetitions (single-sound mode = min_rep 1).
inline bool det_has_period(float period_s) { return period_s > 0.0f; }

class StreamingDetector {
 public:
  enum class EventType : uint8_t { UNIT, NEAR, ALARM_ON, ALARM_OFF };
  struct Event {
    EventType type;
    double time_s;  // end time of the matched window (s)
    float score;
  };
  using Listener = std::function<void(const Event &)>;
  // Invoked for every scored frame (frame count 1-based, score = NCC).
  using FrameListener = std::function<void(uint32_t frame, float score)>;

  StreamingDetector() = default;
  StreamingDetector(const StreamingDetector &) = delete;
  StreamingDetector &operator=(const StreamingDetector &) = delete;

  // template_data points to W*bins row-major int8 (e.g. in flash) and must
  // outlive this object. Returns false when the dimensions are invalid
  // (bins must equal bin_hi-bin_lo+1, band within 1..N_FFT/2) or allocations fail.
  bool begin(const int8_t *template_data, uint16_t frames, uint16_t bins, float threshold,
             float near_threshold, float period_s, float period_tol_s, uint8_t min_repetitions,
             float peak_window_s = DET_PEAK_WINDOW_S, float refractory_s = DET_REFRACTORY_S,
             float release_s = DET_RELEASE_S_TM6, uint16_t bin_lo = DET_BIN_LO,
             uint16_t bin_hi = DET_BIN_HI);

  bool is_ready() const { return ready_; }
  void set_listener(Listener listener) { listener_ = std::move(listener); }
  void set_frame_listener(FrameListener listener) { frame_listener_ = std::move(listener); }

  // Feed audio in arbitrary chunk sizes; frames are assembled internally with
  // HOP overlap. float samples are in nominal [-1, 1] (scale cancels out:
  // dB offsets are absorbed by the noise floor).
  void feed_int16(const int16_t *samples, size_t count);
  void feed_float(const float *samples, size_t count);

  float last_score() const { return last_score_; }
  bool alarm_active() const { return alarm_; }
  uint32_t frames_seen() const { return frames_seen_; }
  uint16_t template_frames() const { return template_frames_; }
  uint16_t template_bins() const { return template_bins_; }

  static double frames_to_seconds(int64_t frames) {
    return static_cast<double>(frames) * DET_HOP / DET_SAMPLE_RATE;
  }

 private:
  void feed_sample_(float s);
  void process_frame_();
  float score_window_() const;
  void emit_(EventType type, double time_s, float score);
  void on_unit_(double t, float score);

  void fft_init_();
  void fft_(float *re, float *im) const;

  Listener listener_;
  FrameListener frame_listener_;
  const int8_t *tmpl_ = nullptr;
  uint16_t template_frames_ = 0;  // W
  uint16_t template_bins_ = 0;    // bins per frame (bin_hi - bin_lo + 1)
  uint16_t bin_lo_ = DET_BIN_LO;
  uint16_t bin_hi_ = DET_BIN_HI;
  // Template stats: sum, sum-of-squares, sqrt(max(stt - st*st/n, 0)).
  int64_t tmpl_sum_ = 0;
  double tmpl_denom_ = 0.0;

  float threshold_ = 0.55f;
  float near_threshold_ = 0.35f;
  float period_s_ = 3.125f;
  float period_tol_s_ = 0.25f;
  uint8_t min_repetitions_ = 2;
  float release_s_ = DET_RELEASE_S_TM6;
  int64_t peak_win_frames_ = 25;
  int64_t refractory_frames_ = 94;

  // FFT working state (precomputed once; float32 like ref's float32 path).
  float hann_[DET_N_FFT]{};
  float tw_re_[DET_N_FFT / 2]{};
  float tw_im_[DET_N_FFT / 2]{};
  uint16_t bit_rev_[DET_N_FFT]{};

  std::vector<float> pending_;       // sub-frame sample staging
  std::vector<float> floor_db_;      // per-bin noise floor (dB), size = template_bins_
  std::vector<uint8_t> history_;     // circular W x template_bins_ quantised history
  std::vector<float> frame_re_;      // FFT scratch
  std::vector<float> frame_im_;      // FFT scratch

  uint32_t frames_seen_ = 0;  // n in ref.py (1-based frame count)
  float last_score_ = 0.0f;

  // Candidate peak picking state.
  bool has_candidate_ = false;
  float cand_best_ = 0.0f;
  int64_t cand_best_n_ = 0;
  int64_t last_unit_n_ = INT64_MIN / 4;

  // Repetition chain state (mirrors ref.py unit_times + alarm flag).
  bool alarm_ = false;
  std::vector<double> unit_times_;

  bool ready_ = false;
};

}  // namespace esphome::alarm_sound_detector
