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

