# Core API guide

Import from `src/core/index.ts`. Source is the reference; this lists what is easy to miss.

## RoadNetwork

- Construct: `new RoadNetwork(project?: Project | string)`
- Edit: `addNode(pos)`, `addSegment(a, b, {c1?, c2?, roadType, overrides?})`,
  `drawRoad({start, end, c1?, c2?, roadType, overrides?})` returning `{segments, nodes, junctions}`.
  Anchors are `{kind:'node',id}`, `{kind:'segment',id,t}` or `{kind:'free',pos}`.
- `splitSegment(id, t)` returns `{node, left, right}`. `removeSegment`, `removeNode`, `moveNode`,
  `setSegmentControls`, `setRoadType`, `setSegmentOverrides`, `setJunctionControl(id, patch)`,
  `setSign`, `setCrosswalk`, `setTraffic`, `setProjectName`, `setCustomRoadType`, `removeCustomRoadType`,
  `addEndpoint`, `updateEndpoint`, `removeEndpoint`, `addDecal`, `updateDecal`, `removeDecal`.
- Batches: `beginBatch()` / `commit()` or `batch(fn)`. Batches nest. Reads stay valid inside.
- Subscribe: `const off = net.onChange(e => ...)`. `e` has `version, dirtyNodes, dirtySegments,
  removedNodes, removedSegments, endpointsChanged, decalsChanged, settingsChanged, reset`.
  On `reset`, rebuild everything.
- Derived reads: `segmentGeom(id)`, `nodeGeom(id)`, `laneGraph`, `connectionsAt(nodeId)`, `cubicOf(id)`,
  `roadType(id)`, `roadTypeOf(segId)`.
- Validation: `validateDraft({start, end, c1?, c2?, roadType})` returns `{code, severity, message, at?}[]`.
  `findCrossings(cubic, ignoreAt?)` gives preview crossings.
- Queries: `nearestNode(pos, max?)`, `nearestSegment(pos, max?)` (t and signed `lateral`),
  `segmentsInRegion(box, loose?)`, `nodesInRegion(box)`, `deadEnds()`.
- Save and undo: `serialize()`, `load(data)`, `snapshot()`, `clear(name?)`, `version`, `signature()`.

Also: `defaultSignalPlan(net, nodeId, preset)`, `effectiveControl(net, nodeId)`, `movementsAt(net, nodeId)`
in `signals.ts`. `checkNetworkInvariants(net): string[]` in `invariants.ts` for tests.
`effectiveLanes`, `effectiveMarkings`, `effectiveSpeedKmh`, `totalHalfWidth` in `roadTypes.ts`.
`roadEdges(geom, def)`, `lanePolyline`, `stationAt`, `maxGrade` in `geometry.ts`.

Built-in road ids: `street-2`, `street-2-bike`, `street-2-oneway`, `street-4`, `avenue-4`, `avenue-6`,
`avenue-4-bus`, `boulevard-8`, `highway-2` to `highway-5`, `dual-4`, `dual-6`, `ramp-1`, `ramp-2`.

## Added for lanes, markings, paint and reversing

- `makeCustomRoadType({ lanes: CustomLane[], medianIndex?, sidewalkLeft/Right?, shoulderLeft/Right? })` builds a
  road lane by lane and throws on a bad layout; `customLaneProblems` gives the reasons without throwing.
  `LaneDef.speedKmh`, `overrides.laneSpeeds`, `laneSpeedKmh(def, overrides, i)`.
- Node markings: `JunctionControl.markings` and `hideAutoMarkings`, edited with `addNodeMarking`,
  `updateNodeMarking`, `removeNodeMarking`, `clearNodeMarkings`, `setHideAutoMarkings`. Geometry in
  `nodeMarkings.ts` (`nodeAnchors`, `lineCurve`, `fillerPolygon`). Anchors are arm and boundary, never positions.
- Road paint: `Decal.road` holds pieces of segments and an offset. Always read positions with `resolveDecal`.
  `roadPathBetween` walks a road through joints. Splits carry paint over; deleting a road removes or cuts it.
- `reverseSegment(id)` turns a road in place, same id, and returns a report. Change events list
  `reversedSegments`; the sim drops or re-seats vehicles on those lanes.
- `setRoadType` (and replacing a custom type) with a different lane layout lists the segment in change events'
  `relaidSegments`: lane indices may name other lanes now, so the sim re-seats vehicles there by position.
