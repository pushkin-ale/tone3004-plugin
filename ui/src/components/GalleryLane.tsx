import React from 'react';
import { ArrowUpDown, Link, PlusCircle } from './icons';
import { GalleryBlock, AddTile, plusIconSize, plusCircleInset } from './GalleryBlock';
import type { AddTileRouting } from './GalleryBlock';
import { KnobControl } from './KnobControl';
import type { KnobVariant } from './KnobInner';
import { fullPanScale, gainDbScale, panScale } from './knobScale';
import type { KnobScale } from './knobScale';

const PAN_LEFT_SCALE = panScale('left');
const PAN_RIGHT_SCALE = panScale('right');
import { ChromeIconButton } from './ChromeIconButton';
import { HELP, helpProps } from './helpText';
import {
  BLACK,
  BORDER,
  BRAND_RED,
  BRAND_YELLOW,
  ICON_BOX_SIZE,
  ICON_SIZE,
  FONT_MONO,
  KNOB_SIZE_SECONDARY,
  MUTED,
  WHITE,
  segmentedCellStyle,
  segmentedGroupStyle,
  uiOffClass,
} from './theme';
import { useParameter } from '../hooks/useParameter';
import { useChainActions } from '../hooks/useChainActions';
import { BlockMeter, DotMeter } from './BlockMeter';
import { meterId as meterIdOf } from '../hooks/useMeters';
import { METER_MIN_DB } from './meterColor';
import type { ChainBranch, ChainItem, ChainSide, LaneId } from '../types/chain';
import { isInsertSlot } from '../types/chain';
/**
 * Lane-level pieces of the chain gallery (see ChainView for the drag
 * orchestration that owns them): the ghost rail, a single lane of tiles,
 * the scroll-edge fades and the stereo pan rail.
 */

export const TILE_SIZE = 224;
/** Stereo shows two lanes, so its tiles shrink to fit the fixed height. */
export const STEREO_TILE_SIZE = 160;
/** Gap between tiles: the visible run of each connector line. */
export const TILE_GAP = 24;
/** Vertical gap between the two stereo lanes. */
export const LANE_GAP = 24;
/** Gutter inside the scroll area; tiles fade out under it while scrolling. */
export const EDGE_FADE_WIDTH = 32;
/** Gap between a lane's own pan/level/meter strip and its first tile. */
export const LANE_CONTROLS_GAP = 16;
/** Fixed width every lane reserves for its strip (whether or not that lane
    renders the lanes-0/1-only seam pill), so every lane's tile grid starts
    at the same x regardless of which lane's controls are widest — required
    for the branch elbow and cross-lane tile alignment to stay correct. */
export const LANE_CONTROLS_WIDTH = 300;

/** Total column height budgeted for stacked lane rows, pinned to the
    original 2-lane case (two STEREO_TILE_SIZE rows plus one gap) so 3/4
    lanes never grow the gallery taller than stereo already does. */
const LANES_HEIGHT_BUDGET = STEREO_TILE_SIZE * 2 + LANE_GAP;

/** Tile size for a lane row at a given chain count: shrinks so all active
    lanes' rows still fit LANES_HEIGHT_BUDGET stacked with LANE_GAP between. */
export const tileSizeForChainCount = (count: number): number =>
  count <= 1 ? TILE_SIZE : Math.floor((LANES_HEIGHT_BUDGET - (count - 1) * LANE_GAP) / count);

/** Signal-flow routing lines for an add tile at the given lane position. */
const addTileRouting = (index: number, count: number): AddTileRouting => {
  if (count <= 1) return 'none';
  if (index === 0) return 'right';
  if (index === count - 1) return 'left';
  return 'both';
};

// Chain branching (stereo mode)
// A branch taps one lane's signal on a connector gap and feeds it to the
// other lane. The affordances live on the gaps between tiles and stay
// invisible until the gap is hovered (CSS :hover, see index.css) so the
// resting state is just the connector lines. Hovering a gap reveals a
// filled white dot that sets (or re-points, when a branch already exists)
// the branch after the tile to its left; hovering the active tap gap
// reveals the same dot, which clears the branch on click. The two-lane
// elbow connector is drawn by ChainView (it spans both lanes).

