# Cloverleaf architecture

A browser-based creative-mode road designer. Roads only, no city economy. The
player draws free-form curved roads, builds interchanges, sets traffic levels,
controls signals and paints markings, while an agent-based sim drives on it.
Look and controls are inspired by Cities: Skylines. No Skylines names, art or
logos may be used.

Stack: TypeScript (strict), Vite, Three.js (WebGL2), Vitest. No UI framework:
plain DOM and CSS. No other runtime dependencies without a strong reason.

## Conventions. These are not negotiable.

- Units are metres, seconds, radians. Speeds are km/h in catalogue and UI, m/s in
  the sim and on `GLane.speed`.
- Three.js axes: Y up, ground at y = 0. The map is 4000 m square, x and z from
  -2000 to 2000. There is no grid anywhere in road logic. Snapping is to
  existing roads, nodes and angles only.
- Right vector of a forward direction f is `(-f.z, 0, f.x)`, normalised. Using
  the opposite sign puts traffic on the wrong side of the road.
- Traffic drives on the right: every `dir: -1` lane sits left of every `dir: 1`
  lane. `RoadTypeDef.lanes` is sorted by offset ascending (left to right looking
  along segment forward). The pavement is centred on the curve, so on an uneven
  road (say two bus lanes one way, one the other) the boundary between directions
  is off the centreline and `dir: 1` lanes can have negative offsets. Read
  per-side sidewalks with `sidewalkOn`; `median.offset` places the median.
- A one-way road has all lanes `dir: 1`, so a segment's a-to-b is its travel
  direction. Drawing a one-way road goes in the direction drawn.
- Junction arms sort clockwise viewed from above (looking down -Y).
- Elevation is absolute y. Ground road at 0. Elevated when y > 1 (bridge, with
  pillars and barriers). Tunnel when y < -1.5. Allowed range -24 to 48 m. The
  editor steps elevation in 4 m increments. Grade separation needs 6 m clearance
  between road surfaces. Two roads crossing with less clearance must join at a
  junction (or be rejected).
- Terrain height comes only from `terrainHeight(x, z)` in `core/terrain.ts`. The
  generated land is flat 0 across the buildable area except a decorative river
  channel, and rises into hills beyond the map edge; landscaping
  (`core/terrainEdit.ts`) adds the player's edits on top. With edits, "ground"
  and tunnels are measured from the edited land (`surfaceLevel`). A road over the river is a bridge because it
  is above the local terrain, so "elevated" means `y - terrainHeight > 1`.

## Module map and ownership

Modules may depend only on the ones listed before them.

| Dir | Purpose | Depends on |
| --- | --- | --- |
| `src/core` | Data model, curves, network edits, junction geometry, lane graph, save format. Pure TS with no DOM or Three.js. | nothing |
| `src/sim` | Vehicles, routing, junction control, signals, spawning, statistics. Pure TS, runs headless under Vitest. | core |
| `src/templates` | Parametric interchange stamps: roundabout, diamond, cloverleaf, trumpet, stack, turbine, and so on. | core |
| `src/rail` | Trains: track graph from rail lanes, consists, physics, block signalling, stations, lines, demo. Pure TS, headless. | core |
| `src/render` | Three.js scene: terrain, roads, markings, vehicles, overlays, previews. | core, read-only access to sim |
| `src/tools` | Input-driven editor tools. No direct DOM outside the canvas input they are given. | core, sim, templates, render |
| `src/ui` | DOM panels. | all of the above |
| `src/app` | Bootstrap, game loop, undo history, autosave, debug hook. | all of the above |
| `tests` | Vitest suites for core, sim, templates. | |

## Core behaviour

`RoadNetwork` owns the `Project` data. All edits go through its methods. Reads of
derived data are always valid: dirty nodes and segments are recomputed
incrementally, and the lane graph is refreshed on `commit()`. It emits a change
event carrying the dirty node and segment ids, so render rebuilds only those.

Geometry:
- Stations are spaced by curvature, tighter on bends, so that lane offsets stay
  smooth.
- Junction trim: for each pair of neighbouring arms, walk their facing road edges
  outward and find where they stop overlapping, plus a margin for corners. Shallow
  angle splits such as a highway off-ramp produce a long trim, capped at 80 m.
- A two-road joint with matching type and continuous tangent is a plain joint:
  no trim, no junction surface, lanes connect directly.
- The junction outline joins arm edges with curves tangent to the road edges, so
  corners are rounded, and ramp gores look tapered.

