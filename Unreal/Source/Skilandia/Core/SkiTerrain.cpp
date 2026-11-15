// Port of src/height.ts.
#include "SkiTerrain.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <tuple>

namespace Ski
{

namespace
{
constexpr int kCols = kTerrainCols;
constexpr int kRows = kTerrainRows;

std::vector<float> GHeights;
/** The ground as generated, so edits can be limited to a sensible depth. */
std::vector<float> GOriginal;
int GGeneration = 0;
int GEditVersion = 0;
std::optional<CellRange> GDirty;

constexpr double kMaxDelta = kMaxEarthworkM / kVerticalM;

uint32_t Hash2(int32_t x, int32_t y)
{
	uint32_t n = static_cast<uint32_t>(x) * 374761393u + static_cast<uint32_t>(y) * 668265263u;
	n = (n ^ (n >> 13)) * 1274126177u;
	return n ^ (n >> 16);
}

double Hash2Unit(int32_t x, int32_t y) { return Hash2(x, y) / 4294967296.0; }

double Clamp01(double n) { return std::max(0.0, std::min(1.0, n)); }

/** Sharp crests: 1 on the ridge line, falling off either side. */
double Ridged(double x, double y) { return 1 - std::fabs(2 * Noise2(x, y) - 1); }

/**
 * The source map is smoothed, so the slopes read as soft hills. Away from the
 * base village, add back what the smoothing took out: on steep ground, sharp
 * ridges and gullies, and in rocky patches, stepped cliff bands.
 */
void Roughen(std::vector<float>& h)
{
	const std::vector<float> src = h;
	const double C = kTerrainCellM;
	auto at = [&src](int i, int j) {
		return static_cast<double>(src[std::min(kRows - 1, std::max(0, j)) * kCols + std::min(kCols - 1, std::max(0, i))]);
	};
	for (int j = 0; j < kRows; j++)
	{
		for (int i = 0; i < kCols; i++)
		{
			const double x = i * C;
			const double y = j * C;
			const int k = j * kCols + i;
			const double gx = ((at(i + 1, j) - at(i - 1, j)) * kVerticalM) / (2 * C);
			const double gy = ((at(i, j + 1) - at(i, j - 1)) * kVerticalM) / (2 * C);
			const double grade = std::hypot(gx, gy);
			const double keep = SmoothStep(1300, 2300, std::hypot(x - kBase.x, y - kBase.y));
			if (keep <= 0) continue;
			double m = kBaseElevM + src[k] * kVerticalM;
			const double steep = SmoothStep(0.1, 0.42, grade);
			const double high = SmoothStep(950, 1500, m);
			// Ridges and gullies, strongest on steep high ground.
			const double relief = (0.2 + steep * 0.8) * (0.4 + high * 0.6) * keep;
			m += ((Ridged(x / 340, y / 300) - 0.5) * 56 + (Ridged(x / 170 + 40, y / 150) - 0.5) * 16) * relief;
			// Cliff bands: tall terraces in rocky patches on really steep ground.
			const double rocky =
				SmoothStep(0.45, 0.62, Noise2(x / 1100 + 11, y / 900 + 5)) * SmoothStep(0.28, 0.55, grade) * high * keep;
			if (rocky > 0)
			{
				const double step = 70 + Noise2(x / 600, y / 600) * 50;
				const double warp = (Noise2(x / 230 + 7, y / 230) - 0.5) * step * 0.9;
				const double t = (m + warp) / step;
				const double f = t - std::floor(t);
				// 60% of each step is a sloping bench, the last 40% a steep riser.
				const double r = f < 0.6 ? f * (0.3 / 0.6) : 0.3 + SmoothStep(0.6, 1, f) * 0.7;
				m += ((std::floor(t) + r) * step - warp - m) * rocky * 0.85;
			}
			h[k] = static_cast<float>((m - kBaseElevM) / kVerticalM);
		}
	}
}

double ClampNum(double n, double a, double b) { return std::max(a, std::min(b, n)); }

/** Visit the heightmap cells within `reach` of a point (distance in metres). */
template <typename Fn>
void CellsNear(double x, double y, double reach, Fn&& fn)
{
	const double C = kTerrainCellM;
	const int i0 = std::max(0, static_cast<int>(std::floor((x - reach) / C)));
	const int i1 = std::min(kCols - 1, static_cast<int>(std::ceil((x + reach) / C)));
	const int j0 = std::max(0, static_cast<int>(std::floor((y - reach) / C)));
	const int j1 = std::min(kRows - 1, static_cast<int>(std::ceil((y + reach) / C)));
	for (int j = j0; j <= j1; j++)
	{
		for (int i = i0; i <= i1; i++)
		{
			const double d = std::hypot(i * C - x, j * C - y);
			if (d <= reach) fn(j * kCols + i, d, i, j);
		}
	}
}

/** Set a cell, kept within the earthwork limit. Returns metres actually moved. */
double SetCell(int k, double h, int i, int j)
{
	const double o = GOriginal[k];
	const double v = std::max(o - kMaxDelta, std::min(o + kMaxDelta, h));
	const double moved = std::fabs(v - GHeights[k]) * kVerticalM;
	if (moved < 1e-4) return 0;
	GHeights[k] = static_cast<float>(v);
	if (!GDirty) GDirty = CellRange{i, i, j, j};
	else
	{
		GDirty->i0 = std::min(GDirty->i0, i);
		GDirty->i1 = std::max(GDirty->i1, i);
		GDirty->j0 = std::min(GDirty->j0, j);
		GDirty->j1 = std::max(GDirty->j1, j);
	}
	return moved;
}

EditResult FinishEdit(double volume, double x, double y, double reach)
{
	if (volume > 0) GEditVersion++;
	return {volume, Box{x - reach, y - reach, x + reach, y + reach}};
}
} // namespace

bool LoadTerrain(const uint16_t* metres, size_t count)
{
	if (!metres || count != static_cast<size_t>(kCols) * kRows) return false;
	GHeights.assign(count, 0.f);
	for (size_t i = 0; i < count; i++) GHeights[i] = static_cast<float>((metres[i] - kBaseElevM) / kVerticalM);
	Roughen(GHeights);
	GOriginal = GHeights;
	GEditVersion = 0;
	GDirty.reset();
	GGeneration++;
	return true;
}

bool LoadTerrainFile(const std::string& path)
{
	FILE* f = std::fopen(path.c_str(), "rb");
	if (!f) return false;
	std::vector<uint8_t> bytes(static_cast<size_t>(kCols) * kRows * 2);
	const size_t got = std::fread(bytes.data(), 1, bytes.size(), f);
	std::fclose(f);
	if (got != bytes.size()) return false;
	std::vector<uint16_t> metres(bytes.size() / 2);
	for (size_t i = 0; i < metres.size(); i++) metres[i] = static_cast<uint16_t>(bytes[2 * i] | (bytes[2 * i + 1] << 8));
	return LoadTerrain(metres.data(), metres.size());
}

bool TerrainLoaded() { return !GHeights.empty(); }

int TerrainGeneration() { return GGeneration; }

double Noise2(double x, double y)
{
	const double fx0 = std::floor(x);
	const double fy0 = std::floor(y);
	const int32_t x0 = static_cast<int32_t>(fx0);
	const int32_t y0 = static_cast<int32_t>(fy0);
	const double fx = x - fx0;
	const double fy = y - fy0;
	const double sx = fx * fx * (3 - 2 * fx);
	const double sy = fy * fy * (3 - 2 * fy);
	const double a = Hash2Unit(x0, y0);
	const double b = Hash2Unit(x0 + 1, y0);
	const double c = Hash2Unit(x0, y0 + 1);
	const double d = Hash2Unit(x0 + 1, y0 + 1);
	return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

double Elevation(double x, double y)
{
	const double u = ClampNum(x / kTerrainCellM, 0, kCols - 1.001);
	const double v = ClampNum(y / kTerrainCellM, 0, kRows - 1.001);
	const int x0 = static_cast<int>(std::floor(u));
	const int y0 = static_cast<int>(std::floor(v));
	const double tx = u - x0;
	const double ty = v - y0;
	const int i = y0 * kCols + x0;
	const double a = GHeights[i];
	const double b = GHeights[i + 1];
	const double c = GHeights[i + kCols];
	const double d = GHeights[i + kCols + 1];
	return Lerp(Lerp(a, b, tx), Lerp(c, d, tx), ty);
}

double ElevationM(double x, double y) { return kBaseElevM + Elevation(x, y) * kVerticalM; }

double SlopeAt(double x, double y)
{
	const double e = kTerrainCellM * 0.5;
	const double dx = Elevation(x + e, y) - Elevation(x - e, y);
	const double dy = Elevation(x, y + e) - Elevation(x, y - e);
	return std::hypot(dx, dy) / (2 * e);
}

double GradeAt(double x, double y) { return (SlopeAt(x, y) * kVerticalM) / kUnitM; }

Vec2 Downhill(double x, double y)
{
	const double e = kTerrainCellM * 0.5;
	const double gx = Elevation(x + e, y) - Elevation(x - e, y);
	const double gy = Elevation(x, y + e) - Elevation(x, y - e);
	double l = std::hypot(gx, gy);
	if (l == 0) l = 1;
	return {-gx / l, -gy / l};
}

double Lerp(double a, double b, double t) { return a + (b - a) * t; }

double SmoothStep(double a, double b, double x)
{
	const double t = Clamp01((x - a) / (b - a));
	return t * t * (3 - 2 * t);
}

double PolylineLength(const std::vector<Vec2>& points)
{
	double n = 0;
	for (size_t i = 1; i < points.size(); i++) n += std::hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
	return n;
}

PolylinePoint PointOnPolyline(const std::vector<Vec2>& points, double dist)
{
	if (points.size() < 2)
	{
		const Vec2 p = points.empty() ? Vec2{0, 0} : points[0];
		return {p.x, p.y, 0, -1, true};
	}
	double left = dist;
	for (size_t i = 1; i < points.size(); i++)
	{
		const double ax = points[i - 1].x;
		const double ay = points[i - 1].y;
		const double bx = points[i].x;
		const double by = points[i].y;
		double seg = std::hypot(bx - ax, by - ay);
		if (seg == 0) seg = 0.001;
		if (left <= seg)
		{
			const double t = left / seg;
			return {ax + (bx - ax) * t, ay + (by - ay) * t, (bx - ax) / seg, (by - ay) / seg, false};
		}
		left -= seg;
	}
	const Vec2& last = points[points.size() - 1];
	const Vec2& prev = points[points.size() - 2];
	double seg = std::hypot(last.x - prev.x, last.y - prev.y);
	if (seg == 0) seg = 1;
	return {last.x, last.y, (last.x - prev.x) / seg, (last.y - prev.y) / seg, true};
}

double DistToPolyline(const std::vector<Vec2>& points, double x, double y)
{
	double best = INFINITY;
	for (size_t i = 1; i < points.size(); i++)
	{
		const double ax = points[i - 1].x;
		const double ay = points[i - 1].y;
		const double abx = points[i].x - ax;
		const double aby = points[i].y - ay;
		double den = abx * abx + aby * aby;
		if (den == 0) den = 1;
		const double t = std::max(0.0, std::min(1.0, ((x - ax) * abx + (y - ay) * aby) / den));
		best = std::min(best, std::hypot(x - (ax + abx * t), y - (ay + aby * t)));
	}
	return best;
}

bool NearSegment(double ax, double ay, double bx, double by, double x, double y, double pad)
{
	const double abx = bx - ax;
	const double aby = by - ay;
	double den = abx * abx + aby * aby;
	if (den == 0) den = 1;
	const double t = std::max(0.0, std::min(1.0, ((x - ax) * abx + (y - ay) * aby) / den));
	return std::hypot(x - (ax + abx * t), y - (ay + aby * t)) < pad;
}

namespace
{
constexpr double kRockStartM = 1880;
constexpr double kRockFullM = 2380;
} // namespace

double RockAt(double x, double y)
{
	const double m = ElevationM(x, y) + (Noise2(x / 600 + 17, y / 600) - 0.5) * 160;
	if (m < kRockStartM) return 0;
	const double alt = SmoothStep(kRockStartM, kRockFullM, m);
	const double n = Noise2(x / 240 + 3, y / 200 + 9) * 0.6 + Noise2(x / 85, y / 85) * 0.4;
	const double thr = 0.74 - 0.22 * alt;
	const double patch = SmoothStep(thr, thr + 0.06, n) * SmoothStep(0, 0.15, alt);
	const double cliff = SmoothStep(0.8, 1.05, GradeAt(x, y)) * std::min(1.0, alt * 3);
	return std::max(patch, cliff);
}

bool IsRock(double x, double y) { return RockAt(x, y) > 0.5; }

int TerrainVersion() { return GEditVersion; }

std::optional<CellRange> TakeTerrainDirty()
{
	std::optional<CellRange> d = GDirty;
	GDirty.reset();
	return d;
}

float HeightAtCell(int i, int j)
{
	i = std::min(kCols - 1, std::max(0, i));
	j = std::min(kRows - 1, std::max(0, j));
	return GHeights[j * kCols + i];
}

PadResult FlattenPad(double x, double y, double radius)
{
	const double C = kTerrainCellM;
	const double inner = radius + C * 0.5;
	const double outer = inner + C * 2;
	std::vector<double> under;
	CellsNear(x, y, inner, [&under](int k, double, int, int) { under.push_back(GHeights[k]); });
	// A footprint smaller than a cell still has the ground under its centre.
	if (under.empty()) under.push_back(Elevation(x, y));
	std::sort(under.begin(), under.end());
	const double level = under[under.size() / 2];
	double volume = 0;
	CellsNear(x, y, outer, [&](int k, double d, int i, int j) {
		const double t = SmoothStep(inner, outer, d);
		volume += SetCell(k, level + (GHeights[k] - level) * t, i, j) * C * C;
	});
	const EditResult r = FinishEdit(volume, x, y, outer);
	return {r.volume, kBaseElevM + level * kVerticalM, r.box};
}

EditResult Sculpt(double x, double y, double radius, SculptMode mode, double amount, double target,
	const std::function<bool(double, double)>& locked)
{
	const double C = kTerrainCellM;
	const double goal = (target - kBaseElevM) / kVerticalM;
	// Work out every new height from the current ground first, then write them.
	std::vector<std::tuple<int, double, int, int>> next;
	CellsNear(x, y, radius, [&](int k, double d, int i, int j) {
		const double w = 1 - SmoothStep(radius * 0.35, radius, d);
		if (w <= 0 || (locked && locked(i * C, j * C))) return;
		double h = GHeights[k];
		if (mode == SculptMode::Raise) h += (w * amount) / kVerticalM;
		else if (mode == SculptMode::Lower) h -= (w * amount) / kVerticalM;
		else if (mode == SculptMode::Flatten) h += (goal - h) * std::min(1.0, w * amount);
		else
		{
			double sum = 0;
			for (int dj = -1; dj <= 1; dj++)
			{
				for (int di = -1; di <= 1; di++)
				{
					const int ii = std::min(kCols - 1, std::max(0, i + di));
					const int jj = std::min(kRows - 1, std::max(0, j + dj));
					sum += GHeights[jj * kCols + ii];
				}
			}
			h += (sum / 9 - h) * std::min(1.0, w * amount);
		}
		next.emplace_back(k, h, i, j);
	});
	double volume = 0;
	for (const auto& [k, h, i, j] : next) volume += SetCell(k, h, i, j) * C * C;
	return FinishEdit(volume, x, y, radius);
}

double EarthworkAt(double x, double y)
{
	const double C = kTerrainCellM;
	const int i = std::min(kCols - 1, std::max(0, static_cast<int>(JsRound(x / C))));
	const int j = std::min(kRows - 1, std::max(0, static_cast<int>(JsRound(y / C))));
	const int k = j * kCols + i;
	return (static_cast<double>(GHeights[k]) - GOriginal[k]) * kVerticalM;
}

} // namespace Ski
