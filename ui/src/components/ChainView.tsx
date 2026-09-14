import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getUiScale, rem } from '../hooks/useUiScale';
import { DragDropProvider } from '@dnd-kit/react';
import { isSortable } from '@dnd-kit/react/sortable';
import { KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import type {
  DragDropManager,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  Sensors,
} from '@dnd-kit/dom';
import { arrayMove } from '@dnd-kit/helpers';
import { ChainBlock } from './ChainBlock';
import {
  BranchElbow,
  EdgeFade,
  GalleryLane,
  LANE_CONTROLS_GAP,
  LANE_CONTROLS_WIDTH,
  LANE_GAP,
  TILE_GAP,
  EDGE_FADE_WIDTH,
  gapCenterX,
  tileSizeForChainCount,
  useChainLaneStrips,
} from './GalleryLane';
import { useChainActions } from '../hooks/useChainActions';
import { useHorizontalWheelScroll } from '../hooks/useHorizontalWheelScroll';
import { FONT_MONO, WHITE } from './theme';
import type { ChainBranch, ChainItem, ChainSide, ToneBlock } from '../types/chain';
import { isInsertSlot, laneIdForIndex } from '../types/chain';

/**
 * Chain gallery: blocks render as square image tiles in horizontal,
 * left-to-right lanes over a static ghost rail of plus circles joined by
 * connector lines. Dragging a
 * tile away reveals the rail behind its slot. (Lane internals live in
 * GalleryLane.tsx; this component owns the drag orchestration.)
 *
 * chainCount 1 shows a single lane; 2-4 stack every active lane in a single
 * shared scroll area, with the per-lane pan/level/solo/invert rail (plus the
 * lanes-0/1-only link/swap pill) on the left. One drag context spans every
 * active lane and the lane lists are mirrored into optimistic local state,
 * so cross-lane drags reflow the target lane live (onDragOver) and drops
 * land without any snap-back while the native roundtrip completes. Tap/click
 * opens the detail takeover; drag a tile to reorder.
 */

/**
 * The block whose detail takeover is open, persisted so it survives this
 * component unmounting while the tone browser (and its OAuth redirect) is up.
 * Cleared from Plugin on preset load so a remount lands on the gallery.
 */
export const DETAIL_BLOCK_STORAGE_KEY = 't3k.detailBlockId';

/**
 * Gallery scroll offset in design px, persisted for the same reason: the
 * scroller unmounts under the detail takeover, the tone browser, and the
 * tuner, and coming back should land where the user left off (issue #82).
 * Cleared from Plugin on preset load so a new chain starts at the left edge.
 */
export const CHAIN_SCROLL_STORAGE_KEY = 't3k.chainScroll';

interface ChainViewProps {
  /** Lane 0 (the only lane at chainCount 1). */
  chain: ChainItem[];
  /** Lane 1, or null below chainCount 2. */
  chainRight: ChainItem[] | null;
  /** Lane 2, or null below chainCount 3. */
  chain3?: ChainItem[] | null;
  /** Lane 3, or null below chainCount 4. */
  chain4?: ChainItem[] | null;
  /** Number of active parallel chains, 1-4. */
  chainCount: 1 | 2 | 3 | 4;
  /** Active branch (lanes 0/1 only, chainCount 2 exactly), or null when the
      chains are independent. */
  branch: ChainBranch | null;
  /** Lanes 0/1 on a rig that can't reproduce stereo: native sums them
      to mono. The pan rail dims their pans and shows the MONO chip. */
  monoSum: boolean;
  /** Whether the native block clipboard holds a copied block (enables Paste
      on insert slots). Survives preset switches: the clipboard snapshot is
      self-contained, not a reference into the current chain. */
  canPaste: boolean;
  sampleRate: number;
  /** Default NAM A2 size for new blocks; the detail card's size chip only
      shows when a block differs from it. */
  namSlimSizeDefault: number;
  /** Block info view: drop the meter-band bottom pad so scroll reaches the faceplate. */
  onFillToFaceplate?: (fill: boolean) => void;
  /** Bumped on preset load so an open detail takeover returns to the gallery. */
  returnToGallery?: number;
}

/** Design-px of travel before a drag engages, so tap/click stays a click.
    Scaled to real px per gesture so the feel tracks the rendered tile size. */
const GALLERY_DRAG_DISTANCE_PX = 6;

const sensors: Sensors = [
  // Distance-only activation (the stock constraints add a 200ms hold trigger,
  // which would turn a slow click-to-open into a drag). The sensor's default
  // guard already keeps buttons and other interactive chrome from starting
  // drags, so power/swap/trash stay clicks.
  PointerSensor.configure({
    activationConstraints: () => [
      new PointerActivationConstraints.Distance({
        value: GALLERY_DRAG_DISTANCE_PX * getUiScale(),
      }),
    ],
  }),
  // Stock keyboard sorting: Space or Enter on a focused tile picks it up,
  // arrows snap it one slot per press (the sortable's SortableKeyboardPlugin
  // owns the targeting), Space/Enter drops, Escape cancels. A grab can only
  // start on the focused tile, so this stays intentional: Space/Enter
  // anywhere else still falls through to the host DAW (see keyPassthrough.ts).
  KeyboardSensor,
];

/** Array-indexed lane mirror (index = lane index 0-3), replacing the old
    2-lane `Record<ChainSide, ...>` shape now that up to 4 lanes are active. */
type Lanes = ChainItem[][];

/** Id of the ⌥-duplicate stand-in: the inert copy of the dragged block that
    holds its home slot while the standard drag machinery runs untouched. */
const DUP_STAND_IN_ID = '__duplicate-stand-in__';

export const ChainView: React.FC<ChainViewProps> = ({
  chain,
  chainRight,
  chain3 = null,
  chain4 = null,
  chainCount,
  branch,
  monoSum,
  canPaste,
  sampleRate,
  namSlimSizeDefault,
  onFillToFaceplate,
  returnToGallery = 0,
}) => {
  const actions = useChainActions();
  const wheelScrollRef = useHorizontalWheelScroll<HTMLDivElement>();
  // One callback ref wires the scroller: it restores the saved offset before
  // first paint, persists it as the user scrolls, and attaches the wheel
  // hook's panning. The hook returns a cleanup (and once a ref callback
  // returns a cleanup React never calls it with null), so it must be
  // forwarded here, not swallowed: StrictMode's dev double-attach would
  // stack a second wheel listener.
  const galleryScrollRef = useCallback(
    (el: HTMLDivElement) => {
      // Stored in design px so a window rescale between visits lands in the
      // same place; an offset past the end (the chain shrank) clamps on
      // assignment.
      const saved = Number(sessionStorage.getItem(CHAIN_SCROLL_STORAGE_KEY));
      if (saved > 0) el.scrollLeft = saved * getUiScale();
      const save = () =>
        sessionStorage.setItem(CHAIN_SCROLL_STORAGE_KEY, String(el.scrollLeft / getUiScale()));
      el.addEventListener('scroll', save, { passive: true });
      const wheelCleanup = wheelScrollRef(el);
      return () => {
        el.removeEventListener('scroll', save);
        if (typeof wheelCleanup === 'function') wheelCleanup();
      };
    },
    [wheelScrollRef]
  );
  // Persisted so the detail takeover survives this component unmounting: a
  // swap from the detail view opens the tone browser (which replaces the whole
  // chain view, and may bounce through the tone3000.com OAuth redirect). The
  // swap keeps the same blockId, so we reopen the detail view for it on return.
  // Cleared when the user backs out, so gallery-initiated swaps land on the
  // gallery, not a stale detail view.
  const [detailBlockId, setDetailBlockId] = useState<string | null>(() =>
    sessionStorage.getItem(DETAIL_BLOCK_STORAGE_KEY)
  );
  useEffect(() => {
    if (detailBlockId) sessionStorage.setItem(DETAIL_BLOCK_STORAGE_KEY, detailBlockId);
    else sessionStorage.removeItem(DETAIL_BLOCK_STORAGE_KEY);
  }, [detailBlockId]);
  // Preset load (Plugin) bumps this while we may be unmounted under the tuner
  // or tone browser; skip 0 so a restored detail after OAuth still opens.
  useEffect(() => {
    if (returnToGallery) setDetailBlockId(null);
  }, [returnToGallery]);
  /** The item under drag; drives the DragOverlay ghost. */
  const [activeDrag, setActiveDrag] = useState<ChainItem | null>(null);

  /** ⌥ held during the current drag; the drop duplicates instead of moving. */
  const altDragRef = useRef(false);

  /** Native lane contents by index, padded to 4 entries (dormant lanes past
      chainCount read as empty arrays). */
  const nativeLanes: Lanes = [chain, chainRight ?? [], chain3 ?? [], chain4 ?? []];

  /** Last real (non-insert) block per lane, for that lane's meter — resolved
      against native order (not the optimistic drag mirror) since meter ids
      key off native block identity regardless of in-flight reordering. */
  const lastBlockIds: (string | null)[] = nativeLanes.map((items) => {
    const real = items.filter((item): item is ToneBlock => !isInsertSlot(item));
    return real.length > 0 ? real[real.length - 1].blockId : null;
  });
  const tileSize = tileSizeForChainCount(chainCount);
  const laneStrips = useChainLaneStrips(chainCount, monoSum, lastBlockIds, tileSize);

  /**
   * Optimistic mirror of every lane. Drag gestures mutate this immediately
   * (live cross-lane reflow via onDragOver, final order on drop) so nothing
   * snaps back while the native mutation + resync roundtrip completes; it
   * resyncs from props whenever native reports a new state and no drag is
   * in flight.
   */
  const [lanes, setLanes] = useState<Lanes>(nativeLanes);
  const draggingRef = useRef(false);

  // Resync the optimistic lanes only when native actually reports new state
  // (and no drag is in flight). `lanes` must NOT be a dependency here: an
  // earlier version included it and unconditionally set a fresh object, which
  // re-triggered itself in a silent render loop.
  useEffect(() => {
    if (!draggingRef.current) setLanes([chain, chainRight ?? [], chain3 ?? [], chain4 ?? []]);
  }, [chain, chainRight, chain3, chain4]);

  /** Index of the lane containing the id in the optimistic local state. */
  const laneOf = (id: string): number | null => {
    const index = lanes.findIndex((lane) => lane.some((item) => item.blockId === id));
    return index === -1 ? null : index;
  };
  /** Index of the lane containing the id per native state (the pre-drag
      origin). */
  const originLaneOf = (id: string): number | null => {
    const index = nativeLanes.findIndex((lane) => lane.some((item) => item.blockId === id));
    return index === -1 ? null : index;
  };

  const resetLanes = () => setLanes(nativeLanes);

  /**
   * Insert (or remove) the ⌥-duplicate stand-in: an inert copy of the
   * dragged block pinned at its home slot. The standard drag machinery
   * (traveling hole, parting neighbors, drop index) runs completely
   * untouched; with the home slot visibly occupied, the exact same gesture
   * reads as pulling a *copy* out instead of moving the block. Rebuilt from
   * native state so toggling ⌥ mid-drag also undoes any optimistic
   * cross-lane reflow (the next dragOver re-parts the target lane).
   */
  const setDuplicateStandIn = (item: ChainItem | null) =>
    setLanes(() => {
      const next = nativeLanes.map((lane) => [...lane]);
      if (item != null) {
        for (const lane of next) {
          const index = lane.findIndex((i) => i.blockId === item.blockId);
          if (index !== -1) {
            lane.splice(index, 0, { ...item, blockId: DUP_STAND_IN_ID });
            break;
          }
        }
      }
      return next;
    });

  // ⌥ tracking rides pointermove (drags move constantly, and the webview can
  // drop bare modifier keydowns, see KnobControl) with key events for
  // in-place toggles. Tone blocks only; inserts have nothing to duplicate.
  useEffect(() => {
    if (activeDrag == null || isInsertSlot(activeDrag)) return;
    if (altDragRef.current) setDuplicateStandIn(activeDrag); // ⌥ down at drag start
    const track = (e: PointerEvent | KeyboardEvent) => {
      if (e.altKey === altDragRef.current) return;
      altDragRef.current = e.altKey;
      setDuplicateStandIn(e.altKey ? activeDrag : null);
    };
    window.addEventListener('pointermove', track);
    window.addEventListener('keydown', track);
    window.addEventListener('keyup', track);
    return () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('keydown', track);
      window.removeEventListener('keyup', track);
    };
    // setDuplicateStandIn closes over nativeLanes (chain/chainRight/chain3/
    // chain4); those are stable for the life of a drag (native doesn't push
    // mid-gesture).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrag]);

  const handleDragStart = (event: DragStartEvent, manager: DragDropManager) => {
    draggingRef.current = true;
    const id = String(event.operation.source?.id);
    setActiveDrag(lanes.flat().find((i) => i.blockId === id) ?? null);
    // Seed from the press that started the drag; the tracker effect keeps it
    // live from here (and inserts the stand-in once activeDrag lands).
    const activator = manager.dragOperation.activatorEvent;
    altDragRef.current = activator instanceof PointerEvent && activator.altKey;
  };

  // Live cross-lane reflow: as the drag crosses into the other lane, move
  // the dragged item into it so that lane parts to make room, exactly like a
  // same-lane sort. Handled here (with the default optimistic cross-group
  // move suppressed) because the built-in resolves before/after with
  // vertical-list math; these lanes are horizontal, so which side of the
  // hovered tile the block lands on must follow the dragged tile's center x.
  // Same-lane sorting stays with the built-in OptimisticSortingPlugin.
  const handleDragOver = (event: DragOverEvent, manager: DragDropManager) => {
    const { source, target } = event.operation;
    if (!source || !target) return;
    const activeId = String(source.id);
    const from = laneOf(activeId);
    const to = laneOf(String(target.id));
    if (from == null || to == null || from === to) return;
    event.preventDefault();

    // Insert slots are lane anchors and stay put.
    const item = lanes[from].find((i) => i.blockId === activeId);
    if (!item || isInsertSlot(item)) return;

    // Land after the hovered tile when the dragged tile's center has passed
    // the hovered tile's center.
    const dragged = manager.dragOperation.shape?.current.center;
    const landAfter = dragged != null && target.shape != null && dragged.x > target.shape.center.x;

    setLanes((prev) => {
      const next = prev.map((lane) => [...lane]);
      next[from] = next[from].filter((i) => i.blockId !== activeId);
      const toItems = next[to];
      const overIndex = toItems.findIndex((i) => i.blockId === String(target.id));
      const insertIndex = overIndex === -1 ? toItems.length : overIndex + (landAfter ? 1 : 0);
      toItems.splice(insertIndex, 0, item);
      return next;
    });
    // Same stabilization OptimisticSortingPlugin applies after its own moves:
    // park the drop target on the source and hold collision detection until
    // the reflowed layout has rendered, so stale rects can't bounce the item
    // straight back across the lanes.
    manager.collisionObserver.disable();
    void manager.actions.setDropTarget(source.id).then(() => {
      manager.collisionObserver.enable();
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    draggingRef.current = false;
    setActiveDrag(null);
    const duplicating = altDragRef.current;
    altDragRef.current = false;
    const { source, target } = event.operation;
    if (event.canceled || !target || !isSortable(source)) {
      resetLanes();
      return;
    }

    const activeId = String(source.id);
    const laneIndex = laneOf(activeId);
    if (laneIndex == null) return;

    // Final same-lane placement: cross-lane moves already landed in
    // onDragOver, and source.index is the optimistic index the drag settled
    // on (the sortable plugin keeps it live during the gesture).
    let laneItems = lanes[laneIndex];
    const oldIndex = laneItems.findIndex((i) => i.blockId === activeId);
    const newIndex = Math.min(source.index, laneItems.length - 1);
    if (oldIndex !== -1 && oldIndex !== newIndex) {
      laneItems = arrayMove(laneItems, oldIndex, newIndex);
      setLanes((prev) => {
        const next = [...prev];
        next[laneIndex] = laneItems;
        return next;
      });
    }
    const finalIndex = laneItems.findIndex((i) => i.blockId === activeId);

    // ⌥-drop: same layout, same index math; the mutation is a clone instead
    // of a move. The stand-in holds the home slot, so `finalIndex` already
    // counts the original staying put; the optimistic lanes match the
    // post-clone chain pixel-for-pixel until the resync swaps in real ids.
    if (duplicating && finalIndex !== -1 && !isInsertSlot(laneItems[finalIndex])) {
      actions.duplicateBlock(activeId, laneIdForIndex(laneIndex), finalIndex);
      return;
    }

    // Commit to native: a lane change is one moveBlock (exact final index);
    // a same-lane shuffle is one reorder. The chainChanged resync converges
    // the optimistic state.
    const origin = originLaneOf(activeId);
    if (origin != null && origin !== laneIndex) {
      actions.moveBlock(activeId, laneIdForIndex(laneIndex), finalIndex);
      return;
    }
    const nativeIds = nativeLanes[laneIndex].map((i) => i.blockId);
    const localIds = laneItems.map((i) => i.blockId);
    if (nativeIds.join() !== localIds.join()) actions.reorderBlocks(localIds);
  };

  // Resolve the detail block across both lanes; it can disappear underneath
  // us (undo, trash from the detail header), in which case we fall back to
  // the gallery.
  const detailBlock =
    detailBlockId != null
      ? (nativeLanes
          .flat()
          .find(
            (item): item is ToneBlock => !isInsertSlot(item) && item.blockId === detailBlockId
          ) ?? null)
      : null;

  // Drop an id whose block vanished: left alone it lingers in state and
  // sessionStorage and could reopen a dead detail view later.
  useEffect(() => {
    if (detailBlockId != null && detailBlock == null) setDetailBlockId(null);
  }, [detailBlockId, detailBlock]);

  if (detailBlock) {
    // Another enabled+loaded NAM after this block in its lane. This mirrors the
    // DSP's lastNamIndex scan (Processor.cpp): with calibration on, such a
    // block hands off at calibrated output level instead of normalizing.
    const detailLane =
      nativeLanes.find((lane) => lane.some((item) => item.blockId === detailBlock.blockId)) ?? [];
    const detailIndex = detailLane.findIndex((item) => item.blockId === detailBlock.blockId);
    const namDownstream = detailLane
      .slice(detailIndex + 1)
      .some(
        (item): item is ToneBlock =>
          !isInsertSlot(item) &&
          item.tone.format?.toLowerCase() === 'nam' &&
          item.loaded &&
          item.params.enabled
      );

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          height: '100%',
          // Top-align under the shared 24px middle-band pad (Plugin); the
          // card bottom then sits 24px above the faceplate when the column
          // matches the meter height (Figma). Info view scrolls ← BLOCK + card.
          justifyContent: 'flex-start',
          boxSizing: 'border-box',
        }}
      >
        <ChainBlock
          block={detailBlock}
          namDownstream={namDownstream}
          sampleRate={sampleRate}
          namSlimSizeDefault={namSlimSizeDefault}
          onBack={() => setDetailBlockId(null)}
          onFillToFaceplate={onFillToFaceplate}
        />
      </div>
    );
  }

  const monoOnly = chainCount === 1;
  // Branching (and the affordances that go with it) is a lanes-0/1-only
  // concept, and only while exactly 2 lanes are active — not "2 or more".
  const branchable = chainCount === 2;

  // Branched layout: the branch lane starts at the trunk's tap gap, so its
  // row is indented past the whole trunk prefix (matching the signal flow:
  // its input *is* that prefix's output). Resolved against the optimistic
  // lane state; a stale tap id (mid-resync after the tapped block moved)
  // renders as independent lanes until native's cleared state arrives.
  const branchLayout = (() => {
    if (!branchable || branch == null) return null;
    const trunkIndex = branch.side === 'left' ? 0 : 1;
    const tapIndex = lanes[trunkIndex].findIndex((i) => i.blockId === branch.afterBlockId);
    if (tapIndex === -1) return null;
    return {
      trunkIndex,
      // Unaffected by each lane's own controls-strip slot: both the trunk
      // and branch lane's GalleryLane render that slot at the same fixed
      // width, so it's already baked equally into both lanes' natural tile
      // start x — only the delta past that shared base needs expressing here.
      indentPx: (tapIndex + 1) * (tileSize + TILE_GAP),
      tapGapX: gapCenterX(tapIndex + 1, tileSize),
    };
  })();
  // BranchElbow is positioned in the outer lanes-column coordinate space
  // (not inside any one lane's own box), so unlike indentPx above it does
  // need the controls-strip slot added explicitly: every lane's tiles start
  // this far past the column's left edge once the strip renders.
  const laneControlsOffset = chainCount >= 2 ? LANE_CONTROLS_WIDTH + LANE_CONTROLS_GAP : 0;

  const lane = (index: number) => {
    const isPairLane = index < 2;
    const chainSide: ChainSide = index === 0 ? 'left' : 'right';
    return (
      <div
        key={index}
        style={{
          marginLeft:
            branchLayout != null && index !== branchLayout.trunkIndex
              ? `${branchLayout.indentPx}rem`
              : 0,
          width: 'max-content',
        }}
      >
        <GalleryLane
          items={lanes[index]}
          tileSize={tileSize}
          stereo={isPairLane && branchable}
          onOpen={setDetailBlockId}
          onAdd={(insertBlockId) => actions.addModel(laneIdForIndex(index), insertBlockId)}
          onPasteBlock={
            canPaste ? (position) => actions.pasteBlock(laneIdForIndex(index), position) : null
          }
          side={laneIdForIndex(index)}
          branch={isPairLane && branchLayout != null ? branch : null}
          branchInteractive={isPairLane && branchable && activeDrag == null}
          onSetBranch={
            isPairLane ? (afterBlockId) => actions.setBranch(chainSide, afterBlockId) : undefined
          }
          onClearBranch={isPairLane ? actions.clearBranch : undefined}
          controls={laneStrips[index]}
        />
      </div>
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'stretch',
        height: '100%',
        boxSizing: 'border-box',
        padding: '0 24rem',
      }}
    >
      <DragDropProvider
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        {/* One shared scroll area: both lanes pan together, fading out under
            the edge gradients as they scroll. */}
        <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
          {/* Mono-only section title. Absolutely positioned so it sits in the
              top-left dead space without shifting the vertically/horizontally
              centered lane. left matches the lane's EDGE_FADE_WIDTH inset so
              the label lines up with the first tile; top is 0 because Plugin
              already applies the shared 24px middle-band pad. */}
          {monoOnly && (
            <span
              style={{
                position: 'absolute',
                top: 0,
                left: rem(EDGE_FADE_WIDTH),
                zIndex: 1,
                pointerEvents: 'none',
                fontFamily: FONT_MONO,
                fontSize: '16rem',
                fontWeight: 400,
                letterSpacing: 'normal',
                textTransform: 'uppercase',
                color: WHITE,
              }}
            >
              Signal Chain
            </span>
          )}
          <div
            ref={galleryScrollRef}
            className="hide-scrollbar"
            style={{
              flex: 1,
              minWidth: 0,
              overflowX: 'auto',
              overflowY: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                gap: `${LANE_GAP}rem`,
                width: 'max-content',
                minWidth: '100%',
                padding: `0 ${EDGE_FADE_WIDTH}rem`,
                boxSizing: 'border-box',
                // No transform on this wrapper: a transformed ancestor becomes
                // the containing block for position:fixed descendants, and
                // dnd-kit positions the dragged tile in fixed viewport
                // coordinates. In webviews without top-layer (popover)
                // promotion the tile would render offset by this box's origin,
                // a big down-right jump at pickup in DAW hosts.
              }}
            >
              {Array.from({ length: chainCount }, (_, index) => lane(index))}
              {branchLayout != null && (
                <BranchElbow
                  x={EDGE_FADE_WIDTH + laneControlsOffset + branchLayout.tapGapX}
                  tileSize={tileSize}
                  trunkOnTop={branchLayout.trunkIndex === 0}
                />
              )}
            </div>
          </div>
          <EdgeFade side="left" />
          <EdgeFade side="right" />
        </div>
      </DragDropProvider>
    </div>
  );
};