/** Diameter of the branch dots: half the power-button chrome footprint. */
export const BRANCH_CIRCLE_SIZE = ICON_BOX_SIZE / 2;

/** X center of the connector gap *before* the tile at `index` (i.e. gap g
    sits between tiles g-1 and g), in lane-content coordinates. */
export const gapCenterX = (gapIndex: number, tileSize: number) =>
  gapIndex * (tileSize + TILE_GAP) - TILE_GAP / 2;

/** Filled white disc; set-branch and clear-branch share the same look. */
const branchDotStyle: React.CSSProperties = {
  width: `${BRANCH_CIRCLE_SIZE}rem`,
  height: `${BRANCH_CIRCLE_SIZE}rem`,
  borderRadius: '50%',
  backgroundColor: WHITE,
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  boxSizing: 'border-box',
  flexShrink: 0,
};

/** Full-gap hover zone wrapping a branch dot: the whole 24px connector
    run is the hit/hover area, the button itself stays hidden until then. */
const branchGapStyle = (centerX: number): React.CSSProperties => ({
  position: 'absolute',
  left: `${centerX - TILE_GAP / 2}rem`,
  top: 0,
  bottom: 0,
  width: `${TILE_GAP}rem`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
});

/**
 * Interactive branch layer over a lane's connector gaps (stereo mode only).
 * Every gap following a tone block carries a hover-revealed filled dot that
 * sets (or, while branched, re-points: one move, no clearing first) the
 * branch to that spot. The one exception is the active tap gap on the trunk
 * lane, whose dot clears the branch instead.
 */
const BranchRail: React.FC<{
  items: ChainItem[];
  tileSize: number;
  side: ChainSide;
  branch: ChainBranch | null;
  /** False while a drag is in flight (gap hit targets would fight drops). */
  interactive: boolean;
  onSetBranch: (afterBlockId: string) => void;
  onClearBranch: () => void;
}> = ({ items, tileSize, side, branch, interactive, onSetBranch, onClearBranch }) => {
  const isTrunk = branch != null && branch.side === side;
  const tapIndex = isTrunk ? items.findIndex((i) => i.blockId === branch.afterBlockId) : -1;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3 }}>
      {interactive &&
        items.map((item, index) => {
          // The tap point is a tone block's output, i.e. the gap after it.
          if (index === items.length - 1 || isInsertSlot(item)) return null;
          // The active tap gap carries the clear button below instead.
          if (isTrunk && index === tapIndex) return null;
          return (
            <div
              key={`${item.blockId}-branch-gap`}
              className="branch-gap"
              style={branchGapStyle(gapCenterX(index + 1, tileSize))}
            >
              <button
                type="button"
                className="branch-gap-button"
                onClick={() => onSetBranch(item.blockId)}
                aria-label="Branch from here"
                {...helpProps(HELP.branchGap)}
                style={branchDotStyle}
              />
            </div>
          );
        })}
      {isTrunk && tapIndex !== -1 && (
        <div className="branch-gap" style={branchGapStyle(gapCenterX(tapIndex + 1, tileSize))}>
          <button
            type="button"
            className="branch-gap-button"
            onClick={onClearBranch}
            aria-label="Make chains independent"
            {...helpProps(HELP.branchJunction)}
            style={branchDotStyle}
          />
        </div>
      )}
    </div>
  );
};

/**
 * Static ghost rail behind a lane: one plus circle per slot, connector lines
 * between them. The circles sit hidden behind the (opaque) tiles and appear
 * when a slot is vacated mid-drag; only the line runs inside the gaps are
 * visible otherwise. Mirrors the old vertical chain's background exactly.
 */
