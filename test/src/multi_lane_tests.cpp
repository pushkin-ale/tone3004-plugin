// N-lane blend tests (chainCount > 2; see laneMixGains/processLaneGroup in
// Processor.cpp).
//
// Each lane's chain is left empty (an identity passthrough, see
// processChainOnBuffer), so the only thing under test is the pan/level/solo/
// invert mixdown math itself: the mono-summed input feeds every lane
// unchanged, and the expected output is the hand-computed sum of each
// lane's constantPowerPanGains(pan) * mainStageGain(level), same formulas as
// laneMixGains in Processor.cpp. The global gate and tone-stack power
// switches default on, so both are disabled here to keep the pre-chain
// signal exactly the fed noise.
//
// The processor's unconditional 5 Hz first-order DC blocker (Processor.cpp,
// applied to the final 2-channel bus on every callback, gated behind
// nothing) is NOT an identity operation on broadband noise: a first-order
// high-pass rolls off slowly enough that its magnitude/phase deviate from
// unity well up into the audible band, and that deviation doesn't decay
// over time (it's the filter's steady-state response, not a settling
// transient) -- increasing a test's settle skip cannot make it go away.
// Because the mixdown gain is otherwise a static per-lane scalar (no
// smoothing in laneMixGains) and dcBlocker is LTI, this is worked around by
// running the exact same filter (same coefficients/reset lifecycle as
// Processor::prepareToPlay) over the hand-computed pre-filter reference
// signal, so the comparison accounts for it instead of assuming it away.
#include "Processor.h"
#include "chain_test_helpers.h"

#include <gtest/gtest.h>

#include <cmath>
#include <vector>

namespace {

constexpr int kBlock = 512;

// Same formulas as Processor.cpp's static constantPowerPanGains/
// mainStageGain (private to that translation unit, so reimplemented here as
// the independent "hand-computed" reference the plan calls for).
std::pair<float, float> panGains(float pan) {
  const float angle = juce::jlimit(0.0f, 1.0f, pan) * juce::MathConstants<float>::halfPi;
  return {std::cos(angle), std::sin(angle)};
}

float levelGain(float level) { return juce::Decibels::decibelsToGain((level - 0.5f) * 48.0f); }

// Mirrors Processor::prepareToPlay's dcBlocker setup exactly (same
// coefficients, reset to zero state at the same point in the test's
// timeline -- right before the first processStereo call, matching the real
// processor's reset in prepareToPlay). Each test keeps its own instance so
// that in a loop driving the processor multiple times (the level sweep), the
// reference filter's state carries across iterations exactly like the real
// one does.
struct RefDcBlocker {
  juce::dsp::IIR::Filter<float> filter;
  RefDcBlocker() {
    filter.coefficients = juce::dsp::IIR::Coefficients<float>::makeFirstOrderHighPass(kFs, 5.0f);
    filter.reset();
  }
  // Filters one channel's pre-DC-blocker signal (already scaled by the
  // lane-mix gain) through the reference filter in place, matching the
  // real per-channel ProcessorDuplicator instance's history.
  std::vector<float> apply(const std::vector<float>& preFilter) {
    std::vector<float> out(preFilter.size());
    for (size_t i = 0; i < preFilter.size(); ++i)
      out[i] = filter.processSample(preFilter[i]);
    return out;
  }
};

std::vector<float> scale(const std::vector<float>& x, float gain) {
  std::vector<float> out(x.size());
  for (size_t i = 0; i < x.size(); ++i)
    out[i] = x[i] * gain;
  return out;
}

// Disables the global gate/tone-stack power switches (both default on) so
// the pre-chain signal is exactly the fed noise, and every lane is an
// identity passthrough (empty chain).
void disableGlobalShaping(ChainTestProcessor& proc) {
  proc.parameters.getParameter("gateEnabled")->setValueNotifyingHost(0.0f);
  proc.parameters.getParameter("toneEqEnabled")->setValueNotifyingHost(0.0f);
}

void setPan(ChainTestProcessor& proc, int lane, float pan) {
  static const char* ids[4] = {"chainPanLeft", "chainPanRight", "chainPanLane3", "chainPanLane4"};
  proc.parameters.getParameter(ids[lane])->setValueNotifyingHost(pan);
}

void setLevel(ChainTestProcessor& proc, int lane, float level) {
  static const char* ids[4] = {"chainLevelLeft", "chainLevelRight", "chainLevelLane3",
                               "chainLevelLane4"};
  proc.parameters.getParameter(ids[lane])->setValueNotifyingHost(level);
}

void setSolo(ChainTestProcessor& proc, int lane, bool solo) {
  static const char* ids[4] = {"chainSoloLeft", "chainSoloRight", "chainSoloLane3",
                               "chainSoloLane4"};
  proc.parameters.getParameter(ids[lane])->setValueNotifyingHost(solo ? 1.0f : 0.0f);
}

void setInvert(ChainTestProcessor& proc, int lane, bool invert) {
  static const char* ids[4] = {"chainInvertLeft", "chainInvertRight", "chainInvertLane3",
                               "chainInvertLane4"};
  proc.parameters.getParameter(ids[lane])->setValueNotifyingHost(invert ? 1.0f : 0.0f);
}

// A stereo rig (2 host channels) with `count` empty lanes at chainCount ==
// count, gate/EQ disabled. Ready to drive once pans/levels/solos/inverts are
// set on the returned processor.
void makeBlendRig(ChainTestProcessor& proc, int count) {
  proc.setPlayConfigDetails(2, 2, kFs, kBlock);
  proc.prepareToPlay(kFs, kBlock);
  std::vector<std::vector<juce::String>> perLane(static_cast<size_t>(count));
  seedLanes(proc, perLane);
  ASSERT_TRUE(waitForChainLoaded(proc)) << "empty lanes should report loaded trivially";
  disableGlobalShaping(proc);
}

}  // namespace

