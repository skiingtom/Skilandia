#include "SkiResort.h"

#include "Camera/PlayerCameraManager.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/PlayerController.h"
#include "HAL/PlatformTime.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "ProceduralMeshComponent.h"
#include "Skilandia.h"

#include <cmath>

namespace
{
constexpr double kCm = 100.0;
/** Terrain chunk size, in heightmap cells. */
constexpr int32 kChunkCells = 50;
/** Forest tile size, in metres. */
constexpr double kForestTileM = 2000;

FLinearColor Hex(const TCHAR* Code) { return FLinearColor(FColor::FromHex(Code)); }

const FLinearColor kSnow(0.86f, 0.89f, 0.95f);
const FLinearColor kRock(0.28f, 0.27f, 0.27f);

/**
 * Add a triangle facing up. Unreal is left-handed: a triangle is drawn from
 * the side where (B - A) x (C - A) points away from the viewer, so for an
 * up-facing triangle that cross product has to point down.
 */
void AddUpTriangle(TArray<int32>& Triangles, const TArray<FVector>& V, int32 A, int32 B, int32 C)
{
	const FVector N = FVector::CrossProduct(V[B] - V[A], V[C] - V[A]);
	Triangles.Add(A);
	if (N.Z > 0)
	{
		Triangles.Add(C);
		Triangles.Add(B);
	}
	else
	{
		Triangles.Add(B);
		Triangles.Add(C);
	}
}

/** Stable 0..1 value per map position (same hash the sim uses for trees). */
double PositionHash(double X, double Y)
{
	const double N = std::sin(X * 12.9898 + Y * 78.233) * 43758.5453;
	return N - std::floor(N);
}

struct FBuildingLook
{
	FName Group;
	const TCHAR* Color;
	double HeightM;
};

FBuildingLook LookOf(Ski::BuildingType T)
{
	using BT = Ski::BuildingType;
	switch (T)
	{
	case BT::ParkingSmall:
	case BT::ParkingLarge: return {TEXT("Parking"), TEXT("4a4f57"), 0.4};
	case BT::Garage: return {TEXT("Garage"), TEXT("6b7078"), 14};
	case BT::Lodge: return {TEXT("Lodge"), TEXT("8a5a3c"), 16};
	case BT::Restroom: return {TEXT("Base"), TEXT("9c7b5b"), 5};
	case BT::Rental:
	case BT::School:
	case BT::Clinic:
	case BT::Patrol:
	case BT::CabinOffice: return {TEXT("Base"), TEXT("9c7b5b"), 8};
	case BT::Cabin: return {TEXT("Cabin"), TEXT("6b4a2f"), 7};
	case BT::Spa: return {TEXT("Spa"), TEXT("2f8f8a"), 9};
	case BT::Heli: return {TEXT("Heli"), TEXT("5a6b78"), 1.5};
	case BT::Lookout: return {TEXT("Lookout"), TEXT("c8a26a"), 2.5};
	case BT::Hotel: return {TEXT("Hotel"), TEXT("b5523b"), 22};
	case BT::GrandHotel: return {TEXT("Hotel"), TEXT("b5523b"), 34};
	case BT::BoutiqueHotel: return {TEXT("Hotel"), TEXT("b5523b"), 18};
	case BT::Condo: return {TEXT("Hotel"), TEXT("b5523b"), 18};
	case BT::Hostel:
	case BT::Motel:
	case BT::Bnb:
	case BT::Inn: return {TEXT("Hotel"), TEXT("b5523b"), 11};
	default: break;
	}
	if (Ski::IsShop(T)) return {TEXT("Shop"), TEXT("7a4ea3"), 9};
	if (Ski::IsFood(T)) return {TEXT("Food"), TEXT("d98a2b"), T == BT::FoodTruck || T == BT::Waffle || T == BT::Shack ? 4.0 : 9.0};
	return {TEXT("Base"), TEXT("9c7b5b"), 8};
}
} // namespace

ASkiResort::ASkiResort()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.TickGroup = TG_PrePhysics;

	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent = Root;

	Sun = CreateDefaultSubobject<UDirectionalLightComponent>(TEXT("Sun"));
	Sun->SetupAttachment(Root);
	Sun->SetMobility(EComponentMobility::Movable);
	Sun->bAtmosphereSunLight = true;
	Sun->Intensity = 10.f;
	Sun->SetRelativeRotation(FRotator(-35.f, 150.f, 0.f));

	SkyLight = CreateDefaultSubobject<USkyLightComponent>(TEXT("SkyLight"));
	SkyLight->SetupAttachment(Root);
	SkyLight->SetMobility(EComponentMobility::Movable);
	SkyLight->bRealTimeCapture = true;
	SkyLight->SourceType = ESkyLightSourceType::SLS_CapturedScene;

	Atmosphere = CreateDefaultSubobject<USkyAtmosphereComponent>(TEXT("Atmosphere"));
	Atmosphere->SetupAttachment(Root);

	Fog = CreateDefaultSubobject<UExponentialHeightFogComponent>(TEXT("Fog"));
	Fog->SetupAttachment(Root);
}

ASkiResort::~ASkiResort() = default;

ASkiResort* ASkiResort::Find(const UWorld* World)
{
	if (!World) return nullptr;
	for (TActorIterator<ASkiResort> It(World); It; ++It) return *It;
	return nullptr;
}