const GhostRail: React.FC<{ slots: number; tileSize: number }> = ({ slots, tileSize }) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      gap: `${TILE_GAP}rem`,
      pointerEvents: 'none',
      zIndex: 1,
    }}
  >
    {Array.from({ length: slots }, (_, i) => (
      <span
        key={`${i}-rail`}
        style={{
          width: `${tileSize}rem`,
          height: `${tileSize}rem`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          flexShrink: 0,
        }}
      >
        {i > 0 && (
          // Runs from the previous slot's plus ring to this slot's, extended
          // past each icon's bounding box by plusCircleInset so the line
          // actually meets the drawn circle (see GalleryBlock).
          <div
            style={{
              position: 'absolute',
              left: `${-(TILE_GAP + tileSize / 2 - plusIconSize(tileSize) / 2 + plusCircleInset(plusIconSize(tileSize)))}rem`,
              top: '50%',
              width: `${TILE_GAP + tileSize - plusIconSize(tileSize) + 2 * plusCircleInset(plusIconSize(tileSize))}rem`,
              height: '2rem',
              backgroundColor: '#ffffff',
              transform: 'translateY(-50%)',
            }}
          />
        )}
        <PlusCircle size={plusIconSize(tileSize)} strokeWidth={1} />
      </span>
    ))}
  </div>
);

/** One lane of tiles over its ghost rail (no scroll of its own; both lanes
    share the outer scroll area). Native keeps every lane at its minimum slot
    layout (5 tiles, always ≥1 insert), so each item here is a real block,
    insert slots included, and every tile is reorderable. While branched,
    native also trims the branch lane's surplus trailing inserts so its
    indented rail ends level with the trunk (see alignBranchLaneLengths). */