// Pre-lane-count snapshots (undo history, presets, DAW state saved by a
// build before this feature) only ever carried the binary stereoEnabled
// flag and no Chain3Blocks/Chain4Blocks children at all. restoreChainSnapshot
// must infer chainCount from that flag and treat the missing lane-2/3
// children as empty (see the ProcessorHistory.cpp fallback comment), so an
// old 2-lane (or mono) save keeps working unchanged on this build.
TEST(MultiLaneTest, LegacyStereoSnapshotWithoutChainCountInfersTwoLanes) {
  ChainTestProcessor proc;
  proc.setPlayConfigDetails(2, 2, kFs, kBlock);
  proc.prepareToPlay(kFs, kBlock);

  juce::ValueTree state("ChainSnapshot");
  state.setProperty("stereoEnabled", true, nullptr);  // no "chainCount" property at all
  juce::ValueTree left("ChainBlocks");
  left.appendChild(makeIrBlockTree("legacy-left", 1, 100), nullptr);
  state.appendChild(left, nullptr);
  juce::ValueTree right("RightChainBlocks");
  right.appendChild(makeIrBlockTree("legacy-right", 2, 101), nullptr);
  state.appendChild(right, nullptr);
  // Deliberately no Chain3Blocks/Chain4Blocks children (pre-existing shape).

  proc.restoreFromTree(state);
  ASSERT_TRUE(waitForChainLoaded(proc));

  EXPECT_EQ(proc.getChainCount(), 2);
  EXPECT_TRUE(proc.isStereoMode());
}

TEST(MultiLaneTest, LegacyMonoSnapshotWithoutChainCountInfersOneLane) {
  ChainTestProcessor proc;
  proc.setPlayConfigDetails(2, 2, kFs, kBlock);
  proc.prepareToPlay(kFs, kBlock);

  juce::ValueTree state("ChainSnapshot");
  // Neither "stereoEnabled" nor "chainCount" present: the oldest possible
  // shape (mono was the only mode before stereo chains existed).
  juce::ValueTree left("ChainBlocks");
  left.appendChild(makeIrBlockTree("legacy-mono", 1, 100), nullptr);
  state.appendChild(left, nullptr);

  proc.restoreFromTree(state);
  ASSERT_TRUE(waitForChainLoaded(proc));

  EXPECT_EQ(proc.getChainCount(), 1);
  EXPECT_FALSE(proc.isStereoMode());
}