void ASkiResort::BeginPlay()
{
	Super::BeginPlay();
	// Everything below is placed in absolute map coordinates.
	SetActorTransform(FTransform::Identity);
	LoadAssets();
	if (!StartGame())
	{
		UE_LOG(LogSkilandia, Error, TEXT("%s"), *LoadError);
		return;
	}
	// Light valley haze that thins out up the mountain (the map is 28 km across).
	Fog->SetFogDensity(0.004f);
	Fog->SetFogHeightFalloff(0.03f);

	for (int32 I = 0; I < ChunksX() * ChunksY(); I++)
	{
		UProceduralMeshComponent* Chunk = NewObject<UProceduralMeshComponent>(this, *FString::Printf(TEXT("Terrain%d"), I));
		Chunk->SetMobility(EComponentMobility::Movable);
		Chunk->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Chunk->SetCanEverAffectNavigation(false);
		Chunk->SetupAttachment(Root);
		Chunk->RegisterComponent();
		TerrainChunks.Add(Chunk);
		BuildTerrainChunk(I);
	}

	NetworkMesh = NewObject<UProceduralMeshComponent>(this, TEXT("Network"));
	NetworkMesh->SetMobility(EComponentMobility::Movable);
	NetworkMesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	NetworkMesh->SetCanEverAffectNavigation(false);
	NetworkMesh->SetCastShadow(false);
	NetworkMesh->SetupAttachment(Root);
	NetworkMesh->RegisterComponent();

	ForestTiles.SetNum(ForestTilesX() * ForestTilesY());
	UE_LOG(LogSkilandia, Log, TEXT("Skilandia: %d terrain chunks, %d forest tiles, highway %d points."), TerrainChunks.Num(), ForestTiles.Num(),
		static_cast<int32>(Ski::Highway().size()));
}

void ASkiResort::EndPlay(const EEndPlayReason::Type Reason)
{
	Game.Reset();
	Super::EndPlay(Reason);
}

void ASkiResort::LoadAssets()
{
	CubeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
	CylinderMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	ConeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cone.Cone"));
	ShapeMaterial = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	// Made by Content/Python/init_unreal.py the first time the editor opens the project.
	VertexColorMaterial = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/Skilandia/M_VertexColor.M_VertexColor"), nullptr, LOAD_NoWarn);
	if (!VertexColorMaterial)
	{
		UE_LOG(LogSkilandia, Warning,
			TEXT("No /Game/Skilandia/M_VertexColor yet: the terrain is drawn plain white. Restart the editor once so init_unreal.py can create it."));
	}
}

bool ASkiResort::StartGame()
{
	const FString Path = FPaths::ProjectContentDir() / TEXT("Data/Terrain.u16");
	TArray<uint8> Bytes;
	if (!FFileHelper::LoadFileToArray(Bytes, *Path))
	{
		LoadError = FString::Printf(TEXT("Couldn't read the heightmap at %s. Run: python3 tools/terrain/export_unreal.py"), *Path);
		return false;
	}
	TArray<uint16> Metres;
	Metres.SetNumUninitialized(Bytes.Num() / 2);
	for (int32 I = 0; I < Metres.Num(); I++) Metres[I] = static_cast<uint16>(Bytes[2 * I] | (Bytes[2 * I + 1] << 8));
	if (!Ski::LoadTerrain(Metres.GetData(), Metres.Num()))
	{
		LoadError = FString::Printf(TEXT("%s is %d bytes; expected %d x %d uint16 values."), *Path, Bytes.Num(), Ski::kTerrainCols, Ski::kTerrainRows);
		return false;
	}
	Game = MakeUnique<Ski::Game>(static_cast<uint32>(Seed));
	// The web game starts on a welcome screen; here the mountain opens straight away.
	Game->startManaging();
	return true;
}

// ---------- coordinates

FVector ASkiResort::ToWorldAt(double X, double Y, double ElevationM) const
{
	return FVector(X * kCm, -Y * kCm, (ElevationM - Ski::kBaseElevM) * VerticalScale * kCm);
}

FVector ASkiResort::ToWorld(double X, double Y, double LiftM) const
{
	return ToWorldAt(X, Y, MeshElevationM(X, Y) + LiftM / VerticalScale);
}

Ski::Vec2 ASkiResort::ToMap(const FVector& World) const { return {World.X / kCm, -World.Y / kCm}; }

double ASkiResort::MeshElevationM(double X, double Y) const
{
	if (!Ski::TerrainLoaded()) return Ski::kBaseElevM;
	const double U = FMath::Clamp(X / Ski::kTerrainCellM, 0.0, Ski::kTerrainCols - 1.001);
	const double V = FMath::Clamp(Y / Ski::kTerrainCellM, 0.0, Ski::kTerrainRows - 1.001);
	const int32 I = FMath::FloorToInt32(U);
	const int32 J = FMath::FloorToInt32(V);
	const double TX = U - I;
	const double TY = V - J;
	const double A = Ski::HeightAtCell(I, J);
	const double B = Ski::HeightAtCell(I + 1, J);
	const double C = Ski::HeightAtCell(I, J + 1);
	const double D = Ski::HeightAtCell(I + 1, J + 1);
	// Same split as the terrain mesh: the diagonal runs from (i+1, j) to (i, j+1).
	const double H = TX + TY <= 1 ? A + (B - A) * TX + (C - A) * TY : D + (C - D) * (1 - TX) + (B - D) * (1 - TY);
	return Ski::kBaseElevM + H * Ski::kVerticalM;
}

