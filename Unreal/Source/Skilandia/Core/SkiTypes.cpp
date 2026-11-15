// Tables from src/types.ts.
#include "SkiTypes.h"

#include <cmath>
#include <initializer_list>

namespace Ski
{

const char* SkierStateName(SkierState s)
{
	switch (s)
	{
	case SkierState::Arriving: return "arriving";
	case SkierState::Booth: return "booth";
	case SkierState::ToLift: return "toLift";
	case SkierState::Queue: return "queue";
	case SkierState::Riding: return "riding";
	case SkierState::ToTrail: return "toTrail";
	case SkierState::Skiing: return "skiing";
	case SkierState::Visit: return "visit";
	case SkierState::Leaving: return "leaving";
	case SkierState::HeliWait: return "heliWait";
	case SkierState::Heli: return "heli";
	}
	return "?";
}

const std::array<PeakDef, 8> kPeaks = {{
	{"hollin", "Hollin Knob", 590 * 14, (1188 - 535) * 14},
	{"ravenhorn", "Ravenhorn", 962 * 14, (1188 - 1052) * 14},
	{"ember", "Little Ember", 1030 * 14, (1188 - 1150) * 14},
	{"corvid", "Corvid Peak", 1383 * 14, (1188 - 873) * 14},
	{"lance", "The Lance", 1418 * 14, (1188 - 840) * 14},
	{"frostmere", "Frostmere", 1462 * 14, (1188 - 968) * 14},
	{"halcyon", "Halcyon Dome", 468 * 14, (1188 - 106) * 14},
	{"kingsfang", "Kingsfang", 1768 * 14, (1188 - 478) * 14},
}};

const std::array<TierDef, 5> kTiers = {{
	{"Local hill", 0, 2000, 10, 500},
	{"Ski area", 1, 6000, 25, 800},
	{"Regional resort", 3, 18000, 40, 1050},
	{"Destination resort", 5, 54000, 70, 1400},
	{"World-class resort", 7, 162000, 110, 1800},
}};

namespace
{
constexpr double E = kEcon;

// Same order as BuildingType.
const std::array<BuildingInfo, kBuildingTypeCount> kBuildings = {{
	{"parkingSmall", "Small parking lot", 450 * E, 18 * E, 20, 0, ""},
	{"parkingLarge", "Large parking lot", 1300 * E, 45 * E, 20, 0, ""},
	{"garage", "Parking garage", 9000 * E, 140 * E, 40, 0, ""},
	{"lodge", "Lodge", 2900 * E, 55 * E, 1, 0, ""},
	{"restroom", "Restroom", 480 * E, 24 * E, 3, 0, ""},
	{"coffee", "Coffee shop", 920 * E, 95 * E, 1, 0, ""},
	{"sandwich", "Sandwich shop", 1050 * E, 140 * E, 1, 0, ""},
	{"shack", "Sugar shack", 620 * E, 42 * E, 8, 0, ""},
	{"cafeteria", "Cafeteria", 1600 * E, 115 * E, 2, 0, ""},
	{"bar", "Apr\xC3\xA8s bar", 2800 * E, 165 * E, 2, 0, ""},
	{"hotel", "Hotel", 12000 * E, 220 * E, 2, 0, ""},
	{"restaurant", "Restaurant", 4800 * E, 175 * E, 2, 0, ""},
	{"shop", "Shop", 3200 * E, 120 * E, 3, 0, ""},
	{"condo", "Condo", 9500 * E, 200 * E, 3, 0, ""},
	{"hostel", "Hostel", 5200 * E, 155 * E, 2, 0, ""},
	{"spa", "Spa", 8500 * E, 185 * E, 1, 0, ""},
	{"patrol", "Ski patrol hut", 1600 * E, 8 * E, 2, 0, ""},
	{"clinic", "First-aid clinic", 2100 * E, 30 * E, 2, 0, ""},
	{"rental", "Ski rental", 2400 * E, 130 * E, 2, 0, ""},
	{"school", "Ski school", 3800 * E, 150 * E, 1, 0, ""},
	{"cabinOffice", "Cabin rental office", 3400 * E, 60 * E, 1, 0, ""},
	{"cabin", "Ski-in cabin", 1500 * E, 75 * E, 30, 0, ""},
	{"heli", "Heli-ski base", 45000 * E, 0, 1, 0, ""},
	{"lookout", "Scenic lookout", 1800 * E, 30 * E, 6, 0.07,
		"A timber deck with fire pits and benches. Skiers off a nearby lift stop to warm up and take in the view. Higher is better."},
	{"pizza", "Pizzeria", 1300 * E, 150 * E, 2, 0.09, "Wood-fired slices. Fast and filling."},
	{"burger", "Burger joint", 1150 * E, 135 * E, 2, 0.08, "Burgers and fries, cheap and quick."},
	{"bakery", "Bakery", 980 * E, 105 * E, 1, 0.07, "Croissants and cinnamon buns for the morning crowd."},
	{"noodle", "Noodle bar", 1400 * E, 155 * E, 1, 0.08, "Hot ramen bowls warm up cold skiers."},
	{"foodTruck", "Food truck", 700 * E, 70 * E, 6, 0, "Parks anywhere: village, roadside or right beside a run."},
	{"waffle", "Waffle hut", 760 * E, 58 * E, 6, 0.06, "Tiny hut on the mountain. Goes beside a run."},
	{"fondue", "Fondue st\xC3\xBC" "bli", 5600 * E, 215 * E, 1, 0.12, "Melted cheese by candlelight. Guests linger."},
	{"steakhouse", "Steakhouse", 7200 * E, 260 * E, 1, 0.11, "Big plates, big checks."},
	{"sushi", "Sushi bar", 6400 * E, 240 * E, 1, 0.1, "Upscale, and the ski-trip treat."},
	{"brewpub", "Brewpub", 4600 * E, 190 * E, 1, 0.1, "House beer and apr\xC3\xA8s crowds."},
	{"summit", "Summit restaurant", 14000 * E, 380 * E, 3, 0.16, "Panoramic dining up the mountain, away from the village."},
	{"skiShop", "Ski & board shop", 2600 * E, 125 * E, 2, 0.09, "Tunes, wax and new gear."},
	{"gifts", "Gift shop", 1400 * E, 70 * E, 2, 0.05, "Mugs, hats and postcards."},
	{"grocery", "Village market", 2200 * E, 105 * E, 1, 0.07, "Groceries for guests in condos and cabins."},
	{"outfitter", "Outdoor outfitter", 4400 * E, 170 * E, 1, 0.07, "Jackets, skins and backcountry kit."},
	{"chocolate", "Chocolatier", 2900 * E, 135 * E, 1, 0.06, "Hot chocolate and truffles."},
	{"boutique", "Fashion boutique", 5200 * E, 190 * E, 2, 0.07, "Designer ski wear. High margins."},
	{"motel", "Motel", 3600 * E, 110 * E, 2, 0.08, "Cheap rooms by the road."},
	{"bnb", "Bed & breakfast", 2800 * E, 95 * E, 3, 0.08, "Cosy rooms in a family house."},
	{"inn", "Mountain inn", 7400 * E, 175 * E, 2, 0.11, "Timber inn with a big fireplace."},
	{"boutiqueHotel", "Boutique hotel", 16000 * E, 290 * E, 2, 0.13, "Small, stylish and pricey."},
	{"grandHotel", "Grand hotel", 38000 * E, 600 * E, 1, 0.2, "A landmark: hundreds of rooms and the best views."},
}};

using BT = BuildingType;

bool In(std::initializer_list<BT> list, BT t)
{
	for (BT x : list)
		if (x == t) return true;
	return false;
}

const ParkingSpec kParkingSmall{120, 300, 44, 30, 27, 0.12};
const ParkingSpec kParkingLarge{400, 1000, 84, 52, 48, 0.1};
const ParkingSpec kGarage{2000, 5000, 62, 42, 37, 0.2};

const std::array<LiftSpec, kLiftTypeCount> kLiftSpecs = {{
	{"carpet", "Magic carpet", "Carpet", 1, 20, 7, 500, 3, 40, 150, true, 0.2, 0,
		"Conveyor belt for beginners. Short, and only up gentle green terrain."},
	{"tbar", "T-bar", "T-bar", 2, 60, 30, 1400, 3, 150, 1300, true, 0.45, 9,
		"Drags two skiers up the snow. The ground has to climb the whole way."},
	{"double", "Double chair", "Double", 2, 75, 30, 3500, 5, 200, 2200, false, 9, 15,
		"Classic two-seat chair. Flies over any terrain."},
	{"quad", "Quad chair", "Quad", 4, 95, 36, 6000, 7, 250, 2800, false, 9, 17,
		"Four across, faster haul. Shorter lift lines."},
	{"six", "Covered six-pack", "Six-pack", 6, 115, 42, 10000, 9, 300, 3500, false, 9, 19,
		"Six-seat chair with a bubble cover. Happy, warm skiers."},
	{"gondola", "8-person gondola", "Gondola", 8, 140, 54, 16000, 12, 400, 6500, false, 9, 24,
		"Enclosed eight-seat cabins. The fastest, longest lift."},
}};

const std::array<TrailKindSpec, kTrailKindCount> kTrailKinds = {{
	{"slope", "Groomed slope", "A regular groomed run.", 1, 1, 10, 0},
	{"slalom", "Slalom course", "Gates down the run. Racers love it.", 1.3, 0.9, 10, 0},
	{"moguls", "Mogul run", "Left ungroomed. Bumps rate it one notch harder.", 1.15, 0.72, 10, 1},
	{"park", "Terrain park", "Wide run for jumps, rails, boxes and a halfpipe.", 1.5, 0.85, 18, 0},
	{"glades", "Glades", "Draw it through the forest: trees are thinned, not cleared. Tree skiing rates one notch harder.", 0.7, 0.65, 26, 1},
}};

const std::array<FeatureSpec, kFeatureTypeCount> kFeatures = {{
	{"jump", "Jump", 300 * E, false, "A kicker. Goes on any run " SKI_DASH " slope, park, glades, anything."},
	{"rail", "Rail", 450 * E, true, "Grind rail. Terrain parks only."},
	{"box", "Box", 350 * E, true, "Wide fun-box. Terrain parks only."},
	{"halfpipe", "Halfpipe", 2400 * E, true, "A big pipe. Terrain parks only."},
}};
} // namespace

const BuildingInfo& Info(BuildingType t) { return kBuildings[static_cast<int>(t)]; }

std::optional<BuildingType> BuildingFromId(const std::string& id)
{
	for (int i = 0; i < kBuildingTypeCount; i++)
		if (id == kBuildings[i].id) return static_cast<BuildingType>(i);
	return std::nullopt;
}

const ParkingSpec* Parking(BuildingType t)
{
	switch (t)
	{
	case BT::ParkingSmall: return &kParkingSmall;
	case BT::ParkingLarge: return &kParkingLarge;
	case BT::Garage: return &kGarage;
	default: return nullptr;
	}
}

double BuildingRadius(BuildingType t)
{
	if (const ParkingSpec* p = Parking(t)) return p->radius;
	if (t == BT::Heli) return 40;
	if (t == BT::GrandHotel) return 32;
	if (t == BT::Cabin || t == BT::Lookout) return 24;
	if (t == BT::FoodTruck || t == BT::Waffle) return 14;
	return 22;
}

bool PlaceAnywhere(BuildingType t) { return In({BT::Shack, BT::FoodTruck, BT::Lookout}, t); }

bool PlaceMountain(BuildingType t)
{
	return In({BT::Shack, BT::FoodTruck, BT::Waffle, BT::Summit, BT::Patrol, BT::Clinic, BT::Cabin, BT::Lookout}, t);
}

bool Trailside(BuildingType t) { return In({BT::Shack, BT::FoodTruck, BT::Waffle}, t); }

const std::vector<BuildingType> kFoodBuildings = {
	BT::Coffee, BT::Sandwich, BT::Shack, BT::Cafeteria, BT::Bar, BT::Restaurant, BT::Pizza, BT::Burger, BT::Bakery,
	BT::Noodle, BT::FoodTruck, BT::Waffle, BT::Fondue, BT::Steakhouse, BT::Sushi, BT::Brewpub, BT::Summit,
};

const std::vector<BuildingType> kShopBuildings = {
	BT::Shop, BT::SkiShop, BT::Gifts, BT::Grocery, BT::Outfitter, BT::Chocolate, BT::Boutique,
};

bool IsFood(BuildingType t)
{
	for (BT x : kFoodBuildings)
		if (x == t) return true;
	return false;
}

bool IsShop(BuildingType t)
{
	for (BT x : kShopBuildings)
		if (x == t) return true;
	return false;
}

bool IsLodging(BuildingType t)
{
	return IsShop(t) ||
		In({BT::Hotel, BT::Condo, BT::Hostel, BT::Motel, BT::Bnb, BT::Inn, BT::BoutiqueHotel, BT::GrandHotel, BT::Spa, BT::Cabin}, t);
}

int UnlockTier(BuildingType t)
{
	// A few landmark buildings need a bigger resort than the first peak gives.
	if (t == BT::BoutiqueHotel || t == BT::Summit) return 2;
	if (t == BT::GrandHotel) return 3;
	const bool expansion = In({BT::Garage, BT::Steakhouse, BT::Sushi, BT::Fondue, BT::Brewpub, BT::Summit, BT::Outfitter,
								  BT::Chocolate, BT::Boutique, BT::Inn, BT::BoutiqueHotel, BT::GrandHotel, BT::Hotel,
								  BT::Restaurant, BT::Shop, BT::Condo, BT::Hostel, BT::Spa, BT::Bar, BT::Patrol},
		t);
	return expansion ? 1 : 0;
}

const std::array<StaffRole, kStaffRoleCount> kStaffRoles = {
	StaffRole::Patrol, StaffRole::Instructor, StaffRole::Food, StaffRole::Lift, StaffRole::Delivery, StaffRole::Maintenance,
};

const char* StaffLabel(StaffRole r)
{
	switch (r)
	{
	case StaffRole::Patrol: return "Ski patrol";
	case StaffRole::Food: return "Food service";
	case StaffRole::Lift: return "Lift attendants";
	case StaffRole::Delivery: return "Delivery";
	case StaffRole::Maintenance: return "Maintenance";
	case StaffRole::Instructor: return "Ski instructors";
	default: return "?";
	}
}

double StaffWagePerMin(StaffRole r)
{
	switch (r)
	{
	case StaffRole::Patrol: return 18 * E;
	case StaffRole::Food: return 14 * E;
	case StaffRole::Lift: return 16 * E;
	case StaffRole::Delivery: return 12 * E;
	case StaffRole::Maintenance: return 15 * E;
	case StaffRole::Instructor: return 15 * E;
	default: return 0;
	}
}

const std::array<DiffInfo, 4> kDiff = {{
	{"Green", "#3cb172"},
	{"Blue", "#3b82d6"},
	{"Black", "#1b1b1b"},
	{"Double black", "#0d0d0d"},
}};

const LiftSpec& Spec(LiftType t) { return kLiftSpecs[static_cast<int>(t)]; }

double LiftCost(LiftType t, double length)
{
	const LiftSpec& s = Spec(t);
	return std::floor(((s.baseCost + s.costPerUnit * length) * kEcon) / 100 + 0.5) * 100;
}

const TrailKindSpec& Spec(TrailKind k) { return kTrailKinds[static_cast<int>(k)]; }

const FeatureSpec& Spec(FeatureType f) { return kFeatures[static_cast<int>(f)]; }

double OperatingCostPerMin(BuildingType t) { return t == BT::Heli ? 150 * kEcon : 0; }

const std::array<const char*, kJacketCount> kJackets = {
	"#c45c4a", "#3a6ea5", "#d98a2b", "#4f8a5b", "#7a4ea3", "#2c3d4f", "#d15a7c", "#1f6f8b",
};

} // namespace Ski
