# Skilandia for Unreal Engine 5

The Unreal Engine 5 version of Skilandia, being ported from the web game in
the repository root. This is the foundation pass: the whole simulation runs
in C++ and the mountain is playable with keyboard tools, drawn with simple
shapes. Menus, art, audio and save games come next.

## Open it

1. Install Unreal Engine 5.7 or newer (Epic Games Launcher), and Visual Studio 2022
   with the **Game development with C++** workload (or JetBrains Rider).
2. Double-click `Unreal/Skilandia.uproject`. When it asks to build the
   `Skilandia` module, click **Yes** (or right-click the `.uproject` →
   **Generate Visual Studio project files**, open `Skilandia.sln` and build
   `Development Editor`).
   On a newer engine than 5.7, right-click the `.uproject` → **Switch Unreal
   Engine version**.
3. The first time the editor opens, `Content/Python/init_unreal.py` creates
   `/Game/Skilandia/M_VertexColor` (the terrain's snow / rock / steepness
   colours). Until then, the mountain is plain white.
4. Press **Play**. No map is needed: the game mode spawns the resort, sky and
   light into whatever level is open (the project opens `/Engine/Maps/Entry`).

## Play

The status bar, the hill's complaints, the next goal and a key list are drawn
on screen. Same rules as the web game (see the main README).

| Keys | |
|---|---|
| Right-drag, scroll, WASD, Q/E | Look, zoom, fly (Shift faster), up/down. Middle-drag pans, Home returns to base |
| T | Cut a run; press again for slalom, moguls, terrain park, glades. Click downhill points, **Enter** to open it |
| L | Lift; press again for the next type (carpet → gondola). Click the bottom station, then the top |
| B / Shift+B | Cycle through the buildings you can place right now |
| F | Park features (jump, rail, box, halfpipe) |
| R / P | Road / footpath |
| X | Demolish |
| C / V | Clear trees / plant trees (V again: brush or single) |
| K | Shape terrain (K again: raise, lower, flatten, smooth; Shift+K: brush size). Hold the left button |
| M | Move the selected building |
| G | Steepness tint |
| Space, 1 2 3 | Pause, speed |
| + / - | Ticket price |
| F1–F6 | Hire patrol, instructors, food service, lift attendants, delivery, maintenance (Shift lets one go) |
| Esc / Tab | Cancel / hide the key list |

## How it's built

```
Unreal/
  Skilandia.uproject
  Config/                    engine, game and input settings
  Content/Data/Terrain.u16   the heightmap (1000 x 594, uint16 metres, row 0 = south)
  Content/Python/            editor start-up script (makes the vertex-colour material)
  Source/Skilandia/
    Core/                    the simulation: plain C++20, no Unreal types
      SkiTypes      tables and types           (src/types.ts)
      SkiTerrain    heightmap, rock, sculpting  (src/height.ts)
      SkiRoads      highway, roads, footpaths   (src/roads.ts, src/paths.ts)
      SkiGame       the resort simulation       (src/sim.ts)
    SkiResort        owns the Game; draws terrain, forest, runs, lifts, buildings, people, sky
    SkiPlayerController  camera, keys, mouse tools, previews
    SkiHUD           on-screen text interface
    SkilandiaGameMode / SkiCameraPawn
  CoreTests/Playthrough.cpp  port of tests/playthrough.ts
```

`Core/` is a line-by-line port of the TypeScript simulation, with the same
function order and comments, so changes can be carried across. Unreal space is
centimetres with X east and Y south (Unreal is left-handed): use
`ASkiResort::ToWorld` / `ToMap` rather than converting by hand. Mountains are
drawn 1.15x as tall, as in the web game (`VerticalScale`).

The terrain is a procedural mesh rather than a Landscape actor, because the
game reshapes it at runtime (building pads, the shaping brush). The forest is
the sim's procedural forest, streamed in 2 km tiles and thinned with distance.

## Test the simulation without Unreal

```bash
Unreal/CoreTests/run.sh
```

Builds `Core/` with g++ or clang and runs the same 30-minute playthrough as
`npm test`: build one of everything, run the hill, conquer all 8 peaks.

The heightmap comes from the web game's data; to regenerate it:

```bash
python3 tools/terrain/export_unreal.py
```

## Not ported yet

- Menus and panels (`src/main.ts`, `src/dock.ts`, `index.html`, `src/style.css`): replace the HUD with UMG
- Models and materials (`src/look.ts`, `src/vehicles.ts`): lodges, chairlifts, cars, skier figures
- Cars driving the roads, snowfall, the intro fly-over
- Audio (`src/audio.ts`)
- Windows packaging (the Electron build in the main README is still the web game)