bool ASkiResort::TraceGround(const FVector& Origin, const FVector& Direction, Ski::Vec2& OutMap, FVector& OutWorld) const
{
	if (!Game) return false;
	const FVector Dir = Direction.GetSafeNormal();
	auto Below = [this](const FVector& P) {
		const Ski::Vec2 M = ToMap(P);
		return P.Z <= ToWorldAt(M.x, M.y, MeshElevationM(M.x, M.y)).Z;
	};
	if (Below(Origin)) return false;
	double Prev = 0;
	double T = 0;
	const double MaxT = 8000000; // 80 km
	while (T < MaxT)
	{
		T += FMath::Max(1000.0, T * 0.01);
		if (Below(Origin + Dir * T))
		{
			double Lo = Prev, Hi = T;
			for (int32 K = 0; K < 24; K++)
			{
				const double Mid = (Lo + Hi) * 0.5;
				if (Below(Origin + Dir * Mid)) Hi = Mid;
				else Lo = Mid;
			}
			OutWorld = Origin + Dir * Hi;
			OutMap = ToMap(OutWorld);
			return OutMap.x >= 0 && OutMap.y >= 0 && OutMap.x <= Ski::kWorldW && OutMap.y <= Ski::kWorldH;
		}
		Prev = T;
	}
	return false;
}

FVector ASkiResort::CameraLocation() const
{
	if (const UWorld* World = GetWorld())
		if (const APlayerController* PC = World->GetFirstPlayerController())
			if (PC->PlayerCameraManager) return PC->PlayerCameraManager->GetCameraLocation();
	return ToWorld(Ski::kBase.x, Ski::kBase.y, 1000);
}

void ASkiResort::SetShowSteepness(bool bShow)
{
	if (bShow == bShowSteepness) return;
	bShowSteepness = bShow;
	if (Game) RebuildTerrainCells(0, Ski::kTerrainCols - 1, 0, Ski::kTerrainRows - 1);
}

// ---------- materials and instanced meshes

UMaterialInterface* ASkiResort::ColorMaterial(const FLinearColor& Color)
{
	const uint32 Key = Color.ToFColor(true).DWColor();
	if (UMaterialInstanceDynamic** Found = MaterialByColor.Find(Key)) return *Found;
	UMaterialInstanceDynamic* M = UMaterialInstanceDynamic::Create(ShapeMaterial, this);
	M->SetVectorParameterValue(TEXT("Color"), Color);
	Materials.Add(M);
	MaterialByColor.Add(Key, M);
	return M;
}

UInstancedStaticMeshComponent* ASkiResort::InstancedMesh(FName Name, UStaticMesh* Mesh, const FLinearColor& Color, bool bShadows)
{
	if (TObjectPtr<UInstancedStaticMeshComponent>* Found = Instanced.Find(Name)) return *Found;
	UInstancedStaticMeshComponent* C = NewObject<UInstancedStaticMeshComponent>(this, Name);
	C->SetMobility(EComponentMobility::Movable);
	C->SetStaticMesh(Mesh);
	C->SetMaterial(0, ColorMaterial(Color));
	C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	C->SetCanEverAffectNavigation(false);
	C->SetCastShadow(bShadows);
	C->SetupAttachment(Root);
	C->RegisterComponent();
	Instanced.Add(Name, C);
	return C;
}

void ASkiResort::SetInstances(UInstancedStaticMeshComponent* Mesh, const TArray<FTransform>& Transforms)
{
	if (!Mesh) return;
	if (Mesh->GetInstanceCount() == Transforms.Num())
	{
		if (Transforms.Num()) Mesh->BatchUpdateInstancesTransforms(0, Transforms, true, true, true);
		return;
	}
	Mesh->ClearInstances();
	if (Transforms.Num()) Mesh->AddInstances(Transforms, false, true);
}

FTransform ASkiResort::ShapeTransform(const UStaticMesh* Mesh, const FVector& Base, const FVector& SizeM, float YawDeg) const
{
	const FBox Box = Mesh ? Mesh->GetBoundingBox() : FBox(FVector(-50), FVector(50));
	const FVector Extent = Box.GetSize();
	const FVector Scale(SizeM.X * kCm / FMath::Max(Extent.X, 1.0), SizeM.Y * kCm / FMath::Max(Extent.Y, 1.0), SizeM.Z * kCm / FMath::Max(Extent.Z, 1.0));
	const FRotator Rot(0.f, YawDeg, 0.f);
	// Stand the mesh on its base, whatever its pivot.
	const FVector LocalBase(Box.GetCenter().X, Box.GetCenter().Y, Box.Min.Z);
	return FTransform(Rot, Base - Rot.RotateVector(LocalBase * Scale), Scale);
}

FTransform ASkiResort::SegmentTransform(const UStaticMesh* Mesh, const FVector& A, const FVector& B, double ThickM) const
{
	const FBox Box = Mesh ? Mesh->GetBoundingBox() : FBox(FVector(-50), FVector(50));
	const FVector Extent = Box.GetSize();
	const FVector Dir = B - A;
	const FVector Scale(Dir.Size() / FMath::Max(Extent.X, 1.0), ThickM * kCm / FMath::Max(Extent.Y, 1.0), ThickM * kCm / FMath::Max(Extent.Z, 1.0));
	const FRotator Rot = Dir.Rotation();
	return FTransform(Rot, (A + B) * 0.5 - Rot.RotateVector(Box.GetCenter() * Scale), Scale);
}

// ---------- terrain

int32 ASkiResort::ChunksX() const { return FMath::DivideAndRoundUp(Ski::kTerrainCols - 1, kChunkCells); }

int32 ASkiResort::ChunksY() const { return FMath::DivideAndRoundUp(Ski::kTerrainRows - 1, kChunkCells); }

