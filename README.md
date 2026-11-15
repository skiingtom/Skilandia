# Skilandia

A ski-resort builder. Fly over Little Hawk Hill, sell tickets, cut runs, build lifts and lodges, then grow into Cedar Ridge and Twin Peaks.

## Play on Windows

Windows builds are paused while the game is being polished. To make one: **Actions → Windows build → Run workflow**, then download **Artifacts → Skilandia-windows** from that run.

1. It contains `Skilandia-Setup-<version>.exe` (installer) and `Skilandia-<version>-portable.exe` (no install, just run it).
2. Double-click it. Windows SmartScreen may say "Windows protected your PC" because the game isn't code-signed yet: click **More info → Run anyway**.

F11 toggles fullscreen.

## Mountains

| Mountain | Holds at once | Lifts allowed |
|---|---|---|
| Little Hawk Hill | 2,000 skiers | 10 |
| Cedar Ridge | 6,000 skiers | 20 |
| Twin Peaks | 18,000 skiers | 40 |

Skiers only come when the resort looks like it can handle them. The **Skiers** counter shows `on the hill / comfortable load` (hover it for the breakdown). The comfortable load is the smallest of:

- **Lifts**: what your lifts can keep cycling (riders per second × a full lap: ride up, ski down, walk back). Lifts with no run at the top don't count
- **Runs**: room on the snow, about one skier per 7 map units of run
- **The mountain's maximum** above

How much of that you actually draw depends on how appealing the resort is (variety, food, lodging, price, lift lines). "The hill is saying" tells you whether lifts, runs or the mountain itself is holding you back. Fed-up skiers leave long lines and go home.

## Controls

- **Open the mountain** on the welcome screen to start
- Right-drag to look, scroll to zoom, WASD to fly
- Press **G** (or "Show steepness") to tint the mountain green / blue / black / red by pitch. It turns on automatically while cutting a trail or placing a carpet / T-bar
- Build from the icon bar at the bottom: Look, Trails, Park, Lifts, Base, Food and Resort each open a submenu

### Runs

- Five kinds: groomed slope, slalom course (gates), mogul run (one notch harder), terrain park (wide, orange-edged) and glades
- Cutting a run clears the forest in its path. **Glades** are drawn through the trees instead: they're thinned, not cleared, marked with boundary poles, and rate one notch harder
- Skiers only ski on runs. They never cut through the woods
- Park features: rails, boxes and halfpipes go inside a terrain park; jumps go on any run

### Lifts

- Magic carpet, T-bar, double, quad, covered six-pack and 8-person gondola. Click the bottom station, then the top
- Carpets and T-bars ride on the snow, so the ground must climb the whole way (and stay gentle for a carpet). Chairs and the gondola fly over anything uphill
- Select a lift to see its capacity, or take it down for 40% back

### Buildings and staff

- Select a building to move it. Moving costs 25% of its price unless you switch the fee off under ⚙ Settings
- **Ski school** sells lessons to beginners (some graduate to blues). It needs instructors, who are paid from day one
- **Heli-ski base** ($450,000) flies expert skiers off the map to the backcountry, eight at a time, for $650 a seat. It costs $1,500/min to run plus $600 fuel a flight; a busy one clears about $7,700/min
- Sugar shacks can sit beside trails
- After you buy the next mountain, hire ski patrol and a crew

## Develop

```bash
npm install
npm run dev        # game in the browser at http://127.0.0.1:5173/
npm run app        # build, then open it in the desktop window
npm run dist:win   # Windows installer + portable exe in release/ (run on Windows)
npm test           # headless 30-minute playthrough that checks everything works together
```

`npm run dist:win:nowine` builds the Windows app on Linux/macOS without Wine; it skips the icon and the installer, so add `--win zip` to package it as a zip:

```bash
npx electron-builder --win zip --x64 --publish never -c.win.signAndEditExecutable=false
```

The app icon is `build/icon.png`, drawn by `python3 build/make_icon.py`.
