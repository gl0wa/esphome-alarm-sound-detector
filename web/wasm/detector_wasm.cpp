// Thin WebAssembly C API over the firmware detector core.
//
// This file contains no DSP of its own: feature extraction runs through
// StreamingDetector's float feature tap, and scoring/event logic IS
// StreamingDetector (components/alarm_sound_detector/detector_core.*,
// a direct port of tools/detector/ref.py). It is compiled with emscripten:
//
//   emcc -O2 -std=c++17 -I<repo-root> \
//     components/alarm_sound_detector/detector_core.cpp web/wasm/detector_wasm.cpp \
//     -o web/src/wasm/detector.js ...
//
// (see web/wasm/build.sh for the exact flags).
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <new>
#include <vector>

#include "components/alarm_sound_detector/detector_core.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define WASM_API EMSCRIPTEN_KEEPALIVE
#else
#define WASM_API
#endif

using esphome::alarm_sound_detector::StreamingDetector;

namespace {

struct DetHandle {
  StreamingDetector det;
  std::vector<int8_t> tmpl_owned;  // template copy; must outlive det (cf. begin())
  std::vector<float> scores;
  struct Ev {
    uint8_t type;  // 0=unit 1=near 2=alarm_on 3=alarm_off
    double time_s;
    float score;
  };
  std::vector<Ev> events;
};

uint8_t event_type_code(StreamingDetector::EventType t) {
  switch (t) {
    case StreamingDetector::EventType::UNIT:
      return 0;
    case StreamingDetector::EventType::NEAR:
      return 1;
    case StreamingDetector::EventType::ALARM_ON:
      return 2;
    case StreamingDetector::EventType::ALARM_OFF:
      return 3;
  }
  return 255;
}

}  // namespace

extern "C" {

// ---- memory ---------------------------------------------------------------
WASM_API void det_free(void *p) { std::free(p); }

// ---- feature extraction ---------------------------------------------------
// Float dB-above-floor features, row-major [frames x bins], malloc'd (free
// with det_free). Same values the firmware detector uses internally
// (identical to ref.frames_db + ref.above_floor). *out_frames/*out_bins
// receive the geometry; returns nullptr when the band is invalid or there
// are no frames.
WASM_API float *det_features_int16(const int16_t *samples, int32_t n_samples, int32_t bin_lo,
                                  int32_t bin_hi, int32_t *out_frames, int32_t *out_bins) {
  if (out_frames) *out_frames = 0;
  if (out_bins) *out_bins = 0;
  if (samples == nullptr || n_samples <= 0 || bin_lo < 1 || bin_hi > 256 || bin_lo > bin_hi) {
    return nullptr;
  }
  const int32_t bins = bin_hi - bin_lo + 1;
  // Dummy 2-frame template (alternating 0/1: non-flat so begin() accepts it).
  // Scores/events are ignored; only the float feature tap is collected.
  std::vector<int8_t> dummy(static_cast<size_t>(2 * bins));
  for (int32_t i = 0; i < 2 * bins; i++) dummy[static_cast<size_t>(i)] = (i & 1) ? 1 : 0;
  StreamingDetector det;
  if (!det.begin(dummy.data(), 2, static_cast<uint16_t>(bins), 2.0f, 1.5f, 3.125f, 0.25f, 255,
                 0.4f, 1.5f, 7.25f, static_cast<uint16_t>(bin_lo),
                 static_cast<uint16_t>(bin_hi))) {
    return nullptr;
  }
  std::vector<float> feats;
  feats.reserve(1024 * static_cast<size_t>(bins));
  det.set_float_frame_listener([&](const float *row, uint16_t n) {
    feats.insert(feats.end(), row, row + n);
  });
  det.feed_int16(samples, static_cast<size_t>(n_samples));
  const int32_t n_frames = static_cast<int32_t>(feats.size() / static_cast<size_t>(bins));
  if (n_frames == 0) {
    return nullptr;
  }
  float *out = static_cast<float *>(std::malloc(feats.size() * sizeof(float)));
  if (out == nullptr) {
    return nullptr;
  }
  std::memcpy(out, feats.data(), feats.size() * sizeof(float));
  if (out_frames) *out_frames = n_frames;
  if (out_bins) *out_bins = bins;
  return out;
}

// ---- streaming detector ---------------------------------------------------
// period_s < 0 selects single (no-periodicity) mode. Returns nullptr when
// the parameters are invalid (same rules as StreamingDetector::begin).
WASM_API DetHandle *det_create(const int8_t *tmpl, int32_t frames, int32_t bins, float threshold,
                              float near_threshold, float period_s, float period_tol_s,
                              int32_t min_repetitions, float peak_window_s, float refractory_s,
                              float release_s, int32_t bin_lo, int32_t bin_hi) {
  if (tmpl == nullptr || frames <= 0 || frames > 65535 || bins <= 0 || bins > 65535 ||
      min_repetitions <= 0 || min_repetitions > 255) {
    return nullptr;
  }
  DetHandle *h = new (std::nothrow) DetHandle();
  if (h == nullptr) {
    return nullptr;
  }
  // The core only borrows the template pointer (on firmware it lives in
  // flash), so keep an owned copy in the handle.
  h->tmpl_owned.assign(tmpl, tmpl + static_cast<size_t>(frames) * bins);
  if (!h->det.begin(h->tmpl_owned.data(), static_cast<uint16_t>(frames), static_cast<uint16_t>(bins), threshold,
                   near_threshold, period_s, period_tol_s,
                   static_cast<uint8_t>(min_repetitions), peak_window_s, refractory_s, release_s,
                   static_cast<uint16_t>(bin_lo), static_cast<uint16_t>(bin_hi))) {
    delete h;
    return nullptr;
  }
  h->det.set_frame_listener([h](uint32_t, float score) { h->scores.push_back(score); });
  h->det.set_listener([h](const StreamingDetector::Event &e) {
    h->events.push_back(
        DetHandle::Ev{event_type_code(e.type), e.time_s, e.score});
  });
  return h;
}

WASM_API void det_feed_int16(DetHandle *h, const int16_t *samples, int32_t n) {
  if (h == nullptr || samples == nullptr || n <= 0) {
    return;
  }
  h->det.feed_int16(samples, static_cast<size_t>(n));
}

WASM_API int32_t det_num_scores(DetHandle *h) {
  return h == nullptr ? 0 : static_cast<int32_t>(h->scores.size());
}

WASM_API void det_copy_scores(DetHandle *h, float *out) {
  if (h == nullptr || out == nullptr) {
    return;
  }
  std::memcpy(out, h->scores.data(), h->scores.size() * sizeof(float));
}

WASM_API int32_t det_num_events(DetHandle *h) {
  return h == nullptr ? 0 : static_cast<int32_t>(h->events.size());
}

WASM_API void det_copy_events(DetHandle *h, int32_t *out_types, double *out_times,
                             float *out_scores) {
  if (h == nullptr) {
    return;
  }
  for (size_t i = 0; i < h->events.size(); i++) {
    if (out_types) out_types[i] = h->events[i].type;
    if (out_times) out_times[i] = h->events[i].time_s;
    if (out_scores) out_scores[i] = h->events[i].score;
  }
}

WASM_API void det_destroy(DetHandle *h) { delete h; }

}  // extern "C"