FLinearColor ASkiResort::TerrainColor(double X, double Y, double ElevationM) const
{
	if (bShowSteepness)
	{
		// The run classifier's pitches: green < 25%, blue < 40%, black < 60%, red beyond.
		const double G = Ski::GradeAt(X, Y);
		const FLinearColor Tint = G < 0.25 ? Hex(TEXT("3cb172")) : G < 0.4 ? Hex(TEXT("3b82d6")) : G < 0.6 ? Hex(TEXT("1b1b1b")) : Hex(TEXT("d0453a"));
		return FLinearColor::LerpUsingHSV(kSnow, Tint, 0.75f);
	}
	const double Rock = Ski::RockAt(X, Y);
	FLinearColor C = kSnow;
	// Wind-scoured snow higher up is a touch bluer.
	C = FMath::Lerp(C, FLinearColor(0.80f, 0.86f, 0.96f), static_cast<float>(Ski::SmoothStep(1500, 2600, ElevationM)) * 0.5f);
	return FMath::Lerp(C, kRock, static_cast<float>(Ski::SmoothStep(0.35, 0.6, Rock)));
}

void ASkiResort::BuildTerrainChunk(int32 Index)
{
	UProceduralMeshComponent* Chunk = TerrainChunks.IsValidIndex(Index) ? TerrainChunks[Index].Get() : nullptr;
	if (!Chunk) return;
	const int32 I0 = (Index % ChunksX()) * kChunkCells;
	const int32 J0 = (Index / ChunksX()) * kChunkCells;
	const int32 I1 = FMath::Min(I0 + kChunkCells, Ski::kTerrainCols - 1);
	const int32 J1 = FMath::Min(J0 + kChunkCells, Ski::kTerrainRows - 1);
	const int32 W = I1 - I0 + 1;
	const double Cell = Ski::kTerrainCellM;
	auto ElevAt = [](int32 I, int32 J) { return Ski::kBaseElevM + Ski::HeightAtCell(I, J) * Ski::kVerticalM; };

	TArray<FVector> Vertices;
	TArray<FVector> Normals;
	TArray<FVector2D> UVs;
	TArray<FLinearColor> Colors;
	TArray<int32> Triangles;
	const int32 Count = W * (J1 - J0 + 1);
	Vertices.Reserve(Count);
	Normals.Reserve(Count);
	UVs.Reserve(Count);
	Colors.Reserve(Count);
	for (int32 J = J0; J <= J1; J++)
	{
		for (int32 I = I0; I <= I1; I++)
		{
			const double X = I * Cell;
			const double Y = J * Cell;
			const double E = ElevAt(I, J);
			Vertices.Add(ToWorldAt(X, Y, E));
			// Slope in map space (y north); world Y points south.
			const double DX = (ElevAt(I + 1, J) - ElevAt(I - 1, J)) * VerticalScale / (2 * Cell);
			const double DY = (ElevAt(I, J + 1) - ElevAt(I, J - 1)) * VerticalScale / (2 * Cell);
			Normals.Add(FVector(-DX, DY, 1.0).GetSafeNormal());
			UVs.Add(FVector2D(X / 50, Y / 50));
			Colors.Add(TerrainColor(X, Y, E));
		}
	}
	for (int32 J = 0; J < J1 - J0; J++)
	{
		for (int32 I = 0; I < W - 1; I++)
		{
			const int32 V00 = J * W + I;
			const int32 V10 = V00 + 1;
			const int32 V01 = V00 + W;
			const int32 V11 = V01 + 1;
			AddUpTriangle(Triangles, Vertices, V00, V10, V01);
			AddUpTriangle(Triangles, Vertices, V10, V11, V01);
		}
	}
	Chunk->CreateMeshSection_LinearColor(0, Vertices, Triangles, Normals, UVs, Colors, TArray<FProcMeshTangent>(), false);
	Chunk->SetMaterial(0, VertexColorMaterial ? VertexColorMaterial.Get() : ColorMaterial(kSnow));
}

void ASkiResort::RebuildTerrainCells(int32 I0, int32 I1, int32 J0, int32 J1)
{
	// Normals reach one cell further.
	const int32 CX0 = FMath::Max(0, (I0 - 1) / kChunkCells);
	const int32 CX1 = FMath::Min(ChunksX() - 1, (I1 + 1) / kChunkCells);
	const int32 CY0 = FMath::Max(0, (J0 - 1) / kChunkCells);
	const int32 CY1 = FMath::Min(ChunksY() - 1, (J1 + 1) / kChunkCells);
	for (int32 CY = CY0; CY <= CY1; CY++)
		for (int32 CX = CX0; CX <= CX1; CX++) BuildTerrainChunk(CY * ChunksX() + CX);
}

// ---------- the forest

int32 ASkiResort::ForestTilesX() const { return FMath::CeilToInt32(Ski::kWorldW / kForestTileM); }

int32 ASkiResort::ForestTilesY() const { return FMath::CeilToInt32(Ski::kWorldH / kForestTileM); }

int32 ASkiResort::DesiredStride(int32 Index, const FVector& Camera) const
{
	const double X0 = (Index % ForestTilesX()) * kForestTileM;
	const double Y0 = (Index / ForestTilesX()) * kForestTileM;
	const Ski::Vec2 Cam = ToMap(Camera);
	const double DX = FMath::Max3(X0 - Cam.x, 0.0, Cam.x - (X0 + kForestTileM));
	const double DY = FMath::Max3(Y0 - Cam.y, 0.0, Cam.y - (Y0 + kForestTileM));
	const double Height = FMath::Max(0.0, Camera.Z / kCm / VerticalScale + Ski::kBaseElevM - MeshElevationM(Cam.x, Cam.y));
	const double D = FMath::Sqrt(DX * DX + DY * DY + Height * Height);
	// Sparser far away: strides are nested, so zooming out only thins the forest.
	return D < 1500 ? 1 : D < 3000 ? 2 : D < 6000 ? 4 : D < 12000 ? 8 : 16;
}

