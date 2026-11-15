// Port of src/sim.ts. Keep the two in step: the comments and the order of
// functions follow the TypeScript so changes can be carried across.
#include "SkiGame.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <map>
#include <utility>

namespace Ski
{

namespace
{
constexpr double kInf = std::numeric_limits<double>::infinity();

/** Forest grid: one possible tree per cell. */
constexpr double kTreeCell = 12;
constexpr double kWalk = 1.8;
constexpr double kSki = 2;

const std::vector<std::string> kNames = {
	"Ava", "Bo", "Cora", "Drew", "Eli", "Faye", "Gus", "Hana", "Ivy", "Jed",
	"Kai", "Liv", "Mae", "Ned", "Oli", "Pia", "Quin", "Rio", "Sky", "Tess",
};

const std::vector<std::string> kTrailPrefix = {
	"Whisper", "Eagle", "Pine", "Goat", "Ridge", "Frost", "Cedar", "Hawk", "Willow", "Storm", "Fox", "Glacier"};
const std::vector<std::string> kTrailSuffix = {"Run", "Glade", "Alley", "Line", "Trail", "Chute", "Way", "Bowl"};
const std::vector<std::string> kLiftPrefix = {"Summit", "Lookout", "Aspen", "Powder", "Timber", "Falcon",
	"Bluebird", "Highline", "Raven", "Tamarack", "Cirque", "Sundance"};

/** How far beyond its edge a lot may sit from the road it opens onto. */
constexpr double kParkingReach = 30;
/** Share of the price you get back when you demolish something. */
constexpr double kSalvage = 0.4;
/** How many saplings one brush stamp plants, how close trees may stand, and the planted-tree grid. */
constexpr int kPlantPerStamp = 9;
constexpr double kPlantGap = 6;
constexpr double kPlantCell = 64;

const char* kCostRed = "#d9785f";

double Clamp(double n, double a, double b) { return std::max(a, std::min(b, n)); }

/** A whole number with thousands separators, like toLocaleString(). */
std::string Num(double n)
{
	const long long v = static_cast<long long>(JsRound(n));
	const bool neg = v < 0;
	const std::string digits = std::to_string(neg ? -v : v);
	std::string out;
	for (size_t i = 0; i < digits.size(); i++)
	{
		if (i > 0 && (digits.size() - i) % 3 == 0) out.push_back(',');
		out.push_back(digits[i]);
	}
	return neg ? "-" + out : out;
}

/** A whole number without separators, like `${n}` for integers. */
std::string Int(double n) { return std::to_string(static_cast<long long>(JsRound(n))); }

std::string Lower(std::string s)
{
	for (char& c : s)
		if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
	return s;
}

std::string Plural(int n, const char* word) { return std::to_string(n) + " " + word + (n == 1 ? "" : "s"); }

double TrailScore(Difficulty skill, Difficulty diff)
{
	const int d = std::abs(skill - diff);
	if (d == 0) return 1;
	if (d == 1) return 0.55;
	if (skill < diff) return 0.08;
	return 0.22;
}

bool SegmentsCross(const Vec2& a, const Vec2& b, const Vec2& c, const Vec2& d)
{
	auto o = [](const Vec2& p, const Vec2& q, const Vec2& r) { return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x); };
	const double d1 = o(c, d, a);
	const double d2 = o(c, d, b);
	const double d3 = o(a, b, c);
	const double d4 = o(a, b, d);
	return d1 * d2 < 0 && d3 * d4 < 0;
}

std::string LiftNoun(LiftType type) { return type == LiftType::TBar ? "T-bar" : Lower(Spec(type).label); }

/** Cash bonus for reaching each goal on the list. */
double GoalBonus(const std::string& goalId)
{
	static const std::map<std::string, double> kBonus = {
		{"road", 1500}, {"lodge", 3000}, {"black", 4000}, {"patrol", 8000}, {"tier1", 25000},
		{"tier2", 60000}, {"tier3", 150000}, {"tier4", 400000}, {"all", 1000000},
	};
	auto it = kBonus.find(goalId);
	return it == kBonus.end() ? 2000 : it->second;
}

/** Stable, well-mixed 0..1 value per grid cell (and salt). */
double CellHash(int32_t gx, int32_t gy, uint32_t salt)
{
	uint32_t h = (static_cast<uint32_t>(gx) * 374761393u) ^ (static_cast<uint32_t>(gy) * 668265263u) ^ (salt * 2246822519u);
	h = (h ^ (h >> 13)) * 1274126177u;
	h ^= h >> 16;
	return h / 4294967296.0;
}

/** Round a stride down to a power of two (1, 2, 4, ... kMaxTreeStride). */
int StrideOf(int s)
{
	int p = 1;
	while (p * 2 <= std::min(s, kMaxTreeStride)) p *= 2;
	return p;
}

/**
 * The one cell kept from the s x s block at (bx, by): one of the four
 * half-size blocks is picked at random, then recursively, so the pick at
 * stride s is always one of the picks at stride s / 2.
 */
std::pair<int, int> StrideCell(int bx, int by, int s)
{
	while (s > 1)
	{
		s >>= 1;
		const int q = static_cast<int>(std::floor(CellHash(bx, by, 40 + s) * 4));
		bx += (q & 1) * s;
		by += (q >> 1) * s;
	}
	return {bx, by};
}

int FloorDiv(int a, int b) { return static_cast<int>(std::floor(static_cast<double>(a) / b)); }

/** The largest stride at which forest cell (gx, gy) is still drawn. */
int CellLevel(int gx, int gy)
{
	int level = 1;
	for (int s = 2; s <= kMaxTreeStride; s *= 2)
	{
		const auto [cx, cy] = StrideCell(FloorDiv(gx, s) * s, FloorDiv(gy, s) * s, s);
		if (cx != gx || cy != gy) break;
		level = s;
	}
	return level;
}

/** Planted trees keep a 1 / stride^2 share: the largest stride this one survives. */
int HashLevel(double h)
{
	int level = 1;
	for (int s = 2; s <= kMaxTreeStride; s *= 2)
	{
		if (h > 1.0 / (s * s)) break;
		level = s;
	}
	return level;
}

/** Stable 0..1 value per tree position. */
double TreeHash(double x, double y)
{
	const double n = std::sin(x * 12.9898 + y * 78.233) * 43758.5453;
	return n - std::floor(n);
}

/** One possible tree per forest cell: where it stands, or nothing for a clearing. */
std::optional<ForestTree> ForestCell(int gx, int gy)
{
	// An independent random spot anywhere in (and a little past) the cell.
	const double x = (gx + 0.5 + (CellHash(gx, gy, 1) - 0.5) * 1.35) * kTreeCell;
	const double y = (gy + 0.5 + (CellHash(gx, gy, 2) - 0.5) * 1.35) * kTreeCell;
	if (x < 4 || y < 4 || x > kWorldW - 4 || y > kWorldH - 4) return std::nullopt;
	const double density = ForestDensity(x, y);
	if (density < 0.42) return std::nullopt;
	// Natural gaps and clumps.
	const double clump = Noise2(x / 38, y / 38);
	if (CellHash(gx, gy, 3) > 0.35 + (density - 0.42) * 1.4 + clump * 0.45) return std::nullopt;
	if (RockAt(x, y) > 0.3) return std::nullopt;
	if (GradeAt(x, y) > 0.9) return std::nullopt; // cliffs
	return ForestTree{x, y, 1};
}

/** Strip a trailing " ($29,000)" from a goal's text. */
std::string StripPrice(const std::string& text)
{
	const size_t at = text.rfind(" ($");
	if (at == std::string::npos || text.empty() || text.back() != ')') return text;
	for (size_t i = at + 3; i + 1 < text.size(); i++)
		if (!((text[i] >= '0' && text[i] <= '9') || text[i] == ',')) return text;
	return text.substr(0, at);
}
} // namespace

// ---------- free functions

const std::vector<Summit>& Summits()
{
	static std::vector<Summit> cached;
	static int generation = -1;
	if (generation != TerrainGeneration())
	{
		cached.clear();
		for (const PeakDef& p : kPeaks)
		{
			double bx = p.x, by = p.y, bm = -1;
			for (int dx = -250; dx <= 250; dx += 10)
			{
				for (int dy = -250; dy <= 250; dy += 10)
				{
					const double m = ElevationM(p.x + dx, p.y + dy);
					if (m > bm)
					{
						bx = p.x + dx;
						by = p.y + dy;
						bm = m;
					}
				}
			}
			cached.push_back({p.id, p.name, bx, by, static_cast<int>(JsRound(bm))});
		}
		generation = TerrainGeneration();
	}
	return cached;
}

double TrailCost(double length, TrailKind kind)
{
	return JsRound(((60 + length * 0.6) * Spec(kind).costMul * kEcon) / 10) * 10;
}

Difficulty ClassifyGrade(double dropM, double lengthM)
{
	const double grade = dropM / std::max(12.0, lengthM);
	// Real-world-ish pitches: green < 25%, blue < 40%, black < 60%.
	if (grade < 0.25) return 0;
	if (grade < 0.4) return 1;
	if (grade < 0.6) return 2;
	return 3;
}

TrailMeasure MeasureTrail(const std::vector<Vec2>& points, TrailKind kind)
{
	const double length = PolylineLength(points);
	const double drop = Elevation(points.front().x, points.front().y) - Elevation(points.back().x, points.back().y);
	const Difficulty base = ClassifyGrade(drop * kVerticalM, length * kUnitM);
	const Difficulty difficulty = std::min(3, base + Spec(kind).diffBump);
	return {length, drop, difficulty, TrailCost(length, kind)};
}

double DistToTrail(const Trail& t, double x, double y) { return DistToPolyline(t.points, x, y); }

NearestOnTrailResult NearestOnTrail(const Trail& t, double x, double y)
{
	NearestOnTrailResult best{0, 0, -1, kInf};
	double acc = 0;
	for (size_t i = 1; i < t.points.size(); i++)
	{
		const Vec2& a = t.points[i - 1];
		const Vec2& b = t.points[i];
		const double abx = b.x - a.x;
		const double aby = b.y - a.y;
		double len = std::hypot(abx, aby);
		if (len == 0) len = 1;
		const double u = std::max(0.0, std::min(1.0, ((x - a.x) * abx + (y - a.y) * aby) / (len * len)));
		const double d = std::hypot(x - (a.x + abx * u), y - (a.y + aby * u));
		if (d < best.d) best = {acc + len * u, abx / len, aby / len, d};
		acc += len;
	}
	return best;
}

double PeakBonus(double elevation)
{
	return JsRound((8000 + std::max(0.0, elevation - 1800) * 60) / 500) * 500;
}

double ForestDensity(double x, double y)
{
	// Nearly unbroken forest, with the odd small meadow.
	const double density = 0.52 + Noise2(x / 360, y / 300) * 0.5 + (Noise2(x / 90, y / 110) - 0.5) * 0.3;
	const double m = ElevationM(x, y);
	const double treeline = 1 - SmoothStep(kTreelineM - 250, kTreelineM + 100 + (Noise2(x / 500, y / 500) - 0.5) * 200, m);
	return density * treeline;
}

// ---------- the game

Game::Game(uint32_t seed) : rng(seed)
{
	roads.push_back(Road{0, Highway(), true});
	layoutStarter();
	for (int i = 0; i < 7; i++) spawnSkier(true);
}

double Game::random()
{
	const uint64_t a = rng() >> 5;
	const uint64_t b = rng() >> 6;
	return (a * 67108864.0 + b) / 9007199254740992.0;
}

/**
 * Find a spot for the starter T-bar on the gentle slopes above the base
 * village, and two short runs back down beside it.
 */
void Game::layoutStarter()
{
	const double saved = money;
	money = kInf;
	const double baseM = ElevationM(kBase.x, kBase.y);
	struct Best
	{
		Vec2 a, b;
		double score;
	};
	std::optional<Best> best;
	for (int ang = 0; ang < 360; ang += 10)
	{
		const double dx = std::cos((ang * kPi) / 180);
		const double dy = std::sin((ang * kPi) / 180);
		for (double start : {120.0, 220.0, 320.0})
		{
			const Vec2 a{kBase.x + dx * start, kBase.y + dy * start};
			for (double len : {450.0, 600.0, 750.0, 900.0})
			{
				const Vec2 b{a.x + dx * len, a.y + dy * len};
				const LiftCheck lc = checkLift(LiftType::TBar, a, b);
				if (lc.error) continue;
				// Want a solid rise on gentle-ish ground, close to the village.
				const double grade = lc.rise / len;
				const double score = std::min(lc.rise, 180.0) - std::fabs(grade - 0.2) * 300 - start * 0.1 -
					(ElevationM(a.x, a.y) - baseM) * 0.2;
				if (!best || score > best->score) best = Best{a, b, score};
			}
		}
	}
	if (!best)
	{
		// The web game throws here; it can't happen on the real map.
		money = saved;
		return;
	}
	lifts = {makeLift(LiftType::TBar, "Valley T-Bar", best->a, best->b)};
	// Two runs from the top back to the bottom, swinging out either side of the lift.
	const Vec2 a = best->a;
	const Vec2 b = best->b;
	const double len = std::hypot(b.x - a.x, b.y - a.y);
	const double ux = (b.x - a.x) / len;
	const double uy = (b.y - a.y) / len;
	const char* names[2] = {"Easy Street", "Valley Run"};
	const double sides[2] = {-1, 1};
	const double shape[5][2] = {{1, 30}, {0.75, 110}, {0.5, 140}, {0.25, 110}, {0.02, 45}};
	for (int i = 0; i < 2; i++)
	{
		std::vector<Vec2> pts;
		for (const auto& td : shape)
		{
			const double t = td[0];
			const double d = td[1];
			pts.push_back({a.x + (b.x - a.x) * t - uy * d * sides[i], a.y + (b.y - a.y) * t + ux * d * sides[i]});
		}
		trails.push_back(makeTrail(names[i], pts));
	}
	trailsChanged();
	money = saved;
}

Trail Game::makeTrail(const std::string& name, const std::vector<Vec2>& points, TrailKind kind)
{
	const TrailMeasure m = MeasureTrail(points, kind);
	usedTrailNames.insert(name);
	Trail t;
	t.id = nextId++;
	t.name = name;
	t.points = points;
	t.kind = kind;
	t.length = m.length;
	t.drop = m.drop;
	t.difficulty = m.difficulty;
	return t;
}

/** The runs or lifts changed: drop anything that points into the old lists. */
void Game::trailsChanged()
{
	served.clear();
	loadCache.reset();
}

/**
 * The forest is procedural: one possible tree per 12 m cell, jittered, kept
 * where a patchy density field says so, thinning out toward the treeline and
 * absent on cliffs and in the village. Runs, lifts, buildings and park
 * features clear it; glades only thin it.
 */
std::vector<ForestTree> Game::treesIn(double x0, double y0, double x1, double y1, bool cleared, int stride)
{
	std::vector<ForestTree> out;
	const int gx0 = std::max(0, static_cast<int>(std::floor(x0 / kTreeCell)));
	const int gy0 = std::max(0, static_cast<int>(std::floor(y0 / kTreeCell)));
	const int gx1 = std::min(static_cast<int>(std::floor(kWorldW / kTreeCell)), static_cast<int>(std::ceil(x1 / kTreeCell)));
	const int gy1 = std::min(static_cast<int>(std::floor(kWorldH / kTreeCell)), static_cast<int>(std::ceil(y1 / kTreeCell)));
	std::optional<ClearIndex> index;
	if (cleared) index = clearersIn(x0 - 40, y0 - 40, x1 + 40, y1 + 40);
	// A stride > 1 samples one random cell from each stride x stride block, for
	// a sparser far-off view. Strides are powers of two and nested, so zooming
	// out only thins the forest, never reshuffles it.
	stride = StrideOf(stride);
	const int sx = FloorDiv(gx0, stride) * stride;
	const int sy = FloorDiv(gy0, stride) * stride;
	for (int by = sy; by <= gy1; by += stride)
	{
		for (int bx = sx; bx <= gx1; bx += stride)
		{
			const auto [gx, gy] = StrideCell(bx, by, stride);
			if (gx < gx0 || gx > gx1 || gy < gy0 || gy > gy1) continue;
			std::optional<ForestTree> t = ForestCell(gx, gy);
			if (!t) continue;
			if (inVillage(t->x, t->y)) continue;
			if (index && isCleared(t->x, t->y, *index)) continue;
			t->level = CellLevel(gx, gy);
			out.push_back(*t);
		}
	}
	// Planted trees: a random share of them when sampling sparsely.
	const double keep = 1.0 / (stride * stride);
	for (int cy = static_cast<int>(std::floor(y0 / kPlantCell)); cy <= static_cast<int>(std::floor(y1 / kPlantCell)); cy++)
	{
		for (int cx = static_cast<int>(std::floor(x0 / kPlantCell)); cx <= static_cast<int>(std::floor(x1 / kPlantCell)); cx++)
		{
			auto it = plantedCells.find(cy * 4096 + cx);
			if (it == plantedCells.end()) continue;
			for (const Vec2& t : it->second)
			{
				if (t.x < x0 || t.x > x1 || t.y < y0 || t.y > y1) continue;
				const double h = TreeHash(t.x, t.y);
				if (stride > 1 && h > keep) continue;
				if (index && isCleared(t.x, t.y, *index, true)) continue;
				out.push_back({t.x, t.y, HashLevel(h)});
			}
		}
	}
	return out;
}

/** Clear a circle of forest: the procedural trees stay cleared, planted ones are dug up. */
void Game::addClearing(double x, double y, double r)
{
	clearings.push_back({x, y, r});
	removePlanted(x, y, r);
}

int Game::removePlanted(double x, double y, double r)
{
	int n = 0;
	for (int cy = static_cast<int>(std::floor((y - r) / kPlantCell)); cy <= static_cast<int>(std::floor((y + r) / kPlantCell)); cy++)
	{
		for (int cx = static_cast<int>(std::floor((x - r) / kPlantCell)); cx <= static_cast<int>(std::floor((x + r) / kPlantCell)); cx++)
		{
			auto it = plantedCells.find(cy * 4096 + cx);
			if (it == plantedCells.end()) continue;
			std::vector<Vec2> kept;
			for (const Vec2& t : it->second)
				if (std::hypot(t.x - x, t.y - y) >= r) kept.push_back(t);
			n += static_cast<int>(it->second.size() - kept.size());
			if (kept.empty()) plantedCells.erase(it);
			else it->second = std::move(kept);
		}
	}
	if (n)
	{
		planted.clear();
		for (const auto& kv : plantedCells) planted.insert(planted.end(), kv.second.begin(), kv.second.end());
	}
	return n;
}

