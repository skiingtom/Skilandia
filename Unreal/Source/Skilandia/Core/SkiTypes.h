// Skilandia simulation core: shared types, tables and constants.
//
// Port of src/types.ts. Plain C++20 with no Unreal dependencies, so the same
// code runs inside the game and in the headless test (Unreal/CoreTests).
//
// Map coordinates: 1 unit = 1 metre, x runs east, y runs north, as in the web
// game. Elevation is in metres above sea level unless a name says otherwise.
//
// Unreal defines macros such as PI, check, verify, ensure and DELTA, so names
// here avoid them. Non-ASCII text is written as UTF-8 byte escapes so it
// compiles the same whatever the compiler's source character set is.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace Ski
{

constexpr double kPi = 3.14159265358979323846;

// UTF-8 punctuation used in game text.
#define SKI_DOT "\xC2\xB7"    // middle dot
#define SKI_DASH "\xE2\x80\x94" // em dash
#define SKI_LQUOTE "\xE2\x80\x9C"
#define SKI_RQUOTE "\xE2\x80\x9D"

struct Vec2
{
	double x = 0;
	double y = 0;
};

/** 0 green, 1 blue, 2 black, 3 double black. */
using Difficulty = int;

enum class BuildingType : uint8_t
{
	ParkingSmall,
	ParkingLarge,
	Garage,
	Lodge,
	Restroom,
	Coffee,
	Sandwich,
	Shack,
	Cafeteria,
	Bar,
	Hotel,
	Restaurant,
	Shop,
	Condo,
	Hostel,
	Spa,
	Patrol,
	Clinic,
	Rental,
	School,
	CabinOffice,
	Cabin,
	Heli,
	Lookout,
	// Quick bites
	Pizza,
	Burger,
	Bakery,
	Noodle,
	FoodTruck,
	Waffle,
	// Restaurants
	Fondue,
	Steakhouse,
	Sushi,
	Brewpub,
	Summit,
	// Shops
	SkiShop,
	Gifts,
	Grocery,
	Outfitter,
	Chocolate,
	Boutique,
	// Hotels
	Motel,
	Bnb,
	Inn,
	BoutiqueHotel,
	GrandHotel,
	Count
};
constexpr int kBuildingTypeCount = static_cast<int>(BuildingType::Count);

enum class LiftType : uint8_t { Carpet, TBar, Double, Quad, Six, Gondola, Count };
constexpr int kLiftTypeCount = static_cast<int>(LiftType::Count);

enum class TrailKind : uint8_t { Slope, Slalom, Moguls, Park, Glades, Count };
constexpr int kTrailKindCount = static_cast<int>(TrailKind::Count);

enum class FeatureType : uint8_t { Jump, Rail, Box, Halfpipe, Count };
constexpr int kFeatureTypeCount = static_cast<int>(FeatureType::Count);

enum class StaffRole : uint8_t { Patrol, Food, Lift, Delivery, Maintenance, Instructor, Count };
constexpr int kStaffRoleCount = static_cast<int>(StaffRole::Count);

enum class SkierState : uint8_t
{
	Arriving,
	Booth,
	ToLift,
	Queue,
	Riding,
	ToTrail,
	Skiing,
	Visit,
	Leaving,
	HeliWait,
	Heli
};

const char* SkierStateName(SkierState s);

/** What a click on the map does. */
enum class ToolKind : uint8_t
{
	Select,
	/** Cutting a run (of Game::trailKind). */
	Cut,
	Road,
	Path,
	Demolish,
	ClearTrees,
	PlantTrees,
	Shape,
	Move,
	/** Placing a building of `building`. */
	Build,
	/** Placing a lift of `lift`. */
	Lift,
	/** Placing a park feature of `feature`. */
	Feature,
	/** Only passed to Game::setTool: start cutting a run of `trail`. Becomes Cut. */
	Trail
};

struct Tool
{
	ToolKind kind = ToolKind::Select;
	BuildingType building = BuildingType::Lodge;
	LiftType lift = LiftType::Quad;
	TrailKind trail = TrailKind::Slope;
	FeatureType feature = FeatureType::Jump;

	static Tool Of(ToolKind k)
	{
		Tool t;
		t.kind = k;
		return t;
	}
	static Tool Build(BuildingType b)
	{
		Tool t;
		t.kind = ToolKind::Build;
		t.building = b;
		return t;
	}
	static Tool ForLift(LiftType l)
	{
		Tool t;
		t.kind = ToolKind::Lift;
		t.lift = l;
		return t;
	}
	static Tool ForTrail(TrailKind k)
	{
		Tool t;
		t.kind = ToolKind::Trail;
		t.trail = k;
		return t;
	}
	static Tool ForFeature(FeatureType f)
	{
		Tool t;
		t.kind = ToolKind::Feature;
		t.feature = f;
		return t;
	}
};

struct Trail
{
	int id = 0;
	std::string name;
	std::vector<Vec2> points;
	Difficulty difficulty = 0;
	double length = 0;
	/** Normalised drop (multiply by kVerticalM for metres). */
	double drop = 0;
	TrailKind kind = TrailKind::Slope;
};

/** A terrain-park feature or jump sitting on the snow. */
struct Feature
{
	int id = 0;
	FeatureType type = FeatureType::Jump;
	double x = 0;
	double y = 0;
	/** Direction skiers travel over it (radians, in map x/y). */
	double angle = 0;
	std::optional<int> trailId;
};

struct Carrier
{
	double t = 0;
	std::vector<int> riders;
};

struct Lift
{
	int id = 0;
	LiftType type = LiftType::TBar;
	std::string name;
	Vec2 bottom;
	Vec2 top;
	std::vector<Carrier> carriers;
};

struct Building
{
	int id = 0;
	BuildingType type = BuildingType::Lodge;
	double x = 0;
	double y = 0;
	double earnAcc = 0;
	double earnTimer = 0;
	/** Facing (radians in map x/y): parking lines up with the road it opens onto. */
	std::optional<double> angle;
};

struct Skier
{
	int id = 0;
	/** Where this skier parked: they arrive from here and walk back to leave. */
	Vec2 lot;
	std::string name;
	Difficulty skill = 0;
	/** Jacket colour, index into kJackets. */
	int color = 0;
	double x = 0;
	double y = 0;
	SkierState state = SkierState::Arriving;
	/** A run id, or minus a carpet's lift id for its bunny slope. */
	std::optional<int> trailId;
	std::optional<int> liftId;
	double rideT = 0;
	/** Favourite kind of run. */
	TrailKind likes = TrailKind::Slope;
	/** Seconds of airtime left after hitting a jump or feature. */
	double air = 0;
	bool lesson = false;
	/** Already flown a heli-ski trip today. */
	bool heliDone = false;
	/** Game time the skier joined their current lift line (first come, first served). */
	double joinT = 0;
	double dist = 0;
	double wait = 0;
	int runsLeft = 0;
	int runsDone = 0;
	double mood = 0;
	bool paid = false;
	double needBath = 0;
	double needFood = 0;
	std::optional<BuildingType> visitType;
	/** Speech bubble text; empty for none. */
	std::string bubble;
	double bubbleT = 0;
	/** Already stopped at a lookout today. */
	bool sawView = false;
	/** Footpath waypoints still to walk, and the destination they lead to. */
	std::optional<std::vector<Vec2>> route;
	std::string routeFor;
	/** Walking along a footpath right now. */
	bool onPath = false;
};

/** A floating money / text label over the map. */
struct Fx
{
	double x = 0;
	double y = 0;
	std::string text;
	double life = 0;
	/** "#rrggbb" */
	std::string color;
};

struct Toast
{
	int id = 0;
	std::string text;
	bool bad = false;
	double life = 0;
};

struct Goal
{
	std::string id;
	std::string text;
	bool done = false;
};

// ---------- the map

constexpr int kTerrainCols = 1000;
constexpr int kTerrainRows = 594;
/** Metres per heightmap cell. */
constexpr double kTerrainCellM = 28.0;

constexpr double kUnitM = 1;
constexpr double kWorldW = kTerrainCols * kTerrainCellM;
constexpr double kWorldH = kTerrainRows * kTerrainCellM;
/** Elevation 0 in normalised units is this many metres above sea level... */
constexpr double kBaseElevM = 500;
/** ...and elevation 1 is this much higher. */
constexpr double kVerticalM = 2300;

/** Where the resort starts: the valley floor by the lake. */
constexpr Vec2 kBase{13650, 7672};

struct PeakDef
{
	const char* id;
	const char* name;
	double x;
	double y;
};
extern const std::array<PeakDef, 8> kPeaks;

/** A lift top this close to a summit (and nearly as high) conquers it. */
constexpr double kConquerRadiusM = 350;
constexpr double kConquerDropM = 150;

struct TierDef
{
	const char* name;
	int peaksNeeded;
	int capacity;
	int maxLifts;
	double villageRadius;
};
extern const std::array<TierDef, 5> kTiers;

/** Money scale: every price, wage, running cost and unlock goal is multiplied by this. */
constexpr double kEcon = 10;

constexpr double kStartMoney = 2200 * kEcon;
constexpr double kStartTicket = 42;

// ---------- buildings

struct BuildingInfo
{
	const char* id;
	const char* label;
	/** Price (already scaled by kEcon). */
	double cost;
	/** Dollars per minute at a busy hill (already scaled by kEcon). */
	double incomePerMin;
	int max;
	/** How much each kind adds to the resort's appeal (repeats add nothing). */
	double appeal;
	/** One line for the build menu, or "". */
	const char* blurb;
};

const BuildingInfo& Info(BuildingType t);
inline double Cost(BuildingType t) { return Info(t).cost; }
inline const char* Label(BuildingType t) { return Info(t).label; }
/** Building type from its web-game id ("lodge", "foodTruck"...). */
std::optional<BuildingType> BuildingFromId(const std::string& id);

/**
 * Parking: how many skiers' cars each holds, its footprint (w x d metres, long
 * side along the road), how far it reaches and the steepest ground it can be
 * graded into.
 */
struct ParkingSpec
{
	int cars;
	int skiers;
	double w;
	double d;
	double radius;
	double maxGrade;
};
/** nullptr unless the type is a parking lot or garage. */
const ParkingSpec* Parking(BuildingType t);
/** The lot the resort starts with, by the ticket booth. */
constexpr int kStarterLotSkiers = 400;

/** How far around a building trees are cleared and other things kept off. */
double BuildingRadius(BuildingType t);

bool PlaceAnywhere(BuildingType t);
bool PlaceMountain(BuildingType t);
/** Small enough to sit right beside a run. */
bool Trailside(BuildingType t);
/** Places skiers visit when hungry. */
bool IsFood(BuildingType t);
extern const std::vector<BuildingType> kFoodBuildings;
/** Places skiers browse on their way back to the car. */
bool IsShop(BuildingType t);
extern const std::vector<BuildingType> kShopBuildings;
/** Overnight / lodging stock that drives delivery staffing. */
bool IsLodging(BuildingType t);

/** A cabin is ski-in / ski-out when a run passes this close (m). */
constexpr double kCabinReach = 60;

/** The resort tier (index into kTiers) a building type unlocks at. */
int UnlockTier(BuildingType t);

// ---------- staff

/** In the order the web game lists them. */
extern const std::array<StaffRole, kStaffRoleCount> kStaffRoles;
const char* StaffLabel(StaffRole r);
/** Scaled by kEcon. */
double StaffWagePerMin(StaffRole r);

// ---------- runs, lifts, features

struct DiffInfo
{
	const char* name;
	const char* color;
};
extern const std::array<DiffInfo, 4> kDiff;

struct LiftSpec
{
	const char* id;
	const char* label;
	const char* shortName;
	/** Riders per carrier (chair, bar, cabin). A carpet carries one per slot. */
	int seats;
	/** Metres per second. */
	double speed;
	/** Metres between carriers. */
	double spacing;
	double baseCost;
	double costPerUnit;
	double minLength;
	double maxLength;
	/** Surface lifts drag skiers over the snow: the ground must climb the whole way. */
	bool surface;
	/** Steepest pitch the line may cross (drop m / run m). */
	double maxGrade;
	/** Height of cable / chairs above the ground at towers. */
	double towerH;
	const char* blurb;
};
const LiftSpec& Spec(LiftType t);
double LiftCost(LiftType t, double length);

struct TrailKindSpec
{
	const char* id;
	const char* label;
	const char* blurb;
	double costMul;
	double speedMul;
	double width;
	int diffBump;
};
const TrailKindSpec& Spec(TrailKind k);

struct FeatureSpec
{
	const char* id;
	const char* label;
	/** Scaled by kEcon. */
	double cost;
	bool parkOnly;
	const char* blurb;
};
const FeatureSpec& Spec(FeatureType f);

/** Fee to move a building, as a share of its price. */
constexpr double kMoveFee = 0.25;

/** Running costs per minute, charged whether busy or not (scaled by kEcon). */
double OperatingCostPerMin(BuildingType t);

/** Heli-skiing: seats per flight, fare per seat, fuel per flight; times are game seconds. */
struct HeliSpec
{
	int seats = 8;
	double fare = 650;
	double fuelPerFlight = 600;
	/** Seconds the drop-and-ski trip lasts (out of sight, off the map). */
	double tripTime = 30;
	/** Seconds the pilot waits for a full load before going with fewer. */
	double maxWait = 10;
};
constexpr HeliSpec kHeli{};

/** Skier jacket colours ("#rrggbb"). */
constexpr int kJacketCount = 8;
extern const std::array<const char*, kJacketCount> kJackets;

} // namespace Ski