void ASkiResort::BuildForestTile(int32 Index, int32 Stride)
{
	FForestTile& Tile = ForestTiles[Index];
	if (!Tile.Mesh)
	{
		Tile.Mesh = NewObject<UInstancedStaticMeshComponent>(this, *FString::Printf(TEXT("Forest%d"), Index));
		Tile.Mesh->SetMobility(EComponentMobility::Movable);
		Tile.Mesh->SetStaticMesh(ConeMesh);
		Tile.Mesh->SetMaterial(0, ColorMaterial(Hex(TEXT("24432f"))));
		Tile.Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Tile.Mesh->SetCanEverAffectNavigation(false);
		Tile.Mesh->SetupAttachment(Root);
		Tile.Mesh->RegisterComponent();
		ForestMeshes.Add(Tile.Mesh);
	}
	const double X0 = (Index % ForestTilesX()) * kForestTileM;
	const double Y0 = (Index / ForestTilesX()) * kForestTileM;
	const double X1 = X0 + kForestTileM;
	const double Y1 = Y0 + kForestTileM;
	// Trees are jittered past their grid cell, so look a cell beyond the tile and keep what lands inside.
	const std::vector<Ski::ForestTree> Trees = Game->treesIn(X0 - 12, Y0 - 12, X1 + 12, Y1 + 12, true, Stride);
	TArray<FTransform> Transforms;
	Transforms.Reserve(static_cast<int32>(Trees.size()));
	// Far-off trees stand in for the ones skipped around them, so draw them a little bigger.
	const double Boost = 1 + 0.12 * std::log2(static_cast<double>(Stride));
	for (const Ski::ForestTree& T : Trees)
	{
		if (T.x < X0 || T.x >= X1 || T.y < Y0 || T.y >= Y1) continue;
		const double H = (9 + PositionHash(T.x, T.y) * 9) * Boost;
		Transforms.Add(ShapeTransform(ConeMesh, ToWorld(T.x, T.y, -0.5), FVector(H * 0.55, H * 0.55, H), 0.f));
	}
	SetInstances(Tile.Mesh, Transforms);
	Tile.Stride = Stride;
	Tile.Version = Game->forestVersion;
}

void ASkiResort::UpdateForest()
{
	struct FJob
	{
		int32 Index;
		int32 Stride;
		double Distance;
	};
	const FVector Camera = CameraLocation();
	const Ski::Vec2 Cam = ToMap(Camera);
	TArray<FJob> Jobs;
	for (int32 I = 0; I < ForestTiles.Num(); I++)
	{
		const int32 Want = DesiredStride(I, Camera);
		if (ForestTiles[I].Stride == Want && ForestTiles[I].Version == Game->forestVersion) continue;
		const double CX = (I % ForestTilesX() + 0.5) * kForestTileM;
		const double CY = (I / ForestTilesX() + 0.5) * kForestTileM;
		Jobs.Add({I, Want, FMath::Square(CX - Cam.x) + FMath::Square(CY - Cam.y)});
	}
	Jobs.Sort([](const FJob& A, const FJob& B) { return A.Distance < B.Distance; });
	const double Start = FPlatformTime::Seconds();
	for (const FJob& Job : Jobs)
	{
		BuildForestTile(Job.Index, Job.Stride);
		if ((FPlatformTime::Seconds() - Start) * 1000 > ForestBudgetMs) break;
	}
}

// ---------- runs, roads and paths

void ASkiResort::AddRibbon(FRibbon& Out, const std::vector<Ski::Vec2>& Points, double WidthM, double LiftM, const FLinearColor& Color) const
{
	if (Points.size() < 2) return;
	struct FSample
	{
		Ski::Vec2 P;
		Ski::Vec2 Dir;
	};
	TArray<FSample> Samples;
	for (size_t I = 1; I < Points.size(); I++)
	{
		const Ski::Vec2 A = Points[I - 1];
		const Ski::Vec2 B = Points[I];
		const double Len = FMath::Max(0.001, std::hypot(B.x - A.x, B.y - A.y));
		const Ski::Vec2 Dir{(B.x - A.x) / Len, (B.y - A.y) / Len};
		const int32 N = FMath::Max(1, FMath::CeilToInt32(Len / 8));
		for (int32 K = 0; K < N; K++) Samples.Add({{A.x + (B.x - A.x) * K / N, A.y + (B.y - A.y) * K / N}, Dir});
		if (I + 1 == Points.size()) Samples.Add({B, Dir});
	}
	const int32 Base = Out.Vertices.Num();
	double Along = 0;
	for (int32 S = 0; S < Samples.Num(); S++)
	{
		const FSample& Sm = Samples[S];
		if (S > 0) Along += std::hypot(Sm.P.x - Samples[S - 1].P.x, Sm.P.y - Samples[S - 1].P.y);
		const Ski::Vec2 Side{-Sm.Dir.y * WidthM / 2, Sm.Dir.x * WidthM / 2};
		Out.Vertices.Add(ToWorld(Sm.P.x + Side.x, Sm.P.y + Side.y, LiftM));
		Out.Vertices.Add(ToWorld(Sm.P.x - Side.x, Sm.P.y - Side.y, LiftM));
		for (int32 K = 0; K < 2; K++)
		{
			Out.Normals.Add(FVector::UpVector);
			Out.Colors.Add(Color);
		}
		Out.UVs.Add(FVector2D(0, Along / WidthM));
		Out.UVs.Add(FVector2D(1, Along / WidthM));
	}
	for (int32 S = 0; S + 1 < Samples.Num(); S++)
	{
		const int32 A = Base + S * 2;
		AddUpTriangle(Out.Triangles, Out.Vertices, A, A + 1, A + 2);
		AddUpTriangle(Out.Triangles, Out.Vertices, A + 1, A + 3, A + 2);
	}
}