Connectors, auto-generated when `control.laneLinks` is null:
- Pass-through: pair lanes by lateral position. Lane drops merge into a neighbour,
  lane adds fan out from one.
- Diverge (one-way in, several one-ways out): rightmost out-branch takes the
  rightmost incoming lanes. When outgoing lanes exceed incoming, the shared lane
  feeds both. Example: 3-lane highway plus 1-lane off-ramp keeps three lanes on
  the mainline with the rightmost lane able to exit.
- Merge (several one-ways in, one out): each feeder takes the outgoing lanes on
  its side. Excess lanes merge in. Must never produce a lane with no exit.
- General junction: rightmost lanes turn right, leftmost turn left, the rest go
  straight, and single-lane approaches share all moves. No U-turns, except at a
  dead end with two-way road, which gets a turnaround.
- Controlled access (any junction with a 'highway' arm): traffic keeps to its own
  carriageway. Ramps and streets branch off or join on their own side only, from
  or into the lanes next to them (merge-only, right in and right out), with no
  turns across a median or opposing traffic. A ramp attached to a lane is fed by
  that lane and every lane outside it. See core/ramps.ts.
- Highway crossing (`JunctionControl.highwayAccess === 'crossing'`, set by drawRoad on a
  road drawn across a highway at grade; absent, as in older saves, is controlled access):
  an ordinary junction where the highway keeps every lane straight on and the side road
  crosses and turns, under protected signals. Two crossings of a divided highway close
  together run one linked plan, so nothing waits in the median. See core/highwayCrossing.ts.