// Equal-power pan-sum: 3 lanes at pan {0, 1, 0.5}, unity level, no solo/
// invert. The pan set is symmetric about center, so L and R must land on
// the exact same hand-computed sum.
TEST(MultiLaneTest, ThreeLanePanSumMatchesHandComputedFormula) {
  ChainTestProcessor proc;
  makeBlendRig(proc, 3);
  setPan(proc, 0, 0.0f);
  setPan(proc, 1, 1.0f);
  setPan(proc, 2, 0.5f);

  const auto in = makeNoise(260 * kBlock, 24601, 0.1f);
  const auto [outL, outR] = processStereo(proc, in);

  const auto [l0, r0] = panGains(0.0f);
  const auto [l1, r1] = panGains(1.0f);
  const auto [l2, r2] = panGains(0.5f);
  const float expectedL = l0 + l1 + l2;  // unity gain per lane
  const float expectedR = r0 + r1 + r2;
  ASSERT_NEAR(expectedL, expectedR, 1e-6f) << "pan set should be symmetric about center";

  RefDcBlocker refL, refR;
  const auto filteredL = refL.apply(scale(in, expectedL));
  const auto filteredR = refR.apply(scale(in, expectedR));

  constexpr size_t skip = 48000;  // chain-edit fade settle
  for (size_t i = skip; i < in.size(); ++i) {
    ASSERT_NEAR(outL[i], filteredL[i], 1e-4f) << "left bus diverged at sample " << i;
    ASSERT_NEAR(outR[i], filteredR[i], 1e-4f) << "right bus diverged at sample " << i;
  }
}

// A mono host rig folds every lane half-to-both channels (laneMixGains'
// foldToMono branch), mirroring imageMatrixGains' pairwise fold.
TEST(MultiLaneTest, MonoRigFoldsAllLanesEvenly) {
  ChainTestProcessor proc;
  proc.setPlayConfigDetails(1, 1, kFs, kBlock);
  seedLanes(proc, {{}, {}, {}});
  proc.prepareToPlay(kFs, kBlock);
  ASSERT_TRUE(waitForChainLoaded(proc));
  disableGlobalShaping(proc);

  const auto in = makeNoise(260 * kBlock, 31415, 0.1f);
  const int total = static_cast<int>(in.size());
  std::vector<float> out(in.size(), 0.0f);
  juce::AudioBuffer<float> buffer(1, kBlock);
  juce::MidiBuffer midi;
  for (int off = 0; off + kBlock <= total; off += kBlock) {
    buffer.copyFrom(0, 0, in.data() + off, kBlock);
    proc.processBlock(buffer, midi);
    std::copy(buffer.getReadPointer(0), buffer.getReadPointer(0) + kBlock, out.begin() + off);
  }

  // Three unity-gain lanes, each folded to 0.5*gain: 0.5*3 = 1.5x.
  RefDcBlocker ref;
  const auto filtered = ref.apply(scale(in, 1.5f));
  constexpr size_t skip = 48000;
  for (size_t i = skip; i < in.size(); ++i)
    ASSERT_NEAR(out[i], filtered[i], 1e-4f) << "mono fold diverged at sample " << i;
}

// Level sweeps the same ±24dB-around-0.5 convention as mainStageGain
// everywhere else in the plugin (input/output trim, balance).
TEST(MultiLaneTest, LevelGainStagingMatchesMainStageGainConvention) {
  ChainTestProcessor proc;
  makeBlendRig(proc, 3);
  // Lane 0 hard left (isolates it on the L bus); lanes 1/2 hard right so
  // they land entirely on R and never contaminate the L-bus assertion.
  setPan(proc, 0, 0.0f);
  setPan(proc, 1, 1.0f);
  setPan(proc, 2, 1.0f);
  setLevel(proc, 1, 0.5f);
  setLevel(proc, 2, 0.5f);

  const auto in = makeNoise(260 * kBlock, 27182, 0.1f);
  constexpr size_t skip = 48000;

  // One reference filter shared across the sweep: the real dcBlocker's state
  // is never reset between these processStereo calls (only prepareToPlay
  // resets it, once, above), so the reference must accumulate history the
  // same way -- fed each iteration's actual pre-filter signal in order.
  RefDcBlocker ref;
  for (const float level : {0.0f, 0.25f, 0.5f, 0.75f, 1.0f}) {
    SCOPED_TRACE("level=" + juce::String(level));
    setLevel(proc, 0, level);
    const auto [outL, outR] = processStereo(proc, in);
    const float expected = levelGain(level);
    const auto filtered = ref.apply(scale(in, expected));
    for (size_t i = skip; i < in.size(); ++i)
      ASSERT_NEAR(outL[i], filtered[i], 1e-4f) << "left bus diverged at sample " << i;
  }
}