void ASkiResort::UpdateNetwork()
{
	FString Key = FString::Printf(TEXT("%d:%d:%d:%d:"), Game->terrainEdits, Game->roadVersion, Game->pathVersion, static_cast<int32>(Game->roads.size()));
	for (const Ski::Trail& T : Game->trails) Key += FString::Printf(TEXT("%d.%d.%d,"), T.id, T.difficulty, static_cast<int32>(T.points.size()));
	if (Key == NetworkKey) return;
	NetworkKey = Key;

	// Sections: one per run difficulty, then roads, the highway and footpaths.
	static const TCHAR* const SectionColors[] = {TEXT("3cb172"), TEXT("3b82d6"), TEXT("1b1b1b"), TEXT("0d0d0d"), TEXT("3d3f44"), TEXT("34363b"), TEXT("a08868")};
	constexpr int32 NumSections = UE_ARRAY_COUNT(SectionColors);
	FRibbon Sections[NumSections];
	for (const Ski::Trail& T : Game->trails)
	{
		const int32 D = FMath::Clamp(T.difficulty, 0, 3);
		AddRibbon(Sections[D], T.points, Ski::Spec(T.kind).width, 0.6, Hex(SectionColors[D]));
	}
	for (const Ski::Road& R : Game->roads)
	{
		const int32 S = R.highway ? 5 : 4;
		AddRibbon(Sections[S], R.points, R.highway ? Ski::kRoadWidth * 1.4 : Ski::kRoadWidth, 0.4, Hex(SectionColors[S]));
	}
	for (const Ski::Path& P : Game->paths) AddRibbon(Sections[6], P.points, Ski::kPathWidth, 0.3, Hex(SectionColors[6]));

	for (int32 S = 0; S < NumSections; S++)
	{
		if (!Sections[S].Vertices.Num())
		{
			NetworkMesh->ClearMeshSection(S);
			continue;
		}
		NetworkMesh->CreateMeshSection_LinearColor(S, Sections[S].Vertices, Sections[S].Triangles, Sections[S].Normals, Sections[S].UVs,
			Sections[S].Colors, TArray<FProcMeshTangent>(), false);
		NetworkMesh->SetMaterial(S, VertexColorMaterial ? VertexColorMaterial.Get() : ColorMaterial(Hex(SectionColors[S])));
	}
}

// ---------- buildings and park features

void ASkiResort::UpdateBuildings()
{
	FString Key = FString::Printf(TEXT("%d:"), Game->terrainEdits);
	for (const Ski::Building& B : Game->buildings) Key += FString::Printf(TEXT("%d@%.0f,%.0f;"), B.id, B.x, B.y);
	for (const Ski::Feature& F : Game->features) Key += FString::Printf(TEXT("f%d;"), F.id);
	if (Key == BuildingKey) return;
	BuildingKey = Key;

	TMap<FName, TArray<FTransform>> Groups;
	TMap<FName, FLinearColor> GroupColors;
	auto Add = [&](FName Group, const TCHAR* Color, const FTransform& T) {
		Groups.FindOrAdd(Group).Add(T);
		GroupColors.Add(Group, Hex(Color));
	};
	// The starter lot and ticket booth, always there.
	const Ski::Vec2 Exit = Game->exit();
	const Ski::Vec2 Booth = Game->booth();
	Add(TEXT("Parking"), TEXT("4a4f57"), ShapeTransform(CubeMesh, ToWorld(Exit.x, Exit.y, -0.2), FVector(90, 50, 0.6)));
	Add(TEXT("Booth"), TEXT("e2b857"), ShapeTransform(CubeMesh, ToWorld(Booth.x, Booth.y, -0.3), FVector(5, 4, 3.5)));
	for (const Ski::Building& B : Game->buildings)
	{
		const FBuildingLook Look = LookOf(B.type);
		const double Yaw = B.angle ? -FMath::RadiansToDegrees(*B.angle) : 0.0;
		FVector Size;
		if (const Ski::ParkingSpec* P = Ski::Parking(B.type)) Size = FVector(P->w, P->d, Look.HeightM);
		else
		{
			const double Side = Ski::BuildingRadius(B.type) * (B.type == Ski::BuildingType::Heli ? 1.2 : 1.1);
			Size = FVector(Side, Side * 0.8, Look.HeightM);
		}
		Add(Look.Group, Look.Color, ShapeTransform(CubeMesh, ToWorld(B.x, B.y, -0.5), Size, static_cast<float>(Yaw)));
	}
	for (const Ski::Feature& F : Game->features)
	{
		const double Yaw = -FMath::RadiansToDegrees(F.angle);
		FVector Size(8, 5, 2.5);
		if (F.type == Ski::FeatureType::Rail) Size = FVector(10, 0.6, 1.2);
		else if (F.type == Ski::FeatureType::Box) Size = FVector(7, 2.5, 1);
		else if (F.type == Ski::FeatureType::Halfpipe) Size = FVector(60, 20, 4);
		Add(TEXT("Feature"), TEXT("a8d8f0"), ShapeTransform(CubeMesh, ToWorld(F.x, F.y, -0.2), Size, static_cast<float>(Yaw)));
	}
	// Clear groups that emptied out, then fill the rest.
	for (const auto& Pair : Instanced)
	{
		const FString Name = Pair.Key.ToString();
		const bool Ours = Name == TEXT("Booth") || Name == TEXT("Feature") || Name == TEXT("Parking") || Name == TEXT("Garage") || Name == TEXT("Lodge") ||
			Name == TEXT("Base") || Name == TEXT("Cabin") || Name == TEXT("Spa") || Name == TEXT("Heli") || Name == TEXT("Lookout") ||
			Name == TEXT("Hotel") || Name == TEXT("Shop") || Name == TEXT("Food");
		if (Ours && !Groups.Contains(Pair.Key)) SetInstances(Pair.Value, {});
	}
	for (const auto& Pair : Groups) SetInstances(InstancedMesh(Pair.Key, CubeMesh, GroupColors[Pair.Key]), Pair.Value);
}