- Edge merge (a ramp attach with `edge`, the road tool's default for a ramp on a
  highway's outside lane): the highway runs through its node as a plain joint, lane
  for lane with no connectors, and only the ramp's taper beside the edge is junction
  surface, with connectors into or out of the edge lane (or the lane added or
  dropped there). See core/edgeMerge.ts. A narrower road continuing a wider one can
  line up left, centred or right (core/laneAlign.ts).
- Every driving lane must have a way out unless the node is a true dead end.
- Bus lanes join only drive or bus lanes. Bike lanes join bike lanes only.

## Simulation design

- Target 5000 vehicles at 60 fps on a laptop. Struct of arrays with typed arrays,
  no per-frame allocation in the hot path. Fixed step 0.1 s, interpolated for
  rendering. Speeds 1x, 2x, 4x, plus pause.
- Longitudinal: Intelligent Driver Model with per-vehicle parameters.
- Routing: one reverse-Dijkstra cost table per destination over the lane graph, so
  no per-vehicle route. A vehicle reads the next lane from its destination's table
  at every decision. Edits therefore reroute vehicles automatically, and a lane
  that can't reach the destination has infinite cost, which drives mandatory lane
  changes. Tables refresh on a staggered timer using live segment speeds for
  congestion. Per-vehicle noise spreads load across alternatives.
- Lane changes: mandatory when the current lane can't continue, discretionary
  (MOBIL-style) for speed. Lateral motion is animated over about 2.5 s.
- Junctions: stop-line logic for signals and signs. Crossing conflicts use the
  `conflicts` list with gap acceptance, first-come ordering and don't-block-the-box
  checks. Merges use a virtual leader projected from the other feeder by distance
  to the merge point, with a stable tie-break, so zipper merges never deadlock.
- Deadlock safety: a vehicle stuck past `despawnStuckSec` is removed and counted.
- Spawning: Poisson per endpoint at `ratePerHour * multiplier`. Destinations are
  weighted by attraction. A vehicle never targets its own endpoint.
- After a network edit, vehicles remap by `GLane.key`, keeping their fraction along
  the lane. Vehicles on lanes that no longer exist are removed.

## Rail design

- Track is a road category `rail` with lanes of kind `rail` (catalogue in `core/railTypes.ts`), so
  drawing, snapping, elevation, bridges, tunnels, junctions, undo and save are the road system's.
  Single track is two coincident lanes, one per direction. Rail links only to rail, only where a
  train can run through (40 degrees at most), with turnouts limited to 40 km/h and no U-turns at
  dead ends. A track crossing a road at grade is a level crossing; metro never crosses at grade.
- Stations and lines persist in the optional `Project.rail`, edited through `RoadNetwork`.
- `rail/TrackGraph` folds lanes back into physical pieces of track, used either way, and groups
  any pieces that could foul each other into blocks. `rail/TrainSim` runs trains on it at a fixed
  0.1 s step: power and mass limited traction, grade, braking curves, curve and switch limits, two
  bogies per car on the track path. A train holds every block it occupies or will enter; blocks
  planned in both directions are taken whole through to a place it can stand aside, and a ring
  of trains waiting on each other is broken by withdrawing the youngest.
- `render/rail.ts` is a RenderLayer added through RenderContext; `app/rail.ts` wires the sim,
  layer, tools and panels together.

## Rendering design

- `logarithmicDepthBuffer` on, to avoid z-fighting across the zoom range.
- Road surfaces are one mesh per segment and per junction, swept from stations.
  They use world-space UVs so asphalt texture is continuous across junctions.
- Markings are separate meshes floating 2 to 3 cm above the surface, with polygon
  offset, depth write off.
- Bridges get barriers and pillars. Tunnels get portals where they pass below
  ground, and an underground view makes the terrain see-through.
- Piers are planned in `render/piers.ts` for every elevated road, track and junction:
  footprints of every carriageway (split at raised medians), sidewalk, track bed,
  platform, junction surface and zoned lot below, each with its headroom. Columns stand
  only in the gaps (hammerhead, twin, or a portal frame straddling the road), shifted
  along the span, with a long girder span as the last resort. The renderer, the draw
  preview and the tests share the plan, and `RoadLayer` re-plans decks within a portal's
  reach of any road or station edited below.
- Vehicles are `InstancedMesh` per model, reading the sim's typed arrays.
- Trees are instanced and hidden where roads run through them.
- Procedural everything: textures from canvas, models from primitives. No binary
  assets in the repo.
- Performance budgets live in `render/quality.ts`. The default level is High at
  most, guessed from the GPU; the governor steps down after 1.5 s of slow,
  GPU-bound frames and steps up only after 6 s of clear GPU headroom (it times the
  GPU with `EXT_disjoint_timer_query_webgl2` where the browser allows).
- The sun's shadow map is cached at Medium and Low (`shadowEvery`): it redraws when
  the shadow box or light moves, on network edits and tree re-sorts, and at least
  every few frames. Something that animates and casts shadows is fine at High and
  Ultra; at lower levels it updates at that slower rate. Vehicles cast sun shadows
  only at High and Ultra; their contact shadow is always on.

## Editor behaviour (modelled on Skylines)

- Draw modes: Straight, Curved (start, control, end), Freeform (continuous with
  the previous tangent), Upgrade (repaint road type over existing segments).
- Snapping to nodes, to points along segments (which splits them), to length and
  angle guides. Hold Ctrl (or Cmd) to disable snapping.
- Live readouts while drawing: length, turn radius, slope, angle at the snap.
  Invalid previews go red and say why.
- Crossing a road at grade auto-creates a junction. Crossing with clearance makes
  a bridge or tunnel.
- PageUp and PageDown change elevation. Left click places, right click cancels the
  last step, Esc leaves the tool.
- Camera: WASD pan, Q/E rotate, R/F tilt, wheel zoom, middle or right drag orbits.
- Undo and redo for all edits, autosave to localStorage, JSON export and import.
- Middle-click (or Option+click, or Cmd+C) copies what is under the cursor: a road's type and
  settings, a marking's style, or a junction's control and shape (tools/clipboard.ts). Cmd+V over
  the same kind of thing pastes it as one undo step; the copy also goes to the system clipboard as
  strictly checked JSON (app/clipboard.ts).

## Visual direction

Skylines-like: muted natural greens, soft sun shadows, readable road hierarchy.
UI is translucent dark navy panels with cyan-blue highlights, rounded corners,
white line icons, tooltips. A wide bottom toolbar with category tabs and thumbnail
cards, a left options strip on the road panel for draw modes and elevation, a top
bar for traffic stats and sim speed, and floating inspector panels for a selected
junction, segment or endpoint. Road thumbnails are drawn procedurally as cross
sections.

## Testing hooks

`window.__cloverleaf` exposes `{ net, sim, renderer, tools, history }` in dev, so
the game can be driven by scripts in a real browser. `?bench=1` runs the performance
benchmark (`app/bench.ts`): a fixed heavy scene, a scripted camera through map,
mid, close, low-angle and rail views at each quality level, and a table of CPU time
per section and GPU time per phase. It never touches saves. Everything in `core`, `sim`
and `templates` must be testable headlessly under Vitest.
