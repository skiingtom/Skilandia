// The landscape: heightmap, noise, rock, and terrain editing. Port of src/height.ts.
//
// The heightmap is global (one world at a time), loaded once with LoadTerrain.
#pragma once

#include "SkiTypes.h"

#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace Ski
{

/** JavaScript's Math.round (halves round up). */
inline double JsRound(double v) { return std::floor(v + 0.5); }

/**
 * Load the heightmap: kTerrainCols x kTerrainRows little-endian uint16 metres,
 * row 0 = south edge (Unreal/Content/Data/Terrain.u16). Resets every edit.
 */
bool LoadTerrain(const uint16_t* metres, size_t count);
/** Read the heightmap file from disk and load it. */
bool LoadTerrainFile(const std::string& path);
bool TerrainLoaded();
/** Bumped by every LoadTerrain, so derived data (highway, summits) can be rebuilt. */
int TerrainGeneration();

double Noise2(double x, double y);

/** Normalised elevation (0..1) at map position x, y (metres; y is north). */
double Elevation(double x, double y);
/** Elevation in metres above sea level. */
double ElevationM(double x, double y);
double SlopeAt(double x, double y);
/** Fall-line steepness in the units the trail classifier uses (drop m / run m). */
double GradeAt(double x, double y);
/** Steepest-descent direction (unit vector in map x/y). */
Vec2 Downhill(double x, double y);

double Lerp(double a, double b, double t);
double SmoothStep(double a, double b, double x);
double PolylineLength(const std::vector<Vec2>& points);

struct PolylinePoint
{
	double x;
	double y;
	double dx;
	double dy;
	bool done;
};
PolylinePoint PointOnPolyline(const std::vector<Vec2>& points, double dist);
double DistToPolyline(const std::vector<Vec2>& points, double x, double y);
bool NearSegment(double ax, double ay, double bx, double by, double x, double y, double pad);

/** Above this the forest gives out and bare rock starts to take over. */
constexpr double kTreelineM = 1950;

/** How rocky a spot is (0..1). Anything over 0.5 is bare rock. */
double RockAt(double x, double y);
bool IsRock(double x, double y);

// ---------- terrain editing: building pads and the shaping brush

/** How far (metres) the ground may be cut or filled from where it started. */
constexpr double kMaxEarthworkM = 40;
constexpr double kHeightCellM = kTerrainCellM;

struct Box
{
	double x0, y0, x1, y1;
};

struct CellRange
{
	int i0, i1, j0, j1;
};

/** Bumped on every edit; the renderer redraws what changed. */
int TerrainVersion();
/** Heightmap cells (vertex indices) changed since the last call, if any. */
std::optional<CellRange> TakeTerrainDirty();

/** Raw normalised height of heightmap vertex (i, j), for building meshes. */
float HeightAtCell(int i, int j);

struct PadResult
{
	double volume;
	double level;
	Box box;
};
/**
 * Grade a building pad: everything under the footprint goes to the median
 * height of the ground there, easing back into the slope just outside it.
 */
PadResult FlattenPad(double x, double y, double radius);

enum class SculptMode : uint8_t { Raise, Lower, Flatten, Smooth };

struct EditResult
{
	double volume;
	Box box;
};
/**
 * One dab of the shaping brush. `amount` is metres at the centre for raise and
 * lower, or 0..1 strength for flatten and smooth; `target` (metres above sea
 * level) is the height flatten works toward. `locked` marks ground that must
 * not move (under buildings).
 */
EditResult Sculpt(double x, double y, double radius, SculptMode mode, double amount, double target = 0,
	const std::function<bool(double, double)>& locked = nullptr);

/** How far the ground here has been cut (negative) or filled (positive), in metres. */
double EarthworkAt(double x, double y);

} // namespace Ski