// ---------- lifts

double ASkiResort::CableElevationM(const Ski::Lift& Lift, double T) const
{
	const Ski::LiftSpec& Spec = Ski::Spec(Lift.type);
	const double X = FMath::Lerp(Lift.bottom.x, Lift.top.x, T);
	const double Y = FMath::Lerp(Lift.bottom.y, Lift.top.y, T);
	const double Ground = MeshElevationM(X, Y);
	if (Spec.surface) return Ground + (Spec.towerH > 0 ? Spec.towerH * 0.85 : 0.6);
	const double Line = FMath::Lerp(MeshElevationM(Lift.bottom.x, Lift.bottom.y), MeshElevationM(Lift.top.x, Lift.top.y), T) + Spec.towerH;
	// A straight span, but never closer to the snow than most of a tower's height.
	return FMath::Max(Line, Ground + Spec.towerH * 0.6);
}

void ASkiResort::UpdateLifts()
{
	FString Key = FString::Printf(TEXT("%d:"), Game->terrainEdits);
	for (const Ski::Lift& L : Game->lifts) Key += FString::Printf(TEXT("%d,"), L.id);
	if (Key == LiftKey) return;
	LiftKey = Key;

	TArray<FTransform> Towers, Cables, Stations;
	for (const Ski::Lift& L : Game->lifts)
	{
		const Ski::LiftSpec& Spec = Ski::Spec(L.type);
		const double Len = std::hypot(L.top.x - L.bottom.x, L.top.y - L.bottom.y);
		const Ski::Vec2 Dir{(L.top.x - L.bottom.x) / Len, (L.top.y - L.bottom.y) / Len};
		const Ski::Vec2 Side{-Dir.y * 2.5, Dir.x * 2.5};
		const double Yaw = -FMath::RadiansToDegrees(std::atan2(Dir.y, Dir.x));
		const FVector StationSize = L.type == Ski::LiftType::Gondola ? FVector(20, 14, 9)
			: L.type == Ski::LiftType::Carpet                         ? FVector(4, 3, 2)
																	  : FVector(14, 10, 7);
		Stations.Add(ShapeTransform(CubeMesh, ToWorld(L.bottom.x, L.bottom.y, -0.5), StationSize, static_cast<float>(Yaw)));
		Stations.Add(ShapeTransform(CubeMesh, ToWorld(L.top.x, L.top.y, -0.5), StationSize, static_cast<float>(Yaw)));
		if (L.type == Ski::LiftType::Carpet)
		{
			// A belt on the snow.
			Cables.Add(SegmentTransform(CubeMesh, ToWorld(L.bottom.x, L.bottom.y, 0.3), ToWorld(L.top.x, L.top.y, 0.3), 1.2));
			continue;
		}
		const int32 N = FMath::Max(2, FMath::CeilToInt32(Len / 120));
		for (int32 K = 0; K <= N; K++)
		{
			const double T = static_cast<double>(K) / N;
			const double X = FMath::Lerp(L.bottom.x, L.top.x, T);
			const double Y = FMath::Lerp(L.bottom.y, L.top.y, T);
			const double Ground = MeshElevationM(X, Y);
			const double Height = (CableElevationM(L, T) - Ground) * VerticalScale + 1;
			if (K > 0 && K < N) Towers.Add(ShapeTransform(CylinderMesh, ToWorld(X, Y, -0.5), FVector(0.9, 0.9, Height), 0.f));
			if (K == 0) continue;
			const double TP = static_cast<double>(K - 1) / N;
			const double XP = FMath::Lerp(L.bottom.x, L.top.x, TP);
			const double YP = FMath::Lerp(L.bottom.y, L.top.y, TP);
			for (const double S : {1.0, -1.0})
			{
				const FVector A = ToWorldAt(XP + Side.x * S, YP + Side.y * S, CableElevationM(L, TP));
				const FVector B = ToWorldAt(X + Side.x * S, Y + Side.y * S, CableElevationM(L, T));
				Cables.Add(SegmentTransform(CubeMesh, A, B, Spec.surface ? 0.15 : 0.25));
			}
		}
	}
	SetInstances(InstancedMesh(TEXT("LiftTower"), CylinderMesh, Hex(TEXT("707880"))), Towers);
	SetInstances(InstancedMesh(TEXT("LiftCable"), CubeMesh, Hex(TEXT("2a2a2a")), false), Cables);
	SetInstances(InstancedMesh(TEXT("LiftStation"), CubeMesh, Hex(TEXT("b33a3a"))), Stations);
}

// ---------- peaks