export const GalleryLane: React.FC<{
  items: ChainItem[];
  tileSize: number;
  /** Stereo mode: enables the branch affordances on the connector gaps. */
  stereo?: boolean;
  onOpen: (blockId: string) => void;
  /** Open the tone browser targeting the clicked insert slot. */
  onAdd: (insertBlockId: string) => void;
  /** Paste the copied block into the insert slot at this lane index; null
      while there's nothing valid to paste (insert action sheets show Paste
      disabled). */
  onPasteBlock?: ((index: number) => void) | null;
  /** Which lane this is; feeds the tile group id and (lanes 0/1 only) the
      branch affordances. */
  side?: LaneId;
  /** Active branch (stereo only); drives the junction node on the trunk. */
  branch?: ChainBranch | null;
  /** Show the hover branch buttons on the connector gaps (stereo, no drag
      in flight). */
  branchInteractive?: boolean;
  onSetBranch?: (afterBlockId: string) => void;
  onClearBranch?: () => void;
  /** This lane's own pan/level/solo/invert/meter strip, inline at the row's
      left edge (see useChainLaneStrips). Null/omitted at chainCount 1, where
      a single chain has nothing to pan or blend against. */
  controls?: React.ReactNode;
}> = ({
  items,
  tileSize,
  stereo = false,
  onOpen,
  onAdd,
  onPasteBlock = null,
  side = 'left',
  branch = null,
  branchInteractive = false,
  onSetBranch,
  onClearBranch,
  controls = null,
}) => (
  <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: `${LANE_CONTROLS_GAP}rem` }}>
    {controls != null && (
      // Fixed-width slot regardless of this lane's actual content width, so
      // every lane's tile grid lines up at the same x (branch elbow math and
      // cross-lane tile alignment both assume this).
      <div style={{ width: `${LANE_CONTROLS_WIDTH}rem`, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        {controls}
      </div>
    )}
    <div style={{ position: 'relative', width: 'max-content' }}>
      <GhostRail slots={items.length} tileSize={tileSize} />
      {stereo && (branchInteractive || branch != null) && (
        // Branching is a lanes-0/1-only concept (see setChainCount, which
        // clears any branch before allowing >2 lanes); `stereo` here is only
        // ever true for those two GalleryLane instances, so this narrowing is
        // safe despite `side` accepting the full LaneId vocabulary.
        <BranchRail
          items={items}
          tileSize={tileSize}
          side={side as ChainSide}
          branch={branch}
          interactive={branchInteractive}
          onSetBranch={onSetBranch ?? (() => {})}
          onClearBranch={onClearBranch ?? (() => {})}
        />
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: `${TILE_GAP}rem`,
          position: 'relative',
          zIndex: 2,
        }}
      >
        {items.map((item, index) =>
          isInsertSlot(item) ? (
            <AddTile
              key={item.blockId}
              id={item.blockId}
              index={index}
              group={side}
              size={tileSize}
              routing={addTileRouting(index, items.length)}
              onClick={() => onAdd(item.blockId)}
              onPaste={onPasteBlock != null ? () => onPasteBlock(index) : null}
            />
          ) : (
            <GalleryBlock
              key={item.blockId}
              block={item}
              index={index}
              group={side}
              size={tileSize}
              onOpen={onOpen}
            />
          )
        )}
      </div>
    </div>
  </div>
);

/** Per-lane solo + mute + polarity as one segmented [S|M|Ø] under the pan
    label. Grey idle; Solo arms house-yellow, Mute arms brand-red (the usual
    console convention, and a visual cue distinct from Solo's exclusivity).
    Solo ("S") auditions its chain (exclusive: engaging one clears every
    other lane's); Mute ("M") silences its chain, independent of and
    additive with every other lane's mute/solo (mute always wins even over
    solo — see imageMatrixGains/laneMixGains); polarity ("Ø") flips its
    chain's sign, for captures that land 180° out. All three act inside the
    native image matrix, on the same smoothers as pan moves, so none click. */
const PanRailChips: React.FC<{
  solo: boolean;
  mute: boolean;
  invert: boolean;
  soloHelp: string;
  muteHelp: string;
  invertHelp: string;
  onSolo: () => void;
  onMute: () => void;
  onInvert: () => void;
}> = ({ solo, mute, invert, soloHelp, muteHelp, invertHelp, onSolo, onMute, onInvert }) => {
  const cell = (on: boolean, color: string): React.CSSProperties => ({
    ...segmentedCellStyle(false),
    minWidth: `${ICON_BOX_SIZE}rem`,
    color: on ? BLACK : MUTED,
    backgroundColor: on ? color : 'transparent',
  });
  return (
    <div style={segmentedGroupStyle()}>
      <button type="button" onClick={onSolo} {...helpProps(soloHelp)} style={cell(solo, BRAND_YELLOW)}>
        <span className="cap-trim">S</span>
      </button>
      <button type="button" onClick={onMute} {...helpProps(muteHelp)} style={cell(mute, BRAND_RED)}>
        <span className="cap-trim">M</span>
      </button>
      <button type="button" onClick={onInvert} {...helpProps(invertHelp)} style={cell(invert, BRAND_YELLOW)}>
        <span className="cap-trim">Ø</span>
      </button>
    </div>
  );
};

/** Lanes 0/1's pairwise seam controls: pan link + whole-chain swap, or the
    MONO chip when the rig sums them (linking pans and swapping lanes matter
    little to a mono blend, and the chip explains their joint output from the
    same spot). Rendered inside lane 0's strip; every other lane renders the
    same footprint `hidden` (visibility, not display) so every lane's strip
    is exactly as wide and its tile grid starts at the same x — see
    LANE_CONTROLS_WIDTH. */
const LaneSeam: React.FC<{
  linked: boolean;
  monoSum: boolean;
  onToggleLink: () => void;
  onSwap: () => void;
  hidden?: boolean;
}> = ({ linked, monoSum, onToggleLink, onSwap, hidden = false }) => (
  <div
    {...(!hidden && monoSum ? helpProps(HELP.monoSum) : {})}
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: '4rem',
      border: BORDER,
      borderRadius: '9999rem',
      padding: '3rem 5rem',
      flexShrink: 0,
      visibility: hidden ? 'hidden' : 'visible',
      pointerEvents: hidden ? 'none' : undefined,
    }}
  >
    {monoSum ? (
      <div
        style={{
          width: `${ICON_BOX_SIZE * 2 + 4}rem`,
          height: `${ICON_BOX_SIZE}rem`,
          display: 'grid',
          placeItems: 'center',
          color: MUTED,
          fontSize: '11rem',
          fontFamily: FONT_MONO,
          lineHeight: 1,
        }}
      >
        <span className="cap-trim">MONO</span>
      </div>
    ) : (
      <>
        <ChromeIconButton tone="link" on={linked} help={HELP.panLink} onClick={onToggleLink} offsetY={0}>
          <Link size={ICON_SIZE} style={{ transform: 'rotate(0deg)' }} />
        </ChromeIconButton>
        <ChromeIconButton help={HELP.swapChains} onClick={onSwap} offsetY={0}>
          <ArrowUpDown size={ICON_SIZE} />
        </ChromeIconButton>
      </>
    )}
  </div>
);

