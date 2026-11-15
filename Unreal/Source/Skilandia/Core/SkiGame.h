// The resort simulation. Port of src/sim.ts.
//
// Call LoadTerrain (SkiTerrain.h) before constructing a Game.
#pragma once

#include "SkiRoads.h"
#include "SkiTerrain.h"
#include "SkiTypes.h"

#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <random>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace Ski
{

/** Each peak snapped to the true high point near its map label. */
struct Summit
{
	std::string id;
	std::string name;
	double x;
	double y;
	int elevation;
};
const std::vector<Summit>& Summits();

struct LiftCheck
{
	std::optional<std::string> error;
	double length = 0;
	double rise = 0;
	double cost = 0;
};

struct TrailMeasure
{
	double length;
	double drop;
	Difficulty difficulty;
	double cost;
};

double TrailCost(double length, TrailKind kind = TrailKind::Slope);
Difficulty ClassifyGrade(double dropM, double lengthM);
TrailMeasure MeasureTrail(const std::vector<Vec2>& points, TrailKind kind = TrailKind::Slope);
double DistToTrail(const Trail& t, double x, double y);

struct NearestOnTrailResult
{
	double along;
	double dx;
	double dy;
	double d;
};
/** Closest point on a run: distance along it and the direction of travel there. */
NearestOnTrailResult NearestOnTrail(const Trail& t, double x, double y);

/** Higher summits pay more. */
double PeakBonus(double elevation);

enum class SelKind : uint8_t { Trail, Building, Lift, Skier, Hill };
struct Selection
{
	SelKind kind = SelKind::Hill;
	int id = 0;
};

enum class ClickResult : uint8_t { Ok, Shake, None };

enum class RewardKind : uint8_t { Goal, Peak, Win };
struct Reward
{
	int id;
	RewardKind kind;
	std::string title;
	std::string text;
	double bonus;
};

enum class DemolishKind : uint8_t { Building, Feature, Lift, Trail, Road, Path };
struct DemolishTarget
{
	DemolishKind kind;
	int id;
	std::string label;
	double refund;
};

enum class LimitedBy : uint8_t { Lifts, Runs, Capacity, Parking };
struct LoadLimits
{
	int lifts = 0;
	int runs = 0;
	int cap = 0;
	int parking = 0;
	int comfortable = 0;
	LimitedBy limitedBy = LimitedBy::Lifts;
};

struct Weather
{
	/** 0 clear .. 1 overcast */
	double cover;
	/** 0 none .. 1 heavy */
	double snow;
	double wind;
};

struct WeatherReport
{
	std::string condition;
	int tempC;
	int windKmh;
	int freshCm;
	std::string forecast;
};

struct ParkingLot
{
	double x;
	double y;
	int skiers;
	bool connected;
	/** Building id, or none for the starter lot. */
	std::optional<int> id;
};

struct HeliState
{
	bool flying = false;
	double t = 0;
	std::vector<int> riders;
	double wait = 0;
};

enum class PlantMode : uint8_t { Single, Brush };

/** A drawn tree; `level` is the largest stride at which it is still drawn. */
struct ForestTree
{
	double x;
	double y;
	int level;
};

/** Largest sparse-forest stride a tree can survive (see Game::treesIn). */
constexpr int kMaxTreeStride = 16;

/** How forested a spot is (0..1): patchy, thinning out toward the treeline. */
double ForestDensity(double x, double y);

/** Shaping: metres a second the brush raises or lowers at its centre, and what earthworks cost. */
constexpr double kShapeRateM = 4;
constexpr double kEarthCostPerM3 = 0.06;
constexpr std::array<double, 3> kShapeSizes = {30, 60, 110};
/** Radius of the tree-clearing brush, and what each tree costs to fell. */
constexpr double kBrushR = 30;
constexpr double kTreeFellCost = 4;
constexpr double kTreePlantCost = 12;
/** How far from a lift's top station people will wander to a lookout. */
constexpr double kLookoutReach = 350;

enum class Sfx : uint8_t { Cash, Build, Err };

class Game
{
public:
	/** `seed` drives every random choice, so a run can be replayed. */
	explicit Game(uint32_t seed = 12345);

	double money = kStartMoney;
	double ticketPrice = kStartTicket;
	int day = 1;
	double dayT = 0;
	/** New snow on the ground (cm). */
	double freshSnowCm = 0;
	double speed = 1;
	bool paused = false;
	bool managing = false;
	ToolKind tool = ToolKind::Select;
	/** Building / lift / feature the current tool places. */
	BuildingType toolBuilding = BuildingType::Lodge;
	LiftType toolLift = LiftType::Quad;
	FeatureType toolFeature = FeatureType::Jump;
	std::vector<Trail> trails;
	std::vector<Lift> lifts;
	/** Bottom station picked while placing a lift, and the pointer for the preview. */
	std::optional<Vec2> liftStart;
	std::optional<Vec2> liftHover;
	/** The highway (always first) and every road the player has built. */
	std::vector<Road> roads;
	/** Bumped whenever the road network changes. */
	int roadVersion = 0;
	std::vector<Path> paths;
	int pathVersion = 0;
	/** Goals already paid out, and celebrations waiting to be shown. */
	std::set<std::string> goalsPaid;
	std::vector<Reward> rewards;
	struct Clearing
	{
		double x, y, r;
	};
	/** Circles of forest the player has felled with the tree brush. */
	std::vector<Clearing> clearings;
	/** Trees the player has planted (on top of the procedural forest). */
	std::vector<Vec2> planted;
	PlantMode plantMode = PlantMode::Brush;
	int treesPlanted = 0;
	int treesFelled = 0;
	/** Shaping brush: mode, radius (m), and the stroke in progress. */
	SculptMode shapeMode = SculptMode::Raise;
	double shapeRadius = 60;
	std::optional<double> shapeTarget;
	double shapeCost = 0;
	double shapeVolume = 0;
	/** Bumped whenever the ground is regraded. */
	int terrainEdits = 0;
	std::optional<Vec2> brushHover;
	std::vector<Building> buildings;
	std::vector<Skier> skiers;
	std::vector<Feature> features;
	/** Kind of run the Trail tool cuts. */
	TrailKind trailKind = TrailKind::Slope;
	/** Building being moved with the Move tool. */
	std::optional<int> moveId;
	/** Settings. */
	bool moveFeeOn = true;
	bool freeTreeClearing = false;
	bool freeShaping = false;
	HeliState heli;
	int heliFlightsToday = 0;
	/** Game seconds since start; orders lift lines. */
	double clock = 0;
	double heliTakeToday = 0;
	double upkeepToday = 0;
	std::vector<Fx> fx;
	std::vector<Toast> toasts;
	std::vector<Vec2> draft;
	std::optional<Selection> hover;
	std::optional<Selection> selected;
	int nextId = 1;
	double spawnAcc = 0;
	double mood = 62;
	int ticketsToday = 0;
	double incomeToday = 0;
	double shopIncomeToday = 0;
	int totalTickets = 0;
	int peakSkiers = 0;
	std::vector<Sfx> sfx;
	int nextToast = 1;
	std::set<std::string> usedTrailNames;
	double thoughtAcc = 0;
	/** Peaks conquered so far (by id). */
	std::set<std::string> conquered;
	bool won = false;
	/** Bumped whenever the forest changes. */
	int forestVersion = 0;
	double lifetimeEarned = 0;
	double wagesToday = 0;
	std::array<int, kStaffRoleCount> staff{};

	int Staff(StaffRole r) const { return staff[static_cast<int>(r)]; }

	// ---------- forest
	std::vector<ForestTree> treesIn(double x0, double y0, double x1, double y1, bool cleared = true, int stride = 1);
	int treesUnderBrush(double x, double y);

	int id() { return nextId++; }

	// ---------- clock and weather
	std::string clockLabel() const;
	std::string timeOfDay(std::optional<double> at = std::nullopt) const;
	WeatherReport weatherReport() const;
	double dayFraction() const;
	Weather weather() const;

	// ---------- appeal and capacity
	struct Variety
	{
		std::array<int, 4> counts;
		double score;
		std::array<bool, kTrailKindCount> kinds;
	};
	Variety variety() const;
	double amenityScore() const;
	double fairPrice() const;
	double liftWait() const;
	int tier() const;
	int capacity() const;
	LoadLimits loadLimits();
	int demand();
	int maxLifts() const;
	double attraction();
	bool has(BuildingType type) const;
	int count(BuildingType type) const;
	std::vector<Goal> goals();
	std::vector<std::string> complaints();

	void toast(const std::string& text, bool bad = false);
	void floatText(double x, double y, const std::string& text, const std::string& color = "#e2b857");
	void startManaging();
	void setTool(const Tool& t);
	void setSpeed(double n);
	void togglePause();
	void setTicketPrice(double n);
	void cancel();

	// ---------- moving buildings
	double moveFee(const Building& b) const;
	Building* movingBuilding();
	void startMove(int buildingId);
	std::optional<std::string> canMoveTo(double x, double y);

	// ---------- park features
	std::optional<std::string> canPlaceFeature(FeatureType type, double x, double y);
	double featureAngle(double x, double y);

	// ---------- lifts
	bool nearLift(double x, double y, double pad) const;
	LiftCheck checkLift(LiftType type, const Vec2& a, const Vec2& b) const;
	void removeLift(int liftId);
	/** Runs whose start is an easy hike from this lift's unload. */
	std::vector<const Trail*> trailsFrom(const Lift& l) const;
	std::optional<TrailMeasure> draftInfo() const;

	// ---------- the village, roads and parking
	double villageRadius() const;
	bool inVillage(double x, double y) const;
	const std::set<int>& connectedRoads();
	std::vector<ParkingLot> parkingLots();
	int parkingCapacity();
	double parkingAngle(BuildingType type, double x, double y) const;
	std::optional<std::vector<Vec2>> carRoute();
	/** The starter lot is linked to the highway. */
	bool roadConnected();
	bool nearRoad(double x, double y, double pad) const;
	struct DraftInfo
	{
		double length;
		double cost;
		double grade;
	};
	DraftInfo roadDraftInfo() const;
	ClickResult finishRoad();
	PathNet& pathNet();
	DraftInfo pathDraftInfo() const;
	ClickResult finishPath();

	// ---------- shaping, clearing, demolishing
	double brushRadius() const;
	void setShapeMode(SculptMode mode);
	void shapeStep(double x, double y, double dt);
	void endShape();
	std::optional<DemolishTarget> demolishTarget(double x, double y);
	void endBrush();

	// ---------- placing things
	std::optional<std::string> canPlace(BuildingType type, double x, double y, std::optional<int> ignoreId = std::nullopt,
		std::optional<double> cost = std::nullopt);
	ClickResult click(double x, double y);
	void moveHover(double x, double y);
	Selection pickAt(double x, double y) const;
	struct SelectionText
	{
		std::string title;
		std::string body;
	};
	SelectionText selectionText();
	std::optional<Vec2> rockOnLeg(const Vec2& a, const Vec2& b, double width) const;
	ClickResult finishTrail();

	// ---------- skiers and money
	void spawnSkier(bool freeTicket);
	void tick(double dt);
	int shopRatePerMin();
	bool cabinOnRun(const Vec2& b) const;
	int skiInCabins() const;
	double upkeepPerMin() const;
	const Building* helipad() const;
	bool staffRequired() const;
	bool expansionUnlocked() const;
	std::array<int, kStaffRoleCount> staffNeeds() const;
	double staffCoverage() const;
	void hire(StaffRole role);
	void fire(StaffRole role);
	Vec2 booth() const;
	/** Where skiers park and leave from. */
	Vec2 exit() const;

	const Trail* findTrail(int trailId) const;
	const Lift* findLift(int liftId) const;
	Lift* findLift(int liftId);
	const Building* findBuilding(int buildingId) const;
	const Skier* findSkier(int skierId) const;

	/** Uniform random number in [0, 1). */
	double random();

private:
	struct ClearShape
	{
		double ax, ay, bx, by, r;
		bool glade;
		bool brush;
	};
	struct ClearIndex
	{
		double x0, y0;
		double cell;
		int cols;
		std::vector<ClearShape> shapes;
		std::unordered_map<int, std::vector<int>> cells;
	};

	std::mt19937 rng;
	std::unique_ptr<PathNet> pathNetCache;
	int pathNetVersion = -1;
	double goalCheckT = 0;
	std::unordered_map<int, std::vector<Vec2>> plantedCells;
	std::optional<Vec2> shapeAt;
	bool shapeBroke = false;
	std::optional<Vec2> shapeCleared;
	std::string routeCacheKey = "\x01";
	std::optional<std::vector<Vec2>> routeCacheRoute;
	int connCacheVersion = -1;
	std::set<int> connCacheIds;
	int starterCacheVersion = -1;
	bool starterCacheValue = false;
	/** Per-tick indexes; they point into `skiers`, so they are only valid inside tick(). */
	std::unordered_map<int, Skier*> byId;
	std::unordered_map<int, std::vector<Skier*>> lines;
	/** How many people stood in each lift's line at the end of the last tick. */
	std::unordered_map<int, int> queued;
	std::unordered_map<int, int> lineSpot;
	std::unordered_map<int, int> lineLen;
	std::unordered_map<int, std::vector<const Trail*>> served;
	std::unordered_map<int, int> heliSpot;
	double boothTake = 0;
	std::optional<LoadLimits> loadCache;
	double loadCacheT = -1;
	std::string loadCacheKey;
	double boothT = 0;
	std::optional<Vec2> lastBrush;
	double strokeCost = 0;
	/** Scratch run for a carpet's bunny slope (see trailFor). */
	Trail bunnyScratch;

	template <typename T>
	const T& pickOne(const std::vector<T>& arr)
	{
		return arr[static_cast<size_t>(random() * arr.size())];
	}

	void layoutStarter();
	Trail makeTrail(const std::string& name, const std::vector<Vec2>& points, TrailKind kind = TrailKind::Slope);
	void trailsChanged();
	void addClearing(double x, double y, double r);
	int removePlanted(double x, double y, double r);
	std::optional<std::string> plantError(double x, double y, const ClearIndex& index, const std::vector<Vec2>& existing);
	ClickResult paintPlanting(double x, double y);
	ClearIndex clearersIn(double x0, double y0, double x1, double y1) const;
	bool isCleared(double x, double y, const ClearIndex& index, bool plantedTree = false) const;
	int treesAlong(const std::vector<Vec2>& points, double halfWidth, bool cleared = true);
	void clearTrees();
	Weather weatherFor(double t) const;
	void checkConquest();
	ClickResult clickMove(double x, double y);
	struct FeatureSpot
	{
		const Trail* trail;
		double angle;
		double dist;
	};
	FeatureSpot featureSpot(double x, double y) const;
	ClickResult clickFeature(FeatureType type, double x, double y);
	ClickResult clickLift(LiftType type, double x, double y);
	Lift makeLift(LiftType type, const std::string& name, const Vec2& bottom, const Vec2& top);
	bool villageOk(double x, double y) const;
	struct RoadNear
	{
		const Road* road;
		Vec2 p;
		int seg;
		double d;
	};
	std::optional<RoadNear> connectedRoadNear(double x, double y, double reach);
	bool starterLotConnected();
	std::optional<std::string> parkingError(BuildingType type, double x, double y, const std::vector<const Building*>& others);
	void gradePad(const Building& b);
	void terrainEdited(const Box& box);
	bool padLocked(double x, double y) const;
	void stampClearing(const std::vector<Vec2>& points, double r);
	ClickResult demolishAt(double x, double y);
	ClickResult paintClearing(double x, double y);
	struct RoadSeg
	{
		Vec2 a, b;
		double w;
	};
	std::vector<RoadSeg> roadSegsIn(double x0, double y0, double x1, double y1) const;
	std::optional<Vec2> snapRoad(double x, double y) const;
	ClickResult clickRoad(double x, double y);
	struct PathSnap
	{
		Vec2 p;
		bool joins;
	};
	std::optional<PathSnap> snapPath(double x, double y);
	ClickResult clickPath(double x, double y);
	void maybeLookout(Skier& s);
	void walkTo(Skier& s, double x, double y, double step, double dt);
	void checkGoals();
	ClickResult clickCut(double x, double y);
	std::string freshTrailName(TrailKind kind = TrailKind::Slope);
	ClickResult clickBuild(BuildingType type, double x, double y);
	Vec2 pickLot();
	void collectBuildingIncome(double dt);
	double buildingFactor(BuildingType type);
	double buildingEarnFactor(const Building& b);
	void payUpkeep(double dt);
	void stepHeli(double dt);
	bool wantsHeli(const Skier& s);
	void payWages(double dt);
	const Building* nearestOf(const std::vector<BuildingType>& types, double x, double y) const;
	void ageToasts(double dt);
	void stepLift(double dt);
	const Lift* chooseLift(const Skier& s);
	const Trail* trailFor(const Skier& s);
	void goToLift(Skier& s);
	const Trail* chooseTrail(const Skier& s, const Lift* lift = nullptr);
	void stepSkier(Skier& s, double dt);
	void buildIndexes();
	const std::vector<const Trail*>& servedBy(const Lift& l);
	void hitFeatures(Skier& s, const Trail& trail, double from, double to);
	void walkToward(Skier& s, double x, double y, double step);
	Vec2 queueSlot(const Skier& s);
	void maybeBubble();
};

} // namespace Ski