/** Why a tree can't be planted here, or nothing if it can. */
std::optional<std::string> Game::plantError(double x, double y, const ClearIndex& index, const std::vector<Vec2>& existing)
{
	if (x < 6 || y < 6 || x > kWorldW - 6 || y > kWorldH - 6) return "That's off the property.";
	if (IsRock(x, y) || RockAt(x, y) > 0.3) return "Nothing grows on bare rock.";
	if (GradeAt(x, y) > 0.9) return "Too steep for a tree.";
	if (ElevationM(x, y) > kTreelineM + 150) return "Too high: that's above the treeline.";
	if (isCleared(x, y, index, true)) return "Keep trees off runs, lifts, roads and buildings.";
	for (const Vec2& t : existing)
		if (std::hypot(t.x - x, t.y - y) < kPlantGap) return "There's already a tree there.";
	return std::nullopt;
}

/** Plant one tree, or a brushful scattered around (x, y). */
ClickResult Game::paintPlanting(double x, double y)
{
	const bool single = plantMode == PlantMode::Single;
	if (!single && lastBrush && std::hypot(lastBrush->x - x, lastBrush->y - y) < kBrushR * 0.45) return ClickResult::None;
	const double r = single ? kPlantGap : kBrushR;
	const ClearIndex index = clearersIn(x - r - 40, y - r - 40, x + r + 40, y + r + 40);
	std::vector<Vec2> existing;
	for (const ForestTree& t : treesIn(x - r - kPlantGap, y - r - kPlantGap, x + r + kPlantGap, y + r + kPlantGap)) existing.push_back({t.x, t.y});
	std::vector<Vec2> spots;
	if (single)
	{
		if (std::optional<std::string> err = plantError(x, y, index, existing))
		{
			toast(*err, true);
			return ClickResult::Shake;
		}
		spots.push_back({x, y});
	}
	else
	{
		for (int k = 0; k < 60 && static_cast<int>(spots.size()) < kPlantPerStamp; k++)
		{
			const double a = random() * kPi * 2;
			const double d = std::sqrt(random()) * kBrushR;
			const Vec2 p{x + std::cos(a) * d, y + std::sin(a) * d};
			if (!plantError(p.x, p.y, index, existing))
			{
				spots.push_back(p);
				existing.push_back(p);
			}
		}
		if (spots.empty()) return ClickResult::None;
	}
	const double cost = freeTreeClearing ? 0 : spots.size() * kTreePlantCost;
	if (cost > 0 && money < cost)
	{
		toast("Need $" + Num(cost - money) + " more to plant trees.", true);
		return ClickResult::Shake;
	}
	money -= cost;
	for (const Vec2& p : spots)
	{
		plantedCells[static_cast<int>(std::floor(p.y / kPlantCell)) * 4096 + static_cast<int>(std::floor(p.x / kPlantCell))].push_back(p);
		planted.push_back(p);
	}
	treesPlanted += static_cast<int>(spots.size());
	lastBrush = Vec2{x, y};
	strokeCost += cost;
	clearTrees();
	if (single) endBrush();
	return ClickResult::Ok;
}

/**
 * Everything that keeps trees off the ground (runs, lifts, roads, buildings,
 * features, brushed clearings) as capsules, bucketed into a coarse grid over a
 * box so each tree only checks what's near it.
 */
Game::ClearIndex Game::clearersIn(double x0, double y0, double x1, double y1) const
{
	ClearIndex index;
	index.x0 = x0;
	index.y0 = y0;
	index.cell = 64;
	index.cols = static_cast<int>(std::ceil((x1 - x0) / index.cell)) + 1;
	auto add = [&](double ax, double ay, double bx, double by, double r, bool glade, bool brush) {
		const double cell = index.cell;
		const int i0 = std::max(0, static_cast<int>(std::floor((std::min(ax, bx) - r - x0) / cell)));
		const int i1 = std::min(index.cols - 1, static_cast<int>(std::floor((std::max(ax, bx) + r - x0) / cell)));
		const int j0 = std::max(0, static_cast<int>(std::floor((std::min(ay, by) - r - y0) / cell)));
		const int j1 = static_cast<int>(std::floor((std::min(y1, std::max(ay, by) + r) - y0) / cell));
		if (i0 > i1 || j0 > j1) return;
		index.shapes.push_back({ax, ay, bx, by, r, glade, brush});
		const int si = static_cast<int>(index.shapes.size()) - 1;
		for (int j = j0; j <= j1; j++)
			for (int i = i0; i <= i1; i++) index.cells[j * index.cols + i].push_back(si);
	};
	for (const Trail& t : trails)
	{
		const bool glade = t.kind == TrailKind::Glades;
		const double r = Spec(t.kind).width / 2 + (glade ? 0 : 9);
		for (size_t i = 1; i < t.points.size(); i++) add(t.points[i - 1].x, t.points[i - 1].y, t.points[i].x, t.points[i].y, r, glade, false);
	}
	for (const Lift& l : lifts) add(l.bottom.x, l.bottom.y, l.top.x, l.top.y, 16, false, false);
	for (const Building& b : buildings) add(b.x, b.y, b.x, b.y, BuildingRadius(b.type), false, false);
	for (const Feature& f : features) add(f.x, f.y, f.x, f.y, f.type == FeatureType::Halfpipe ? 40 : 12, false, false);
	for (const RoadSeg& s : roadSegsIn(x0, y0, x1, y1)) add(s.a.x, s.a.y, s.b.x, s.b.y, s.w / 2 + 5, false, false);
	for (const Path& pth : paths)
	{
		for (size_t i = 1; i < pth.points.size(); i++)
			add(pth.points[i - 1].x, pth.points[i - 1].y, pth.points[i].x, pth.points[i].y, kPathWidth / 2 + 2, false, false);
	}
	for (const Clearing& c : clearings) add(c.x, c.y, c.x, c.y, c.r, false, true);
	return index;
}

/** Is this spot kept clear of trees? Planted trees ignore old brushed clearings. */
bool Game::isCleared(double x, double y, const ClearIndex& index, bool plantedTree) const
{
	const int i = static_cast<int>(std::floor((x - index.x0) / index.cell));
	const int j = static_cast<int>(std::floor((y - index.y0) / index.cell));
	auto it = index.cells.find(j * index.cols + i);
	if (it == index.cells.end()) return false;
	for (int si : it->second)
	{
		const ClearShape& c = index.shapes[si];
		if (plantedTree && c.brush) continue;
		if (!NearSegment(c.ax, c.ay, c.bx, c.by, x, y, c.r)) continue;
		// Glades are thinned, not cleared: a narrow line down the middle, then every other tree.
		if (!c.glade || NearSegment(c.ax, c.ay, c.bx, c.by, x, y, 2.5) || TreeHash(x, y) < 0.5) return true;
	}
	return false;
}

/** Trees standing inside a corridor along a path (for glades and the "trees cleared" count). */
int Game::treesAlong(const std::vector<Vec2>& points, double halfWidth, bool cleared)
{
	double x0 = kInf, y0 = kInf, x1 = -kInf, y1 = -kInf;
	for (const Vec2& p : points)
	{
		x0 = std::min(x0, p.x);
		y0 = std::min(y0, p.y);
		x1 = std::max(x1, p.x);
		y1 = std::max(y1, p.y);
	}
	int n = 0;
	for (const ForestTree& t : treesIn(x0 - halfWidth, y0 - halfWidth, x1 + halfWidth, y1 + halfWidth, cleared))
		if (DistToPolyline(points, t.x, t.y) < halfWidth) n++;
	return n;
}

/** Called whenever something clears or thins the forest. */
void Game::clearTrees() { forestVersion++; }

std::string Game::clockLabel() const
{
	const Weather w = weather();
	const char* sky = w.snow > 0.15 ? "Snowing" : w.cover > 0.45 ? "Cloudy" : w.cover > 0.2 ? "Sunny spells" : "Clear";
	return "Day " + std::to_string(day) + " " SKI_DOT " " + timeOfDay() + " " SKI_DOT " " + sky;
}

/** Clock time for a point in the open day (0..52 game seconds), e.g. "2:15 PM". */
std::string Game::timeOfDay(std::optional<double> at) const
{
	const double t = at ? *at : dayT;
	const double minutes = 8 * 60 + 30 + (t / 52) * (7.5 * 60);
	const int h24 = static_cast<int>(std::floor(minutes / 60));
	const int m = static_cast<int>(std::floor(std::fmod(minutes, 60)));
	char buf[32];
	std::snprintf(buf, sizeof buf, "%d:%02d %s", ((h24 + 11) % 12) + 1, m, h24 >= 12 ? "PM" : "AM");
	return buf;
}

/** The weather at a point in game time (days, fractional). */
Weather Game::weatherFor(double t) const
{
	const double tau = kPi * 2;
	double cover = 0.46 + 0.3 * std::sin((tau * t) / 2.3 + 1.0) + 0.17 * std::sin((tau * t) / 0.9 + 2.1) +
		0.08 * std::sin((tau * t) / 0.37 + 0.4);
	cover *= std::min(1.0, std::max(0.0, (t - 1.15) / 0.6));
	cover = std::min(1.0, std::max(0.0, cover));
	const double k = std::min(1.0, std::max(0.0, (cover - 0.62) / 0.25));
	const double snow = k * k * (3 - 2 * k);
	const double wind = 0.5 + 0.5 * std::sin((tau * t) / 1.7 + 0.8);
	return {cover, snow, wind};
}

/**
 * What the weather panel shows: conditions now, temperature at the base, wind,
 * fresh snow on the ground and a short forecast for the rest of the day.
 */
WeatherReport Game::weatherReport() const
{
	const Weather w = weather();
	const char* condition = w.snow > 0.7 ? "Heavy snow"
		: w.snow > 0.15                  ? "Snowing"
		: w.cover > 0.7                  ? "Overcast"
		: w.cover > 0.45                 ? "Cloudy"
		: w.cover > 0.2                  ? "Sunny spells"
										 : "Clear skies";
	// Coldest first thing, warmest mid-afternoon; cloud keeps it milder, snow colder.
	const double f = dayFraction();
	const int tempC = static_cast<int>(JsRound(-9 + 6 * std::sin(kPi * std::min(1.0, f * 1.15)) + (w.cover - 0.5) * 3 - w.snow * 2 +
		(Noise2(day * 0.71, 3) - 0.5) * 6));
	const int windKmh = static_cast<int>(JsRound(4 + w.wind * 30 + w.snow * 15));
	const bool snowing = w.snow > 0.15;
	std::string forecast = snowing ? "Snowing into tomorrow" : w.cover > 0.45 ? "Staying cloudy" : "Fine for the rest of the day";
	// Look ahead in steps of about 20 game minutes.
	const double step = 1.0 / 22;
	const double left = 1 - f;
	const double now = day + dayT / 52;
	for (int k = 1; k <= 14; k++)
	{
		const double a = k * step;
		const Weather next = weatherFor(now + a);
		if ((next.snow > 0.15) == snowing) continue;
		const std::string when = a <= left ? "by " + timeOfDay((f + a) * 52) : a - left < 0.35 ? "overnight" : "tomorrow morning";
		if (snowing) forecast = "Clearing " + when;
		else forecast = "Snow " + (when == "overnight" || when == "tomorrow morning" ? when : "from " + timeOfDay((f + a) * 52));
		break;
	}
	return {condition, tempC, windKmh, static_cast<int>(JsRound(freshSnowCm)), forecast};
}

/** How far through the open day we are: 0 at 8:30 AM, 1 at 4 PM. */
double Game::dayFraction() const { return std::min(1.0, std::max(0.0, dayT / 52)); }

/**
 * The weather is a slow mix of waves over game time, so storms roll in and
 * clear over a day or two. Day one opens clear.
 */
Weather Game::weather() const { return weatherFor(day + dayT / 52); }

Game::Variety Game::variety() const
{
	Variety v{};
	for (const Trail& t : trails)
	{
		v.counts[t.difficulty]++;
		v.kinds[static_cast<int>(t.kind)] = true;
	}
	double score = std::min(v.counts[0], 2) / 2.0 * 0.28 + std::min(v.counts[1], 2) / 2.0 * 0.26 +
		std::min(v.counts[2], 1) * 0.24 + std::min(v.counts[3], 1) * 0.22;
	// Specialty runs and park features widen the appeal.
	if (v.kinds[static_cast<int>(TrailKind::Slalom)]) score += 0.05;
	if (v.kinds[static_cast<int>(TrailKind::Moguls)]) score += 0.05;
	if (v.kinds[static_cast<int>(TrailKind::Park)]) score += 0.06;
	score += std::min(0.08, features.size() * 0.012);
	v.score = score;
	return v;
}

double Game::amenityScore() const
{
	using BT = BuildingType;
	double n = 0;
	if (has(BT::Lodge)) n += 0.18;
	n += std::min(2, count(BT::Restroom)) * 0.1;
	if (has(BT::Coffee)) n += 0.12;
	if (has(BT::Sandwich)) n += 0.12;
	if (has(BT::Cafeteria)) n += 0.12;
	if (has(BT::Bar)) n += 0.13;
	n += std::min(3, count(BT::Shack)) * 0.08;
	if (has(BT::Hotel)) n += 0.16;
	if (has(BT::Hostel)) n += 0.11;
	if (has(BT::Restaurant)) n += 0.14;
	if (has(BT::Shop)) n += 0.1;
	if (has(BT::Condo)) n += 0.14;
	if (has(BT::Spa)) n += 0.15;
	if (has(BT::Patrol)) n += 0.08;
	if (has(BT::Clinic)) n += 0.1;
	if (has(BT::Rental)) n += 0.11;
	if (has(BT::School)) n += 0.12;
	// Ski-in / ski-out cabins: a little more appeal for each one, up to ten.
	n += std::min(10, skiInCabins()) * 0.025;
	if (has(BT::Heli)) n += 0.15;
	// Pizzerias, steakhouses, boutiques, inns...: each kind on offer widens the appeal.
	for (int i = 0; i < kBuildingTypeCount; i++)
	{
		const BT t = static_cast<BT>(i);
		if (Info(t).appeal > 0 && has(t)) n += Info(t).appeal;
	}
	return std::min(2.1, n);
}

double Game::fairPrice() const { return JsRound(34 + amenityScore() * 38 + variety().score * 22); }

/** Roughly how long, in seconds, the average lift line takes right now. */
double Game::liftWait() const
{
	double inLine = 0;
	double total = 0;
	for (const Lift& l : lifts)
	{
		const LiftSpec& spec = Spec(l.type);
		auto it = queued.find(l.id);
		const double q = it == queued.end() ? 0 : it->second;
		const double perSec = (spec.seats * spec.speed) / spec.spacing;
		inLine += q;
		total += q * (q / perSec);
	}
	return inLine > 0 ? total / inLine : 0;
}

/** Current resort tier: grows as peaks are conquered. */
int Game::tier() const
{
	int t = 0;
	for (size_t i = 0; i < kTiers.size(); i++)
		if (static_cast<int>(conquered.size()) >= kTiers[i].peaksNeeded) t = static_cast<int>(i);
	return t;
}

int Game::capacity() const { return kTiers[tier()].capacity; }

/** A peak is conquered when a lift's top station reaches its summit. */
void Game::checkConquest()
{
	const int before = tier();
	const std::vector<Summit>& summits = Summits();
	for (const Summit& p : summits)
	{
		if (conquered.count(p.id)) continue;
		bool reached = false;
		for (const Lift& l : lifts)
		{
			if (std::hypot(l.top.x - p.x, l.top.y - p.y) <= kConquerRadiusM && ElevationM(l.top.x, l.top.y) >= p.elevation - kConquerDropM)
				reached = true;
		}
		if (!reached) continue;
		conquered.insert(p.id);
		const double bonus = PeakBonus(p.elevation);
		money += bonus;
		const std::string n = std::to_string(conquered.size());
		const std::string total = std::to_string(summits.size());
		rewards.push_back({id(), RewardKind::Peak, p.name + " conquered",
			Num(p.elevation) + " m summit " SKI_DOT " " + n + " of " + total + " peaks", bonus});
		toast(p.name + " (" + Num(p.elevation) + " m) conquered! " + n + "/" + total + " peaks. Bonus +$" + Num(bonus) + ".");
		sfx.push_back(Sfx::Build);
	}
	const int after = tier();
	if (after > before)
	{
		const TierDef& t = kTiers[after];
		toast("Your resort is now a " + Lower(t.name) + ": room for " + Num(t.capacity) + " skiers and " + std::to_string(t.maxLifts) + " lifts.");
	}
	if (!won && conquered.size() == summits.size())
	{
		won = true;
		toast("You conquered the mountain! Every peak has a lift.");
	}
}

/**
 * How many skiers the resort can comfortably handle right now: what the lifts
 * can keep cycling, room on the runs, the tier's cap and the parking. The
 * smallest one is the limit. Recomputed a few times a second.
 */
LoadLimits Game::loadLimits()
{
	std::string key = "0:";
	for (const Lift& l : lifts) key += std::to_string(l.id) + ",";
	key += ":";
	for (const Trail& t : trails) key += std::to_string(t.id) + ",";
	key += ":" + std::to_string(roadVersion) + ":";
	for (const Building& b : buildings)
		if (Parking(b.type)) key += std::to_string(b.id) + ",";
	if (loadCache && loadCacheKey == key && clock - loadCacheT < 0.5) return *loadCache;
	double liftLoad = 0;
	for (const Lift& l : lifts)
	{
		const LiftSpec& spec = Spec(l.type);
		const std::vector<const Trail*>& from = servedBy(l);
		const bool bunny = l.type == LiftType::Carpet && from.empty();
		if (from.empty() && !bunny) continue; // nothing to ski from the top
		const double len = std::hypot(l.top.x - l.bottom.x, l.top.y - l.bottom.y);
		const double perSec = (spec.seats * spec.speed) / spec.spacing;
		double runLen = len;
		if (!bunny)
		{
			runLen = 0;
			for (const Trail* t : from) runLen += t->length;
			runLen /= from.size();
		}
		const double lap = len / spec.speed + runLen / 110 + 18;
		liftLoad += perSec * lap * 0.85;
	}
	double runs = 0;
	for (const Trail& t : trails) runs += t.length / 7;
	const int cap = capacity();
	const int parking = parkingCapacity();
	const int comfortable = static_cast<int>(JsRound(std::min({liftLoad, runs, static_cast<double>(cap), static_cast<double>(parking)})));
	LoadLimits out;
	out.lifts = static_cast<int>(JsRound(liftLoad));
	out.runs = static_cast<int>(JsRound(runs));
	out.cap = cap;
	out.parking = parking;
	out.comfortable = comfortable;
	out.limitedBy = comfortable == parking && parking < cap ? LimitedBy::Parking
		: comfortable == cap                               ? LimitedBy::Capacity
		: liftLoad <= runs                                 ? LimitedBy::Lifts
														   : LimitedBy::Runs;
	loadCache = out;
	loadCacheT = clock;
	loadCacheKey = key;
	return out;
}