// Any soloed lane zeroes every non-soloed lane's contribution, N-way.
TEST(MultiLaneTest, SoloMutesNonSoloedLanes) {
  ChainTestProcessor proc;
  makeBlendRig(proc, 3);
  setPan(proc, 0, 0.0f);
  setPan(proc, 1, 1.0f);
  setPan(proc, 2, 0.5f);
  setSolo(proc, 1, true);  // only lane 1 (hard right) stays audible

  const auto in = makeNoise(260 * kBlock, 16180, 0.1f);
  const auto [outL, outR] = processStereo(proc, in);

  const auto [l1, r1] = panGains(1.0f);
  RefDcBlocker refL, refR;
  const auto filteredL = refL.apply(scale(in, l1));
  const auto filteredR = refR.apply(scale(in, r1));
  constexpr size_t skip = 48000;
  for (size_t i = skip; i < in.size(); ++i) {
    ASSERT_NEAR(outL[i], filteredL[i], 1e-4f) << "left bus should carry only the soloed lane";
    ASSERT_NEAR(outR[i], filteredR[i], 1e-4f) << "right bus should carry only the soloed lane";
  }
}

// Multiple simultaneous solos: both soloed lanes stay audible, the
// unsoloed one is muted (mirrors imageMatrixGains: both-solo leaves both
// chains through, matched here for N lanes).
TEST(MultiLaneTest, MultipleSoloedLanesAllStayAudible) {
  ChainTestProcessor proc;
  makeBlendRig(proc, 3);
  setPan(proc, 0, 0.0f);
  setPan(proc, 1, 1.0f);
  setPan(proc, 2, 0.5f);
  setSolo(proc, 0, true);
  setSolo(proc, 1, true);

  const auto in = makeNoise(260 * kBlock, 12345, 0.1f);
  const auto [outL, outR] = processStereo(proc, in);

  const auto [l0, r0] = panGains(0.0f);
  const auto [l1, r1] = panGains(1.0f);
  const float expectedL = l0 + l1;
  const float expectedR = r0 + r1;
  RefDcBlocker refL, refR;
  const auto filteredL = refL.apply(scale(in, expectedL));
  const auto filteredR = refR.apply(scale(in, expectedR));
  constexpr size_t skip = 48000;
  for (size_t i = skip; i < in.size(); ++i) {
    ASSERT_NEAR(outL[i], filteredL[i], 1e-4f) << "left bus diverged at sample " << i;
    ASSERT_NEAR(outR[i], filteredR[i], 1e-4f) << "right bus diverged at sample " << i;
  }
}

// Invert negates a lane's contribution to the sum, same as chainInvertLeft/
// Right in imageMatrixGains, extended to lane 3.
TEST(MultiLaneTest, InvertNegatesLaneContribution) {
  ChainTestProcessor proc;
  makeBlendRig(proc, 4);
  setPan(proc, 0, 0.0f);
  setPan(proc, 1, 1.0f);
  setPan(proc, 2, 0.5f);
  setPan(proc, 3, 0.5f);
  setInvert(proc, 3, true);

  const auto in = makeNoise(260 * kBlock, 99991, 0.1f);
  const auto [outL, outR] = processStereo(proc, in);

  const auto [l0, r0] = panGains(0.0f);
  const auto [l1, r1] = panGains(1.0f);
  const auto [l2, r2] = panGains(0.5f);
  // Lane 3 has the same pan as lane 2 but inverted, so the two cancel.
  const float expectedL = l0 + l1 + l2 - l2;
  const float expectedR = r0 + r1 + r2 - r2;
  RefDcBlocker refL, refR;
  const auto filteredL = refL.apply(scale(in, expectedL));
  const auto filteredR = refR.apply(scale(in, expectedR));
  constexpr size_t skip = 48000;
  for (size_t i = skip; i < in.size(); ++i) {
    ASSERT_NEAR(outL[i], filteredL[i], 1e-4f) << "left bus diverged at sample " << i;
    ASSERT_NEAR(outR[i], filteredR[i], 1e-4f) << "right bus diverged at sample " << i;
  }
}
