// Roads and footpaths. Port of src/roads.ts and src/paths.ts.
#pragma once

#include "SkiTypes.h"

#include <cstdint>
#include <optional>
#include <unordered_map>
#include <vector>

namespace Ski
{

// ---------- roads

/** Dollars per metre of road. */
constexpr double kRoadCostPerM = 6;
/** Steepest a road leg may climb (rise / run). */
constexpr double kRoadMaxGrade = 0.14;
/** Shortest leg you can click. */
constexpr double kRoadMinLeg = 20;
/** How close a click has to be to snap onto a road or the parking lot. */
constexpr double kRoadSnap = 34;
/** Asphalt width in metres (trees are cleared a little wider). */
constexpr double kRoadWidth = 9;

struct Road
{
	int id = 0;
	std::vector<Vec2> points;
	/** The highway that brings skiers in from out of the valley. */
	bool highway = false;
};

/** Average grade of a road leg, sampled so a hump in the middle counts. */
double LegGrade(const Vec2& a, const Vec2& b);
double RoadLength(const std::vector<Vec2>& points);

struct NearestOnRoad
{
	Vec2 p;
	int seg = 0;
	double d = 0;
	double t = 0;
};
/** Nearest point on a polyline, with the segment index it falls on. */
NearestOnRoad NearestOnPolyline(const std::vector<Vec2>& points, double x, double y);

/**
 * Shortest drive over the road network from either end of the highway to
 * `goal`. Roads join where a point is shared exactly. Empty if unreachable.
 */
std::optional<std::vector<Vec2>> RouteTo(const std::vector<Road>& roads, const Vec2& goal);

/**
 * The highway: a least-cost path along the valley floor between the two lowest
 * ways out of the map, keeping its distance from the village. Computed from
 * the terrain on first use after each LoadTerrain.
 */
const std::vector<Vec2>& Highway();

// ---------- footpaths

/** Dollars per metre of path. */
constexpr double kPathCostPerM = 2;
/** Walkway width in metres. */
constexpr double kPathWidth = 4.5;
/** Steepest a path leg may climb. */
constexpr double kPathMaxGrade = 0.3;
/** Shortest leg you can click. */
constexpr double kPathMinLeg = 6;
/** How close a click has to be to join an existing path. */
constexpr double kPathSnap = 16;
/** How much faster people walk on a path than through the snow. */
constexpr double kPathSpeed = 1.7;

struct Path
{
	int id = 0;
	std::vector<Vec2> points;
};

/**
 * The walkable network: path polylines cut into nodes a few metres apart,
 * joined wherever two paths meet. Shortest walks are found backwards from each
 * destination once and cached.
 */
class PathNet
{
public:
	explicit PathNet(const std::vector<Path>& paths);

	/**
	 * Waypoints along the paths from `from` toward `to` (the walker heads
	 * straight for `to` after the last one), or nothing if wading straight
	 * there is quicker.
	 */
	std::optional<std::vector<Vec2>> Route(const Vec2& from, const Vec2& to);

	const std::vector<Vec2>& Nodes() const { return nodes; }

private:
	struct Edge
	{
		int to;
		double w;
	};
	struct Tree
	{
		std::vector<double> d;
		std::vector<int> next;
	};

	std::vector<Vec2> nodes;
	std::vector<std::vector<Edge>> adj;
	std::unordered_map<int64_t, Tree> trees;
	std::unordered_map<int64_t, std::vector<int>> grid;
	static constexpr double kCell = 60;

	int AddNode(const Vec2& p);
	void Link(int a, int b);
	static int64_t Key(int64_t i, int64_t j) { return (i << 32) ^ (j & 0xffffffff); }
	int64_t CellKey(double x, double y) const;
	std::vector<int> Near(double x, double y) const;
	const Tree& TreeTo(const Vec2& to);
};

} // namespace Ski
