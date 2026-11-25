// Portable detector core — see detector_core.h. Direct port of
// tools/detector/ref.py: frames_db, above_floor, quantize_feat,
// ncc_quantized and StreamingDetector.
#include "detector_core.h"

#include <cmath>
#include <cstring>

namespace esphome::alarm_sound_detector {

namespace {

// log10(1e-10) guard constant, matching ref.py's 10*log10(p + 1e-10).
constexpr float kEps = 1e-10f;

uint16_t reverse_bits(uint16_t x, int bits) {
  uint16_t y = 0;
  for (int i = 0; i < bits; i++) {
    y = static_cast<uint16_t>((y << 1) | (x & 1));
    x >>= 1;
  }
  return y;
}

}  // namespace

bool StreamingDetector::begin(const int8_t *template_data, uint16_t frames, uint16_t bins,
                              float threshold, float near_threshold, float period_s,
                              float period_tol_s, uint8_t min_repetitions, float peak_window_s,
                              float refractory_s, float release_s, uint16_t bin_lo,
                              uint16_t bin_hi) {
  const bool has_period = det_has_period(period_s);
  if (template_data == nullptr || frames == 0 || bins == 0) {
    return false;
  }
  if (bin_lo < 1 || bin_hi > DET_BIN_MAX || bin_lo > bin_hi) {
    return false;
  }
  if (bins != static_cast<uint16_t>(bin_hi - bin_lo + 1)) {
    return false;
  }
  if (!(threshold > near_threshold) || period_tol_s < 0.0f || min_repetitions == 0) {
    return false;
  }
  if (has_period) {
    if (!(period_s > 0.0f)) {
      return false;
    }
  } else if (!(release_s > 0.0f)) {
    // Single (no-periodicity) mode still needs an explicit release window.
    return false;
  }
  if (!(refractory_s >= 0.0f) || !(release_s > 0.0f)) {
    return false;
  }
  const int64_t n = static_cast<int64_t>(frames) * bins;
  int64_t st = 0, stt = 0;
  for (int64_t i = 0; i < n; i++) {
    const int64_t t = template_data[i];
    st += t;
    stt += t * t;
  }
  const double tden = std::sqrt(std::max(static_cast<double>(stt) -
                                             static_cast<double>(st) * st / n,
                                         0.0));
  if (!(tden > 0.0)) {  // flat template can never match
    return false;
  }

  // Note: allocated with plain std::vector (ESP-IDF builds with
  // exceptions disabled; an out-of-memory here aborts like elsewhere in ESPHome).
  pending_.clear();
  pending_.reserve(DET_N_FFT + DET_HOP);
  floor_db_.assign(bins, 0.0f);
  history_.assign(static_cast<size_t>(frames) * bins, 0);
  frame_re_.assign(DET_N_FFT, 0.0f);
  frame_im_.assign(DET_N_FFT, 0.0f);
  float_frame_.assign(bins, 0.0f);

  tmpl_ = template_data;
  template_frames_ = frames;
  template_bins_ = bins;
  bin_lo_ = bin_lo;
  bin_hi_ = bin_hi;
  tmpl_sum_ = st;
  tmpl_denom_ = tden;

  threshold_ = threshold;
  near_threshold_ = near_threshold;
  period_s_ = period_s;
  period_tol_s_ = period_tol_s;
  min_repetitions_ = min_repetitions;
  release_s_ = release_s;
  const double fps = static_cast<double>(DET_SAMPLE_RATE) / DET_HOP;
  peak_win_frames_ = static_cast<int64_t>(std::llround(peak_window_s * fps));
  refractory_frames_ = static_cast<int64_t>(std::llround(refractory_s * fps));

  frames_seen_ = 0;
  last_score_ = 0.0f;
  has_candidate_ = false;
  cand_best_ = 0.0f;
  cand_best_n_ = 0;
  last_unit_n_ = INT64_MIN / 4;
  alarm_ = false;
  unit_times_.clear();

  fft_init_();
  ready_ = true;
  return true;
}

void StreamingDetector::fft_init_() {
  // Periodic Hann: np.hanning(N_FFT + 1)[:-1].
  constexpr double kPi = 3.14159265358979323846;
  for (uint16_t i = 0; i < DET_N_FFT; i++) {
    hann_[i] = 0.5f - 0.5f * static_cast<float>(std::cos(2.0 * kPi * i / DET_N_FFT));
  }
  // Twiddles W_N^k = exp(-2*pi*i*k/N), k = 0..N/2-1.
  for (uint16_t k = 0; k < DET_N_FFT / 2; k++) {
    const double a = 2.0 * kPi * k / DET_N_FFT;
    tw_re_[k] = static_cast<float>(std::cos(a));
    tw_im_[k] = static_cast<float>(-std::sin(a));
  }
  int bits = 0;
  for (uint16_t v = DET_N_FFT; v > 1; v >>= 1) {
    bits++;
  }
  for (uint16_t i = 0; i < DET_N_FFT; i++) {
    bit_rev_[i] = reverse_bits(i, bits);
  }
}

void StreamingDetector::fft_(float *re, float *im) const {
  // Iterative radix-2 DIT complex FFT, N = 512.
  for (uint16_t i = 0; i < DET_N_FFT; i++) {
    const uint16_t j = bit_rev_[i];
    if (i < j) {
      const float t = re[i];
      re[i] = re[j];
      re[j] = t;
      const float u = im[i];
      im[i] = im[j];
      im[j] = u;
    }
  }
  for (uint16_t len = 1; len < DET_N_FFT; len <<= 1) {
    const uint16_t step = DET_N_FFT / (2 * len);
    for (uint16_t base = 0; base < DET_N_FFT; base += 2 * len) {
      for (uint16_t j = 0; j < len; j++) {
        const float wr = tw_re_[j * step];
        const float wi = tw_im_[j * step];
        const float xr = re[base + j + len];
        const float xi = im[base + j + len];
        const float tr = wr * xr - wi * xi;
        const float ti = wr * xi + wi * xr;
        re[base + j + len] = re[base + j] - tr;
        im[base + j + len] = im[base + j] - ti;
        re[base + j] += tr;
        im[base + j] += ti;
      }
    }
  }
}

void StreamingDetector::feed_int16(const int16_t *samples, size_t count) {
  if (!ready_ || samples == nullptr) {
    return;
  }
  for (size_t i = 0; i < count; i++) {
    feed_sample_(static_cast<float>(samples[i]) / 32768.0f);
  }
}

void StreamingDetector::feed_float(const float *samples, size_t count) {
  if (!ready_ || samples == nullptr) {
    return;
  }
  for (size_t i = 0; i < count; i++) {
    feed_sample_(samples[i]);
  }
}

void StreamingDetector::feed_sample_(float s) {
  pending_.push_back(s);
  while (pending_.size() >= DET_N_FFT) {
    process_frame_();
    // Drop one hop; compact when the staging buffer grows.
    pending_.erase(pending_.begin(), pending_.begin() + DET_HOP);
  }
}

void StreamingDetector::process_frame_() {
  const float *x = pending_.data();
  float *re = frame_re_.data();
  float *im = frame_im_.data();
  for (uint16_t i = 0; i < DET_N_FFT; i++) {
    re[i] = x[i] * hann_[i];
    im[i] = 0.0f;
  }
  fft_(re, im);

  const uint16_t n_bins = template_bins_;
  // First frame initialises the floor (ref.py: floor = db[0].copy()).
  const bool first = (frames_seen_ == 0);
  const bool tap = static_cast<bool>(float_frame_listener_);
  for (uint16_t b = 0; b < n_bins; b++) {
    const uint16_t k = static_cast<uint16_t>(bin_lo_ + b);
    const double p = static_cast<double>(re[k]) * re[k] + static_cast<double>(im[k]) * im[k];
    const float db = 10.0f * static_cast<float>(std::log10(p + kEps));
    if (first) {
      floor_db_[b] = db;
    } else {
      const float risen = floor_db_[b] + DET_FLOOR_RISE_DB_PER_FRAME;
      floor_db_[b] = db < risen ? db : risen;  // min(row, floor + rise)
    }
    // quantize_feat: clip(floor(dB/0.5 + 0.5), 0, 255).
    const float above = db - floor_db_[b];
    if (tap) {
      float_frame_[b] = above;
    }
    float q = std::floor(above / DET_FEAT_STEP_DB + 0.5f);
    if (q < 0.0f) {
      q = 0.0f;
    } else if (q > 255.0f) {
      q = 255.0f;
    }
    history_[(frames_seen_ % template_frames_) * n_bins + b] = static_cast<uint8_t>(q);
  }
  frames_seen_++;

  if (tap) {
    float_frame_listener_(float_frame_.data(), n_bins);
  }
  if (frames_seen_ < template_frames_) {
    return;
  }
  const float s = score_window_();
  last_score_ = s;
  if (frame_listener_) {
    frame_listener_(frames_seen_, s);
  }
  const auto n = static_cast<int64_t>(frames_seen_);
  const double now_s = frames_to_seconds(n);

  // Candidate peak picking: open on crossing near_threshold, close once the
  // score has not improved for peak_win frames (ref.py).
  if (!has_candidate_) {
    if (s >= near_threshold_ && (n - last_unit_n_) >= refractory_frames_) {
      has_candidate_ = true;
      cand_best_ = s;
      cand_best_n_ = n;
    }
  } else {
    if (s > cand_best_) {
      cand_best_ = s;
      cand_best_n_ = n;
    }
    if ((n - cand_best_n_) >= peak_win_frames_) {
      const double tb = frames_to_seconds(cand_best_n_);
      if (cand_best_ >= threshold_) {
        emit_(EventType::UNIT, tb, cand_best_);
        last_unit_n_ = cand_best_n_;
        on_unit_(tb, cand_best_);
      } else {
        emit_(EventType::NEAR, tb, cand_best_);
      }
      has_candidate_ = false;
    }
  }
  if (alarm_ && (now_s - unit_times_.back()) > release_s_) {
    alarm_ = false;
    unit_times_.clear();
    emit_(EventType::ALARM_OFF, now_s, 0.0f);
  }
}

float StreamingDetector::score_window_() const {
  // ncc_quantized: window row j (oldest = 0) pairs with template row j.
  const auto W = static_cast<int64_t>(template_frames_);
  const auto B = static_cast<int64_t>(template_bins_);
  const int64_t n = W * B;
  const int64_t base = static_cast<int64_t>(frames_seen_) - W;  // oldest frame's 0-based index
  int64_t sw = 0, sww = 0, swt = 0;
  const int8_t *t = tmpl_;
  for (int64_t j = 0; j < W; j++) {
    const auto slot = static_cast<size_t>((base + j) % W);
    const uint8_t *row = &history_[slot * static_cast<size_t>(B)];
    for (int64_t b = 0; b < B; b++) {
      const int64_t w = row[b];
      const int64_t tv = t[j * B + b];
      sw += w;
      sww += w * w;
      swt += w * tv;
    }
  }
  const double num = static_cast<double>(swt) - static_cast<double>(sw) * tmpl_sum_ / n;
  const double den_w =
      std::sqrt(std::max(static_cast<double>(sww) - static_cast<double>(sw) * sw / n, 0.0));
  if (!(den_w > 0.0)) {
    return 0.0f;
  }
  return static_cast<float>(num / (den_w * tmpl_denom_));
}

void StreamingDetector::on_unit_(double t, float score) {
  if (!det_has_period(period_s_)) {
    // No periodicity check: chain any units within release_s of the chain.
    while (!unit_times_.empty() && t - unit_times_.front() > release_s_) {
      unit_times_.erase(unit_times_.begin());
    }
  } else {
    // Keep the chain of units spaced by ~k*period (k=1,2 allows one miss).
    if (!unit_times_.empty()) {
      const double dt = t - unit_times_.back();
      const double k = std::round(dt / period_s_);
      if (!((k == 1.0 || k == 2.0) && std::fabs(dt - k * period_s_) <= period_tol_s_ * k)) {
        if (alarm_) {
          return;  // stray unit during an alarm: ignore, keep the chain
        }
        unit_times_.clear();
      }
    }
  }
  unit_times_.push_back(t);
  if (!alarm_ && unit_times_.size() >= min_repetitions_) {
    alarm_ = true;
    emit_(EventType::ALARM_ON, t, score);
  }
}

void StreamingDetector::emit_(EventType type, double time_s, float score) {
  if (listener_) {
    listener_(Event{type, time_s, score});
  }
}

}  // namespace esphome::alarm_sound_detector