/** One lane's inline pan/level/solo/invert/meter strip: seam (lane 0 only,
    hidden elsewhere) → Pan → [S|Ø] → Level → level meter, all in a row at
    the lane's own row height so it never shrinks as more lanes stack (unlike
    the old shared-height rail column, whose per-lane share shrank toward
    unusable at chainCount 3/4). */
const LaneStrip: React.FC<{
  dimmed?: boolean;
  panLabel: string;
  panValue: number;
  onPanChange: (value: number) => void;
  onPanDrag: (dragging: boolean) => void;
  panVariant: KnobVariant;
  panMin?: number;
  panMax?: number;
  panDefault: number;
  panParamId: string;
  panScale: KnobScale;
  panHelp: string;
  solo: boolean;
  mute: boolean;
  invert: boolean;
  onSolo: () => void;
  onMute: () => void;
  onInvert: () => void;
  soloHelp: string;
  muteHelp: string;
  invertHelp: string;
  levelValue: number;
  onLevelChange: (value: number) => void;
  onLevelDrag: (dragging: boolean) => void;
  levelLabel: string;
  levelParamId: string;
  levelHelp: string;
  /** This lane's last real block's output meter id, or null when the lane
      has no processed block yet (renders a static off meter). */
  meterKey: string | null;
  /** Vertical extent of the meter, px — matches this lane's own tile size so
      the meter's row never grows past the tile it sits beside (see
      useChainLaneStrips/tileSizeForChainCount), and reads with noticeably
      more resolution at chainCount 2 (160, same family value as the block
      rails' RAIL_METER_HEIGHT) than the old fixed horizontal strip did. */
  meterHeight: number;
  seam: React.ReactNode;
}> = ({
  dimmed = false,
  panLabel,
  panValue,
  onPanChange,
  onPanDrag,
  panVariant,
  panMin,
  panMax,
  panDefault,
  panParamId,
  panScale: scale,
  panHelp,
  solo,
  mute,
  invert,
  onSolo,
  onMute,
  onInvert,
  soloHelp,
  muteHelp,
  invertHelp,
  levelValue,
  onLevelChange,
  onLevelDrag,
  levelLabel,
  levelParamId,
  levelHelp,
  meterKey,
  meterHeight,
  seam,
}) => {
  const panOffWrap: React.CSSProperties = { transition: 'opacity 0.2s ease' };
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '12rem' }}>
      {seam}
      <div className={uiOffClass(dimmed)} style={panOffWrap} {...(dimmed ? helpProps(HELP.panMonoSum) : {})}>
        <KnobControl
          label={panLabel}
          value={panValue}
          onChange={onPanChange}
          variant={panVariant}
          min={panMin}
          max={panMax}
          size={KNOB_SIZE_SECONDARY}
          thumb="secondary"
          scale={scale}
          defaultValue={panDefault}
          paramId={panParamId}
          help={panHelp}
          labelBright
          onDragStateChange={onPanDrag}
        />
      </div>
      <PanRailChips
        solo={solo}
        mute={mute}
        invert={invert}
        soloHelp={soloHelp}
        muteHelp={muteHelp}
        invertHelp={invertHelp}
        onSolo={onSolo}
        onMute={onMute}
        onInvert={onInvert}
      />
      <KnobControl
        label={levelLabel}
        value={levelValue}
        onChange={onLevelChange}
        size={KNOB_SIZE_SECONDARY}
        thumb="secondary"
        scale={gainDbScale}
        defaultValue={0.5}
        paramId={levelParamId}
        help={levelHelp}
        labelBright
        onDragStateChange={onLevelDrag}
      />
      {meterKey != null ? (
        <BlockMeter meterId={meterKey} orientation="vertical" length={meterHeight} />
      ) : (
        <DotMeter db={METER_MIN_DB} length={meterHeight} orientation="vertical" />
      )}
    </div>
  );
};