/** Skiers the resort will draw right now: its comfortable load, scaled by how appealing it is. */
int Game::demand() { return static_cast<int>(JsRound(loadLimits().comfortable * Clamp(attraction(), 0.25, 1))); }

int Game::maxLifts() const { return kTiers[tier()].maxLifts; }

double Game::attraction()
{
	const double fair = fairPrice();
	const double priceFactor = ticketPrice <= fair ? 1 : Clamp(1 - (ticketPrice - fair) / (fair + 8), 0.18, 1);
	// Word gets around about long lift lines.
	const double wait = liftWait();
	const double queueFactor = wait > 180 ? 0.45 : wait > 90 ? 0.7 : wait > 45 ? 0.88 : 1;
	return Clamp(0.32 + variety().score * 0.42 + amenityScore() * 0.34, 0.15, 1.15) * priceFactor * queueFactor;
}

bool Game::has(BuildingType type) const
{
	for (const Building& b : buildings)
		if (b.type == type) return true;
	return false;
}

int Game::count(BuildingType type) const
{
	int n = 0;
	for (const Building& b : buildings)
		if (b.type == type) n++;
	return n;
}

std::vector<Goal> Game::goals()
{
	const int n = static_cast<int>(conquered.size());
	const int total = static_cast<int>(Summits().size());
	std::vector<Goal> tierGoals;
	for (size_t i = 1; i < kTiers.size(); i++)
	{
		const TierDef& t = kTiers[i];
		const std::string what = "(" + Num(t.capacity) + "-skier " + Lower(t.name) + ")";
		tierGoals.push_back({"tier" + std::to_string(i),
			t.peaksNeeded == 1 ? "Run a lift to your first peak " + what : "Conquer " + std::to_string(t.peaksNeeded) + " peaks " + what,
			n >= t.peaksNeeded});
	}
	std::vector<Goal> out;
	out.push_back({"road", "Build a road from the highway to the parking lot", parkingCapacity() > 0});
	out.push_back({"lodge", "Build a lodge ($" + Num(Cost(BuildingType::Lodge)) + ")", has(BuildingType::Lodge)});
	bool black = false;
	for (const Trail& t : trails)
		if (t.difficulty >= 2) black = true;
	out.push_back({"black", "Cut a black-diamond run", black});
	out.push_back(tierGoals[0]);
	out.push_back({"patrol", "Hire ski patrol (needed once you're a ski area)", staffRequired() && Staff(StaffRole::Patrol) > 0});
	for (size_t i = 1; i < tierGoals.size(); i++) out.push_back(tierGoals[i]);
	out.push_back({"all", "Conquer the mountain: lifts to all " + std::to_string(total) + " peaks (" + std::to_string(n) + "/" + std::to_string(total) + ")",
		n >= total});
	return out;
}

std::vector<std::string> Game::complaints()
{
	using BT = BuildingType;
	const Variety v = variety();
	std::vector<std::string> out;
	int onHill = 0, beginners = 0, parkFans = 0;
	for (const Skier& s : skiers)
	{
		if (s.state != SkierState::Leaving && s.state != SkierState::Arriving) onHill++;
		if (s.skill == 0) beginners++;
		if (s.likes == TrailKind::Park) parkFans++;
	}
	if (parkingCapacity() == 0) out.push_back("No road reaches the parking lot. Build one from the highway so skiers can drive in.");
	else
	{
		for (const ParkingLot& l : parkingLots())
		{
			if (!l.connected && l.id)
			{
				out.push_back("A parking lot has no road to the highway, so nobody can park there.");
				break;
			}
		}
	}
	if (!has(BT::Lodge)) out.push_back("A lodge would let you set ticket prices.");
	if (v.counts[2] == 0 && v.counts[3] == 0) out.push_back("Advanced skiers want a black diamond.");
	if (v.counts[3] == 0 && trails.size() >= 4) out.push_back("A few experts keep asking for a double black.");
	if (v.counts[0] == 0) out.push_back("Beginners have nowhere gentle to ski.");
	if (count(BT::Restroom) == 0 && onHill > 6) out.push_back("People are hunting for a restroom.");
	if (has(BT::School) && Staff(StaffRole::Instructor) == 0) out.push_back("The ski school has no instructors. Hire some.");
	if (!has(BT::School) && beginners >= 5) out.push_back("Beginners are asking about lessons.");
	if (!v.kinds[static_cast<int>(TrailKind::Park)] && parkFans >= 3) out.push_back("Freestylers want a terrain park.");
	if (ticketPrice > fairPrice() + 8) out.push_back("Tickets feel expensive for what is here.");
	bool food = false;
	for (BT t : kFoodBuildings)
		if (has(t)) food = true;
	if (has(BT::Lodge) && !food) out.push_back("Hungry skiers wish there was food.");
	if (has(BT::Lodge) && !has(BT::Rental) && beginners >= 4) out.push_back("Beginners keep asking where to rent skis.");
	if (staffRequired())
	{
		const auto need = staffNeeds();
		for (StaffRole role : kStaffRoles)
		{
			if (Staff(role) < need[static_cast<int>(role)])
			{
				out.push_back(std::string("Short on ") + Lower(StaffLabel(role)) + ". Hire more staff.");
				break;
			}
		}
	}
	const LoadLimits load = loadLimits();
	if (skiers.size() >= demand() * 0.9)
	{
		if (load.limitedBy == LimitedBy::Parking) out.push_back("The parking is full. Build more parking beside a road to draw more skiers.");
		else if (load.limitedBy == LimitedBy::Lifts) out.push_back("The lifts are maxed out. Add or upgrade lifts to draw more skiers.");
		else if (load.limitedBy == LimitedBy::Runs) out.push_back("The runs are crowded. Cut more trails to draw more skiers.");
		else if (tier() < static_cast<int>(kTiers.size()) - 1) out.push_back("The resort is full. Run a lift to another peak to grow it.");
		else out.push_back("The resort is at full size.");
	}
	if (out.empty()) out.push_back("The hill feels friendly. Keep an eye on mix and price.");
	if (out.size() > 3) out.resize(3);
	return out;
}

void Game::toast(const std::string& text, bool bad)
{
	toasts.push_back({nextToast++, text, bad, 3.6});
	if (toasts.size() > 4) toasts.erase(toasts.begin());
}

void Game::floatText(double x, double y, const std::string& text, const std::string& color)
{
	fx.push_back({x, y, text, 1.1, color});
}

void Game::startManaging()
{
	managing = true;
	if (parkingCapacity() == 0) toast("Skiers need a way in: build a road from the highway to your parking lot.");
}

void Game::setTool(const Tool& t)
{
	liftStart.reset();
	moveId.reset();
	switch (t.kind)
	{
	case ToolKind::Demolish:
	case ToolKind::ClearTrees:
	case ToolKind::PlantTrees:
	case ToolKind::Shape:
		tool = t.kind;
		draft.clear();
		selected.reset();
		lastBrush.reset();
		return;
	case ToolKind::Road:
	case ToolKind::Path:
		tool = t.kind;
		draft.clear();
		selected.reset();
		return;
	case ToolKind::Trail:
		trailKind = t.trail;
		tool = ToolKind::Cut;
		draft.clear();
		selected.reset();
		return;
	case ToolKind::Feature:
		tool = ToolKind::Feature;
		toolFeature = t.feature;
		draft.clear();
		selected.reset();
		return;
	case ToolKind::Lift:
		if (static_cast<int>(lifts.size()) >= maxLifts())
		{
			toast(std::to_string(maxLifts()) + " lifts is the limit for this mountain.", true);
			return;
		}
		tool = ToolKind::Lift;
		toolLift = t.lift;
		draft.clear();
		selected.reset();
		return;
	case ToolKind::Move:
		return;
	case ToolKind::Build:
	{
		const BuildingType b = t.building;
		if (tier() < UnlockTier(b))
		{
			const int need = UnlockTier(b);
			toast(need <= 1 ? std::string(Label(b)) + "s unlock after your first peak."
							: std::string(Label(b)) + "s unlock once you're a " + Lower(kTiers[need].name) + " (" +
					std::to_string(kTiers[need].peaksNeeded) + " peaks).",
				true);
			return;
		}
		if (count(b) >= Info(b).max)
		{
			toast("That's as many " + Lower(Label(b)) + "s as this hill needs.", true);
			return;
		}
		tool = ToolKind::Build;
		toolBuilding = b;
		draft.clear();
		selected.reset();
		return;
	}
	case ToolKind::Select:
	case ToolKind::Cut:
		tool = t.kind;
		draft.clear();
		if (t.kind != ToolKind::Select) selected.reset();
		return;
	}
}

void Game::setSpeed(double n)
{
	speed = n;
	if (n > 0) paused = false;
}

void Game::togglePause() { paused = !paused; }

void Game::setTicketPrice(double n)
{
	if (!has(BuildingType::Lodge)) return;
	ticketPrice = Clamp(JsRound(n), 18, 88);
}

void Game::cancel()
{
	tool = ToolKind::Select;
	draft.clear();
	liftStart.reset();
	moveId.reset();
}

// ---------- moving buildings

double Game::moveFee(const Building& b) const { return moveFeeOn ? JsRound((Cost(b.type) * kMoveFee) / 10) * 10 : 0; }

Building* Game::movingBuilding()
{
	if (tool != ToolKind::Move || !moveId) return nullptr;
	for (Building& b : buildings)
		if (b.id == *moveId) return &b;
	return nullptr;
}

void Game::startMove(int buildingId)
{
	const Building* found = findBuilding(buildingId);
	if (!found) return;
	cancel();
	tool = ToolKind::Move;
	moveId = buildingId;
	const double fee = moveFee(*found);
	toast("Click a new spot for the " + Lower(Label(found->type)) + (fee ? " " SKI_DOT " $" + Num(fee) + " to move" : " " SKI_DOT " moving is free") + ".");
}

std::optional<std::string> Game::canMoveTo(double x, double y)
{
	const Building* b = movingBuilding();
	if (!b) return "Pick a building first.";
	return canPlace(b->type, x, y, b->id, moveFee(*b));
}

ClickResult Game::clickMove(double x, double y)
{
	if (!movingBuilding()) return ClickResult::None;
	if (std::optional<std::string> err = canMoveTo(x, y))
	{
		toast(*err, true);
		return ClickResult::Shake;
	}
	Building* b = movingBuilding();
	const double fee = moveFee(*b);
	money -= fee;
	b->x = x;
	b->y = y;
	if (Parking(b->type)) b->angle = parkingAngle(b->type, x, y);
	gradePad(*b);
	clearTrees();
	if (fee) floatText(x, y, "-" + Int(fee), kCostRed);
	toast(std::string(Label(b->type)) + " moved" + (fee ? " for $" + Num(fee) : "") + ".");
	tool = ToolKind::Select;
	moveId.reset();
	selected = Selection{SelKind::Building, b->id};
	return ClickResult::Ok;
}

// ---------- park features and jumps

/** Where a feature at (x, y) would sit: its run (if any) and travel direction. */
Game::FeatureSpot Game::featureSpot(double x, double y) const
{
	const Trail* best = nullptr;
	double bestD = kInf;
	for (const Trail& t : trails)
	{
		const double d = DistToTrail(t, x, y);
		if (d < bestD)
		{
			bestD = d;
			best = &t;
		}
	}
	if (best && bestD <= Spec(best->kind).width / 2 + 3)
	{
		const NearestOnTrailResult nearest = NearestOnTrail(*best, x, y);
		return {best, std::atan2(nearest.dy, nearest.dx), bestD};
	}
	// Off-piste jump: face down the fall line.
	const double gx = Elevation(x + 3, y) - Elevation(x - 3, y);
	const double gy = Elevation(x, y + 3) - Elevation(x, y - 3);
	return {nullptr, std::atan2(-gy, -gx), bestD};
}

std::optional<std::string> Game::canPlaceFeature(FeatureType type, double x, double y)
{
	const FeatureSpec& spec = Spec(type);
	if (x < 14 || x > kWorldW - 14 || y > kWorldH - 12) return "That's off the property.";
	if (inVillage(x, y)) return "Build features up on the hill.";
	const FeatureSpot spot = featureSpot(x, y);
	if (spec.parkOnly && (!spot.trail || spot.trail->kind != TrailKind::Park))
		return std::string(spec.label) + "s go inside a terrain park. Cut a park run first.";
	if (!spot.trail) return "Put jumps on a run " SKI_DASH " skiers only ski designated trails.";
	const double gap = type == FeatureType::Halfpipe ? 70 : 16;
	for (const Feature& f : features)
		if (std::hypot(f.x - x, f.y - y) < (f.type == FeatureType::Halfpipe ? 70 : gap)) return "Too close to another feature.";
	for (const Building& b : buildings)
		if (std::hypot(b.x - x, b.y - y) < 24) return "A building is in the way.";
	if (nearLift(x, y, 14)) return "Keep clear of the lift line.";
	if (money < spec.cost) return "Need $" + Num(spec.cost - money) + " more.";
	return std::nullopt;
}

double Game::featureAngle(double x, double y) { return featureSpot(x, y).angle; }

ClickResult Game::clickFeature(FeatureType type, double x, double y)
{
	if (std::optional<std::string> err = canPlaceFeature(type, x, y))
	{
		toast(*err, true);
		return ClickResult::Shake;
	}
	const FeatureSpec& spec = Spec(type);
	const FeatureSpot spot = featureSpot(x, y);
	money -= spec.cost;
	Feature f;
	f.id = id();
	f.type = type;
	f.x = x;
	f.y = y;
	f.angle = spot.angle;
	if (spot.trail) f.trailId = spot.trail->id;
	const std::string where = spot.trail ? spot.trail->name : "the hill";
	features.push_back(f);
	clearTrees();
	floatText(x, y, "-" + Int(spec.cost), kCostRed);
	toast(std::string(spec.label) + " built on " + where + ".");
	return ClickResult::Ok;
}

bool Game::nearLift(double x, double y, double pad) const
{
	for (const Lift& l : lifts)
		if (NearSegment(l.bottom.x, l.bottom.y, l.top.x, l.top.y, x, y, pad)) return true;
	return false;
}

/**
 * Can a lift of this type run from bottom station `a` to top station `b`?
 * Surface lifts (carpet, T-bar) drag people over the snow, so the ground itself
 * must climb the whole way and stay under the type's max pitch. Chairs and
 * gondolas fly, so they only need the top above the bottom.
 */
