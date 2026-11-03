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