/**
 * Per-lane pan/level/solo/invert/meter strips, one per active lane (index
 * 0-3), each meant to render inline at the left of that lane's own
 * GalleryLane row (see ChainView) instead of a single external rail column
 * shared across every lane — the old column divided a fixed height by lane
 * count, which squeezed lanes 3/4's knobs toward unusable; a lane's own row
 * never shrinks below its tile size regardless of how many lanes are active.
 *
 * Lanes 0/1 keep their original linked, half-track pan design with the link
 * toggle and whole-chain swap folded into lane 0's strip (branch/Align/
 * Auto-Balance are inherently pairwise and stay scoped to just these two
 * lanes); lanes 2/3, added for chainCount 3/4, get a plain full-range pan
 * knob and no seam of their own — every lane still reserves the same seam
 * footprint (hidden past lane 0) so every strip is the same width and every
 * lane's tile grid starts at the same x. Constant-power pan positions (0 =
 * hard left, 1 = hard right): Pan L covers hard left..center on a half
 * track, Pan R center..hard right. Linked (default) mirrors L/R so width
 * changes stay symmetric.
 *
 * `monoSum` (a rig that can't reproduce stereo): native sums lanes 0/1 to
 * mono, so their pans dim and go inert, and the seam swaps its link/swap
 * buttons for a MONO chip that says why. Solo, polarity and lanes 2/3 stay
 * live: they act on the chains inside (and alongside) the sum.
 *
 * Returns an array of 4 slots (null past `chainCount`, and all null below
 * chainCount 2 — a single chain has nothing to pan or blend against).
 */
