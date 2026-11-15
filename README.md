# Skilandia

A browser ski-resort builder. Fly over Little Hawk Hill, sell tickets, place buildings, then grow into Cedar Ridge and Twin Peaks.

## Run locally

```bash
npm install
npm run dev
```

Then open [http://127.0.0.1:5173/](http://127.0.0.1:5173/).

## Controls

- **Open the mountain** on the welcome screen to start
- Right-drag to look, scroll to zoom, WASD to fly
- Press **G** (or "Show steepness") to tint the mountain green / blue / black / red by pitch. It turns on automatically while cutting a trail
- Build from the icon bar at the bottom: Look, Trail, and Lifts / Base / Food / Resort, which open a submenu
- Lifts: magic carpet, T-bar, double, quad, covered six-pack and 8-person gondola. Click the bottom station, then the top. Carpets and T-bars ride on the snow, so the ground must climb the whole way (and stay gentle for a carpet); chairs and the gondola fly over anything uphill
- Select a lift to see its capacity, or take it down for 40% back
- Sugar shacks can sit beside trails
- After you buy the next mountain, hire ski patrol and a crew

## Scripts

- `npm run dev` — local game server
- `npm run build` — production build
- `npm run preview` — serve the production build