- Editing a placed road's lanes: `stripForSegment` and `applyLaneStrip` in `tools/laneEdit.ts`. Applying reuses a type
  with the same layout or adds a `custom-lanes-N` type (unused ones are tidied on the next edit), as one batch, and
  remaps lane-indexed data (lane speeds and line styles, `laneLinks`, boundary anchors, hidden arrows, islands, paint
  and zone offsets) by lane identity. It reports what it had to drop.

## Gotchas

- `GLane` objects and graph maps are shared between graph versions. Treat them as immutable. Dense
  `idx` values mean something only within one graph. Sim remaps on `graph.version`.
- `graph.roadLanes.get(seg)` has `-1` for a lane that does not exist (nothing left after trimming).
- `SegmentGeom.valid === false` means either nothing left (`stations` empty, no lanes) or bend too
  tight (lanes still exist). Use `minRadius` to tell them apart.
- Invalid `control.laneLinks` are skipped silently.
- `splitSegment`: the original id keeps the a side, the new id takes the b side.
- `NodeGeom.arms` is clockwise, but the starting arm can rotate between edits.
- Outlines are not planar on sloped nodes, so triangulate in XZ.
- `merge.selfS` is where two paths first come within a lane width. `diverge.selfS` is where they
  finish separating, so it is not 0.
- A crossing node takes the existing road's height and the new road bends to meet it. `validateDraft`
  errors when the gap is over 1.5 m and under 6 m.
- Ramps are rank 2. `auto` junction mode never picks all-stop.

## Ramps and controlled access (`ramps.ts`)

- `SegmentOverrides.attachA` / `attachB`: `{ lane, hostSide }`. That end of the road sits on the outer
  edge of the host road's carriageway at its node instead of on the node, and the host's outermost
  `lane + 1` lanes feed or take it. `cubicOf` returns the moved curve; `nodeCubicOf` the raw one. Pass
  `startAttach` / `endAttach` to `drawRoad` and `validateDraft`; `makeAttach` builds one. Attaches survive
  save, split, reverse and moving the host.
- At a junction with three or more arms and a `highway` arm, connectors follow `linkControlledAccess`:
  each carriageway keeps to itself, side roads branch off or join on their own side only (merge-only,
  right in and right out), never across a median, with no left or U-turns across a two-way highway.
  `effectiveControl` gives `none` there in auto mode. Hand-set `laneLinks` still win.
- `validateDraft` adds `wrongWay` (error: a one-way road joining against the highway traffic) and
  `atGradeHighway` (warning: a two-way road joining a highway at grade).
- Crossings (`highwayCrossing.ts`): `JunctionControl.highwayAccess` is `'crossing'` or `'rightInOut'`; absent means
  right in, right out, so old saves keep their junctions. `drawRoad` sets `'crossing'` on nodes it makes that are shaped
  like a road passing straight across a highway (`crossingShaped`, `tagNewCrossings`), never on a node that already was.
  Connectors come from `linkHighwayCrossing`, auto control is signals from `autoSignalPlan`: protected lefts, or for two
  crossings of one-way carriageways joined by a side road of at most `PAIR_MAX` m (`crossingPair`), `pairedSignalPlan`,
  the same fixed cycle at both nodes with every move protected and the median cleared before the far side moves.
  `validateDraft` warns `atGradeHighway` on such a crossing too. The junction panel switches it.
- Streets and avenues take attaches too (`isStreetHost`). No `lanes`: a side merge or slip lane on the kerb, as on a
  highway, only the carriageway on its side, free-flow in auto mode (`isStreetMerge`), `wrongWay` if drawn against
  it. `RampAttach.lanes` set: a terminal on the node that turns into or out of exactly those host lanes, counted
  across the road from the edge on the attached road's side (`hostCrossSection`); left turns take the attached
  road's left lanes. `linkStreetAttaches` links the rest of the junction as if the attached road were not there.
  Signals, signs and `movementsAt` follow the resulting connectors. The road tool offers street lane snaps to ramps
  (other roads with Shift held); Shift-click picks several lanes (`tools/laneSnap.ts`, `streetEndFor`).

## Edge merges and lane line-ups (`edgeMerge.ts`, `laneAlign.ts`)