export function useChainLaneStrips(
  chainCount: 1 | 2 | 3 | 4,
  monoSum: boolean,
  lastBlockIds: (string | null)[],
  tileSize: number
): (React.ReactNode | null)[] {
  const { swapChains } = useChainActions();
  const [panLeft, setPanLeft, onPanLeftDrag] = useParameter('chainPanLeft', 'slider');
  const [panRight, setPanRight, onPanRightDrag] = useParameter('chainPanRight', 'slider');
  const [linked, setLinked] = useParameter('chainPanLinked', 'toggle');
  const [soloLeft, setSoloLeft] = useParameter('chainSoloLeft', 'toggle');
  const [soloRight, setSoloRight] = useParameter('chainSoloRight', 'toggle');
  const [muteLeft, setMuteLeft] = useParameter('chainMuteLeft', 'toggle');
  const [muteRight, setMuteRight] = useParameter('chainMuteRight', 'toggle');
  const [invertLeft, setInvertLeft] = useParameter('chainInvertLeft', 'toggle');
  const [invertRight, setInvertRight] = useParameter('chainInvertRight', 'toggle');
  const [levelLeft, setLevelLeft, onLevelLeftDrag] = useParameter('chainLevelLeft', 'slider');
  const [levelRight, setLevelRight, onLevelRightDrag] = useParameter('chainLevelRight', 'slider');
  const [pan3, setPan3, onPan3Drag] = useParameter('chainPanLane3', 'slider');
  const [solo3, setSolo3] = useParameter('chainSoloLane3', 'toggle');
  const [mute3, setMute3] = useParameter('chainMuteLane3', 'toggle');
  const [invert3, setInvert3] = useParameter('chainInvertLane3', 'toggle');
  const [level3, setLevel3, onLevel3Drag] = useParameter('chainLevelLane3', 'slider');
  const [pan4, setPan4, onPan4Drag] = useParameter('chainPanLane4', 'slider');
  const [solo4, setSolo4] = useParameter('chainSoloLane4', 'toggle');
  const [mute4, setMute4] = useParameter('chainMuteLane4', 'toggle');
  const [invert4, setInvert4] = useParameter('chainInvertLane4', 'toggle');
  const [level4, setLevel4, onLevel4Drag] = useParameter('chainLevelLane4', 'slider');

  const handlePanLeft = (value: number) => {
    setPanLeft(value);
    if (linked) setPanRight(1 - value);
  };
  const handlePanRight = (value: number) => {
    setPanRight(value);
    if (linked) setPanLeft(1 - value);
  };
  const handleToggleLink = () => {
    const next = !linked;
    setLinked(next);
    // Re-linking snaps back to a symmetric image, anchored on the left pan.
    if (next) setPanRight(1 - panLeft);
  };
  // N-way solo: engaging one lane's solo clears every other lane's, so the
  // rail always reads as "audition one chain at a time" regardless of how
  // many lanes are active (native independently zeroes every non-soloed
  // lane's gain the instant any lane is soloed; this just keeps the UI in
  // that single-solo shape).
  const soloSetters = [setSoloLeft, setSoloRight, setSolo3, setSolo4];
  const toggleSolo = (laneIndex: number, current: boolean) => {
    const next = !current;
    soloSetters[laneIndex](next);
    if (next) soloSetters.forEach((set, i) => i !== laneIndex && set(false));
  };
  // Mute is independent per lane (unlike solo): toggling one lane's mute
  // never touches any other lane's mute or solo state.
  const muteSetters = [setMuteLeft, setMuteRight, setMute3, setMute4];
  const toggleMute = (laneIndex: number, current: boolean) => muteSetters[laneIndex](!current);

  // A single chain has nothing to pan or blend against; no strips at all.
  if (chainCount < 2) return [null, null, null, null];

  return [
    <LaneStrip
      key="lane-0"
      dimmed={monoSum}
      panLabel="Pan L"
      panValue={panLeft}
      onPanChange={handlePanLeft}
      onPanDrag={onPanLeftDrag}
      panVariant="panLeft"
      panMin={0}
      panMax={0.5}
      panDefault={0}
      panParamId="chainPanLeft"
      panScale={PAN_LEFT_SCALE}
      panHelp={HELP.panLeft}
      solo={soloLeft}
      mute={muteLeft}
      invert={invertLeft}
      onSolo={() => toggleSolo(0, soloLeft)}
      onMute={() => toggleMute(0, muteLeft)}
      onInvert={() => setInvertLeft(!invertLeft)}
      soloHelp={HELP.soloLeft}
      muteHelp={HELP.muteLeft}
      invertHelp={HELP.invertLeft}
      levelValue={levelLeft}
      onLevelChange={setLevelLeft}
      onLevelDrag={onLevelLeftDrag}
      levelLabel="Lvl L"
      levelParamId="chainLevelLeft"
      levelHelp={HELP.levelLeft}
      meterKey={lastBlockIds[0] != null ? meterIdOf.blockOut(lastBlockIds[0]) : null}
      meterHeight={tileSize}
      seam={
        <LaneSeam linked={linked} monoSum={monoSum} onToggleLink={handleToggleLink} onSwap={swapChains} />
      }
    />,
    <LaneStrip
      key="lane-1"
      dimmed={monoSum}
      panLabel="Pan R"
      panValue={panRight}
      onPanChange={handlePanRight}
      onPanDrag={onPanRightDrag}
      panVariant="panRight"
      panMin={0.5}
      panMax={1}
      panDefault={1}
      panParamId="chainPanRight"
      panScale={PAN_RIGHT_SCALE}
      panHelp={HELP.panRight}
      solo={soloRight}
      mute={muteRight}
      invert={invertRight}
      onSolo={() => toggleSolo(1, soloRight)}
      onMute={() => toggleMute(1, muteRight)}
      onInvert={() => setInvertRight(!invertRight)}
      soloHelp={HELP.soloRight}
      muteHelp={HELP.muteRight}
      invertHelp={HELP.invertRight}
      levelValue={levelRight}
      onLevelChange={setLevelRight}
      onLevelDrag={onLevelRightDrag}
      levelLabel="Lvl R"
      levelParamId="chainLevelRight"
      levelHelp={HELP.levelRight}
      meterKey={lastBlockIds[1] != null ? meterIdOf.blockOut(lastBlockIds[1]) : null}
      meterHeight={tileSize}
      seam={<LaneSeam linked={linked} monoSum={monoSum} onToggleLink={handleToggleLink} onSwap={swapChains} hidden />}
    />,
    chainCount >= 3 ? (
      <LaneStrip
        key="lane-2"
        panLabel="Pan 3"
        panValue={pan3}
        onPanChange={setPan3}
        onPanDrag={onPan3Drag}
        panVariant="bipolar"
        panDefault={0.5}
        panParamId="chainPanLane3"
        panScale={fullPanScale}
        panHelp={HELP.panLane3}
        solo={solo3}
        mute={mute3}
        invert={invert3}
        onSolo={() => toggleSolo(2, solo3)}
        onMute={() => toggleMute(2, mute3)}
        onInvert={() => setInvert3(!invert3)}
        soloHelp={HELP.soloLane3}
        muteHelp={HELP.muteLane3}
        invertHelp={HELP.invertLane3}
        levelValue={level3}
        onLevelChange={setLevel3}
        onLevelDrag={onLevel3Drag}
        levelLabel="Lvl 3"
        levelParamId="chainLevelLane3"
        levelHelp={HELP.levelLane3}
        meterKey={lastBlockIds[2] != null ? meterIdOf.blockOut(lastBlockIds[2]) : null}
        meterHeight={tileSize}
        seam={<LaneSeam linked={linked} monoSum={monoSum} onToggleLink={handleToggleLink} onSwap={swapChains} hidden />}
      />
    ) : null,
    chainCount >= 4 ? (
      <LaneStrip
        key="lane-3"
        panLabel="Pan 4"
        panValue={pan4}
        onPanChange={setPan4}
        onPanDrag={onPan4Drag}
        panVariant="bipolar"
        panDefault={0.5}
        panParamId="chainPanLane4"
        panScale={fullPanScale}
        panHelp={HELP.panLane4}
        solo={solo4}
        mute={mute4}
        invert={invert4}
        onSolo={() => toggleSolo(3, solo4)}
        onMute={() => toggleMute(3, mute4)}
        onInvert={() => setInvert4(!invert4)}
        soloHelp={HELP.soloLane4}
        muteHelp={HELP.muteLane4}
        invertHelp={HELP.invertLane4}
        levelValue={level4}
        onLevelChange={setLevel4}
        onLevelDrag={onLevel4Drag}
        levelLabel="Lvl 4"
        levelParamId="chainLevelLane4"
        levelHelp={HELP.levelLane4}
        meterKey={lastBlockIds[3] != null ? meterIdOf.blockOut(lastBlockIds[3]) : null}
        meterHeight={tileSize}
        seam={<LaneSeam linked={linked} monoSum={monoSum} onToggleLink={handleToggleLink} onSwap={swapChains} hidden />}
      />
    ) : null,
  ];
}

