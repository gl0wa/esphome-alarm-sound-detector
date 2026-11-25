// Host equivalence harness for the detector core.
//
// Reads a raw float32 16 kHz mono file plus a raw int8 template blob and
// prints per-frame NCC scores and detector events for comparison against
// tools/detector/ref.py (see tests/detector/test_equivalence.py).
//
// Usage:
//   detector_cli audio.f32 tmpl.i8 frames bins [threshold near period_s tol_s min_rep]
//
// Output (stdout):
//   SCORE <frame_1based> <score>
//   EVENT <unit|near|alarm_on|alarm_off> <time_s> <score>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "detector_core.h"

using esphome::alarm_sound_detector::StreamingDetector;

namespace {

const char *event_name(StreamingDetector::EventType t) {
  switch (t) {
    case StreamingDetector::EventType::UNIT:
      return "unit";
    case StreamingDetector::EventType::NEAR:
      return "near";
    case StreamingDetector::EventType::ALARM_ON:
      return "alarm_on";
    case StreamingDetector::EventType::ALARM_OFF:
      return "alarm_off";
  }
  return "?";
}

bool read_file(const char *path, std::vector<uint8_t> &out) {
  FILE *f = std::fopen(path, "rb");
  if (f == nullptr) {
    return false;
  }
  std::fseek(f, 0, SEEK_END);
  const long n = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  if (n < 0) {
    std::fclose(f);
    return false;
  }
  out.resize(static_cast<size_t>(n));
  const size_t got = std::fread(out.data(), 1, out.size(), f);
  std::fclose(f);
  return got == out.size();
}

}  // namespace

int main(int argc, char **argv) {
  if (argc < 5) {
    std::fprintf(stderr,
                 "usage: %s audio.f32 tmpl.i8 frames bins "
                 "[threshold near period_s tol_s min_rep]\n",
                 argv[0]);
    return 2;
  }
  const char *audio_path = argv[1];
  const char *tmpl_path = argv[2];
  const auto frames = static_cast<uint16_t>(std::atoi(argv[3]));
  const auto bins = static_cast<uint16_t>(std::atoi(argv[4]));
  const float threshold = argc > 5 ? static_cast<float>(std::atof(argv[5])) : 0.55f;
  const float near = argc > 6 ? static_cast<float>(std::atof(argv[6])) : 0.35f;
  const float period = argc > 7 ? static_cast<float>(std::atof(argv[7])) : 3.125f;
  const float tol = argc > 8 ? static_cast<float>(std::atof(argv[8])) : 0.25f;
  const uint8_t min_rep = argc > 9 ? static_cast<uint8_t>(std::atoi(argv[9])) : 2;

  std::vector<uint8_t> audio_raw, tmpl_raw;
  if (!read_file(audio_path, audio_raw) || audio_raw.size() % 4 != 0) {
    std::fprintf(stderr, "cannot read audio %s\n", audio_path);
    return 1;
  }
  if (!read_file(tmpl_path, tmpl_raw)) {
    std::fprintf(stderr, "cannot read template %s\n", tmpl_path);
    return 1;
  }
  if (tmpl_raw.size() != static_cast<size_t>(frames) * bins) {
    std::fprintf(stderr, "template size %zu != %u x %u\n", tmpl_raw.size(), frames, bins);
    return 1;
  }

  StreamingDetector det;
  if (!det.begin(reinterpret_cast<const int8_t *>(tmpl_raw.data()), frames, bins, threshold, near,
                 period, tol, min_rep)) {
    std::fprintf(stderr, "detector begin() failed\n");
    return 1;
  }
  det.set_listener([](const StreamingDetector::Event &e) {
    std::printf("EVENT %s %.6f %.6f\n", event_name(e.type), e.time_s, e.score);
  });
  det.set_frame_listener([](uint32_t frame, float score) {
    std::printf("SCORE %u %.6f\n", frame, score);
  });

  const size_t nsamp = audio_raw.size() / 4;
  // Feed in odd-sized chunks to exercise arbitrary chunk assembly.
  constexpr size_t kChunk = 997;
  size_t off = 0;
  while (off < nsamp) {
    const size_t m = off + kChunk <= nsamp ? kChunk : nsamp - off;
    const auto *p = reinterpret_cast<const float *>(audio_raw.data()) + off;
    det.feed_float(p, m);
    off += m;
  }
  return 0;
}