- `RampAttach.edge` (`EdgeMergeSpec`: `mode`, `taper`, `addLength`): the ramp blends into the highway's outermost lane
  instead of making a full junction. Absent (older saves) is a full junction. The ramp end sits beside the carriageway
  edge (`edgeAttachPoint`), its inner carriageway edge on the narrower host's. The node lays out as `NodeGeom.kind
  'merge'` with `NodeGeom.edge` (`EdgeMergeGeom`: taper outline and edge line, host lane edge, gore): the two highway
  arms are untrimmed with a shared cross section, their lanes join directly (`NodeLanes.direct`), and only the ramp
  (trimmed by the taper) has connectors, to or from the edge lane. `outline` is the taper beside the edge only.
- Needs exactly three arms, two highway arms within 3 degrees of straight through, a one-way ramp within 25 degrees
  of the traffic, on the outside of its carriageway (either side of a one-way highway), `lane` 0, and lanes that line
  up. Otherwise it is the usual full junction; `net.edgeMergeProblem(node)` says why.
- Lane add or drop: the highway past the node has one lane more or fewer and is lined up on the side away from the
  ramp; the ramp links with the lane that has no partner. `tools/edgeMergeOps.ts` `applyRampLaneChange` builds them.
- Sim: a lane fed by a connector and a road lane is a merge lane (`sim/compiled.ts`); `sim/merge.ts` orders vehicles
  on the road feeder too, by time to the merge point, and `mergeClash` checks lane changes into such a lane.
- `SegmentOverrides.alignA` / `alignB` (`'left' | 'centre' | 'right'`, along the segment's a to b): a narrower road
  lines up with the wider one it continues at that node. The curve end (and its handle) moves sideways; only the
  narrower road moves, and only while narrower. `endShift`, `alignedCubic`; `LaneEnd.lat` includes the shift, so
  lanes pair by where they are. Split keeps it with its end, reverse swaps left and right. The road tool shows three
  points across a road end of another width (`tools/endAlign.ts`); the junction panel changes it later.

## Junction shape (`junctionShape.ts`)

- `JunctionControl.shape` (optional): `corners[`${seg}>${nextSeg}`]` `{ radius?, kerb?, sidewalk?: false }`,
  `arms[seg]` `{ trim?, edgeLeft?, edgeRight? }` (left and right looking at the node), `islands[]`
  `{ id, segmentId, from, to, back, reach }` with boundaries counted from the arm's left looking at the node.
  Keyed by segment ids, never positions. Split renames, removal strips, save keeps, reverse needs nothing.
- Edit with `applyJunctionShape(net, node, shape)`, which validates and refuses with reasons (a kerb in the way
  of a connector, an island over a lane, a lane left with no exit, a trim that buries a cut point). It runs in one
  batch, so a refused shape never reaches listeners. `net.setJunctionShape` sets without checking.
- `computeNodeLayout(id, arms, shape?)` and `buildNodeGeom(layout, pos, geomOf, shape?)` honour it: trims grow so a
  kerb radius fits, the outline uses filleted, moved or sidewalk-less corners. `NodeArm.kerbLeft/kerbRight` is where
  the outline meets the cut line when an arm-end kerb moved; read corners from `kerbLeftOf(arm)`, not `leftEdge`.
- Connectors: `buildNodeLanes` drops connectors through an island (`islandBlocker`) and swings turns wider round
  moved kerbs (`kerbFitter`, via `buildConnector(node, link, cubic?)`). Both are inert without a shape.
- `segmentKerbShift(net, seg)` and `shapedKerbLines` give the kerb along a road near a shaped arm end.
- Arm lengths: `armTrimLimits(net, node, seg)` gives `{ now, auto, min, max }` (min where the carriageway edges stop
  overlapping the neighbours, max leaving 2 m of road). `withArmLength` sets one arm in metres from the node,
  `withScale` multiplies every automatic trim (`shape.scale`), `applyShortestShape` finds the tightest valid node.
  `NodeArm.autoTrim` is the trim without the shape. A dead end takes an arm trim too (its road stops short).

## Walls, barriers and quays (`walls.ts`, `terrainMods.ts`, `quays.ts`)

- `SegmentOverrides.structure` (`StructureSpec`: mode `auto | embankment | retaining | trench | cut | pillars | tunnel`,
  plus per-side `left`/`right` wall `on`, `style`, `top`, `height` cap) and `SegmentOverrides.barriers` (per-side sound
  barrier `kind` and `height`). Both copy on split and swap sides on `reverseSegment`, so walls stay put in the world.
- `sideSection(spec, side, def, surfaceY, natural)` / `segmentSections(net, id)` give wall faces, slopes and the ground
  profile per station. Renderer and terrain modifiers both read them.
- `terrainHeight` stays the untouched land. `groundHeight(net, x, z)` (or `terrainModsFor(net).groundAt`) adds
  embankments, cuts, junction pads and quay fill, derived from the project and cached by `net.version`. Use it for
  anything that stands on the ground.
- `structureFootprint(net, {cubic, roadType, structure})` checks the extra width: another road in a wall is an error,
  under a slope a warning (`code: 'structureFootprint'`).
- Quays persist in optional `Project.quays` (`{id, bank, x0, x1, style, top}`): a stretch of one bank between two
  centreline x values. `addQuay`, `updateQuay`, `removeQuay`, `net.quays`; change events set `quaysChanged`.

## Known limitations

1. About 4.9% of junctions under random fuzz use a hull outline fallback (`outlineSimplified`),
   nearly all from tiny stubs. Valid polygon, loses rounded corners.
2. At the 80 m trim cap, a ramp hugging the highway still overlaps it past the cut, so the two road
   surfaces overlap with no gore. The renderer clips each road's lines off the other's surface there
   (`render/gore.ts`). A ramp attached to a lane (below) leaves from the carriageway edge, which roughly
   halves the trim, and `validateDraft` allows such an overlap only for `DIVERGE_ALLOWANCE` (150 m).
3. Only `drawRoad` creates junctions at crossings. `moveNode`, `setSegmentControls` and `addSegment` do
   not. A road crossing itself is reported by `validateDraft`, not resolved.
4. Two nearly collinear overlapping roads give no crossing hits. `validateDraft` refuses them with a
   `tooClose` error ("Overlaps an existing road.", with the stretch in `issue.stretch`), as do the Move
   tool and templates through `segmentOverlapIssues` in `overlap.ts`. `addSegment` does not check.
5. A bike lane meeting a junction with no bike lanes gets a turnaround or stops. The no-orphan guarantee
   covers drive lanes.

## Landscaping (`terrainEdit.ts`)

- Ground height order: `baseTerrainHeight` (generated land) + landscaping offsets = `terrainHeight(x, z)`; the walls
  module's embankments, cuts and quays go on top in `groundHeight(net, x, z)` and treat `terrainHeight` as the land.
- `bindTerrainEdits(net)` (main.ts does it) makes `net.project.terrain` drive `terrainHeight`, loads and undo included.
  Nothing bound or nothing edited: `terrainHeight` is exactly the old function.
- `terrainEditVersion()` (terrain.ts) changes whenever committed landscaping changes. Cache anything derived from
  `terrainHeight` on it as well as `net.version` (terrainMods does).
- `surfaceLevel(x, z)`: what buildings sit on and tunnels are measured from: `max(terrainHeight, 0)` without edits, the
  dug ground where the land was lowered. Tunnel means `y < surfaceLevel - 1.5`.
- `isWater`: the river level is a water table; ground under `WATER_LEVEL` is water, wherever it is.
- `net.setTerrain(data, box)` stores a stroke (one undo step), touches the roads in the box so everything on the ground
  rebuilds, and fires `terrainChanged`. Roads are never moved by landscaping.


## One marking standard (`paintStandard.ts`, `paintCoherence.ts`, `render/paint.ts`)

- Every mark, automatic or hand-placed, takes its measures from `core/paintStandard.ts`: `LINE_W`, `DASH` by speed
  class (`dashFor(kmh)`), `standardWidth` (a width of exactly `LINE_W.lane`/`LINE_W.edge` is drawn at the road's own
  width: wider on fast roads), `PAINT_HEX` (one white, one yellow), `CROSSWALK`, `STOP`, `TEETH`, `ARROW`, `TEXT`,
  `HATCH`, `GORE`, `EXIT_ONLY`, `LANE_DROP`, `PAINT_MATERIAL`, `PAINT_LAYERS`. Named looks: `LINE_STANDARDS`,
  `FILL_STANDARDS` (the editor's built-in presets), `matchStandard(spec)`.
- Automatic lines are `boundaryLines(...)` (now in core, with a stable `key` and `role` per line) turned into a
  `LineStyleSpec` by `autoLineSpec`; both they and user lines become strokes through `strokesOfSpec`. Render through
  `render/paint.ts`: `paintRoadLine` (a line along a road in the road's dash phase, `segmentDashPhase`),
  `paintSpecAlong`, `paintCrossing`, `paintArea`, `PaintBatches` (one chunk batch per layer, one shared material from
  `markingMaterial(shared)`). `PaintBuf.inLayer(layer, fn)` picks the stacking layer: fill < line < bar < symbol.
- Decals store their look in `Decal.style` (lines, crosswalks, stop lines, teeth) or `Decal.fill` (areas). Saves
  without `Project.paintStandard` are migrated on load (`markingMigrate.ts`): placement untouched, old defaults to the
  standard, chosen measures kept.
- Coherence (`paintCoherence.ts`): `snapToAutoLine`, `userRoadLines` / `coveredStretches` (the renderer leaves an
  automatic line off where a hand-placed one holds it), `userRoadStamps` / `userArmMarks` (same for crosswalks, stop
  lines, arrows). One marking per place: `slotsOf`, `stackedWith(net, item)` (what a placement would replace, named),
  enforced in `addDecal` / `addMarking` / `addNodeMarking` (older one removed in the same batch; `net.lastReplaced`
  names what went) and on load (`cleanStacked`, newest kept). Lines down the middle of a lane are not a slot.
- `SegmentOverrides.paintOff`: automatic lines along a road taken away by key (`autoLinePatch`); mirrored on reverse.
- Ordinary junctions (3+ arms, not a ramp junction; highway crossings at grade included), `render/markings.ts`: every
  arm ends alike at `junctionSetback` (one value per junction): crosswalk kerb to kerb (shaped kerbs too), stop line
  across the incoming lanes (always at lights or a stop sign, even where the road's `stopLines` is off), lane lines
  square at its back. Median edge lines end where the nose narrows and turn round its tip (`medianNoseBack`, shared
  with `render/roads.ts`); the pale outline leaves the crosswalk clear. `junctionGuides` paints nothing in the box but
  dashed left-turn guides on big junctions (`GUIDE_MIN_TURN` metres of turn, two or more lanes in), parts `T` / `T0`...,
  none crossing another (the main road's turns win) or a crosswalk.

## Traffic rules (`trafficRules.ts`, `signalTools.ts`)

- `JunctionControl.rules` (optional, types in `trafficRuleTypes.ts`): `laneArrows[`${seg}:${lane}`]` turns allowed per arriving
  lane, and `arms[seg]` switches `uturn`, `laneChange` (straight lanes may end next door), `enterBlocked` (no wait for room
  on the exit), `pedestrians` (false also sets the arm's crosswalk to 'none'), `nearTurnOnRed`, `farTurnOnRed` (one-way to
  one-way). Keyed by reference: split renames, removal strips, reverse moves arrows to the mirrored lane, save keeps.
- `applyTrafficRules(links, arms, control)` runs in `buildNodeLanes` after the automatic or hand links, so connectors,
  painted arrows, signals and the sim follow. Without rules it returns the links untouched.
- Edit with `setLaneArrows`, `toggleLaneArrow` (refuses the last arrow), `resetLaneArrows`, `setArmRule`, `toggleArmRule`;
  read with `laneArrowsAt` and `armRule`; `armRuleRefusal` says when a switch does not apply.
- `SegmentOverrides.laneBans[lane]`: vehicle classes kept off a lane (`setLaneVehicles`, `toggleLaneVehicle`). The sim
  compiles them into `allow` bits (one per class: car, van, truck, bus, bike) and keeps a route table per class only
  where classes differ. Speed limits are the existing `speedKmh` / `laneSpeeds` (`setRoadSpeed`, `setLaneSpeed`);
  `UNLIMITED_KMH` (250) is "no limit".
- `applyPriorityRoad(net, seg)` signs every junction along `priorityRoadPath` (through junctions on the straightest arm):
  the road's arms priority, side roads yield; junctions with lights are skipped.
- `copySignalPlan` / `pasteSignalPlan` map a plan by arm order and turn; `applyGreenWave(net, nodes, kmh)` gives each
  plan the first one's cycle and an offset from the road distance, as fixed time.
- Sim extras (`SimApi`, all optional): `setManualSignal`, `setManualMovement`, `signalMovements` (hand light control,
  not saved), `clearTraffic({ stuckOnly })`, `setSpawnPaused`.
- Transitions (two roads end to end over a junction surface): `transitionLines` in `render/markings.ts` carries the
  centre, edge and lane lines across (lane-drop look, `lineStandard('laneDrop')`, where a lane ends; highway lane
  drops and exits get `laneEndLines`). Lane-drop paint comes only from these two. `RoadPaintPiece.offset` lets one
  Paint line keep its own offset on each road it crosses; the Paint tool's cursor over a junction surface lands on the
  nearest arm's cut (`junctionCursor` in `tools/roadAnchors.ts`).
