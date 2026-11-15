// Port of src/roads.ts and src/paths.ts.
#include "SkiRoads.h"

#include "SkiTerrain.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <map>
#include <queue>
#include <unordered_set>

namespace Ski
{

namespace
{
constexpr double kInf = std::numeric_limits<double>::infinity();

/** Road network vertex key: a point rounded to half a metre. */
int64_t PointKey(const Vec2& p)
{
	const int64_t kx = static_cast<int64_t>(JsRound(p.x * 2));
	const int64_t ky = static_cast<int64_t>(JsRound(p.y * 2));
	return (kx << 32) ^ (ky & 0xffffffff);
}

/** Ramer-Douglas-Peucker. */
std::vector<Vec2> Simplify(const std::vector<Vec2>& pts, double tol)
{
	if (pts.size() < 3) return pts;
	const Vec2 a = pts.front();
	const Vec2 b = pts.back();
	double worst = 0;
	size_t at = 0;
	for (size_t i = 1; i + 1 < pts.size(); i++)
	{
		const double d = NearestOnPolyline({a, b}, pts[i].x, pts[i].y).d;
		if (d > worst)
		{
			worst = d;
			at = i;
		}
	}
	if (worst < tol) return {a, b};
	std::vector<Vec2> left = Simplify(std::vector<Vec2>(pts.begin(), pts.begin() + at + 1), tol);
	const std::vector<Vec2> right = Simplify(std::vector<Vec2>(pts.begin() + at, pts.end()), tol);
	left.pop_back();
	left.insert(left.end(), right.begin(), right.end());
	return left;
}

std::vector<Vec2> BuildHighway()
{
	constexpr double S = 84;
	const int W = static_cast<int>(std::floor(kWorldW / S));
	const int H = static_cast<int>(std::floor(kWorldH / S));
	std::vector<float> elev(static_cast<size_t>(W + 1) * (H + 1));
	for (int j = 0; j <= H; j++)
		for (int i = 0; i <= W; i++) elev[j * (W + 1) + i] = static_cast<float>(ElevationM(i * S + 1, j * S + 1));
	auto at = [&elev, W](int i, int j) { return static_cast<double>(elev[j * (W + 1) + i]); };

	// Exits: the lowest point on the map edge, then the lowest edge point far from it.
	struct EdgePt
	{
		int i, j;
		double m;
	};
	std::vector<EdgePt> edge;
	for (int i = 0; i <= W; i++)
	{
		edge.push_back({i, 0, at(i, 0)});
		edge.push_back({i, H, at(i, H)});
	}
	for (int j = 0; j <= H; j++)
	{
		edge.push_back({0, j, at(0, j)});
		edge.push_back({W, j, at(W, j)});
	}
	std::stable_sort(edge.begin(), edge.end(), [](const EdgePt& p, const EdgePt& q) { return p.m < q.m; });
	const EdgePt s = edge[0];
	EdgePt e = edge.back();
	for (const EdgePt& p : edge)
	{
		if (std::hypot(p.i - s.i, p.j - s.j) * S > kWorldW * 0.45)
		{
			e = p;
			break;
		}
	}

	const int N = (W + 1) * (H + 1);
	std::vector<double> dist(N, kInf);
	std::vector<int> prev(N, -1);
	using Item = std::pair<double, int>;
	std::priority_queue<Item, std::vector<Item>, std::greater<Item>> heap;
	const int start = s.j * (W + 1) + s.i;
	const int goal = e.j * (W + 1) + e.i;
	dist[start] = 0;
	heap.push({0, start});
	const double floorM = s.m;
	while (!heap.empty())
	{
		const auto [c, n] = heap.top();
		heap.pop();
		if (c > dist[n]) continue;
		if (n == goal) break;
		const int i = n % (W + 1);
		const int j = n / (W + 1);
		for (int dj = -1; dj <= 1; dj++)
		{
			for (int di = -1; di <= 1; di++)
			{
				if (!di && !dj) continue;
				const int ni = i + di;
				const int nj = j + dj;
				if (ni < 0 || nj < 0 || ni > W || nj > H) continue;
				const double d = std::hypot(di, dj) * S;
				const double g = std::fabs(at(ni, nj) - at(i, j)) / d;
				const double x = ni * S;
				const double y = nj * S;
				const double db = std::hypot(x - kBase.x, y - kBase.y);
				// Stay out of the village, but swing past it like a resort road would.
				const double nearVillage = std::max(0.0, 1 - std::max(0.0, db - 420) / 300);
				const double pass = std::exp(-std::pow((db - 750) / 700, 2));
				const double w = d * (1 + 90 * g * g + std::max(0.0, at(ni, nj) - floorM) / 220 + nearVillage * 12) * (1 - 0.55 * pass);
				const int m = nj * (W + 1) + ni;
				if (c + w < dist[m])
				{
					dist[m] = c + w;
					prev[m] = n;
					heap.push({c + w, m});
				}
			}
		}
	}
	std::vector<Vec2> path;
	for (int n = goal; n >= 0; n = prev[n]) path.push_back({(n % (W + 1)) * S, (n / (W + 1)) * S});
	path = Simplify(path, 22);
	// Round the corners off.
	for (int k = 0; k < 2; k++)
	{
		std::vector<Vec2> out{path[0]};
		for (size_t i = 0; i + 1 < path.size(); i++)
		{
			const Vec2 a = path[i];
			const Vec2 b = path[i + 1];
			out.push_back({a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25});
			out.push_back({a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75});
		}
		out.push_back(path.back());
		path = out;
	}
	for (Vec2& p : path)
	{
		p.x = std::min(kWorldW - 1, std::max(1.0, p.x));
		p.y = std::min(kWorldH - 1, std::max(1.0, p.y));
	}
	return path;
}
} // namespace

double LegGrade(const Vec2& a, const Vec2& b)
{
	const double len = std::hypot(b.x - a.x, b.y - a.y);
	if (len < 1) return 0;
	const int steps = std::max(1, static_cast<int>(std::ceil(len / 40)));
	double worst = 0;
	double prev = ElevationM(a.x, a.y);
	for (int i = 1; i <= steps; i++)
	{
		const double t = static_cast<double>(i) / steps;
		const double m = ElevationM(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
		worst = std::max(worst, std::fabs(m - prev) / (len / steps));
		prev = m;
	}
	// Short humps are graded out: blend the worst stretch with the overall pitch.
	const double overall = std::fabs(ElevationM(b.x, b.y) - ElevationM(a.x, a.y)) / len;
	return overall * 0.5 + worst * 0.5;
}

double RoadLength(const std::vector<Vec2>& points) { return PolylineLength(points); }

NearestOnRoad NearestOnPolyline(const std::vector<Vec2>& points, double x, double y)
{
	NearestOnRoad best;
	best.p = points.empty() ? Vec2{} : points[0];
	best.d = kInf;
	for (size_t i = 1; i < points.size(); i++)
	{
		const Vec2& a = points[i - 1];
		const Vec2& b = points[i];
		const double abx = b.x - a.x;
		const double aby = b.y - a.y;
		double den = abx * abx + aby * aby;
		if (den == 0) den = 1;
		const double t = std::max(0.0, std::min(1.0, ((x - a.x) * abx + (y - a.y) * aby) / den));
		const Vec2 p{a.x + abx * t, a.y + aby * t};
		const double d = std::hypot(x - p.x, y - p.y);
		if (d < best.d)
		{
			best.p = p;
			best.seg = static_cast<int>(i) - 1;
			best.d = d;
			best.t = t;
		}
	}
	return best;
}

std::optional<std::vector<Vec2>> RouteTo(const std::vector<Road>& roads, const Vec2& goal)
{
	std::unordered_map<int64_t, Vec2> pts;
	std::unordered_map<int64_t, std::vector<std::pair<int64_t, double>>> adjacency;
	auto link = [&](const Vec2& a, const Vec2& b) {
		const int64_t ka = PointKey(a);
		const int64_t kb = PointKey(b);
		pts[ka] = a;
		pts[kb] = b;
		const double w = std::hypot(b.x - a.x, b.y - a.y);
		adjacency[ka].push_back({kb, w});
		adjacency[kb].push_back({ka, w});
	};
	for (const Road& r : roads)
		for (size_t i = 1; i < r.points.size(); i++) link(r.points[i - 1], r.points[i]);
	const int64_t goalKey = PointKey(goal);
	if (!adjacency.count(goalKey)) return std::nullopt;
	const Road* highway = nullptr;
	for (const Road& r : roads)
		if (r.highway)
		{
			highway = &r;
			break;
		}
	if (!highway || highway->points.empty()) return std::nullopt;
	const int64_t starts[2] = {PointKey(highway->points.front()), PointKey(highway->points.back())};
	// Dijkstra from the goal outwards.
	std::unordered_map<int64_t, double> dist{{goalKey, 0}};
	std::unordered_map<int64_t, int64_t> prev;
	using Item = std::pair<double, int64_t>;
	std::priority_queue<Item, std::vector<Item>, std::greater<Item>> heap;
	heap.push({0, goalKey});
	while (!heap.empty())
	{
		const auto [cd, cur] = heap.top();
		heap.pop();
		if (cd > dist[cur]) continue;
		for (const auto& [to, w] : adjacency[cur])
		{
			const double nd = cd + w;
			auto it = dist.find(to);
			if (it == dist.end() || nd < it->second)
			{
				dist[to] = nd;
				prev[to] = cur;
				heap.push({nd, to});
			}
		}
	}
	std::optional<int64_t> from;
	double fromD = kInf;
	for (int64_t s : starts)
	{
		auto it = dist.find(s);
		if (it != dist.end() && it->second < fromD)
		{
			fromD = it->second;
			from = s;
		}
	}
	if (!from) return std::nullopt;
	std::vector<Vec2> out;
	int64_t k = *from;
	for (int guard = 0; guard < 100000; guard++)
	{
		out.push_back(pts[k]);
		auto it = prev.find(k);
		if (it == prev.end()) break;
		k = it->second;
	}
	return out;
}

const std::vector<Vec2>& Highway()
{
	static std::vector<Vec2> cached;
	static int generation = -1;
	if (generation != TerrainGeneration())
	{
		cached = BuildHighway();
		generation = TerrainGeneration();
	}
	return cached;
}

// ---------- footpaths

namespace
{
/** Path nodes are at most this far apart. */
constexpr double kNodeGap = 14;
} // namespace

int PathNet::AddNode(const Vec2& p)
{
	nodes.push_back(p);
	adj.emplace_back();
	return static_cast<int>(nodes.size()) - 1;
}

void PathNet::Link(int a, int b)
{
	const double w = std::hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y) / kPathSpeed;
	adj[a].push_back({b, w});
	adj[b].push_back({a, w});
}

int64_t PathNet::CellKey(double x, double y) const
{
	return Key(static_cast<int64_t>(std::floor(x / kCell)), static_cast<int64_t>(std::floor(y / kCell)));
}

std::vector<int> PathNet::Near(double x, double y) const
{
	std::vector<int> out;
	const int64_t ci = static_cast<int64_t>(std::floor(x / kCell));
	const int64_t cj = static_cast<int64_t>(std::floor(y / kCell));
	for (int64_t j = cj - 1; j <= cj + 1; j++)
	{
		for (int64_t i = ci - 1; i <= ci + 1; i++)
		{
			auto it = grid.find(Key(i, j));
			if (it != grid.end()) out.insert(out.end(), it->second.begin(), it->second.end());
		}
	}
	return out;
}

PathNet::PathNet(const std::vector<Path>& paths)
{
	for (const Path& path : paths)
	{
		int prevNode = -1;
		for (size_t i = 0; i < path.points.size(); i++)
		{
			const Vec2& p = path.points[i];
			if (i > 0)
			{
				const Vec2& a = path.points[i - 1];
				const double len = std::hypot(p.x - a.x, p.y - a.y);
				const int n = std::max(1, static_cast<int>(std::ceil(len / kNodeGap)));
				for (int k = 1; k < n; k++)
				{
					const int q = AddNode({a.x + ((p.x - a.x) * k) / n, a.y + ((p.y - a.y) * k) / n});
					Link(prevNode, q);
					prevNode = q;
				}
			}
			const int id = AddNode(p);
			if (prevNode >= 0) Link(prevNode, id);
			prevNode = id;
		}
	}
	// Spatial grid, then join nodes of different stretches that touch.
	for (size_t i = 0; i < nodes.size(); i++) grid[CellKey(nodes[i].x, nodes[i].y)].push_back(static_cast<int>(i));
	for (size_t i = 0; i < nodes.size(); i++)
	{
		const Vec2 p = nodes[i];
		for (int j : Near(p.x, p.y))
		{
			if (j <= static_cast<int>(i)) continue;
			const Vec2& q = nodes[j];
			if (std::hypot(p.x - q.x, p.y - q.y) >= 3) continue;
			bool linked = false;
			for (const Edge& e : adj[i])
				if (e.to == j) linked = true;
			if (!linked) Link(static_cast<int>(i), j);
		}
	}
}

const PathNet::Tree& PathNet::TreeTo(const Vec2& to)
{
	const int64_t k = Key(static_cast<int64_t>(JsRound(to.x / 3)), static_cast<int64_t>(JsRound(to.y / 3)));
	auto found = trees.find(k);
	if (found != trees.end()) return found->second;
	const size_t n = nodes.size();
	Tree t;
	t.d.assign(n, 0);
	t.next.assign(n, -1);
	std::vector<uint8_t> done(n, 0);
	using Item = std::pair<double, int>;
	std::priority_queue<Item, std::vector<Item>, std::greater<Item>> heap;
	// Every node can always step off the path and wade straight there.
	for (size_t i = 0; i < n; i++)
	{
		t.d[i] = std::hypot(nodes[i].x - to.x, nodes[i].y - to.y);
		heap.push({t.d[i], static_cast<int>(i)});
	}
	while (!heap.empty())
	{
		const auto [w, i] = heap.top();
		heap.pop();
		if (done[i] || w > t.d[i]) continue;
		done[i] = 1;
		for (const Edge& e : adj[i])
		{
			const double nw = w + e.w;
			if (nw < t.d[e.to])
			{
				t.d[e.to] = nw;
				t.next[e.to] = i;
				heap.push({nw, e.to});
			}
		}
	}
	if (trees.size() > 400) trees.clear();
	return trees.emplace(k, std::move(t)).first->second;
}

std::optional<std::vector<Vec2>> PathNet::Route(const Vec2& from, const Vec2& to)
{
	if (nodes.empty()) return std::nullopt;
	const double direct = std::hypot(to.x - from.x, to.y - from.y);
	if (direct < 20) return std::nullopt;
	const Tree& tree = TreeTo(to);
	int best = -1;
	double bestW = direct * 0.95;
	for (size_t i = 0; i < nodes.size(); i++)
	{
		const Vec2& p = nodes[i];
		const double off = std::hypot(p.x - from.x, p.y - from.y);
		if (off >= bestW) continue;
		const double w = off + tree.d[i];
		if (w < bestW)
		{
			bestW = w;
			best = static_cast<int>(i);
		}
	}
	if (best < 0 || tree.next[best] < 0) return std::nullopt;
	std::vector<Vec2> out;
	for (int i = best, guard = 0; i >= 0 && guard < 5000; i = tree.next[i], guard++) out.push_back(nodes[i]);
	return out;
}

} // namespace Ski