/**
 * The two-lane elbow of an active branch: a vertical drop from the trunk
 * lane's tap gap to the branch lane's row, plus the short horizontal stub
 * into the branch lane's first tile, using the same 1px hairlines as the ghost rail.
 * Positioned by ChainView inside the lanes column (it spans both lanes);
 * `x` is the tap gap's center in column coordinates.
 */
export const BranchElbow: React.FC<{ x: number; tileSize: number; trunkOnTop: boolean }> = ({
  x,
  tileSize,
  trunkOnTop,
}) => {
  const topLaneCenter = tileSize / 2;
  const bottomLaneCenter = tileSize + LANE_GAP + tileSize / 2;
  const stubY = trunkOnTop ? bottomLaneCenter : topLaneCenter;
  const line: React.CSSProperties = {
    position: 'absolute',
    backgroundColor: '#ffffff',
    pointerEvents: 'none',
    zIndex: 1,
  };
  return (
    <>
      <div
        style={{
          ...line,
          left: `${x}rem`,
          top: `${topLaneCenter}rem`,
          width: '2rem',
          height: `${bottomLaneCenter - topLaneCenter}rem`,
          transform: 'translateX(-50%)',
        }}
      />
      <div
        style={{
          ...line,
          left: `${x}rem`,
          top: `${stubY}rem`,
          width: `${TILE_GAP / 2}rem`,
          height: '2rem',
          transform: 'translateY(-50%)',
        }}
      />
    </>
  );
};

/** Fade the lanes out under the gutters as they scroll, so content slides
    behind a smooth ramp to the background instead of hard-clipping. */
export const EdgeFade: React.FC<{ side: 'left' | 'right' }> = ({ side }) => (
  <div
    style={{
      position: 'absolute',
      top: 0,
      bottom: 0,
      // Overhang the outer edge by a design px: at fractional UI scales the
      // scrollport's clip edge and this overlay can round to different
      // device pixels, which would leave a subpixel strip of content visible
      // just past the fade. The overhang end is solid black over the black
      // background, so it never shows.
      [side]: '-1rem',
      width: `${EDGE_FADE_WIDTH + 1}rem`,
      background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, #000000, rgba(0, 0, 0, 0))`,
      pointerEvents: 'none',
      zIndex: 3,
    }}
  />
);
