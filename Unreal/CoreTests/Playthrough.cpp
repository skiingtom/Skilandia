/**
 * Headless playthrough of the C++ simulation core on the real map. A port of
 * tests/playthrough.ts: build one of everything around the starter T-bar, run
 * the sim for 30 game minutes checking invariants every tick, then make sure
 * every peak can be conquered and the game can be won.
 *
 * Run with: Unreal/CoreTests/run.sh
 */
#include "SkiGame.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

using namespace Ski;

namespace
{
std::vector<std::string> problems;

void ok(bool cond, const std::string& msg)
{
	if (!cond && problems.size() < 30) problems.push_back(msg);
}

std::string lastToast(const Game& g) { return g.toasts.empty() ? std::string("(no toast)") : g.toasts.back().text; }

std::string fmt(double v, int digits = 1)
{
	char buf[64];
	std::snprintf(buf, sizeof buf, "%.*f", digits, v);
	return buf;
}

BuildingType B(const char* id) { return *BuildingFromId(id); }
} // namespace

int main(int argc, char** argv)
{
	const std::string terrain = argc > 1 ? argv[1] : "Unreal/Content/Data/Terrain.u16";
	if (!LoadTerrainFile(terrain))
	{
		std::fprintf(stderr, "Couldn't load %s (run from the repository root, or pass the path)\n", terrain.c_str());
		return 2;
	}
	Game g;
	g.startManaging();
	g.money = 1e9;

	// --- the starter resort
	const Lift tbar = g.lifts[0];
	ok(g.lifts.size() == 1 && tbar.type == LiftType::TBar, "should start with one T-bar");
	ok(g.trails.size() >= 2, "should start with runs beside the T-bar");

	// --- the access road: nobody drives in until the parking lot reaches the highway
	ok(!g.roadConnected(), "parking lot should start unconnected");
	const size_t before = g.skiers.size();
	for (int i = 0; i < 600; i++) g.tick(0.05);
	ok(g.skiers.size() <= before, "skiers arrived with no road");
	{
		const Vec2 exit = g.exit();
		const Vec2 hw = NearestOnPolyline(g.roads[0].points, exit.x, exit.y).p;
		g.setTool(Tool::Of(ToolKind::Road));
		ok(g.click(hw.x, hw.y) == ClickResult::Ok, "road should start on the highway");
		// Two legs: halfway, then the parking lot (which finishes it).
		g.click((hw.x + exit.x) / 2, (hw.y + exit.y) / 2);
		const ClickResult r = g.click(exit.x, exit.y);
		ok(r == ClickResult::Ok && g.roadConnected(), "access road failed: " + lastToast(g));
		const auto route = g.carRoute();
		std::printf("access road: %s route pts %zu\n", lastToast(g).c_str(), route ? route->size() : 0);
	}

	// --- parking: lots go beside a connected road and add room for skiers
	{
		ok(g.parkingCapacity() == kStarterLotSkiers, "starter parking should hold 400, got " + std::to_string(g.parkingCapacity()));
		auto spotBeside = [&g](BuildingType type, size_t roadIndex) -> std::optional<Vec2> {
			const Road r = g.roads[roadIndex];
			const double R = Parking(type)->radius;
			for (size_t i = 1; i < r.points.size(); i++)
			{
				const Vec2 a = r.points[i - 1];
				const Vec2 b = r.points[i];
				double len = std::hypot(b.x - a.x, b.y - a.y);
				if (len == 0) len = 1;
				for (double t : {0.5, 0.25, 0.75})
				{
					for (double side : {1.0, -1.0})
					{
						const Vec2 p{a.x + (b.x - a.x) * t - ((b.y - a.y) / len) * (R + 8) * side,
							a.y + (b.y - a.y) * t + ((b.x - a.x) / len) * (R + 8) * side};
						if (!g.canPlace(type, p.x, p.y)) return p;
					}
				}
			}
			return std::nullopt;
		};
		size_t access = 0;
		for (size_t i = 0; i < g.roads.size(); i++)
			if (!g.roads[i].highway)
			{
				access = i;
				break;
			}
		std::optional<Vec2> spot = spotBeside(B("parkingSmall"), access);
		if (!spot) spot = spotBeside(B("parkingSmall"), 0);
		ok(spot.has_value(), "no room for a small lot beside the roads");
		if (spot)
		{
			g.setTool(Tool::Build(B("parkingSmall")));
			ok(g.click(spot->x, spot->y) == ClickResult::Ok, "small lot failed: " + lastToast(g));
			ok(g.parkingCapacity() == kStarterLotSkiers + Parking(B("parkingSmall"))->skiers, "parking didn't grow: " + std::to_string(g.parkingCapacity()));
			ok(g.buildings.back().angle.has_value(), "lot should line up with the road");
		}
		// Away from any road: refused.
		const Vec2 far{kBase.x + 2500, kBase.y - 2500};
		ok(g.canPlace(B("parkingSmall"), far.x, far.y).has_value(), "a lot with no road beside it should be refused");
		// On top of the road: refused.
		const Vec2 onRoad = g.roads[access].points[1];
		ok(g.canPlace(B("parkingLarge"), onRoad.x, onRoad.y).has_value(), "a lot on the road itself should be refused");
		// The garage waits for the first peak.
		ok(!g.expansionUnlocked() && g.canPlace(B("garage"), kBase.x, kBase.y).has_value(), "garage should be locked at first");
		// Skiers park at the new lot too, and the limit holds.
		for (int i = 0; i < 3000; i++) g.tick(0.05);
		ok(static_cast<int>(g.skiers.size()) <= g.loadLimits().parking + 25,
			"more skiers (" + std::to_string(g.skiers.size()) + ") than parking (" + std::to_string(g.loadLimits().parking) + ")");
		if (spot)
		{
			bool parkedThere = false;
			for (const Skier& s : g.skiers)
				if (std::hypot(s.lot.x - spot->x, s.lot.y - spot->y) < 1) parkedThere = true;
			ok(parkedThere, "nobody parked in the new lot");
			// Demolish it: capacity drops back, and its parkers still find their car.
			g.setTool(Tool::Of(ToolKind::Demolish));
			ok(g.click(spot->x, spot->y) == ClickResult::Ok, "couldn't demolish the lot: " + lastToast(g));
			ok(g.parkingCapacity() == kStarterLotSkiers, "capacity didn't drop after demolishing the lot");
		}
	}
	const Vec2 la = tbar.bottom;
	const Vec2 lb = tbar.top;
	const double len = std::hypot(lb.x - la.x, lb.y - la.y);
	const double ux = (lb.x - la.x) / len;
	const double uy = (lb.y - la.y) / len;
	/** A point along the T-bar line (t: 0 bottom..1 top), pushed sideways by `side` metres. */
	auto along = [&](double t, double side) { return Vec2{la.x + (lb.x - la.x) * t - uy * side, la.y + (lb.y - la.y) * t + ux * side}; };

	auto cut = [&g](TrailKind kind, const std::vector<Vec2>& pts) {
		g.setTool(Tool::ForTrail(kind));
		for (const Vec2& p : pts) g.click(p.x, p.y);
		const ClickResult r = g.finishTrail();
		std::printf("cut %s: %s %s\n", Spec(kind).id, r == ClickResult::Ok ? "ok" : "shake", r == ClickResult::Ok ? "" : lastToast(g).c_str());
		return r;
	};

	cut(TrailKind::Park, {along(1, 220), along(0.6, 260), along(0.25, 240), along(0.02, 200)});
	cut(TrailKind::Slalom, {along(1, -220), along(0.6, -260), along(0.2, -240), along(0.02, -200)});
	cut(TrailKind::Moguls, {along(0.95, 380), along(0.5, 400), along(0.05, 360)});
	// Glades: through the forest further out.
	const ClickResult gladesOk = cut(TrailKind::Glades, {along(0.95, -420), along(0.6, -460), along(0.25, -440), along(0.05, -380)});
	ok(gladesOk == ClickResult::Ok, "glades should cut through forest");

	const Trail* park = nullptr;
	for (const Trail& t : g.trails)
		if (t.kind == TrailKind::Park) park = &t;
	ok(park != nullptr, "park run was not created");
	if (park)
	{
		// Upper part of the park, well above the village.
		const Vec2 a = park->points[0];
		const Vec2 b = park->points[1];
		const std::pair<FeatureType, double> feats[] = {
			{FeatureType::Jump, 0.1}, {FeatureType::Rail, 0.3}, {FeatureType::Box, 0.45}, {FeatureType::Halfpipe, 0.75}};
		for (const auto& [type, u] : feats)
		{
			g.setTool(Tool::ForFeature(type));
			const ClickResult r = g.click(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u);
			ok(r == ClickResult::Ok, std::string(Spec(type).id) + " in the park failed: " + lastToast(g));
		}
	}
	ok(g.canPlaceFeature(FeatureType::Jump, kBase.x + 3000, kBase.y - 3000).has_value(), "off-run jump should be rejected");

	// Village buildings around the base
	const std::tuple<const char*, double, double> spots[] = {
		{"lodge", 150, 120}, {"restroom", -150, 60}, {"coffee", 200, -40}, {"school", -220, -120},
		{"rental", -80, 140}, {"cafeteria", 80, -160}, {"heli", 260, 260},
	};
	for (const auto& [type, dx, dy] : spots)
	{
		g.setTool(Tool::Build(B(type)));
		const ClickResult r = g.click(kBase.x + dx, kBase.y + dy);
		ok(r == ClickResult::Ok, std::string(type) + " in the village failed: " + lastToast(g));
	}
	// Clinic sits on the mountain, outside the village ring.
	{
		const Lift& t = g.lifts[0];
		const Vec2 mid{(t.bottom.x + t.top.x) / 2 + 90, (t.bottom.y + t.top.y) / 2};
		g.setTool(Tool::Build(B("clinic")));
		ok(g.click(mid.x, mid.y) == ClickResult::Ok, "clinic on the mountain failed: " + lastToast(g));
	}
	// Cabins: need the rental office, and a run at the door.
	{
		g.setTool(Tool::Build(B("cabin")));
		const auto first = g.canPlace(B("cabin"), kBase.x + 3000, kBase.y - 3000);
		ok(first && first->find("office") != std::string::npos, "cabin should need the rental office first");
		g.setTool(Tool::Build(B("cabinOffice")));
		ok(g.click(kBase.x + 60, kBase.y - 230) == ClickResult::Ok, "cabin office failed: " + lastToast(g));
		// Find a spot beside a run, out of the village.
		std::optional<Vec2> spot;
		for (const Trail& t : g.trails)
		{
			for (size_t i = 1; i < t.points.size() && !spot; i++)
			{
				const Vec2 a = t.points[i - 1];
				const Vec2 b = t.points[i];
				double l = std::hypot(b.x - a.x, b.y - a.y);
				if (l == 0) l = 1;
				for (double u : {0.2, 0.5, 0.8})
				{
					for (double off : {25.0, 35.0, 45.0, -25.0, -35.0, -45.0})
					{
						const Vec2 p{a.x + (b.x - a.x) * u - ((b.y - a.y) / l) * off, a.y + (b.y - a.y) * u + ((b.x - a.x) / l) * off};
						if (!spot && !g.canPlace(B("cabin"), p.x, p.y)) spot = p;
					}
				}
			}
		}
		ok(spot.has_value(), "no hillside spot for a cabin");
		if (spot)
		{
			g.setTool(Tool::Build(B("cabin")));
			ok(g.click(spot->x, spot->y) == ClickResult::Ok, "ski-in cabin failed: " + lastToast(g));
			ok(g.skiInCabins() == 1, "the cabin should count as ski-in / ski-out");
		}
		ok(g.canPlace(B("cabin"), kBase.x + 3000, kBase.y - 3000).has_value(), "a cabin far from any run should be refused");
		g.setTool(Tool::Of(ToolKind::Select));
	}
	// Expansion buildings unlock after the first peak; conquer Hollin first, then place a few.
	{
		const Summit* p = nullptr;
		for (const Summit& s : Summits())
			if (s.id == "hollin") p = &s;
		const double dx = kBase.x - p->x;
		const double dy = kBase.y - p->y;
		const double d = std::hypot(dx, dy);
		const Vec2 bottom{p->x + (dx / d) * 2500, p->y + (dy / d) * 2500};
		const Vec2 top{p->x + (dx / d) * 40, p->y + (dy / d) * 40};
		g.setTool(Tool::ForLift(LiftType::Gondola));
		g.click(bottom.x, bottom.y);
		ok(g.click(top.x, top.y) == ClickResult::Ok, "early gondola to Hollin failed: " + lastToast(g));
		ok(g.conquered.count("hollin") == 1, "Hollin should unlock expansion buildings");
	}
	const std::tuple<const char*, double, double> expansionSpots[] = {{"bar", -280, 40}, {"hostel", 320, -80}, {"spa", -40, 220}};
	for (const auto& [type, dx, dy] : expansionSpots)
	{
		g.setTool(Tool::Build(B(type)));
		const ClickResult r = g.click(kBase.x + dx, kBase.y + dy);
		ok(r == ClickResult::Ok, std::string(type) + " after first peak failed: " + lastToast(g));
	}
	// New food, restaurants, shops and hotels: find room for each one in the village.
	{
		auto place = [&g](BuildingType type) {
			for (double r = 120; r <= 480; r += 30)
			{
				for (double a = 0; a < kPi * 2; a += kPi / 16)
				{
					const double x = kBase.x + std::cos(a) * r;
					const double y = kBase.y + std::sin(a) * r;
					if (!g.canPlace(type, x, y))
					{
						g.setTool(Tool::Build(type));
						return g.click(x, y) == ClickResult::Ok;
					}
				}
			}
			return false;
		};
		for (const char* type : {"pizza", "burger", "bakery", "noodle", "foodTruck", "fondue", "brewpub", "sushi", "skiShop", "gifts",
				 "grocery", "boutique", "motel", "bnb", "inn"})
			ok(place(B(type)), std::string(type) + " in the village failed: " + lastToast(g));
		const auto grand = g.canPlace(B("grandHotel"), kBase.x, kBase.y);
		ok(grand && grand->find("peaks") != std::string::npos, "the grand hotel should wait for a regional resort");
		const auto summit = g.canPlace(B("summit"), kBase.x + 150, kBase.y);
		ok(summit && summit->find("peaks") != std::string::npos, "the summit restaurant should wait for more peaks");
		const auto waffle = g.canPlace(B("waffle"), kBase.x + 3000, kBase.y - 3000);
		ok(waffle && waffle->find("beside a run") != std::string::npos, "a waffle hut needs a run nearby");
		ok(g.amenityScore() > 1.65, "new places should raise appeal past the old cap (" + fmt(g.amenityScore(), 2) + ")");
	}
	g.hire(StaffRole::Instructor);
	g.hire(StaffRole::Instructor);
	ok(g.helipad() != nullptr, "heli base not built");

	// --- 30 game minutes
	struct Stuck
	{
		SkierState state;
		double t;
	};
	std::map<int, Stuck> stuck;
	std::map<int, double> liftIdle;
	size_t peakSkiers = 0;
	int flights = 0;
	bool wasFlying = false;
	for (int i = 0; i < 36000; i++)
	{
		g.tick(0.05);
		ok(std::isfinite(g.money), "money became " + fmt(g.money));
		peakSkiers = std::max(peakSkiers, g.skiers.size());
		ok(static_cast<int>(g.skiers.size()) <= g.capacity(), "over capacity");
		ok(static_cast<int>(g.skiers.size()) <= g.loadLimits().comfortable + 25,
			"more skiers (" + std::to_string(g.skiers.size()) + ") than the resort can handle (" + std::to_string(g.loadLimits().comfortable) + ")");
		if (i % 200 == 0) ok(g.liftWait() < 90, "lift lines got long: " + fmt(g.liftWait(), 0) + "s");
		if (g.heli.flying && !wasFlying) flights++;
		wasFlying = g.heli.flying;
		for (const Lift& l : g.lifts)
		{
			bool inLine = false, boarding = false;
			for (const Skier& s : g.skiers)
			{
				if (s.liftId != l.id) continue;
				if (s.state == SkierState::Queue) inLine = true;
				if (s.state == SkierState::Riding) boarding = true;
			}
			liftIdle[l.id] = inLine && !boarding ? liftIdle[l.id] + 0.05 : 0;
			ok(liftIdle[l.id] < 30, l.name + " has a line but nobody has boarded for 30s");
		}
		for (const Skier& s : g.skiers)
		{
			ok(std::isfinite(s.x) && std::isfinite(s.y), "skier " + std::to_string(s.id) + " has NaN position in " + SkierStateName(s.state));
			ok(s.mood >= 0 && s.mood <= 100, "skier " + std::to_string(s.id) + " mood out of range: " + fmt(s.mood));
			if (s.state == SkierState::Skiing && s.trailId && *s.trailId >= 0)
			{
				const Trail* t = g.findTrail(*s.trailId);
				const double d = NearestOnTrail(*t, s.x, s.y).d;
				ok(d <= Spec(t->kind).width / 2 + 1, "skier " + std::to_string(s.id) + " is " + fmt(d) + " m off " + Spec(t->kind).id + " run " + t->name);
			}
			auto it = stuck.find(s.id);
			if (it == stuck.end() || it->second.state != s.state) stuck[s.id] = {s.state, 0};
			else
			{
				it->second.t += 0.05;
				if (s.state != SkierState::Queue)
					ok(it->second.t < 150, "skier " + std::to_string(s.id) + " stuck in " + SkierStateName(s.state) + " for " + fmt(it->second.t, 0) + "s");
			}
		}
	}
	std::printf("{ runs: %zu, skiers: %zu, peakSkiers: %zu, comfortable: %d, tickets: %d, heliFlights: %d, mood: %d, forestVersion: %d }\n",
		g.trails.size(), g.skiers.size(), peakSkiers, g.loadLimits().comfortable, g.totalTickets, flights, static_cast<int>(JsRound(g.mood)),
		g.forestVersion);
	ok(g.totalTickets > 100, "hardly anyone came");

	// --- the tree brush: fells standing trees, charges per tree, and they stay gone
	{
		std::optional<Vec2> spot;
		for (int a = 0; a < 36 && !spot; a++)
		{
			for (double d : {700.0, 900.0, 1200.0})
			{
				const Vec2 p{kBase.x + std::cos(a / 5.7) * d, kBase.y + std::sin(a / 5.7) * d};
				if (g.treesUnderBrush(p.x, p.y) > 10)
				{
					spot = p;
					break;
				}
			}
		}
		ok(spot.has_value(), "no forest to test the brush on");
		if (spot)
		{
			const int n = g.treesUnderBrush(spot->x, spot->y);
			const double money = g.money;
			g.setTool(Tool::Of(ToolKind::ClearTrees));
			ok(g.click(spot->x, spot->y) == ClickResult::Ok, "brush should fell trees");
			ok(g.treesUnderBrush(spot->x, spot->y) == 0, "trees still standing under the brush");
			ok(std::fabs(money - g.money - n * 4) < 1, "brush charged " + fmt(money - g.money) + " for " + std::to_string(n) + " trees");
			g.endBrush();

			// Replant the clearing: the area brush scatters saplings, a single click plants one.
			g.setTool(Tool::Of(ToolKind::PlantTrees));
			g.plantMode = PlantMode::Brush;
			const double beforePlant = g.money;
			ok(g.click(spot->x, spot->y) == ClickResult::Ok, "planting brush failed: " + lastToast(g));
			const int planted = g.treesUnderBrush(spot->x, spot->y);
			ok(planted > 0, "planting brush planted nothing");
			ok(std::fabs(beforePlant - g.money - planted * 12) < 1, "planting charged " + fmt(beforePlant - g.money) + " for " + std::to_string(planted) + " trees");
			g.endBrush();
			g.plantMode = PlantMode::Single;
			const Vec2 freeSpot{spot->x + 22, spot->y + 22};
			const size_t nearBefore = g.treesIn(freeSpot.x - 3, freeSpot.y - 3, freeSpot.x + 3, freeSpot.y + 3).size();
			if (g.click(freeSpot.x, freeSpot.y) == ClickResult::Ok)
				ok(g.treesIn(freeSpot.x - 3, freeSpot.y - 3, freeSpot.x + 3, freeSpot.y + 3).size() == nearBefore + 1, "single plant should add one tree");
			// Clearing again digs the planted trees back up.
			g.setTool(Tool::Of(ToolKind::ClearTrees));
			g.click(spot->x, spot->y);
			g.endBrush();
			ok(g.treesUnderBrush(spot->x, spot->y) == 0, "planted trees survived the clearing brush");
			g.setTool(Tool::Of(ToolKind::Select));
		}
	}

	// --- the forest isn't laid out on a grid: tree spacing along a row varies widely
	{
		std::vector<double> xs;
		for (const ForestTree& t : g.treesIn(kBase.x + 2000, kBase.y - 2006, kBase.x + 2600, kBase.y - 1994)) xs.push_back(t.x);
		std::sort(xs.begin(), xs.end());
		std::vector<double> gaps;
		for (size_t i = 1; i < xs.size(); i++) gaps.push_back(xs[i] - xs[i - 1]);
		double mean = 0;
		for (double v : gaps) mean += v;
		mean /= std::max<size_t>(1, gaps.size());
		double var = 0;
		for (double v : gaps) var += (v - mean) * (v - mean);
		const double sd = std::sqrt(var / std::max<size_t>(1, gaps.size()));
		ok(gaps.size() < 5 || sd / mean > 0.5, "forest looks gridded (spacing sd/mean " + fmt(sd / mean, 2) + ")");
	}

	// --- rocks: above the rock line, a run can't be cut straight through an outcrop
	{
		bool found = false;
		for (double x = 2000; x < 26000 && !found; x += 97)
		{
			for (double y = 2000; y < 15000 && !found; y += 89)
			{
				if (!IsRock(x, y) || ElevationM(x, y) < 2100) continue;
				// Snow above and below the outcrop, along the fall line.
				const Vec2 a{x, y - 90};
				const Vec2 b{x, y + 90};
				if (IsRock(a.x, a.y) || IsRock(b.x, b.y)) continue;
				const bool aHigh = ElevationM(a.x, a.y) > ElevationM(b.x, b.y);
				const Vec2 hi = aHigh ? a : b;
				const Vec2 lo = aHigh ? b : a;
				if (ElevationM(hi.x, hi.y) - ElevationM(lo.x, lo.y) < 15) continue;
				found = true;
				g.setTool(Tool::ForTrail(TrailKind::Slope));
				ok(g.click(hi.x, hi.y) == ClickResult::Ok, "run should start on snow");
				ok(g.click(lo.x, lo.y) == ClickResult::Shake, "run went straight through rock");
				g.cancel();
			}
		}
		ok(found, "found no outcrop to test against");
	}

	// --- demolish: one of each kind, with salvage, and the hill keeps working
	{
		auto demolish = [&g](double x, double y, DemolishKind kind, const char* name) {
			g.setTool(Tool::Of(ToolKind::Demolish));
			const auto t = g.demolishTarget(x, y);
			ok(t && t->kind == kind, std::string("demolish at ") + name + " found something else");
			const double money = g.money;
			const ClickResult r = g.click(x, y);
			ok(r == ClickResult::Ok, std::string("demolish ") + name + " failed: " + lastToast(g));
			ok(g.money - money == (t ? t->refund : 0), std::string(name) + " salvage mismatch");
		};
		const Building* shop = nullptr;
		for (const Building& b : g.buildings)
			if (b.type != BuildingType::Heli) shop = &b;
		ok(shop != nullptr, "no building to demolish");
		if (shop)
		{
			const int shopId = shop->id;
			demolish(shop->x, shop->y, DemolishKind::Building, "building");
			ok(!g.findBuilding(shopId), "building still there");
		}
		for (const Feature& f : g.features)
		{
			if (f.type != FeatureType::Jump) continue;
			const Vec2 at{f.x, f.y};
			demolish(at.x, at.y, DemolishKind::Feature, "feature");
			break;
		}
		const Trail* moguls = nullptr;
		for (const Trail& t : g.trails)
			if (t.kind == TrailKind::Moguls && !moguls) moguls = &t;
		const Vec2 mid = moguls->points[1];
		const int mogulsId = moguls->id;
		demolish(mid.x, mid.y, DemolishKind::Trail, "trail");
		ok(!g.findTrail(mogulsId), "trail still there");
		ok(g.treesIn(mid.x - 5, mid.y - 5, mid.x + 5, mid.y + 5).empty(), "trees sprang back on a demolished run");
		const Lift lastLift = g.lifts.back();
		demolish((lastLift.bottom.x + lastLift.top.x) / 2, (lastLift.bottom.y + lastLift.top.y) / 2, DemolishKind::Lift, "lift");
		ok(!g.findLift(lastLift.id), "lift still there");
		// The access road: tearing it out cuts off the lot; rebuilding reconnects it.
		const Road* road = nullptr;
		for (const Road& r : g.roads)
			if (!r.highway && !road) road = &r;
		const Vec2 rp{(road->points[0].x + road->points[1].x) / 2, (road->points[0].y + road->points[1].y) / 2};
		demolish(rp.x, rp.y, DemolishKind::Road, "road");
		ok(!g.roadConnected(), "lot still connected after its road was demolished");
		g.setTool(Tool::Of(ToolKind::Demolish));
		const Vec2 hw = g.roads[0].points[5];
		ok(!g.demolishTarget(hw.x, hw.y), "the highway shouldn't be demolishable");
		const Vec2 exit = g.exit();
		const Vec2 hp = NearestOnPolyline(g.roads[0].points, exit.x, exit.y).p;
		g.setTool(Tool::Of(ToolKind::Road));
		g.click(hp.x, hp.y);
		g.click((hp.x + exit.x) / 2, (hp.y + exit.y) / 2);
		g.click(exit.x, exit.y);
		ok(g.roadConnected(), "couldn't reconnect the lot");
		for (int i = 0; i < 2000; i++) g.tick(0.05);
		ok(std::isfinite(g.money), "money broke after demolishing");
		bool onGone = false;
		for (const Skier& s : g.skiers)
			if (s.trailId && *s.trailId >= 0 && !g.findTrail(*s.trailId)) onGone = true;
		ok(!onGone, "skier left on a demolished run");
	}

	// --- terrain: buildings level their pad, and the shaping brush moves earth
	{
		std::optional<Vec2> spot;
		for (int a = 0; a < 72 && !spot; a++)
		{
			for (double d : {150.0, 250.0, 350.0})
			{
				const Vec2 p{kBase.x + std::cos(a / 11.4) * d, kBase.y + std::sin(a / 11.4) * d};
				if (!g.canPlace(B("restroom"), p.x, p.y) && GradeAt(p.x, p.y) > 0.05)
				{
					spot = p;
					break;
				}
			}
		}
		ok(spot.has_value(), "no sloping village spot for a restroom");
		if (spot)
		{
			g.setTool(Tool::Build(B("restroom")));
			ok(g.click(spot->x, spot->y) == ClickResult::Ok, "restroom failed: " + lastToast(g));
			double lo = 1e9, hi = -1e9;
			for (double dx : {-8.0, 0.0, 8.0})
				for (double dy : {-8.0, 0.0, 8.0})
				{
					const double h = ElevationM(spot->x + dx, spot->y + dy);
					lo = std::min(lo, h);
					hi = std::max(hi, h);
				}
			ok(hi - lo < 0.6, "pad isn't level: " + fmt(hi - lo, 2) + " m");
		}

		// Raise somewhere open: the ground comes up, money goes down, and it stops at the limit.
		const Vec2 open{kBase.x + 2600, kBase.y + 1800};
		const double h0 = ElevationM(open.x, open.y);
		const double money = g.money;
		g.setTool(Tool::Of(ToolKind::Shape));
		g.setShapeMode(SculptMode::Raise);
		g.shapeRadius = 60;
		for (int i = 0; i < 20; i++) g.shapeStep(open.x, open.y, 0.05);
		const double h1 = ElevationM(open.x, open.y);
		ok(h1 > h0 + 2, "raise barely moved the ground (" + fmt(h1 - h0, 2) + " m)");
		ok(g.money < money, "shaping should cost money");
		g.endShape();
		for (int i = 0; i < 600; i++) g.shapeStep(open.x, open.y, 0.05);
		g.endShape();
		ok(std::fabs(EarthworkAt(open.x, open.y) - kMaxEarthworkM) < 0.5, "fill limit not held: " + fmt(EarthworkAt(open.x, open.y)) + " m");
		// Smooth and flatten pull it back toward the surroundings / a level.
		g.setShapeMode(SculptMode::Smooth);
		for (int i = 0; i < 40; i++) g.shapeStep(open.x, open.y, 0.05);
		g.endShape();
		ok(ElevationM(open.x, open.y) < h0 + kMaxEarthworkM - 1, "smooth didn't round the mound off");
		g.setShapeMode(SculptMode::Lower);
		for (int i = 0; i < 1200; i++) g.shapeStep(open.x, open.y, 0.05);
		g.endShape();
		ok(std::fabs(EarthworkAt(open.x, open.y) + kMaxEarthworkM) < 0.5, "cut limit not held: " + fmt(EarthworkAt(open.x, open.y)) + " m");

		// Shaping right over a building leaves its pad alone.
		if (spot)
		{
			const double beforeShape = ElevationM(spot->x, spot->y);
			g.setShapeMode(SculptMode::Raise);
			for (int i = 0; i < 40; i++) g.shapeStep(spot->x, spot->y, 0.05);
			g.endShape();
			ok(std::fabs(ElevationM(spot->x, spot->y) - beforeShape) < 0.01, "shaping moved the ground under a building");
		}
		g.cancel();
	}

	// --- settings: free tree clearing and free shaping cost nothing (and still work)
	{
		g.freeTreeClearing = true;
		g.freeShaping = true;
		std::optional<Vec2> spot;
		for (int a = 0; a < 36 && !spot; a++)
		{
			const Vec2 p{kBase.x + std::cos(a / 5.7) * 1500, kBase.y + std::sin(a / 5.7) * 1500};
			if (g.treesUnderBrush(p.x, p.y) > 10) spot = p;
		}
		ok(spot.has_value(), "no forest for the free-clearing test");
		if (spot)
		{
			const double money = g.money;
			g.setTool(Tool::Of(ToolKind::ClearTrees));
			ok(g.click(spot->x, spot->y) == ClickResult::Ok && g.treesUnderBrush(spot->x, spot->y) == 0, "free clearing didn't fell the trees");
			g.endBrush();
			g.setTool(Tool::Of(ToolKind::Shape));
			g.setShapeMode(SculptMode::Raise);
			const double h0 = ElevationM(spot->x + 300, spot->y);
			for (int i = 0; i < 20; i++) g.shapeStep(spot->x + 300, spot->y, 0.05);
			g.endShape();
			ok(ElevationM(spot->x + 300, spot->y) > h0 + 1, "free shaping didn't move the ground");
			ok(g.money == money, "free tools still charged $" + fmt(money - g.money, 2));
			// Free shaping works even when broke.
			g.money = 0;
			const double h1 = ElevationM(spot->x - 300, spot->y);
			for (int i = 0; i < 20; i++) g.shapeStep(spot->x - 300, spot->y, 0.05);
			g.endShape();
			ok(ElevationM(spot->x - 300, spot->y) > h1 + 1, "free shaping refused with no money");
			g.money = money;
		}
		g.freeTreeClearing = false;
		g.freeShaping = false;
		g.cancel();
	}

	// --- conquer every remaining peak with a gondola from somewhere below it
	for (const Summit& p : Summits())
	{
		if (g.conquered.count(p.id)) continue;
		const double dx = kBase.x - p.x;
		const double dy = kBase.y - p.y;
		const double d = std::hypot(dx, dy);
		bool built = false;
		for (double reach : {6000.0, 5000.0, 4000.0, 3000.0, 2000.0})
		{
			const double r = std::min(reach, d - 50);
			const Vec2 bottom{p.x + (dx / d) * r, p.y + (dy / d) * r};
			const Vec2 top{p.x + (dx / d) * 40, p.y + (dy / d) * 40};
			g.setTool(Tool::ForLift(LiftType::Gondola));
			g.click(bottom.x, bottom.y);
			if (g.click(top.x, top.y) == ClickResult::Ok)
			{
				built = true;
				break;
			}
			g.cancel();
		}
		ok(built, "couldn't run a gondola to " + p.name + ": " + lastToast(g));
		ok(g.conquered.count(p.id) == 1, p.name + " (" + std::to_string(p.elevation) + " m) wasn't conquered");
	}
	std::printf("conquered %zu/%zu, tier %s, won: %s\n", g.conquered.size(), Summits().size(), kTiers[g.tier()].name, g.won ? "true" : "false");
	ok(g.won, "conquering every peak should win the game");

	// --- once unlocked, a parking garage goes up beside the highway or a road
	{
		bool placed = false;
		const std::vector<Road> roads = g.roads;
		for (const Road& r : roads)
		{
			for (size_t i = 1; i < r.points.size() && !placed; i++)
			{
				const Vec2 a = r.points[i - 1];
				const Vec2 b = r.points[i];
				double l = std::hypot(b.x - a.x, b.y - a.y);
				if (l == 0) l = 1;
				for (double side : {1.0, -1.0})
				{
					const double R = Parking(B("garage"))->radius + 8;
					const Vec2 p{(a.x + b.x) / 2 - ((b.y - a.y) / l) * R * side, (a.y + b.y) / 2 + ((b.x - a.x) / l) * R * side};
					if (g.canPlace(B("garage"), p.x, p.y)) continue;
					const int capBefore = g.parkingCapacity();
					g.setTool(Tool::Build(B("garage")));
					placed = g.click(p.x, p.y) == ClickResult::Ok && g.parkingCapacity() == capBefore + Parking(B("garage"))->skiers;
					break;
				}
			}
			if (placed) break;
		}
		ok(placed, "couldn't build a parking garage anywhere beside a road");
	}
	ok(g.capacity() == kTiers.back().capacity, "should reach the top tier");
	for (int i = 0; i < 2000; i++) g.tick(0.05);
	ok(std::isfinite(g.money), "money NaN after conquering");

	// --- goals pay a bonus and queue a celebration, once each
	{
		int peaks = 0;
		for (const Reward& r : g.rewards)
			if (r.kind == RewardKind::Peak) peaks++;
		ok(peaks == 8, "expected 8 peak rewards, got " + std::to_string(peaks));
		ok(g.goalsPaid.count("tier1") && g.goalsPaid.count("all"), "tier and win goals should be paid out");
		const size_t n = g.rewards.size();
		for (int i = 0; i < 200; i++) g.tick(0.05);
		ok(g.rewards.size() == n, "goals should only pay out once");
	}

	// --- footpaths: walkers use them between the booth, buildings, lifts and the lot
	{
		const Vec2 booth = g.booth();
		const Building* lodge = nullptr;
		for (const Building& b : g.buildings)
			if (b.type == BuildingType::Lodge) lodge = &b;
		const Vec2 lodgeAt{lodge->x, lodge->y};
		g.setTool(Tool::Of(ToolKind::Path));
		ok(g.click(booth.x, booth.y) == ClickResult::Ok, "path should start at the booth");
		g.click((booth.x + lodgeAt.x) / 2 + 30, (booth.y + lodgeAt.y) / 2);
		const ClickResult r = g.click(lodgeAt.x, lodgeAt.y);
		ok(r == ClickResult::Ok && g.paths.size() == 1, "path to the lodge failed: " + lastToast(g));
		const Vec2 exit = g.exit();
		g.click(exit.x, exit.y);
		g.click(booth.x - 20, booth.y + 40);
		g.click(booth.x, booth.y);
		g.setTool(Tool::Of(ToolKind::Select));
		ok(!g.paths.empty(), "second path failed");
		int walkedOnPath = 0;
		for (int i = 0; i < 4000; i++)
		{
			g.tick(0.05);
			if (i % 20 == 0)
				for (const Skier& s : g.skiers)
					if (s.onPath) walkedOnPath++;
		}
		ok(walkedOnPath > 0, "nobody walked on the footpaths");
		g.setTool(Tool::Of(ToolKind::Demolish));
		const Vec2 p0 = g.paths[0].points[1];
		ok(g.click(p0.x, p0.y) == ClickResult::Ok, "couldn't demolish a path: " + lastToast(g));
		g.setTool(Tool::Of(ToolKind::Select));
		for (int i = 0; i < 400; i++) g.tick(0.05);
		bool finite = true;
		for (const Skier& s : g.skiers)
			if (!std::isfinite(s.x) || !std::isfinite(s.y)) finite = false;
		ok(finite, "walker position broke after removing a path");
	}

	// --- lookouts: people stepping off a nearby lift stop by the fire pits
	{
		const Lift* busiest = nullptr;
		size_t most = 0;
		for (const Lift& l : g.lifts)
		{
			size_t riders = 0;
			for (const Carrier& c : l.carriers) riders += c.riders.size();
			if (!busiest || riders > most)
			{
				busiest = &l;
				most = riders;
			}
		}
		const Vec2 top = busiest->top;
		std::optional<Vec2> spot;
		for (double r = 50; r < 320 && !spot; r += 15)
		{
			for (double a = 0; a < kPi * 2 && !spot; a += 0.35)
			{
				const Vec2 q{top.x + std::cos(a) * r, top.y + std::sin(a) * r};
				if (!g.canPlace(B("lookout"), q.x, q.y)) spot = q;
			}
		}
		ok(spot.has_value(), "no spot for a lookout near a lift top");
		if (spot)
		{
			g.setTool(Tool::Build(B("lookout")));
			ok(g.click(spot->x, spot->y) == ClickResult::Ok, "lookout failed: " + lastToast(g));
			g.setTool(Tool::Of(ToolKind::Select));
			int seen = 0;
			for (int i = 0; i < 4000; i++)
			{
				g.tick(0.05);
				if (i % 10 == 0)
					for (const Skier& s : g.skiers)
						if (s.visitType == BuildingType::Lookout) seen++;
			}
			ok(seen > 0, "nobody stopped at the lookout");
			bool lost = false;
			for (const Skier& s : g.skiers)
				if (s.state == SkierState::Visit && !s.visitType) lost = true;
			ok(!lost, "a visitor lost track of where they were going");
		}
	}

	if (problems.empty())
	{
		std::printf("ALL CHECKS PASSED\n");
		return 0;
	}
	std::printf("PROBLEMS (%zu):\n", problems.size());
	for (const std::string& p : problems) std::printf("%s\n", p.c_str());
	return 1;
}
