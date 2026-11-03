# Cloverleaf

A browser road designer in the spirit of Cities: Skylines. Draw free-form curved roads, build interchanges, set traffic levels, control signals and paint markings while an agent-based traffic simulation drives on what you build.

Built with TypeScript, Three.js and Vite. Everything is procedural, with no binary assets.

## Run

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Check

```bash
npm run typecheck
npm test
```

## Controls

WASD pans, Q/E rotates, R/F tilts, the wheel zooms. Left click places, right click steps back, Esc leaves a tool. PageUp and PageDown change road elevation. B bulldozes, Ctrl or Cmd+Z undoes.

See `ARCHITECTURE.md` for how the code is organised and `CORE_API.md` for the road network API.