void ASkiResort::UpdatePeaks()
{
	FString Key = FString::Printf(TEXT("%d:"), Game->terrainEdits);
	for (const std::string& Id : Game->conquered) Key += UTF8_TO_TCHAR(Id.c_str());
	if (Key == PeakKey) return;
	PeakKey = Key;
	TArray<FTransform> Poles, Red, Gold;
	for (const Ski::Summit& P : Ski::Summits())
	{
		const FVector Base = ToWorld(P.x, P.y, -1);
		Poles.Add(ShapeTransform(CylinderMesh, Base, FVector(0.8, 0.8, 30)));
		const FTransform Flag = ShapeTransform(CubeMesh, Base + FVector(300, 0, 2400), FVector(8, 0.4, 5));
		(Game->conquered.count(P.id) ? Gold : Red).Add(Flag);
	}
	SetInstances(InstancedMesh(TEXT("FlagPole"), CylinderMesh, Hex(TEXT("dddddd"))), Poles);
	SetInstances(InstancedMesh(TEXT("FlagRed"), CubeMesh, Hex(TEXT("c0392b"))), Red);
	SetInstances(InstancedMesh(TEXT("FlagGold"), CubeMesh, Hex(TEXT("e2b857"))), Gold);
}

// ---------- people and moving parts

void ASkiResort::UpdatePeople()
{
	TArray<FTransform> ByJacket[Ski::kJacketCount];
	const FVector Body(0.55 * PeopleScale, 0.55 * PeopleScale, 1.75 * PeopleScale);
	for (const Ski::Skier& S : Game->skiers)
	{
		if (S.state == Ski::SkierState::Heli) continue; // off the map, in the backcountry
		FVector At;
		if (S.state == Ski::SkierState::Riding && S.liftId)
		{
			const Ski::Lift* L = Game->findLift(*S.liftId);
			if (!L) continue;
			const Ski::LiftSpec& Spec = Ski::Spec(L->type);
			const double Len = FMath::Max(1.0, std::hypot(L->top.x - L->bottom.x, L->top.y - L->bottom.y));
			// Up the right-hand line, seated under the cable (or standing on the snow for surface lifts).
			const double SX = -(L->top.y - L->bottom.y) / Len * 2.5;
			const double SY = (L->top.x - L->bottom.x) / Len * 2.5;
			const double Hang = Spec.surface ? 0 : 2.4 + 1.75 * PeopleScale;
			At = Spec.surface ? ToWorld(S.x + SX, S.y + SY, 0) : ToWorldAt(S.x + SX, S.y + SY, CableElevationM(*L, S.rideT) - Hang / VerticalScale);
		}
		else At = ToWorld(S.x, S.y, S.air * 4);
		ByJacket[FMath::Clamp(S.color, 0, Ski::kJacketCount - 1)].Add(ShapeTransform(CylinderMesh, At, Body));
	}
	for (int32 I = 0; I < Ski::kJacketCount; I++)
	{
		const FName Name(*FString::Printf(TEXT("Skiers%d"), I));
		SetInstances(InstancedMesh(Name, CylinderMesh, FLinearColor(FColor::FromHex(UTF8_TO_TCHAR(Ski::kJackets[I]))), false), ByJacket[I]);
	}

	// Chairs, bars and cabins going up the line.
	TArray<FTransform> Carriers;
	for (const Ski::Lift& L : Game->lifts)
	{
		if (L.type == Ski::LiftType::Carpet) continue;
		const Ski::LiftSpec& Spec = Ski::Spec(L.type);
		const double Len = FMath::Max(1.0, std::hypot(L.top.x - L.bottom.x, L.top.y - L.bottom.y));
		const double SX = -(L.top.y - L.bottom.y) / Len * 2.5;
		const double SY = (L.top.x - L.bottom.x) / Len * 2.5;
		const double Yaw = -FMath::RadiansToDegrees(std::atan2(L.top.y - L.bottom.y, L.top.x - L.bottom.x)) + 90;
		const bool Gondola = L.type == Ski::LiftType::Gondola;
		const FVector Size = Gondola ? FVector(3, 2.6, 2.6) : FVector(Spec.seats * 0.7, 0.9, 0.5);
		for (const Ski::Carrier& C : L.carriers)
		{
			const double X = FMath::Lerp(L.bottom.x, L.top.x, C.t) + SX;
			const double Y = FMath::Lerp(L.bottom.y, L.top.y, C.t) + SY;
			const double Drop = Spec.surface ? 1.5 : Gondola ? 3.8 : 2.6;
			Carriers.Add(ShapeTransform(CubeMesh, ToWorldAt(X, Y, CableElevationM(L, C.t) - Drop / VerticalScale), Size, static_cast<float>(Yaw)));
		}
	}
	SetInstances(InstancedMesh(TEXT("Carriers"), CubeMesh, Hex(TEXT("d0d4d8")), false), Carriers);
}

void ASkiResort::UpdateSky()
{
	// The sun climbs from the south-east, peaks around 12:15 and sets toward 4 PM.
	const double F = Game->dayFraction();
	const double Elevation = 8 + 34 * std::sin(PI * F);
	const double Yaw = FMath::Lerp(120.0, 240.0, F);
	Sun->SetWorldRotation(FRotator(static_cast<float>(-Elevation), static_cast<float>(Yaw), 0.f));
	const Ski::Weather W = Game->weather();
	Sun->SetIntensity(static_cast<float>(10.0 * (1 - 0.65 * W.cover)));
	// A snowstorm closes the fog in.
	Fog->SetFogDensity(static_cast<float>(0.004 + W.snow * 0.02 + W.cover * 0.003));
}

void ASkiResort::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (!Game) return;
	Game->tick(FMath::Min(static_cast<double>(DeltaSeconds), 0.05));
	Game->sfx.clear(); // no audio yet
	if (const std::optional<Ski::CellRange> Dirty = Ski::TakeTerrainDirty()) RebuildTerrainCells(Dirty->i0, Dirty->i1, Dirty->j0, Dirty->j1);
	UpdateNetwork();
	UpdateBuildings();
	UpdateLifts();
	UpdatePeaks();
	UpdatePeople();
	UpdateForest();
	UpdateSky();
}