LiftCheck Game::checkLift(LiftType type, const Vec2& a, const Vec2& b) const
{
	const LiftSpec& spec = Spec(type);
	LiftCheck out;
	out.length = std::hypot(b.x - a.x, b.y - a.y);
	const double eA = Elevation(a.x, a.y);
	const double eB = Elevation(b.x, b.y);
	out.rise = (eB - eA) * kVerticalM;
	out.cost = LiftCost(type, out.length);
	const double length = out.length;
	auto fail = [&out](const std::string& error) {
		out.error = error;
		return out;
	};
	const std::string noun = LiftNoun(type);
	auto offProperty = [](const Vec2& p) { return p.x < 14 || p.x > kWorldW - 14 || p.y < 30 || p.y > kWorldH - 12; };
	if (offProperty(a) || offProperty(b)) return fail("That's off the property.");
	if (static_cast<int>(lifts.size()) >= maxLifts()) return fail(std::to_string(maxLifts()) + " lifts is the limit for this mountain.");
	if (length < spec.minLength) return fail("Too short " SKI_DASH " a " + noun + " needs at least " + Int(spec.minLength * kUnitM) + " m.");
	if (length > spec.maxLength) return fail("Too long " SKI_DASH " a " + noun + " tops out at " + Int(spec.maxLength * kUnitM) + " m.");
	if (eB - eA < 0.012)
	{
		return fail(spec.surface ? "A " + noun + " can't go downhill " SKI_DASH " put the top station uphill of the bottom."
								 : std::string("Lifts carry skiers up " SKI_DASH " put the top station higher than the bottom."));
	}
	if (spec.surface)
	{
		const int n = std::max(4, static_cast<int>(std::ceil(length / 3)));
		std::vector<double> es;
		for (int i = 0; i <= n; i++)
		{
			const double t = static_cast<double>(i) / n;
			es.push_back(Elevation(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
		}
		// Pitch over ~12-unit windows so tiny bumps don't count.
		const int w = std::max(1, static_cast<int>(JsRound(12 / (length / n))));
		for (int i = w; i <= n; i++)
		{
			const double grade = ((es[i] - es[i - w]) * kVerticalM) / (((length / n) * w) * kUnitM);
			if (grade > spec.maxGrade)
			{
				return fail(type == LiftType::Carpet ? "Too steep for a magic carpet " SKI_DASH " keep it on gentle beginner terrain."
													 : "Too steep for a T-bar " SKI_DASH " this pitch needs a chairlift.");
			}
		}
		double highest = eA;
		for (int i = 1; i <= n; i++)
		{
			if (es[i] < highest - 0.004)
				return fail("The ground dips along this line " SKI_DASH " a " + noun + " rides on the snow, so it has to climb the whole way.");
			highest = std::max(highest, es[i]);
		}
	}
	for (const Building& bd : buildings)
		if (NearSegment(a.x, a.y, b.x, b.y, bd.x, bd.y, 16)) return fail("A building is in the way.");
	for (const Lift& l : lifts)
	{
		if (SegmentsCross(a, b, l.bottom, l.top)) return fail("That would cross " + l.name + ".");
		const bool close = NearSegment(l.bottom.x, l.bottom.y, l.top.x, l.top.y, a.x, a.y, 12) ||
			NearSegment(l.bottom.x, l.bottom.y, l.top.x, l.top.y, b.x, b.y, 12) ||
			NearSegment(a.x, a.y, b.x, b.y, l.bottom.x, l.bottom.y, 12) || NearSegment(a.x, a.y, b.x, b.y, l.top.x, l.top.y, 12);
		if (close) return fail("Too close to " + l.name + "'s line.");
		if (std::hypot(l.bottom.x - a.x, l.bottom.y - a.y) < 18 || std::hypot(l.top.x - b.x, l.top.y - b.y) < 18)
			return fail("Too close to " + l.name + "'s station.");
	}
	if (money < out.cost) return fail("Need $" + Num(out.cost - money) + " more.");
	return out;
}

ClickResult Game::clickLift(LiftType type, double x, double y)
{
	const LiftSpec& spec = Spec(type);
	if (!liftStart)
	{
		if (x < 14 || x > kWorldW - 14 || y < 30 || y > kWorldH - 12)
		{
			toast("That's off the property.", true);
			return ClickResult::Shake;
		}
		for (const Building& b : buildings)
		{
			if (std::hypot(b.x - x, b.y - y) < 18)
			{
				toast("A building is in the way.", true);
				return ClickResult::Shake;
			}
		}
		liftStart = Vec2{x, y};
		toast("Bottom station set. Now click uphill for the top of the " + LiftNoun(type) + ".");
		return ClickResult::Ok;
	}
	const Vec2 a = *liftStart;
	const Vec2 b{x, y};
	const LiftCheck lc = checkLift(type, a, b);
	if (lc.error)
	{
		toast(*lc.error, true);
		return ClickResult::Shake;
	}
	money -= lc.cost;
	std::set<std::string> used;
	for (const Lift& l : lifts) used.insert(l.name);
	std::string name = pickOne(kLiftPrefix) + " " + spec.shortName;
	for (int i = 0; i < 20 && used.count(name); i++) name = pickOne(kLiftPrefix) + " " + spec.shortName;
	lifts.push_back(makeLift(type, name, a, b));
	const int liftId = lifts.back().id;
	trailsChanged();
	clearTrees();
	checkConquest();
	floatText(a.x, a.y, "-" + Int(lc.cost), kCostRed);
	toast(name + " is spinning. " + spec.label + ", " + Int(lc.length * kUnitM) + " m.");
	liftStart.reset();
	tool = ToolKind::Select;
	selected = Selection{SelKind::Lift, liftId};
	return ClickResult::Ok;
}

void Game::removeLift(int liftId)
{
	auto it = std::find_if(lifts.begin(), lifts.end(), [liftId](const Lift& l) { return l.id == liftId; });
	if (it == lifts.end()) return;
	if (lifts.size() <= 1)
	{
		toast("Keep at least one lift running.", true);
		return;
	}
	const double refund = JsRound(LiftCost(it->type, std::hypot(it->top.x - it->bottom.x, it->top.y - it->bottom.y)) * 0.4);
	const std::string name = it->name;
	lifts.erase(it);
	trailsChanged();
	for (Skier& s : skiers)
	{
		if (s.liftId != liftId) continue;
		s.liftId.reset();
		if (s.state == SkierState::Riding)
		{
			s.state = SkierState::ToTrail;
			s.trailId.reset();
		}
	}
	money += refund;
	selected.reset();
	toast("Took down " + name + ". Salvage +$" + Num(refund) + ".");
}

Lift Game::makeLift(LiftType type, const std::string& name, const Vec2& bottom, const Vec2& top)
{
	const LiftSpec& spec = Spec(type);
	const double len = std::hypot(top.x - bottom.x, top.y - bottom.y);
	const int n = std::max(2, static_cast<int>(JsRound(len / spec.spacing)));
	Lift l;
	l.id = id();
	l.type = type;
	l.name = name;
	l.bottom = bottom;
	l.top = top;
	for (int i = 0; i < n; i++) l.carriers.push_back({static_cast<double>(i) / n, {}});
	return l;
}

std::vector<const Trail*> Game::trailsFrom(const Lift& l) const
{
	const double topE = Elevation(l.top.x, l.top.y);
	std::vector<const Trail*> out;
	for (const Trail& t : trails)
	{
		const Vec2& p = t.points[0];
		if (std::hypot(p.x - l.top.x, p.y - l.top.y) < 250 && Elevation(p.x, p.y) < topE + 0.04) out.push_back(&t);
	}
	return out;
}

std::optional<TrailMeasure> Game::draftInfo() const
{
	if (draft.size() < 2)
	{
		if (draft.size() == 1) return TrailMeasure{0, 0, 0, TrailCost(0, trailKind)};
		return std::nullopt;
	}
	return MeasureTrail(draft, trailKind);
}

/** The base village: a circle around the base that grows with the resort tier. */
double Game::villageRadius() const { return kTiers[tier()].villageRadius; }

bool Game::inVillage(double x, double y) const { return std::hypot(x - kBase.x, y - kBase.y) < villageRadius(); }

bool Game::villageOk(double x, double y) const { return inVillage(x, y) && GradeAt(x, y) < 0.25; }

/** Roads joined up to the highway (they share points with it, directly or through other roads). */
const std::set<int>& Game::connectedRoads()
{
	if (connCacheVersion == roadVersion) return connCacheIds;
	auto key = [](const Vec2& p) {
		return (static_cast<int64_t>(JsRound(p.x * 2)) << 32) ^ (static_cast<int64_t>(JsRound(p.y * 2)) & 0xffffffff);
	};
	std::unordered_map<int64_t, std::vector<const Road*>> byPoint;
	for (const Road& r : roads)
		for (const Vec2& p : r.points) byPoint[key(p)].push_back(&r);
	std::set<int> ids;
	std::vector<const Road*> stack;
	for (const Road& r : roads)
		if (r.highway) stack.push_back(&r);
	while (!stack.empty())
	{
		const Road* r = stack.back();
		stack.pop_back();
		if (ids.count(r->id)) continue;
		ids.insert(r->id);
		for (const Vec2& p : r->points)
			for (const Road* o : byPoint[key(p)])
				if (!ids.count(o->id)) stack.push_back(o);
	}
	connCacheIds = ids;
	connCacheVersion = roadVersion;
	return connCacheIds;
}

/** Nearest point on a road that reaches the highway, within `reach` of a spot. */
std::optional<Game::RoadNear> Game::connectedRoadNear(double x, double y, double reach)
{
	const std::set<int>& ids = connectedRoads();
	std::optional<RoadNear> best;
	for (const Road& r : roads)
	{
		if (!ids.count(r.id)) continue;
		const NearestOnRoad n = NearestOnPolyline(r.points, x, y);
		if (n.d < reach && (!best || n.d < best->d)) best = RoadNear{&r, n.p, n.seg, n.d};
	}
	return best;
}

/** Every parking lot (the starter lot plus any built), with whether cars can reach it. */
std::vector<ParkingLot> Game::parkingLots()
{
	const Vec2 ex = exit();
	std::vector<ParkingLot> out;
	out.push_back({ex.x, ex.y, kStarterLotSkiers, starterLotConnected(), std::nullopt});
	for (const Building& b : buildings)
	{
		const ParkingSpec* spec = Parking(b.type);
		if (!spec) continue;
		out.push_back({b.x, b.y, spec->skiers, connectedRoadNear(b.x, b.y, spec->radius + kParkingReach).has_value(), b.id});
	}
	return out;
}

bool Game::starterLotConnected()
{
	// Cached per road network: a route search is cheap but this is asked every tick.
	if (starterCacheVersion != roadVersion)
	{
		starterCacheValue = RouteTo(roads, exit()).has_value();
		starterCacheVersion = roadVersion;
	}
	return starterCacheValue;
}

/** Skiers the reachable parking can take. */
int Game::parkingCapacity()
{
	int n = 0;
	for (const ParkingLot& l : parkingLots())
		if (l.connected) n += l.skiers;
	return n;
}

/** Line a lot up with the nearest road (or face the village if there isn't one). */
double Game::parkingAngle(BuildingType type, double x, double y) const
{
	const ParkingSpec* spec = Parking(type);
	bool found = false;
	Vec2 ba, bb;
	double bd = kInf;
	for (const Road& r : roads)
	{
		const NearestOnRoad n = NearestOnPolyline(r.points, x, y);
		if (!found || n.d < bd)
		{
			found = true;
			ba = r.points[n.seg];
			bb = n.seg + 1 < static_cast<int>(r.points.size()) ? r.points[n.seg + 1] : r.points[n.seg];
			bd = n.d;
		}
	}
	if (!found || !spec || bd > spec->radius + kParkingReach * 2) return std::atan2(kBase.y - y, kBase.x - x) + kPi / 2;
	return std::atan2(bb.y - ba.y, bb.x - ba.x);
}

/** Placement rules for parking: beside a road, off it, on gentle ground. */
std::optional<std::string> Game::parkingError(BuildingType type, double x, double y, const std::vector<const Building*>& others)
{
	const ParkingSpec& spec = *Parking(type);
	if (x < spec.radius || x > kWorldW - spec.radius || y < spec.radius || y > kWorldH - spec.radius) return "That's off the property.";
	// Sample the footprint: it has to be gradable, and not rock.
	double worst = 0;
	const int offsets[5][2] = {{0, 0}, {1, 0}, {-1, 0}, {0, 1}, {0, -1}};
	for (const auto& o : offsets)
	{
		const double px = x + o[0] * spec.w * 0.4;
		const double py = y + o[1] * spec.d * 0.4;
		worst = std::max(worst, GradeAt(px, py));
		if (IsRock(px, py)) return "That's bare rock.";
	}
	if (worst > spec.maxGrade)
	{
		return std::string("Too steep for ") + (type == BuildingType::Garage ? "a garage" : "a lot") + " (" + Int(worst * 100) + "%, max " +
			Int(spec.maxGrade * 100) + "%).";
	}
	for (const Building* b : others)
		if (std::hypot(b->x - x, b->y - y) < spec.radius + BuildingRadius(b->type) + 6) return "Too close to another building.";
	const Vec2 ex = exit();
	if (std::hypot(ex.x - x, ex.y - y) < spec.radius + 80) return "Too close to the main parking lot.";
	for (const Trail& t : trails)
		if (DistToTrail(t, x, y) < spec.radius + 12) return "Don't put parking on a run.";
	if (nearLift(x, y, spec.radius + 10)) return "Keep clear of the lift line.";
	if (nearRoad(x, y, spec.radius - 6)) return "Keep the lot off the road itself.";
	if (!nearRoad(x, y, spec.radius + kParkingReach)) return "Put parking right beside a road.";
	return std::nullopt;
}

// ---------- shaping the ground

/** Regrade the pad under a building to the median height of its footprint. */
void Game::gradePad(const Building& b)
{
	const PadResult r = FlattenPad(b.x, b.y, BuildingRadius(b.type));
	if (r.volume > 0) terrainEdited(r.box);
}

/** After the ground changes: re-rate runs that cross it, and re-seat the forest. */
void Game::terrainEdited(const Box& box)
{
	for (Trail& t : trails)
	{
		bool inside = false;
		for (const Vec2& p : t.points)
			if (p.x > box.x0 - 40 && p.x < box.x1 + 40 && p.y > box.y0 - 40 && p.y < box.y1 + 40) inside = true;
		if (!inside) continue;
		const TrailMeasure m = MeasureTrail(t.points, t.kind);
		t.length = m.length;
		t.drop = m.drop;
		t.difficulty = m.difficulty;
	}
	terrainEdits++;
	clearTrees();
}

/** Ground under a building (or the starter lot) stays put while you shape around it. */
bool Game::padLocked(double x, double y) const
{
	const Vec2 ex = exit();
	if (std::fabs(x - ex.x) < 90 && std::fabs(y - ex.y) < 50) return true;
	for (const Building& b : buildings)
		if (std::hypot(b.x - x, b.y - y) < BuildingRadius(b.type) + 10) return true;
	return false;
}

/** Brush radius for the current tool (tree brush or shaping). */
double Game::brushRadius() const
{
	if (tool == ToolKind::PlantTrees && plantMode == PlantMode::Single) return 4;
	return tool == ToolKind::Shape ? shapeRadius : kBrushR;
}

void Game::setShapeMode(SculptMode mode)
{
	shapeMode = mode;
	shapeTarget.reset();
}

/** One frame of the shaping brush held down at (x, y). */
void Game::shapeStep(double x, double y, double dt)
{
	if (!managing || tool != ToolKind::Shape) return;
	if (!shapeTarget) shapeTarget = ElevationM(x, y);
	const double amount = shapeMode == SculptMode::Raise || shapeMode == SculptMode::Lower ? kShapeRateM * dt : std::min(1.0, 2.5 * dt);
	// Stop when the money runs out.
	if (!freeShaping && money <= 0)
	{
		if (!shapeBroke) toast("Out of money for earthworks.", true);
		shapeBroke = true;
		return;
	}
	const EditResult r = Sculpt(x, y, shapeRadius, shapeMode, amount, *shapeTarget, [this](double px, double py) { return padLocked(px, py); });
	if (r.volume <= 0) return;
	const double cost = freeShaping ? 0 : r.volume * kEarthCostPerM3;
	money -= cost;
	shapeCost += cost;
	shapeVolume += r.volume;
	shapeAt = Vec2{x, y};
	// Earthworks bulldoze the forest they pass over.
	if (!shapeCleared || std::hypot(shapeCleared->x - x, shapeCleared->y - y) > shapeRadius * 0.4)
	{
		addClearing(x, y, shapeRadius * 0.85);
		shapeCleared = Vec2{x, y};
	}
	terrainEdited(r.box);
}

/** Let go of the shaping brush: show what the stroke moved and cost. */
void Game::endShape()
{
	if (shapeAt && shapeCost >= 1) floatText(shapeAt->x, shapeAt->y, "-$" + Num(shapeCost), kCostRed);
	shapeTarget.reset();
	shapeCost = 0;
	shapeVolume = 0;
	shapeAt.reset();
	shapeBroke = false;
	shapeCleared.reset();
}

/** What a demolish click at this spot would take down (closest thing wins). */
std::optional<DemolishTarget> Game::demolishTarget(double x, double y)
{
	std::optional<DemolishTarget> best;
	double bestD = kInf;
	auto offer = [&](const DemolishTarget& t, double d) {
		if (d < bestD)
		{
			bestD = d;
			best = t;
		}
	};
	for (const Building& b : buildings)
	{
		const double d = std::hypot(b.x - x, b.y - y);
		// Buildings win ties: they sit on top of everything else.
		if (d < BuildingRadius(b.type) + 2) offer({DemolishKind::Building, b.id, Label(b.type), JsRound(Cost(b.type) * kSalvage)}, d - 8);
	}
	for (const Feature& f : features)
	{
		const double d = std::hypot(f.x - x, f.y - y);
		if (d < 14) offer({DemolishKind::Feature, f.id, Spec(f.type).label, JsRound(Spec(f.type).cost * kSalvage)}, d - 4);
	}
	for (const Lift& l : lifts)
	{
		const double d = NearestOnPolyline({l.bottom, l.top}, x, y).d;
		if (d < 18)
		{
			const double refund = JsRound(LiftCost(l.type, std::hypot(l.top.x - l.bottom.x, l.top.y - l.bottom.y)) * kSalvage);
			offer({DemolishKind::Lift, l.id, l.name, refund}, d);
		}
	}
	for (const Trail& t : trails)
	{
		const double d = DistToTrail(t, x, y);
		if (d < Spec(t.kind).width / 2 + 4) offer({DemolishKind::Trail, t.id, t.name, 0}, d + 2);
	}
	for (const Road& r : roads)
	{
		if (r.highway) continue;
		const double d = NearestOnPolyline(r.points, x, y).d;
		if (d < kRoadWidth / 2 + 6) offer({DemolishKind::Road, r.id, "Road", JsRound(RoadLength(r.points) * kRoadCostPerM * 0.25)}, d);
	}
	for (const Path& pth : paths)
	{
		const double d = NearestOnPolyline(pth.points, x, y).d;
		if (d < kPathWidth / 2 + 5) offer({DemolishKind::Path, pth.id, "Path", JsRound(RoadLength(pth.points) * kPathCostPerM * 0.25)}, d + 1);
	}
	return best;
}

/** Leave the ground a demolished thing stood on cleared (the forest doesn't spring back). */
void Game::stampClearing(const std::vector<Vec2>& points, double r)
{
	for (size_t i = 0; i < points.size(); i++)
	{
		const Vec2 a = points[i];
		const Vec2 b = points[std::min(points.size() - 1, i + 1)];
		const double len = std::hypot(b.x - a.x, b.y - a.y);
		const int n = std::max(1, static_cast<int>(std::ceil(len / (r * 0.9))));
		for (int k = 0; k < n; k++) addClearing(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, r);
	}
}

ClickResult Game::demolishAt(double x, double y)
{
	const std::optional<DemolishTarget> target = demolishTarget(x, y);
	if (!target)
	{
		toast("Nothing to demolish there. Click a building, lift, run, park feature, road or path.", true);
		return ClickResult::Shake;
	}
	const DemolishTarget t = *target;
	if (t.kind == DemolishKind::Lift && lifts.size() <= 1)
	{
		toast("Keep at least one lift running.", true);
		return ClickResult::Shake;
	}
	switch (t.kind)
	{
	case DemolishKind::Building:
	{
		auto it = std::find_if(buildings.begin(), buildings.end(), [&t](const Building& q) { return q.id == t.id; });
		stampClearing({{it->x, it->y}}, BuildingRadius(it->type));
		buildings.erase(it);
		break;
	}
	case DemolishKind::Feature:
	{
		auto it = std::find_if(features.begin(), features.end(), [&t](const Feature& q) { return q.id == t.id; });
		stampClearing({{it->x, it->y}}, it->type == FeatureType::Halfpipe ? 40 : 12);
		features.erase(it);
		break;
	}
	case DemolishKind::Lift:
	{
		auto it = std::find_if(lifts.begin(), lifts.end(), [&t](const Lift& q) { return q.id == t.id; });
		stampClearing({it->bottom, it->top}, 16);
		lifts.erase(it);
		trailsChanged();
		for (Skier& s : skiers)
		{
			if (s.liftId != t.id) continue;
			s.liftId.reset();
			if (s.state == SkierState::Riding || s.state == SkierState::Queue)
			{
				s.state = SkierState::ToTrail;
				s.trailId.reset();
			}
		}
		break;
	}
	case DemolishKind::Trail:
	{
		auto it = std::find_if(trails.begin(), trails.end(), [&t](const Trail& q) { return q.id == t.id; });
		if (it->kind != TrailKind::Glades) stampClearing(it->points, Spec(it->kind).width / 2 + 9);
		trails.erase(it);
		trailsChanged();
		// Park features go with the run they were built on.
		features.erase(std::remove_if(features.begin(), features.end(), [&t](const Feature& f) { return f.trailId == t.id; }), features.end());
		for (Skier& s : skiers)
			if (s.trailId == t.id) s.trailId.reset();
		break;
	}
	case DemolishKind::Path:
		paths.erase(std::remove_if(paths.begin(), paths.end(), [&t](const Path& q) { return q.id == t.id; }), paths.end());
		pathVersion++;
		break;
	case DemolishKind::Road:
	{
		auto it = std::find_if(roads.begin(), roads.end(), [&t](const Road& q) { return q.id == t.id; });
		stampClearing(it->points, kRoadWidth / 2 + 5);
		roads.erase(it);
		roadVersion++;
		break;
	}
	}
	money += t.refund;
	selected.reset();
	clearTrees();
	floatText(x, y, t.refund ? "+$" + Num(t.refund) : "Gone");
	const bool cutOff = t.kind == DemolishKind::Road && !roadConnected();
	toast("Demolished " + (t.kind == DemolishKind::Trail ? SKI_LQUOTE + t.label + SKI_RQUOTE : t.label) + "." +
			(t.refund ? " Salvage +$" + Num(t.refund) + "." : "") +
			(cutOff ? " The parking lot is cut off: no new skiers until it's reconnected." : ""),
		cutOff);
	return ClickResult::Ok;
}

/** Trees the brush would fell at this spot. */
int Game::treesUnderBrush(double x, double y)
{
	int n = 0;
	for (const ForestTree& t : treesIn(x - kBrushR, y - kBrushR, x + kBrushR, y + kBrushR))
		if (std::hypot(t.x - x, t.y - y) < kBrushR) n++;
	return n;
}

/** Fell the trees in a circle (click or drag). */
ClickResult Game::paintClearing(double x, double y)
{
	if (lastBrush && std::hypot(lastBrush->x - x, lastBrush->y - y) < kBrushR * 0.45) return ClickResult::None;
	const int n = treesUnderBrush(x, y);
	if (!n) return ClickResult::None;
	const double cost = freeTreeClearing ? 0 : n * kTreeFellCost;
	if (cost > 0 && money < cost)
	{
		toast("Need $" + Num(cost - money) + " more to clear these trees.", true);
		return ClickResult::Shake;
	}
	money -= cost;
	addClearing(x, y, kBrushR);
	lastBrush = Vec2{x, y};
	treesFelled += n;
	clearTrees();
	strokeCost += cost;
	return ClickResult::Ok;
}

/** Lift the brush: show what the stroke cost, and start the next one fresh. */
void Game::endBrush()
{
	if (lastBrush && strokeCost) floatText(lastBrush->x, lastBrush->y, "-$" + Num(strokeCost), kCostRed);
	strokeCost = 0;
	lastBrush.reset();
}

/** The drive in from the highway to the parking lot, or nothing if there isn't one. */
std::optional<std::vector<Vec2>> Game::carRoute()
{
	std::string key = std::to_string(roadVersion) + ":";
	for (const Building& b : buildings)
		if (Parking(b.type)) key += std::to_string(b.id) + ",";
	if (routeCacheKey != key)
	{
		std::optional<std::vector<Vec2>> route;
		std::vector<ParkingLot> lots;
		for (const ParkingLot& l : parkingLots())
			if (l.connected) lots.push_back(l);
		std::stable_sort(lots.begin(), lots.end(), [](const ParkingLot& p, const ParkingLot& q) { return p.skiers > q.skiers; });
		if (!lots.empty() && !lots[0].id) route = RouteTo(roads, exit());
		else if (!lots.empty())
		{
			// Drive to the road beside the lot, then pull in.
			const ParkingLot lot = lots[0];
			const ParkingSpec* spec = Parking(findBuilding(*lot.id)->type);
			if (const std::optional<RoadNear> nearRoadPt = connectedRoadNear(lot.x, lot.y, spec->radius + kParkingReach))
			{
				const Vec2 a = nearRoadPt->road->points[nearRoadPt->seg];
				const Vec2 b = nearRoadPt->seg + 1 < static_cast<int>(nearRoadPt->road->points.size()) ? nearRoadPt->road->points[nearRoadPt->seg + 1] : a;
				const Vec2 v0 = std::hypot(a.x - nearRoadPt->p.x, a.y - nearRoadPt->p.y) < std::hypot(b.x - nearRoadPt->p.x, b.y - nearRoadPt->p.y) ? a : b;
				if (std::optional<std::vector<Vec2>> to = RouteTo(roads, v0))
				{
					to->push_back({lot.x, lot.y});
					route = to;
				}
			}
		}
		routeCacheKey = key;
		routeCacheRoute = route;
	}
	return routeCacheRoute;
}

bool Game::roadConnected() { return starterLotConnected(); }

bool Game::nearRoad(double x, double y, double pad) const
{
	for (const RoadSeg& s : roadSegsIn(x - pad - 10, y - pad - 10, x + pad + 10, y + pad + 10))
		if (NearSegment(s.a.x, s.a.y, s.b.x, s.b.y, x, y, s.w / 2 + pad)) return true;
	return false;
}

/** Road legs touching a box, with their width (the highway is wider). */
std::vector<Game::RoadSeg> Game::roadSegsIn(double x0, double y0, double x1, double y1) const
{
	std::vector<RoadSeg> out;
	for (const Road& r : roads)
	{
		const double w = r.highway ? kRoadWidth * 1.4 : kRoadWidth;
		for (size_t i = 1; i < r.points.size(); i++)
		{
			const Vec2& a = r.points[i - 1];
			const Vec2& b = r.points[i];
			if (std::max(a.x, b.x) < x0 || std::min(a.x, b.x) > x1 || std::max(a.y, b.y) < y0 || std::min(a.y, b.y) > y1) continue;
			out.push_back({a, b, w});
		}
	}
	return out;
}

/** Snap a click onto the parking lot or the nearest road, if it's close. */
std::optional<Vec2> Game::snapRoad(double x, double y) const
{
	const Vec2 ex = exit();
	if (std::hypot(x - ex.x, y - ex.y) < kRoadSnap * 1.6) return ex;
	std::optional<Vec2> best;
	double bestD = kInf;
	for (const Road& r : roads)
	{
		const NearestOnRoad n = NearestOnPolyline(r.points, x, y);
		if (n.d < kRoadSnap && n.d < bestD)
		{
			best = n.p;
			bestD = n.d;
		}
	}
	return best;
}

Game::DraftInfo Game::roadDraftInfo() const
{
	const double length = RoadLength(draft);
	double grade = 0;
	for (size_t i = 1; i < draft.size(); i++) grade = std::max(grade, LegGrade(draft[i - 1], draft[i]));
	return {length, JsRound(length * kRoadCostPerM), grade};
}

ClickResult Game::clickRoad(double x, double y)
{
	const std::optional<Vec2> snap = snapRoad(x, y);
	if (draft.empty())
	{
		if (!snap)
		{
			toast("Start the road on the highway, another road or the parking lot.", true);
			return ClickResult::Shake;
		}
		draft.push_back(*snap);
		return ClickResult::Ok;
	}
	if (x < 12 || x > kWorldW - 12 || y < 12 || y > kWorldH - 12)
	{
		toast("That's off the map.", true);
		return ClickResult::Shake;
	}
	const Vec2 p = snap ? *snap : Vec2{x, y};
	const Vec2 last = draft.back();
	if (std::hypot(p.x - last.x, p.y - last.y) < kRoadMinLeg) return ClickResult::None;
	const double g = LegGrade(last, p);
	if (g > kRoadMaxGrade)
	{
		toast("Too steep for a road (" + Int(g * 100) + "%, max " + Int(kRoadMaxGrade * 100) + "%). Zig-zag up the slope instead.", true);
		return ClickResult::Shake;
	}
	draft.push_back(p);
	// Reaching another road or the parking lot finishes it.
	if (snap) return finishRoad();
	return ClickResult::Ok;
}

ClickResult Game::finishRoad()
{
	if (draft.size() < 2)
	{
		toast("Click along the way you want the road to go.", true);
		return ClickResult::Shake;
	}
	const DraftInfo info = roadDraftInfo();
	if (money < info.cost)
	{
		toast("Need $" + Num(info.cost - money) + " more for this road.", true);
		return ClickResult::Shake;
	}
	const bool wasConnected = roadConnected();
	std::vector<Vec2> points = draft;
	// Join up: split any road an end of this one lands on, so they share a point.
	for (size_t e : {static_cast<size_t>(0), points.size() - 1})
	{
		Vec2& end = points[e];
		for (Road& r : roads)
		{
			const NearestOnRoad n = NearestOnPolyline(r.points, end.x, end.y);
			if (n.d > 0.5) continue;
			const Vec2 a = r.points[n.seg];
			const Vec2 b = r.points[n.seg + 1];
			if (std::hypot(a.x - end.x, a.y - end.y) < 0.5) end = a;
			else if (std::hypot(b.x - end.x, b.y - end.y) < 0.5) end = b;
			else r.points.insert(r.points.begin() + n.seg + 1, end);
			break;
		}
	}
	money -= info.cost;
	roads.push_back(Road{id(), points, false});
	roadVersion++;
	clearTrees();
	const Vec2 tail = points.back();
	floatText(tail.x, tail.y, "-" + Int(info.cost), kCostRed);
	const bool now = roadConnected();
	toast(now && !wasConnected ? "Road open (" + Int(info.length) + " m). The parking lot is connected: skiers can drive in!"
							   : "Road built: " + Int(info.length) + " m for $" + Num(info.cost) + ".");
	draft.clear();
	tool = ToolKind::Select;
	return ClickResult::Ok;
}

// ---------- footpaths

/** Walking network over the footpaths (rebuilt when they change). */
PathNet& Game::pathNet()
{
	if (!pathNetCache || pathNetVersion != pathVersion)
	{
		pathNetCache = std::make_unique<PathNet>(paths);
		pathNetVersion = pathVersion;
	}
	return *pathNetCache;
}

/**
 * Snap a path click onto something people walk to or from: another path, a
 * building's door, a lift's bottom station, the ticket booth or the lot.
 */
std::optional<Game::PathSnap> Game::snapPath(double x, double y)
{
	std::optional<PathSnap> best;
	double bestD = kInf;
	auto offer = [&](const Vec2& p, double d, double reach) {
		if (d < reach && (!best || d < bestD))
		{
			best = PathSnap{p, true};
			bestD = d;
		}
	};
	for (const Path& pth : paths)
	{
		const NearestOnRoad n = NearestOnPolyline(pth.points, x, y);
		offer(n.p, n.d, kPathSnap);
	}
	for (const Building& b : buildings)
	{
		if (Parking(b.type)) continue;
		offer({b.x, b.y}, std::hypot(b.x - x, b.y - y), BuildingRadius(b.type) + 8);
	}
	for (const Lift& l : lifts) offer(l.bottom, std::hypot(l.bottom.x - x, l.bottom.y - y), 22);
	const Vec2 bo = booth();
	offer(bo, std::hypot(bo.x - x, bo.y - y), 18);
	for (const ParkingLot& lot : parkingLots()) offer({lot.x, lot.y}, std::hypot(lot.x - x, lot.y - y), lot.id ? 30 : 40);
	return best;
}

Game::DraftInfo Game::pathDraftInfo() const
{
	const double length = RoadLength(draft);
	double grade = 0;
	for (size_t i = 1; i < draft.size(); i++) grade = std::max(grade, LegGrade(draft[i - 1], draft[i]));
	return {length, JsRound(length * kPathCostPerM), grade};
}

ClickResult Game::clickPath(double x, double y)
{
	if (x < 12 || x > kWorldW - 12 || y < 12 || y > kWorldH - 12)
	{
		toast("That's off the map.", true);
		return ClickResult::Shake;
	}
	const std::optional<PathSnap> snap = snapPath(x, y);
	const Vec2 p = snap ? snap->p : Vec2{x, y};
	if (draft.empty())
	{
		draft.push_back(p);
		return ClickResult::Ok;
	}
	const Vec2 last = draft.back();
	if (std::hypot(p.x - last.x, p.y - last.y) < kPathMinLeg) return ClickResult::None;
	const double g = LegGrade(last, p);
	if (g > kPathMaxGrade)
	{
		toast("Too steep for a footpath (" + Int(g * 100) + "%, max " + Int(kPathMaxGrade * 100) + "%). Wind it across the slope.", true);
		return ClickResult::Shake;
	}
	draft.push_back(p);
	// Reaching another path, a building, a lift or the lot finishes it.
	if (snap && snap->joins) return finishPath();
	return ClickResult::Ok;
}

ClickResult Game::finishPath()
{
	if (draft.size() < 2)
	{
		toast("Click along the way you want people to walk.", true);
		return ClickResult::Shake;
	}
	const DraftInfo info = pathDraftInfo();
	if (money < info.cost)
	{
		toast("Need $" + Num(info.cost - money) + " more for this path.", true);
		return ClickResult::Shake;
	}
	const std::vector<Vec2> points = draft;
	// Join up: split any path an end lands on, so they share a point.
	for (const Vec2& end : {points.front(), points.back()})
	{
		for (Path& r : paths)
		{
			const NearestOnRoad n = NearestOnPolyline(r.points, end.x, end.y);
			if (n.d > 0.5) continue;
			const Vec2 a = r.points[n.seg];
			if (n.seg + 1 < static_cast<int>(r.points.size()))
			{
				const Vec2 b = r.points[n.seg + 1];
				if (std::hypot(a.x - end.x, a.y - end.y) > 0.5 && std::hypot(b.x - end.x, b.y - end.y) > 0.5)
					r.points.insert(r.points.begin() + n.seg + 1, end);
			}
			break;
		}
	}
	money -= info.cost;
	paths.push_back(Path{id(), points});
	pathVersion++;
	clearTrees();
	const Vec2 tail = points.back();
	floatText(tail.x, tail.y, "-" + Int(info.cost), kCostRed);
	toast("Footpath laid: " + Int(info.length) + " m for $" + Num(info.cost) + ". People on foot will use it.");
	// Stay on the painter so the next path can start right away.
	draft.clear();
	return ClickResult::Ok;
}

/** Off the lift: a lookout close by draws some people over for the view (once a day each). */
void Game::maybeLookout(Skier& s)
{
	if (s.sawView || !has(BuildingType::Lookout)) return;
	const Building* spot = nearestOf({BuildingType::Lookout}, s.x, s.y);
	if (!spot || std::hypot(spot->x - s.x, spot->y - s.y) > kLookoutReach || random() > 0.3) return;
	s.sawView = true;
	s.state = SkierState::Visit;
	s.visitType = BuildingType::Lookout;
	s.wait = 0;
}

/** Walk toward a spot, along the footpaths when that's the better way. */
void Game::walkTo(Skier& s, double x, double y, double step, double dt)
{
	if (paths.empty())
	{
		s.onPath = false;
		walkToward(s, x, y, step);
		return;
	}
	const std::string key = Int(x) + "," + Int(y) + ":" + std::to_string(pathVersion);
	if (s.routeFor != key)
	{
		s.routeFor = key;
		s.route = pathNet().Route({s.x, s.y}, {x, y});
		s.onPath = false;
	}
	if (s.route && !s.route->empty())
	{
		std::vector<Vec2>& r = *s.route;
		const Vec2 wp = r.front();
		walkToward(s, wp.x, wp.y, s.onPath ? step * kPathSpeed : step);
		if (std::hypot(s.x - wp.x, s.y - wp.y) < 1)
		{
			r.erase(r.begin());
			s.onPath = !r.empty();
		}
		// A cleared walkway beats wading through the drifts.
		if (s.onPath) s.mood = std::min(100.0, s.mood + dt * 0.4);
		return;
	}
	s.onPath = false;
	walkToward(s, x, y, step);
}

// ---------- goals and rewards

/** Pay out goals as they're reached, and queue a celebration for each. */
void Game::checkGoals()
{
	for (const Goal& g : goals())
	{
		if (!g.done || goalsPaid.count(g.id)) continue;
		goalsPaid.insert(g.id);
		const double bonus = GoalBonus(g.id);
		money += bonus;
		const int tierIdx = g.id.rfind("tier", 0) == 0 ? std::atoi(g.id.c_str() + 4) : 0;
		Reward r;
		r.id = id();
		r.kind = g.id == "all" ? RewardKind::Win : RewardKind::Goal;
		r.bonus = bonus;
		if (tierIdx)
		{
			const TierDef& t = kTiers[tierIdx];
			r.title = "You're a " + Lower(t.name) + "!";
			r.text = "Room for " + Num(t.capacity) + " skiers and " + std::to_string(t.maxLifts) + " lifts.";
		}
		else
		{
			r.title = g.id == "all" ? "You conquered the mountain!" : "Goal reached";
			r.text = StripPrice(g.text);
		}
		rewards.push_back(r);
	}
}

std::optional<std::string> Game::canPlace(BuildingType type, double x, double y, std::optional<int> ignoreId, std::optional<double> cost)
{
	using BT = BuildingType;
	const bool moving = ignoreId.has_value();
	std::vector<const Building*> others;
	for (const Building& b : buildings)
		if (!ignoreId || b.id != *ignoreId) others.push_back(&b);
	const double price = cost ? *cost : Cost(type);
	const std::string label = Label(type);
	if (!moving && tier() < UnlockTier(type))
	{
		const int need = UnlockTier(type);
		if (need <= 1) return "Conquer your first peak to unlock this.";
		return "Unlocks at " + Lower(kTiers[need].name) + " (" + std::to_string(kTiers[need].peaksNeeded) + " peaks).";
	}
	if (!moving && count(type) >= Info(type).max) return "No more " + Lower(label) + "s on this hill.";
	if (Parking(type))
	{
		if (std::optional<std::string> err = parkingError(type, x, y, others)) return err;
		if (money < price) return "Need $" + Num(price - money) + " more.";
		return std::nullopt;
	}
	const bool anywhere = PlaceAnywhere(type);
	const bool midMountain = PlaceMountain(type);
	if (!anywhere && !midMountain && !villageOk(x, y)) return inVillage(x, y) ? "Too steep to build here." : "Build in the base village.";
	if (type == BT::Cabin && !has(BT::CabinOffice)) return "Open a cabin rental office in the village first.";
	if (midMountain && !anywhere && inVillage(x, y)) return "Put this on the mountain, not in the village.";
	auto runWithin = [&](double reach) {
		for (const Trail& t : trails)
			if (DistToTrail(t, x, y) < reach) return true;
		return false;
	};
	if (type == BT::Cabin && !runWithin(kCabinReach))
		return "Cabins are ski-in / ski-out: put it within " + Int(kCabinReach) + " m of a run.";
	if (x < 12 || x > kWorldW - 12 || y < 24 || y > kWorldH - 12) return "That's off the property.";
	const bool small = Trailside(type);
	if (type == BT::Waffle && !runWithin(60)) return "Put the waffle hut beside a run.";
	const double minGap = small ? 22 : type == BT::Cabin ? 24 : type == BT::Heli ? 60 : type == BT::GrandHotel ? 56 : 38;
	for (const Building* b : others)
		if (std::hypot(b->x - x, b->y - y) < minGap) return "Too close to another building.";
	if (!small && runWithin(18)) return "Don't plant a building on a run.";
	if (small && runWithin(8)) return "Keep the " + Lower(label) + " beside the run, not in the fall line.";
	if (nearLift(x, y, 26)) return "Keep clear of the lift line.";
	if (IsRock(x, y)) return "That's bare rock.";
	if (nearRoad(x, y, small ? 10 : 18)) return "Keep clear of the road.";
	if (money < price) return "Need $" + Num(price - money) + " more.";
	return std::nullopt;
}

ClickResult Game::click(double x, double y)
{
	if (!managing) return ClickResult::None;
	switch (tool)
	{
	case ToolKind::Cut: return clickCut(x, y);
	case ToolKind::Road: return clickRoad(x, y);
	case ToolKind::Path: return clickPath(x, y);
	case ToolKind::Demolish: return demolishAt(x, y);
	case ToolKind::ClearTrees: return paintClearing(x, y);
	case ToolKind::PlantTrees: return paintPlanting(x, y);
	case ToolKind::Shape: return ClickResult::None; // shaping happens while the button is held
	case ToolKind::Move: return clickMove(x, y);
	case ToolKind::Feature: return clickFeature(toolFeature, x, y);
	case ToolKind::Lift: return clickLift(toolLift, x, y);
	case ToolKind::Build: return clickBuild(toolBuilding, x, y);
	case ToolKind::Select:
	case ToolKind::Trail:
		break;
	}
	selected = pickAt(x, y);
	return ClickResult::Ok;
}

void Game::moveHover(double x, double y)
{
	if (tool == ToolKind::Select) hover = pickAt(x, y);
	else hover.reset();
}

Selection Game::pickAt(double x, double y) const
{
	Selection best{SelKind::Hill, 0};
	double bestD = 28;
	for (const Skier& s : skiers)
	{
		const double d = std::hypot(s.x - x, s.y - y);
		if (d < 14 && d < bestD)
		{
			bestD = d;
			best = {SelKind::Skier, s.id};
		}
	}
	for (const Building& b : buildings)
	{
		const double d = std::hypot(b.x - x, b.y - y);
		if (d < std::max(22.0, BuildingRadius(b.type)) && d < bestD)
		{
			bestD = d;
			best = {SelKind::Building, b.id};
		}
	}
	for (const Trail& t : trails)
	{
		const double d = DistToTrail(t, x, y);
		if (d < 24 && d < bestD)
		{
			bestD = d;
			best = {SelKind::Trail, t.id};
		}
	}
	for (const Lift& l : lifts)
		if (NearSegment(l.bottom.x, l.bottom.y, l.top.x, l.top.y, x, y, 16) && 14 < bestD) best = {SelKind::Lift, l.id};
	return best;
}

Game::SelectionText Game::selectionText()
{
	using BT = BuildingType;
	const std::optional<Selection> sel = selected;
	if (!sel || sel->kind == SelKind::Hill)
	{
		return {"Skilandia", std::string(kTiers[tier()].name) + " " SKI_DOT " " + std::to_string(conquered.size()) + "/" +
				std::to_string(Summits().size()) + " peaks conquered. Lifetime take $" + Num(lifetimeEarned) +
				". Run lifts to the high peaks to grow the resort."};
	}
	if (sel->kind == SelKind::Trail)
	{
		const Trail* t = findTrail(sel->id);
		if (!t) return {"Trail", ""};
		const DiffInfo& d = kDiff[t->difficulty];
		int feats = 0;
		for (const Feature& f : features)
			if (f.trailId == t->id) feats++;
		const TrailKindSpec& kind = Spec(t->kind);
		return {std::string(d.name) + ": " + t->name,
			std::string(kind.label) + " " SKI_DOT " " + d.name + " " SKI_DOT " " + Int(t->length * kUnitM) + " m long " SKI_DOT " " +
				Int(t->drop * kVerticalM) + " m drop" + (feats ? " " SKI_DOT " " + Plural(feats, "feature") : "") + ". " + kind.blurb};
	}
	if (sel->kind == SelKind::Building)
	{
		const Building* b = findBuilding(sel->id);
		if (!b) return {"Building", ""};
		const double fee = moveFee(*b);
		const std::string moveText = " Moving it costs " + (fee ? "$" + Num(fee) : std::string("nothing")) + ".";
		if (b->type == BT::Heli)
		{
			int waiting = 0;
			for (const Skier& k : skiers)
				if (k.state == SkierState::HeliWait) waiting++;
			return {Label(BT::Heli),
				"Flies " + std::to_string(kHeli.seats) + " experts at a time into the backcountry for $" + Int(kHeli.fare) +
					" a seat. Fuel $" + Int(kHeli.fuelPerFlight) + " a flight, upkeep $" + Int(OperatingCostPerMin(BT::Heli)) + "/min. " +
					(heli.flying ? std::string("Helicopter is out on a drop.") : std::to_string(waiting) + " waiting on the pad.") +
					" Today: " + std::to_string(heliFlightsToday) + " flights, $" + Num(heliTakeToday) + " in fares." + moveText};
		}
		std::string extra;
		switch (b->type)
		{
		case BT::ParkingSmall: extra = "Room for 120 cars (300 skiers). Earns parking fees as it fills."; break;
		case BT::ParkingLarge: extra = "Room for 400 cars (1,000 skiers). Earns parking fees as it fills."; break;
		case BT::Garage: extra = "Five decks, 2,000 cars (5,000 skiers). Earns parking fees as it fills."; break;
		case BT::Lodge: extra = "Also unlocks ticket prices."; break;
		case BT::Restroom: extra = "Slowest earner, but people stay on the hill."; break;
		case BT::Coffee: extra = "Cafe sales. Faster than a shack, slower than a restaurant."; break;
		case BT::Sandwich: extra = "Solid lunch money."; break;
		case BT::Shack: extra = "Tiny snack hut. Drop it beside a trail or on the summit."; break;
		case BT::Cafeteria: extra = "Tray-line meals. Steady lunch traffic."; break;
		case BT::Bar: extra = "Apr\xC3\xA8s drinks. Guests linger and spend."; break;
		case BT::Hotel: extra = "Overnight guests " SKI_DASH " top earner."; break;
		case BT::Restaurant: extra = "Sit-down meals. Faster than sandwiches."; break;
		case BT::Shop: extra = "Retail on the village street."; break;
		case BT::Condo: extra = "Sold as lodging. Big checks, village only."; break;
		case BT::Hostel: extra = "Budget beds. Cheaper than a hotel, still fills the village."; break;
		case BT::Spa: extra = "Soaks and massages. Guests leave happier."; break;
		case BT::Patrol: extra = "Barely earns. After the first peak you also need hired patrol."; break;
		case BT::Clinic: extra = "Bandages and ice packs. Can sit on the mountain."; break;
		case BT::Rental: extra = "Boots and boards for day-trippers."; break;
		case BT::School: extra = "Lessons for beginners. Needs instructors: " + std::to_string(Staff(StaffRole::Instructor)) + " hired."; break;
		case BT::CabinOffice:
			extra = "Rents out hillside cabins. " + Plural(count(BT::Cabin), "cabin") + " on the books, " + std::to_string(skiInCabins()) +
				" ski-in / ski-out.";
			break;
		case BT::Cabin:
			extra = cabinOnRun({b->x, b->y}) ? "Ski-in / ski-out: guests step out the door onto a run. Fully booked."
											 : "No run within " + Int(kCabinReach) + " m any more, so it rents for a fraction of the price. Cut a run past it.";
			break;
		case BT::Lookout:
		{
			int up = 0;
			for (const Skier& k : skiers)
				if (k.visitType == BT::Lookout) up++;
			extra = "Fire pits and benches with a view. " + std::to_string(up) + " people up here now. Skiers stop by from lifts within " +
				Int(kLookoutReach) + " m.";
			break;
		}
		default: extra = Info(b->type).blurb; break;
		}
		return {Label(b->type), "Earns $" + Int(Info(b->type).incomePerMin) + "/min when the hill is busy. " + extra + moveText};
	}
	if (sel->kind == SelKind::Lift)
	{
		const Lift* l = findLift(sel->id);
		if (!l) return {"Lift", ""};
		const LiftSpec& spec = Spec(l->type);
		int q = 0;
		for (const Skier& s : skiers)
			if (s.liftId == l->id && s.state == SkierState::Queue) q++;
		const double len = std::hypot(l->top.x - l->bottom.x, l->top.y - l->bottom.y);
		const double rise = (Elevation(l->top.x, l->top.y) - Elevation(l->bottom.x, l->bottom.y)) * kVerticalM;
		const double perHour = JsRound(((spec.seats * spec.speed) / spec.spacing) * 3600 / 6);
		const int servedRuns = static_cast<int>(trailsFrom(*l).size());
		return {l->name, std::string(spec.label) + " " SKI_DOT " " + Int(len * kUnitM) + " m long " SKI_DOT " " + Int(rise) +
				" m rise " SKI_DOT " about " + Num(perHour) + " riders/hr. " + std::to_string(q) + " in line. Serves " + Plural(servedRuns, "run") +
				" from the top."};
	}
	const Skier* s = findSkier(sel->id);
	if (!s) return {"Skier", ""};
	return {s->name, std::string(kDiff[s->skill].name) + " skier " SKI_DOT " mood " + Int(s->mood) + " " SKI_DOT " " + Plural(s->runsDone, "run") + " today."};
}

/** First rocky spot on a run leg (centre and both sides), or nothing if it's clear. */
std::optional<Vec2> Game::rockOnLeg(const Vec2& a, const Vec2& b, double width) const
{
	const double len = std::hypot(b.x - a.x, b.y - a.y);
	const int n = std::max(1, static_cast<int>(std::ceil(len / 7)));
	const double l = len == 0 ? 1 : len;
	const double ux = (b.x - a.x) / l;
	const double uy = (b.y - a.y) / l;
	for (int i = 0; i <= n; i++)
	{
		const double t = static_cast<double>(i) / n;
		for (double side : {0.0, -0.35, 0.35})
		{
			const double x = a.x + (b.x - a.x) * t - uy * width * side;
			const double y = a.y + (b.y - a.y) * t + ux * width * side;
			if (IsRock(x, y)) return Vec2{x, y};
		}
	}
	return std::nullopt;
}

ClickResult Game::clickCut(double x, double y)
{
	if (draft.empty())
	{
		if (ElevationM(x, y) < ElevationM(kBase.x, kBase.y) + 40)
		{
			toast("Start the cut higher on the mountain.", true);
			return ClickResult::Shake;
		}
		if (IsRock(x, y))
		{
			toast("That's bare rock. Start the run on snow.", true);
			return ClickResult::Shake;
		}
		draft.push_back({x, y});
		return ClickResult::Ok;
	}
	const Vec2 last = draft.back();
	const double step = std::hypot(x - last.x, y - last.y);
	if (step < 16) return ClickResult::None;
	const double up = Elevation(x, y) - Elevation(last.x, last.y);
	if (up > 0.018)
	{
		toast("Runs have to go downhill.", true);
		return ClickResult::Shake;
	}
	if (rockOnLeg(last, {x, y}, Spec(trailKind).width))
	{
		toast("Rocks in the way. Route the run around the outcrop.", true);
		return ClickResult::Shake;
	}
	draft.push_back({x, y});
	return ClickResult::Ok;
}

ClickResult Game::finishTrail()
{
	if (tool == ToolKind::Road) return finishRoad();
	if (tool == ToolKind::Path) return finishPath();
	if (draft.size() < 2)
	{
		toast("Click a few downhill points first.", true);
		return ClickResult::Shake;
	}
	const TrailKind kind = trailKind;
	const TrailMeasure info = MeasureTrail(draft, kind);
	if (info.length < 120)
	{
		toast("That run is too short to groom.", true);
		return ClickResult::Shake;
	}
	if (kind == TrailKind::Glades)
	{
		const int inside = treesAlong(draft, Spec(TrailKind::Glades).width / 2);
		if (inside < info.length / 20)
		{
			toast("Glades need forest. Draw this one through the trees.", true);
			return ClickResult::Shake;
		}
	}
	if (money < info.cost)
	{
		toast("Need $" + Num(info.cost - money) + " more to cut this.", true);
		return ClickResult::Shake;
	}
	money -= info.cost;
	const std::string name = freshTrailName(kind);
	const Trail trail = makeTrail(name, draft, kind);
	const double half = Spec(kind).width / 2 + 9;
	const int before = treesAlong(trail.points, half);
	trails.push_back(trail);
	trailsChanged();
	const int felled = before - treesAlong(trail.points, half);
	clearTrees();
	floatText(draft[0].x, draft[0].y, "-" + Int(info.cost), kCostRed);
	toast(std::string(kDiff[info.difficulty].name) + " " + Lower(Spec(kind).label) + " " SKI_LQUOTE + name + SKI_RQUOTE " is open. " +
		std::to_string(felled) + " trees cleared.");
	draft.clear();
	tool = ToolKind::Select;
	selected = Selection{SelKind::Trail, trail.id};
	return ClickResult::Ok;
}

std::string Game::freshTrailName(TrailKind kind)
{
	static const std::vector<std::string> kSlalom = {"Slalom", "Gates", "Race Course"};
	static const std::vector<std::string> kMoguls = {"Bumps", "Moguls", "Washboard"};
	static const std::vector<std::string> kPark = {"Park", "Terrain Park", "Jib Park"};
	static const std::vector<std::string> kGlades = {"Glades", "Trees", "Woods"};
	const std::vector<std::string>& suffix = kind == TrailKind::Slalom ? kSlalom
		: kind == TrailKind::Moguls                                    ? kMoguls
		: kind == TrailKind::Park                                      ? kPark
		: kind == TrailKind::Glades                                    ? kGlades
																	   : kTrailSuffix;
	for (int i = 0; i < 40; i++)
	{
		const std::string prefix = pickOne(kTrailPrefix);
		const std::string name = prefix + " " + pickOne(suffix);
		if (!usedTrailNames.count(name))
		{
			usedTrailNames.insert(name);
			return name;
		}
	}
	return "Run " + std::to_string(trails.size() + 1);
}

ClickResult Game::clickBuild(BuildingType type, double x, double y)
{
	using BT = BuildingType;
	if (std::optional<std::string> err = canPlace(type, x, y))
	{
		toast(*err, true);
		return ClickResult::Shake;
	}
	money -= Cost(type);
	Building b;
	b.id = id();
	b.type = type;
	b.x = x;
	b.y = y;
	if (Parking(type)) b.angle = parkingAngle(type, x, y);
	buildings.push_back(b);
	gradePad(b);
	clearTrees();
	floatText(x, y, "-" + Int(Cost(type)), kCostRed);
	tool = ToolKind::Select;
	selected = Selection{SelKind::Building, b.id};
	const std::string label = Label(type);
	if (type == BT::CabinOffice)
		toast("Cabin rental office is open. Build ski-in cabins beside your runs (Resort menu); each earns $" + Int(Info(BT::Cabin).incomePerMin) + "/min.");
	else if (type == BT::Lodge)
		toast("Lodge is open. Earns $" + Int(Info(BT::Lodge).incomePerMin) + "/min and unlocks ticket prices.");
	else if (type == BT::Heli)
		toast("Heli-ski base is open. Experts pay $" + Int(kHeli.fare) + " a seat; it costs $" + Int(OperatingCostPerMin(BT::Heli)) + "/min to run.");
	else if (const ParkingSpec* spec = Parking(type))
	{
		bool connected = false;
		for (const ParkingLot& l : parkingLots())
			if (l.id == b.id) connected = l.connected;
		toast(label + " is open: room for " + Num(spec->skiers) + " more skiers (" + Num(spec->cars) + " cars)." +
			(connected ? "" : " Connect it to a road so cars can reach it."));
	}
	else toast(label + " is open. Earns $" + Int(Info(type).incomePerMin) + "/min.");
	return ClickResult::Ok;
}

/** The reachable lot with the most room left (the starter lot if nothing is reachable). */
Vec2 Game::pickLot()
{
	std::map<std::pair<double, double>, int> parked;
	for (const Skier& s : skiers) parked[{s.lot.x, s.lot.y}]++;
	Vec2 best = exit();
	double room = -kInf;
	for (const ParkingLot& l : parkingLots())
	{
		if (!l.connected) continue;
		auto it = parked.find({l.x, l.y});
		const double free = (l.skiers - (it == parked.end() ? 0 : it->second)) / static_cast<double>(l.skiers);
		if (free > room)
		{
			room = free;
			best = {l.x, l.y};
		}
	}
	return best;
}

void Game::spawnSkier(bool freeTicket)
{
	const Vec2 lot = pickLot();
	const double skillRoll = random();
	Difficulty skill = 0;
	const Variety v = variety();
	if (skillRoll > 0.82 && (v.counts[2] + v.counts[3] > 0 || random() < 0.25)) skill = 3;
	else if (skillRoll > 0.58) skill = 2;
	else if (skillRoll > 0.3) skill = 1;
	Skier s;
	s.id = id();
	s.name = pickOne(kNames);
	s.skill = skill;
	s.color = static_cast<int>(random() * kJackets.size());
	// Out of a car in the parking lot.
	s.x = lot.x - 30 + random() * 60;
	s.y = lot.y - 15 + random() * 30;
	s.lot = lot;
	s.state = SkierState::Arriving;
	const double r = random();
	s.likes = r < 0.55 ? TrailKind::Slope : r < 0.75 ? TrailKind::Park : r < 0.88 ? TrailKind::Moguls : TrailKind::Slalom;
	s.runsLeft = 6 + static_cast<int>(random() * 9);
	s.mood = 70;
	s.paid = freeTicket;
	s.needBath = 0.15 + random() * 0.2;
	s.needFood = 0.1 + random() * 0.2;
	skiers.push_back(s);
}

void Game::tick(double dt)
{
	const double capped = std::min(dt, 0.05) * (paused ? 0 : speed);
	if (capped <= 0)
	{
		ageToasts(dt);
		return;
	}
	if (managing)
	{
		goalCheckT -= capped;
		if (goalCheckT <= 0)
		{
			goalCheckT = 1;
			checkGoals();
		}
		const bool snowing = weather().snow > 0.15;
		dayT += capped;
		if (dayT >= 52)
		{
			dayT = 0;
			day += 1;
			ticketsToday = 0;
			incomeToday = 0;
			shopIncomeToday = 0;
			wagesToday = 0;
			upkeepToday = 0;
			heliFlightsToday = 0;
			heliTakeToday = 0;
			for (Skier& k : skiers) k.sawView = false;
			toast("Day " + std::to_string(day) + " in Skilandia.");
		}
		const Weather wNow = weather();
		// A day is 52 game seconds: a half-day storm leaves 20-30 cm, which settles and gets skied off over a day or two.
		freshSnowCm = std::max(0.0, freshSnowCm + capped * (wNow.snow * 1.1 - 0.05 - freshSnowCm * 0.004));
		const bool nowSnowing = wNow.snow > 0.15;
		if (nowSnowing != snowing) toast(nowSnowing ? "Snow is falling. Fresh powder on the way!" : "The snow has stopped. The sun is breaking through.");
		// Skiers only come when it looks like the resort can take them.
		const int want = demand();
		const int gap = want - static_cast<int>(skiers.size());
		// Nobody can get here until a road reaches somewhere to park.
		if (gap > 0 && parkingCapacity() > 0) spawnAcc += capped * std::min(gap / 45.0 + 0.05, capacity() * 0.003);
		const int cap = capacity();
		while (spawnAcc > 1)
		{
			spawnAcc -= 1;
			if (static_cast<int>(skiers.size()) < std::min(cap, want)) spawnSkier(false);
		}
		boothT += capped;
		if (boothT > 2 && boothTake > 0)
		{
			const Vec2 b = booth();
			floatText(b.x, b.y, "+$" + Num(boothTake));
			sfx.push_back(Sfx::Cash);
			boothTake = 0;
			boothT = 0;
		}
		collectBuildingIncome(capped);
		payWages(capped);
		payUpkeep(capped);
	}
	clock += capped;
	buildIndexes();
	stepLift(capped);
	stepHeli(capped);
	for (Skier& s : skiers)
	{
		stepSkier(s, capped);
		s.mood = Clamp(s.mood, 0, 100);
	}
	skiers.erase(std::remove_if(skiers.begin(), skiers.end(),
					 [](const Skier& s) {
						 return s.state == SkierState::Leaving && std::hypot(s.x - s.lot.x, s.y - s.lot.y) < 12 && s.wait <= 0;
					 }),
		skiers.end());
	// The indexes point into the skier list, which just changed: keep only the line lengths.
	queued.clear();
	for (const auto& kv : lines) queued[kv.first] = static_cast<int>(kv.second.size());
	byId.clear();
	lines.clear();
	peakSkiers = std::max(peakSkiers, static_cast<int>(skiers.size()));
	thoughtAcc += capped;
	if (thoughtAcc > 4.5)
	{
		thoughtAcc = 0;
		maybeBubble();
	}
	double avg = 60;
	if (!skiers.empty())
	{
		avg = 0;
		for (const Skier& s : skiers) avg += s.mood;
		avg /= skiers.size();
	}
	mood = Lerp(mood, avg, 0.08);
	for (Fx& f : fx)
	{
		f.life -= capped;
		f.y += capped * 18;
	}
	fx.erase(std::remove_if(fx.begin(), fx.end(), [](const Fx& f) { return f.life <= 0; }), fx.end());
	ageToasts(capped);
}

int Game::shopRatePerMin()
{
	if (buildings.empty()) return 0;
	const double busy = Clamp(skiers.size() / 200.0, 0, 1);
	const double util = (0.35 + 0.65 * busy) * staffCoverage();
	double n = 0;
	for (const Building& b : buildings) n += Info(b.type).incomePerMin * buildingEarnFactor(b);
	return static_cast<int>(JsRound(n * util));
}

void Game::collectBuildingIncome(double dt)
{
	if (buildings.empty()) return;
	const double busy = Clamp(skiers.size() / 200.0, 0, 1);
	const double util = (0.35 + 0.65 * busy) * staffCoverage();
	for (Building& b : buildings)
	{
		const double gain = (Info(b.type).incomePerMin / 60) * util * buildingEarnFactor(b) * dt;
		if (gain <= 0) continue;
		money += gain;
		incomeToday += gain;
		shopIncomeToday += gain;
		lifetimeEarned += gain;
		b.earnAcc += gain;
		b.earnTimer += dt;
		if (b.earnTimer >= 2.4 && b.earnAcc >= 1)
		{
			const double shown = std::max(1.0, JsRound(b.earnAcc));
			b.earnAcc = 0;
			b.earnTimer = 0;
			floatText(b.x, b.y, "+$" + Int(shown));
		}
	}
}

/** A ski school only runs lessons with instructors on staff. */
double Game::buildingFactor(BuildingType type)
{
	if (Parking(type))
	{
		const int cap = parkingCapacity();
		return cap ? Clamp(skiers.size() / static_cast<double>(cap), 0, 1) : 0;
	}
	if (type != BuildingType::School) return 1;
	const int need = std::max(1, staffNeeds()[static_cast<int>(StaffRole::Instructor)]);
	return std::min(1.0, Staff(StaffRole::Instructor) / static_cast<double>(need));
}

/** Is a run close enough to ski to and from this cabin's door? */
bool Game::cabinOnRun(const Vec2& b) const
{
	for (const Trail& t : trails)
		if (DistToTrail(t, b.x, b.y) < kCabinReach) return true;
	return false;
}

/** Cabins that are rentable as ski-in / ski-out (an office open and a run at the door). */
int Game::skiInCabins() const
{
	if (!has(BuildingType::CabinOffice)) return 0;
	int n = 0;
	for (const Building& b : buildings)
		if (b.type == BuildingType::Cabin && cabinOnRun({b.x, b.y})) n++;
	return n;
}

/** Per-building earnings factor (cabins depend on their office and a run nearby). */
double Game::buildingEarnFactor(const Building& b)
{
	if (b.type != BuildingType::Cabin) return buildingFactor(b.type);
	if (!has(BuildingType::CabinOffice)) return 0;
	return cabinOnRun({b.x, b.y}) ? 1 : 0.3;
}

/** Running costs for buildings that have them. */
double Game::upkeepPerMin() const
{
	double n = 0;
	for (const Building& b : buildings) n += OperatingCostPerMin(b.type);
	return n;
}

void Game::payUpkeep(double dt)
{
	const double cost = (upkeepPerMin() / 60) * dt;
	money -= cost;
	upkeepToday += cost;
}

const Building* Game::helipad() const
{
	for (const Building& b : buildings)
		if (b.type == BuildingType::Heli) return &b;
	return nullptr;
}

/** Load experts on the pad, fly them off the map, bring them back. */
void Game::stepHeli(double dt)
{
	const Building* pad = helipad();
	HeliState& h = heli;
	if (!pad)
	{
		h.flying = false;
		h.riders.clear();
		return;
	}
	if (h.flying)
	{
		h.t += dt;
		if (h.t >= kHeli.tripTime)
		{
			static const std::vector<std::string> kHappy = {"Best day ever", "Deep powder!", "Worth every cent", "Untracked!"};
			for (int riderId : h.riders)
			{
				auto it = byId.find(riderId);
				if (it == byId.end()) continue;
				Skier& s = *it->second;
				s.x = pad->x + (random() - 0.5) * 16;
				s.y = pad->y + (random() - 0.5) * 16;
				s.runsDone += 3;
				s.runsLeft -= 1;
				s.mood = std::min(100.0, s.mood + 18);
				s.bubble = pickOne(kHappy);
				s.bubbleT = 2.6;
				if (s.runsLeft <= 0) s.state = SkierState::Leaving;
				else goToLift(s);
			}
			h.flying = false;
			h.riders.clear();
			h.t = 0;
			h.wait = 0;
		}
		return;
	}
	std::vector<Skier*> ready;
	for (Skier& s : skiers)
		if (s.state == SkierState::HeliWait && std::hypot(s.x - pad->x, s.y - pad->y) < 36) ready.push_back(&s);
	if (ready.empty())
	{
		h.wait = 0;
		return;
	}
	h.wait += dt;
	if (static_cast<int>(ready.size()) < kHeli.seats && h.wait < kHeli.maxWait) return;
	if (static_cast<int>(ready.size()) > kHeli.seats) ready.resize(kHeli.seats);
	for (Skier* s : ready)
	{
		s->state = SkierState::Heli;
		s->heliDone = true;
		money += kHeli.fare;
		incomeToday += kHeli.fare;
		lifetimeEarned += kHeli.fare;
		heliTakeToday += kHeli.fare;
	}
	money -= kHeli.fuelPerFlight;
	upkeepToday += kHeli.fuelPerFlight;
	heliFlightsToday += 1;
	floatText(pad->x, pad->y, "+$" + Int(kHeli.fare * ready.size() - kHeli.fuelPerFlight) + " heli");
	sfx.push_back(Sfx::Cash);
	h.flying = true;
	h.t = 0;
	h.riders.clear();
	for (Skier* s : ready) h.riders.push_back(s->id);
}

/** Experts sometimes book a heli drop instead of riding the lifts. */
bool Game::wantsHeli(const Skier& s) { return s.skill >= 2 && !s.heliDone && helipad() && random() < 0.4; }

void Game::payWages(double dt)
{
	for (StaffRole role : kStaffRoles)
	{
		if (!staffRequired() && role != StaffRole::Instructor) continue;
		const double w = (StaffWagePerMin(role) / 60) * Staff(role) * dt;
		money -= w;
		wagesToday += w;
	}
}

/** Payroll and the bigger buildings start once the resort is a ski area (first peak). */
bool Game::staffRequired() const { return tier() >= 1; }

bool Game::expansionUnlocked() const { return tier() >= 1; }

std::array<int, kStaffRoleCount> Game::staffNeeds() const
{
	std::array<int, kStaffRoleCount> need{};
	need[static_cast<int>(StaffRole::Instructor)] = count(BuildingType::School) * 2;
	if (!staffRequired()) return need;
	int foodBuildings = 0, lodgings = 0;
	for (const Building& b : buildings)
	{
		if (IsFood(b.type)) foodBuildings++;
		if (IsLodging(b.type)) lodgings++;
	}
	need[static_cast<int>(StaffRole::Patrol)] = std::max(1, static_cast<int>(std::ceil(skiers.size() / 150.0)) + tier());
	need[static_cast<int>(StaffRole::Food)] = std::max(foodBuildings > 0 ? 1 : 0, foodBuildings);
	need[static_cast<int>(StaffRole::Lift)] = std::max(1, static_cast<int>(std::ceil(lifts.size() / 2.0)));
	need[static_cast<int>(StaffRole::Delivery)] =
		std::max(foodBuildings + lodgings > 0 ? 1 : 0, static_cast<int>(std::ceil((foodBuildings + lodgings) / 2.0)));
	need[static_cast<int>(StaffRole::Maintenance)] = std::max(1, static_cast<int>(std::ceil(trails.size() / 5.0)) + 1);
	return need;
}

double Game::staffCoverage() const
{
	if (!staffRequired()) return 1;
	const auto need = staffNeeds();
	double got = 0;
	double want = 0;
	for (StaffRole role : kStaffRoles)
	{
		if (role == StaffRole::Instructor) continue; // only the ski school depends on them
		const int n = std::max(1, need[static_cast<int>(role)]);
		want += n;
		got += std::min(Staff(role), n);
	}
	return want == 0 ? 1 : Clamp(got / want, 0.35, 1);
}

void Game::hire(StaffRole role)
{
	if (role == StaffRole::Instructor)
	{
		if (count(BuildingType::School) == 0)
		{
			toast("Build a ski school first.", true);
			return;
		}
		staff[static_cast<int>(role)] += 1;
		toast("Hired a ski instructor.");
		return;
	}
	if (!staffRequired())
	{
		toast("The local hill is family-run. Payroll starts once you conquer your first peak.", true);
		return;
	}
	staff[static_cast<int>(role)] += 1;
	toast("Hired " + Lower(StaffLabel(role)) + ".");
}

void Game::fire(StaffRole role)
{
	if (Staff(role) <= 0) return;
	staff[static_cast<int>(role)] -= 1;
	toast("Let a " + Lower(StaffLabel(role)) + " go.");
}

const Building* Game::nearestOf(const std::vector<BuildingType>& types, double x, double y) const
{
	const Building* best = nullptr;
	double bestD = kInf;
	for (const Building& b : buildings)
	{
		if (std::find(types.begin(), types.end(), b.type) == types.end()) continue;
		const double d = (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y);
		if (d < bestD)
		{
			bestD = d;
			best = &b;
		}
	}
	return best;
}

void Game::ageToasts(double dt)
{
	for (Toast& t : toasts) t.life -= dt;
	toasts.erase(std::remove_if(toasts.begin(), toasts.end(), [](const Toast& t) { return t.life <= 0; }), toasts.end());
}

void Game::stepLift(double dt)
{
	for (Lift& lift : lifts)
	{
		const LiftSpec& spec = Spec(lift.type);
		const double len = std::max(20.0, std::hypot(lift.top.x - lift.bottom.x, lift.top.y - lift.bottom.y));
		const double dtT = (dt * spec.speed) / len;
		for (Carrier& c : lift.carriers)
		{
			const double before = c.t;
			c.t += dtT;
			if (before < 0.04 && c.t >= 0.04 && c.riders.empty())
			{
				auto it = lines.find(lift.id);
				if (it != lines.end())
				{
					std::vector<Skier*>& line = it->second;
					const size_t take = std::min(line.size(), static_cast<size_t>(spec.seats));
					for (size_t i = 0; i < take; i++)
					{
						Skier& s = *line[i];
						c.riders.push_back(s.id);
						s.state = SkierState::Riding;
						s.wait = 0;
						// Warm bubble chairs and cabins keep people cheerful.
						if (lift.type == LiftType::Six || lift.type == LiftType::Gondola) s.mood = std::min(100.0, s.mood + 1.5);
					}
					line.erase(line.begin(), line.begin() + take);
				}
			}
			if (c.t >= 0.97 && !c.riders.empty())
			{
				for (int riderId : c.riders)
				{
					auto it = byId.find(riderId);
					if (it == byId.end()) continue;
					Skier& s = *it->second;
					s.x = lift.top.x + (random() * 10 - 5);
					s.y = lift.top.y + (random() * 6 - 3);
					s.state = SkierState::ToTrail;
					if (lift.type == LiftType::Carpet && servedBy(lift).empty()) s.trailId = -lift.id;
					else if (const Trail* t = chooseTrail(s, &lift)) s.trailId = t->id;
					else s.trailId.reset();
					s.dist = 0;
					maybeLookout(s);
				}
				c.riders.clear();
			}
			if (c.t >= 1) c.t -= 1;
		}
	}
}

/**
 * Pick the lift that gets this skier to terrain they like soonest: close by,
 * short line, and runs at the top that fit their skill.
 */
const Lift* Game::chooseLift(const Skier& s)
{
	const Lift* best = nullptr;
	double bestScore = kInf;
	for (const Lift& l : lifts)
	{
		const LiftSpec& spec = Spec(l.type);
		const std::vector<const Trail*>& from = servedBy(l);
		const bool bunny = l.type == LiftType::Carpet && from.empty();
		if (bunny && s.skill > 0) continue;
		double fit = bunny ? 1 : 0;
		if (!bunny)
			for (const Trail* t : from) fit = std::max(fit, TrailScore(s.skill, t->difficulty));
		auto it = lineLen.find(l.id);
		const double line = it == lineLen.end() ? 0 : it->second;
		const double perSec = (spec.seats * spec.speed) / spec.spacing;
		const double score = std::hypot(s.x - l.bottom.x, s.y - l.bottom.y) * 0.45 + (line / perSec) * 6 + (1 - fit) * 220 +
			(!from.empty() || bunny ? 0 : 500) + (l.type == LiftType::Carpet && s.skill == 0 ? -70 : 0) + random() * 25;
		if (score < bestScore)
		{
			bestScore = score;
			best = &l;
		}
	}
	return best;
}

/** The skier's run: a real trail, or (negative id) the bunny slope beside a carpet. */
const Trail* Game::trailFor(const Skier& s)
{
	if (!s.trailId) return nullptr;
	if (*s.trailId >= 0) return findTrail(*s.trailId);
	const Lift* lift = findLift(-*s.trailId);
	if (!lift) return nullptr;
	const double dx = lift->top.x - lift->bottom.x;
	const double dy = lift->top.y - lift->bottom.y;
	double l = std::hypot(dx, dy);
	if (l == 0) l = 1;
	const double ox = (-dy / l) * 12;
	const double oy = (dx / l) * 12;
	bunnyScratch.id = *s.trailId;
	bunnyScratch.name = "Bunny slope";
	bunnyScratch.points = {{lift->top.x + ox, lift->top.y + oy},
		{lift->bottom.x + ox * 1.4 + (dx / l) * 6, lift->bottom.y + oy * 1.4 + (dy / l) * 6}};
	const double drop = Elevation(bunnyScratch.points[0].x, bunnyScratch.points[0].y) - Elevation(bunnyScratch.points[1].x, bunnyScratch.points[1].y);
	bunnyScratch.difficulty = 0;
	bunnyScratch.length = l;
	bunnyScratch.drop = std::max(0.0, drop);
	bunnyScratch.kind = TrailKind::Slope;
	return &bunnyScratch;
}

void Game::goToLift(Skier& s)
{
	if (s.runsDone > 0 && wantsHeli(s) && random() < 0.4)
	{
		s.state = SkierState::HeliWait;
		s.wait = 0;
		return;
	}
	s.state = SkierState::ToLift;
	s.joinT = clock;
	s.liftId.reset();
}

const Trail* Game::chooseTrail(const Skier& s, const Lift* lift)
{
	auto score = [&s](const Trail* t) { return TrailScore(s.skill, t->difficulty) * (t->kind == s.likes ? 1.6 : 1); };
	std::vector<const Trail*> ranked;
	for (const Trail& t : trails) ranked.push_back(&t);
	std::stable_sort(ranked.begin(), ranked.end(), [&score](const Trail* p, const Trail* q) { return score(p) > score(q); });
	std::vector<const Trail*> options;
	for (const Trail* t : ranked)
		if (TrailScore(s.skill, t->difficulty) > 0.15) options.push_back(t);
	if (options.empty()) return ranked.empty() ? nullptr : ranked[0];
	std::vector<const Trail*> from;
	if (lift) from = servedBy(*lift);
	std::vector<const Trail*> hikeOk;
	for (const Trail* t : options)
		if (std::find(from.begin(), from.end(), t) != from.end()) hikeOk.push_back(t);
	if (!hikeOk.empty()) return hikeOk[static_cast<size_t>(random() * std::min<size_t>(3, hikeOk.size()))];
	// Nothing served from this lift: take the closest trailhead rather than roam the mountain.
	const Vec2 at = lift ? lift->top : Vec2{s.x, s.y};
	std::vector<const Trail*> pool = from;
	if (pool.empty())
		for (const Trail& t : trails) pool.push_back(&t);
	const Trail* best = nullptr;
	double bestD = kInf;
	for (const Trail* t : pool)
	{
		const double d = std::hypot(t->points[0].x - at.x, t->points[0].y - at.y);
		if (d < bestD)
		{
			bestD = d;
			best = t;
		}
	}
	return best;
}

Vec2 Game::booth() const { return {kBase.x - 60, kBase.y + 90}; }

Vec2 Game::exit() const { return {kBase.x - 160, kBase.y + 200}; }

void Game::stepSkier(Skier& s, double dt)
{
	using BT = BuildingType;
	s.needBath = Clamp(s.needBath + dt * 0.015, 0, 1.2);
	s.needFood = Clamp(s.needFood + dt * 0.012, 0, 1.2);
	if (s.bubbleT > 0) s.bubbleT -= dt;
	else s.bubble.clear();
	if (s.air > 0) s.air = std::max(0.0, s.air - dt);
	switch (s.state)
	{
	case SkierState::Arriving:
	{
		const Vec2 b = booth();
		walkTo(s, b.x, b.y, 42 * kWalk * dt, dt);
		if (std::hypot(s.x - b.x, s.y - b.y) < 10) s.state = SkierState::Booth;
		return;
	}
	case SkierState::Booth:
	{
		if (!s.paid)
		{
			const double fair = fairPrice() + (s.skill - 1) * 4;
			if (ticketPrice > fair + 14 && random() < 0.55)
			{
				s.mood -= 25;
				s.state = SkierState::Leaving;
				s.bubble = "Too pricey";
				s.bubbleT = 2.2;
				return;
			}
			s.paid = true;
			money += ticketPrice;
			ticketsToday += 1;
			totalTickets += 1;
			incomeToday += ticketPrice;
			lifetimeEarned += ticketPrice;
			boothTake += ticketPrice;
		}
		if (wantsHeli(s))
		{
			s.state = SkierState::HeliWait;
			s.wait = 0;
			return;
		}
		// New skiers sign up for a lesson when the school has instructors.
		if (s.skill == 0 && !s.lesson && has(BT::School) && Staff(StaffRole::Instructor) > 0 && random() < 0.65)
		{
			s.state = SkierState::Visit;
			s.visitType = BT::School;
			s.lesson = true;
			s.wait = 0;
			return;
		}
		goToLift(s);
		return;
	}
	case SkierState::ToLift:
	{
		if (!s.liftId || !findLift(*s.liftId))
		{
			const Lift* chosen = chooseLift(s);
			if (!chosen)
			{
				s.liftId.reset();
				s.state = SkierState::Leaving;
				return;
			}
			s.liftId = chosen->id;
		}
		const Vec2 q = queueSlot(s);
		const Lift& lift = *findLift(*s.liftId);
		// Head for the station along the paths, then find a spot in line.
		if (std::hypot(s.x - lift.bottom.x, s.y - lift.bottom.y) > 40) walkTo(s, lift.bottom.x, lift.bottom.y, 46 * kWalk * dt, dt);
		else walkToward(s, q.x, q.y, 46 * kWalk * dt);
		if (std::hypot(s.x - q.x, s.y - q.y) < 8) s.state = SkierState::Queue;
		return;
	}
	case SkierState::Queue:
	{
		if (!s.liftId || !findLift(*s.liftId))
		{
			goToLift(s);
			return;
		}
		const Vec2 q = queueSlot(s);
		walkToward(s, q.x, q.y, 30 * dt);
		s.wait += dt;
		// Patience wears thin after ~40s in line; fed-up skiers go home.
		if (s.wait > 40)
		{
			s.mood -= 4;
			s.wait = 30;
		}
		if (s.mood < 15)
		{
			s.state = SkierState::Leaving;
			s.liftId.reset();
			s.bubble = "Line's too long";
			s.bubbleT = 2.4;
		}
		return;
	}
	case SkierState::Riding:
	{
		const Lift* lift = s.liftId ? findLift(*s.liftId) : nullptr;
		const Carrier* c = nullptr;
		if (lift)
		{
			for (const Carrier& k : lift->carriers)
			{
				if (std::find(k.riders.begin(), k.riders.end(), s.id) != k.riders.end())
				{
					c = &k;
					break;
				}
			}
		}
		if (!lift || !c)
		{
			s.state = SkierState::ToTrail;
			maybeLookout(s);
			return;
		}
		const double t = std::min(c->t, 0.97);
		s.rideT = t;
		// Spread riders across the chair.
		const double index = static_cast<double>(std::find(c->riders.begin(), c->riders.end(), s.id) - c->riders.begin());
		const double seat = index - (c->riders.size() - 1) / 2.0;
		const double dx = lift->top.x - lift->bottom.x;
		const double dy = lift->top.y - lift->bottom.y;
		double l = std::hypot(dx, dy);
		if (l == 0) l = 1;
		s.x = Lerp(lift->bottom.x, lift->top.x, t) - (dy / l) * seat * 1.4;
		s.y = Lerp(lift->bottom.y, lift->top.y, t) + (dx / l) * seat * 1.4;
		return;
	}
	case SkierState::ToTrail:
	{
		const Trail* trail = trailFor(s);
		if (!trail) trail = chooseTrail(s);
		if (!trail)
		{
			s.state = SkierState::Leaving;
			return;
		}
		s.trailId = trail->id;
		const Vec2 start = trail->points[0];
		const Difficulty diff = trail->difficulty;
		walkToward(s, start.x, start.y, 50 * kWalk * dt);
		if (std::hypot(s.x - start.x, s.y - start.y) < 10)
		{
			s.state = SkierState::Skiing;
			s.x = start.x;
			s.y = start.y;
			s.dist = 0;
			const int mismatch = diff - s.skill;
			if (mismatch > 1) s.mood -= 12;
			else if (mismatch == 0) s.mood += 4;
			else if (mismatch < 0) s.mood -= 2;
		}
		return;
	}
	case SkierState::Skiing:
	{
		const Trail* trail = trailFor(s);
		if (!trail)
		{
			goToLift(s);
			return;
		}
		const double grade = (trail->drop * kVerticalM) / (std::max(40.0, trail->length) * kUnitM);
		const TrailKindSpec& kind = Spec(trail->kind);
		const double speedNow =
			(46 + trail->difficulty * 16 + grade * 90 - std::max(0, trail->difficulty - s.skill) * 12) * kSki * kind.speedMul;
		const double before = s.dist;
		s.dist += speedNow * dt;
		hitFeatures(s, *trail, before, s.dist);
		const PolylinePoint p = PointOnPolyline(trail->points, s.dist);
		// Slalom skiers carve wide around the gates; others make lazy turns.
		const bool slalom = trail->kind == TrailKind::Slalom;
		const double swing = slalom ? 4 : trail->kind == TrailKind::Park ? 1.5 : 3.2;
		const double freq = slalom ? kPi / 28 : 0.08;
		const double phase = slalom ? 0 : s.id;
		s.x = p.x + std::sin(s.dist * freq + phase) * swing * -p.dy;
		s.y = p.y + std::sin(s.dist * freq + phase) * swing * p.dx;
		if (p.done)
		{
			s.runsDone += 1;
			s.runsLeft -= 1;
			s.mood += 3;
			if (s.needBath > 0.72)
			{
				if (has(BT::Restroom))
				{
					s.state = SkierState::Visit;
					s.visitType = BT::Restroom;
					s.wait = 0;
					return;
				}
				s.mood -= 14;
				s.bubble = "Need a bathroom";
				s.bubbleT = 2.4;
			}
			if (s.needFood > 0.72)
			{
				if (const Building* food = nearestOf(kFoodBuildings, s.x, s.y))
				{
					s.state = SkierState::Visit;
					s.visitType = food->type;
					s.wait = 0;
					return;
				}
				s.mood -= 8;
			}
			// Done for the day: some browse the shops on the way back to the car.
			if (s.runsLeft <= 0 && s.mood >= 28 && random() < 0.4)
			{
				if (const Building* shop = nearestOf(kShopBuildings, s.x, s.y))
				{
					s.state = SkierState::Visit;
					s.visitType = shop->type;
					s.wait = 0;
					return;
				}
			}
			if (s.runsLeft <= 0 || s.mood < 28) s.state = SkierState::Leaving;
			else goToLift(s);
		}
		return;
	}
	case SkierState::Visit:
	{
		const Building* b = s.visitType ? nearestOf({*s.visitType}, s.x, s.y) : nullptr;
		if (!b)
		{
			if (s.visitType == BT::Lookout)
			{
				s.visitType.reset();
				s.state = SkierState::ToTrail;
			}
			else goToLift(s);
			return;
		}
		const Vec2 at{b->x, b->y};
		walkTo(s, at.x, at.y, 44 * kWalk * dt, dt);
		if (std::hypot(s.x - at.x, s.y - at.y) < 12)
		{
			s.wait += dt;
			const bool longVisit = s.visitType == BT::School || s.visitType == BT::Lookout;
			if (s.wait > (longVisit ? 3 : 1.6))
			{
				if (s.visitType == BT::Lookout)
				{
					// Warmed up by the fire pit and soaked in the view: the higher, the better.
					static const std::vector<std::string> kHigh = {"What a view!", "You can see forever", "Top of the world"};
					static const std::vector<std::string> kLow = {"Nice fire!", "Toasty", "Pretty view"};
					const double high = Clamp((ElevationM(at.x, at.y) - 1000) / 1500, 0, 1);
					s.mood = std::min(100.0, s.mood + 6 + high * 10);
					s.needFood = std::max(0.0, s.needFood - 0.1);
					if (random() < 0.35)
					{
						s.bubble = pickOne(high > 0.5 ? kHigh : kLow);
						s.bubbleT = 2.2;
					}
					s.wait = 0;
					s.visitType.reset();
					s.state = SkierState::ToTrail;
					return;
				}
				if (s.visitType == BT::School)
				{
					// A lesson: happier, and some beginners graduate to blues.
					const double fee = 25;
					money += fee;
					incomeToday += fee;
					shopIncomeToday += fee;
					lifetimeEarned += fee;
					s.mood += 6;
					if (random() < 0.35)
					{
						s.skill = 1;
						s.bubble = "I can ski blues!";
						s.bubbleT = 2.4;
					}
				}
				else if (s.visitType == BT::Restroom) s.needBath = 0.05;
				else if (IsFood(*s.visitType)) s.needFood = 0.08;
				s.mood += 8;
				s.wait = 0;
				s.visitType.reset();
				if (s.runsLeft <= 0) s.state = SkierState::Leaving;
				else goToLift(s);
			}
		}
		return;
	}
	case SkierState::HeliWait:
	{
		const Building* pad = helipad();
		if (!pad)
		{
			goToLift(s);
			return;
		}
		auto it = heliSpot.find(s.id);
		const int i = it == heliSpot.end() ? 0 : it->second;
		walkToward(s, pad->x - 14 + (i % 4) * 6, pad->y - 18 - (i / 4) * 6, 46 * kWalk * dt);
		s.wait += dt;
		if (s.wait > 60)
		{
			// Gave up waiting on the helicopter.
			s.mood -= 10;
			s.heliDone = true;
			goToLift(s);
		}
		return;
	}
	case SkierState::Heli:
		return; // off the map, skiing the backcountry
	case SkierState::Leaving:
		walkTo(s, s.lot.x, s.lot.y, 48 * kWalk * dt, dt);
		s.wait = 0;
		return;
	}
}

/** Rebuild the per-tick indexes (O(skiers)). */
void Game::buildIndexes()
{
	byId.clear();
	lines.clear();
	lineSpot.clear();
	lineLen.clear();
	heliSpot.clear();
	served.clear();
	int heliCount = 0;
	std::unordered_map<int, std::vector<Skier*>> waiting;
	for (Skier& s : skiers)
	{
		byId[s.id] = &s;
		if (s.state == SkierState::HeliWait) heliSpot[s.id] = heliCount++;
		if (!s.liftId) continue;
		if (s.state == SkierState::Queue || (s.state == SkierState::ToLift && s.paid)) waiting[*s.liftId].push_back(&s);
	}
	// First come, first served: order each line by when people joined it.
	for (auto& [liftId, w] : waiting)
	{
		std::sort(w.begin(), w.end(), [](const Skier* p, const Skier* q) { return p->joinT != q->joinT ? p->joinT < q->joinT : p->id < q->id; });
		lineLen[liftId] = static_cast<int>(w.size());
		std::vector<Skier*>& line = lines[liftId];
		for (size_t i = 0; i < w.size(); i++)
		{
			lineSpot[w[i]->id] = static_cast<int>(i);
			if (w[i]->state == SkierState::Queue) line.push_back(w[i]);
		}
	}
}

/** Runs served from a lift's top (cached per tick, and until the runs or lifts change). */
const std::vector<const Trail*>& Game::servedBy(const Lift& l)
{
	auto it = served.find(l.id);
	if (it == served.end()) it = served.emplace(l.id, trailsFrom(l)).first;
	return it->second;
}

/** Skiers who can handle it hit the jumps and features on their run. */
void Game::hitFeatures(Skier& s, const Trail& trail, double from, double to)
{
	static const std::vector<std::string> kCheers = {"Sent it!", "Woo!", "Stomped", "Big air"};
	for (const Feature& f : features)
	{
		if (f.trailId != trail.id) continue;
		const double at = NearestOnTrail(trail, f.x, f.y).along;
		if (at <= from || at > to) continue;
		const bool keen = s.likes == TrailKind::Park;
		if (s.skill == 0 && !keen) continue; // beginners ski around
		s.air = f.type == FeatureType::Halfpipe ? 1.1 : f.type == FeatureType::Jump ? 0.75 : 0.45;
		s.mood = std::min(100.0, s.mood + (keen ? 4 : 2));
		if (random() < 0.25)
		{
			s.bubble = pickOne(kCheers);
			s.bubbleT = 1.6;
		}
	}
}

void Game::walkToward(Skier& s, double x, double y, double step)
{
	const double dx = x - s.x;
	const double dy = y - s.y;
	double d = std::hypot(dx, dy);
	if (d == 0) d = 1;
	const double m = std::min(step, d);
	s.x += (dx / d) * m;
	s.y += (dy / d) * m;
}

Vec2 Game::queueSlot(const Skier& s)
{
	const Lift* found = s.liftId ? findLift(*s.liftId) : nullptr;
	const Lift& lift = found ? *found : lifts[0];
	auto len = lineLen.find(lift.id);
	const int lineCount = len == lineLen.end() ? 0 : len->second;
	auto spot = lineSpot.find(s.id);
	const int i = spot == lineSpot.end() ? lineCount : spot->second;
	// Line up behind the bottom station, facing up the lift.
	double dx = lift.top.x - lift.bottom.x;
	double dy = lift.top.y - lift.bottom.y;
	double l = std::hypot(dx, dy);
	if (l == 0) l = 1;
	dx /= l;
	dy /= l;
	// The corral gets wider as the line grows, so big crowds stay near the station.
	const int cols = std::max(8, static_cast<int>(std::ceil(std::sqrt(static_cast<double>(lineCount)) * 1.3)));
	const double back = 10 + (i / cols) * 4;
	const double side = ((i % cols) - (cols - 1) / 2.0) * 3.2;
	return {lift.bottom.x - dx * back - dy * side, lift.bottom.y - dy * back + dx * side};
}

void Game::maybeBubble()
{
	static const std::vector<std::string> kChatter = {"Nice snow", "One more", "Cold!", "Whee"};
	std::vector<Skier*> talkers;
	for (Skier& s : skiers)
		if (s.state == SkierState::Queue || s.state == SkierState::Skiing) talkers.push_back(&s);
	if (talkers.empty()) return;
	Skier& s = *pickOne(talkers);
	const Variety v = variety();
	if (s.skill >= 2 && v.counts[2] + v.counts[3] == 0) s.bubble = "Got a black?";
	else if (s.needBath > 0.7 && count(BuildingType::Restroom) == 0) s.bubble = "Bathroom?";
	else if (s.skill == 0 && v.counts[0] == 0) s.bubble = "Too steep";
	else if (random() < 0.3) s.bubble = pickOne(kChatter);
	else return;
	s.bubbleT = 2.1;
}

const Trail* Game::findTrail(int trailId) const
{
	for (const Trail& t : trails)
		if (t.id == trailId) return &t;
	return nullptr;
}

const Lift* Game::findLift(int liftId) const
{
	for (const Lift& l : lifts)
		if (l.id == liftId) return &l;
	return nullptr;
}

Lift* Game::findLift(int liftId)
{
	for (Lift& l : lifts)
		if (l.id == liftId) return &l;
	return nullptr;
}

const Building* Game::findBuilding(int buildingId) const
{
	for (const Building& b : buildings)
		if (b.id == buildingId) return &b;
	return nullptr;
}

const Skier* Game::findSkier(int skierId) const
{
	for (const Skier& s : skiers)
		if (s.id == skierId) return &s;
	return nullptr;
}

} // namespace Ski
