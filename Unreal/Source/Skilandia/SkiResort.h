#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "SkiGame.h"

#include "SkiResort.generated.h"

class UDirectionalLightComponent;
class UExponentialHeightFogComponent;
class UInstancedStaticMeshComponent;
class UMaterialInstanceDynamic;
class UMaterialInterface;
class UProceduralMeshComponent;
class USkyAtmosphereComponent;
class USkyLightComponent;
class UStaticMesh;

/**
 * The resort: owns the simulation (Ski::Game, see Core/) and draws it.
 *
 * Map coordinates are metres with x east and y north, as in the web game.
 * Unreal is in centimetres, left-handed, Z up: world X = x, world Y = -y, and
 * world Z = (elevation - 500 m) * VerticalScale. Use ToWorld / ToMap rather
 * than converting by hand.
 *
 * Everything is drawn from engine basic shapes and procedural meshes, so the
 * project needs no art assets yet. Optional: the editor creates
 * /Game/Skilandia/M_VertexColor on start-up (Content/Python/init_unreal.py)
 * so the terrain shows rock, snow and the steepness tint.
 */
UCLASS()
class SKILANDIA_API ASkiResort : public AActor
{
	GENERATED_BODY()

public:
	ASkiResort();
	virtual ~ASkiResort() override;

	virtual void Tick(float DeltaSeconds) override;

	/** The first resort in the world, if any. */
	static ASkiResort* Find(const UWorld* World);

	/** The simulation, or null if the heightmap failed to load. */
	Ski::Game* GetGame() const { return Game.Get(); }
	/** Why the resort couldn't start, or empty. */
	const FString& GetLoadError() const { return LoadError; }

	/** Map position (metres) and elevation (metres above sea level) to world space. */
	FVector ToWorldAt(double X, double Y, double ElevationM) const;
	/** A map position on the drawn ground, lifted by `LiftM` metres. */
	FVector ToWorld(double X, double Y, double LiftM = 0) const;
	Ski::Vec2 ToMap(const FVector& World) const;
	/** Elevation (m) of the drawn terrain mesh, which differs slightly from the sim's bilinear ground. */
	double MeshElevationM(double X, double Y) const;
	/** Where a ray (world space) first meets the ground. */
	bool TraceGround(const FVector& Origin, const FVector& Direction, Ski::Vec2& OutMap, FVector& OutWorld) const;

	bool IsShowingSteepness() const { return bShowSteepness; }
	void SetShowSteepness(bool bShow);

	/** Vertical exaggeration; the web game draws the mountains 1.15x as tall. */
	UPROPERTY(EditAnywhere, Category = "Skilandia")
	float VerticalScale = 1.15f;

	/** People are drawn this much bigger than life so they read from the air. */
	UPROPERTY(EditAnywhere, Category = "Skilandia")
	float PeopleScale = 3.f;

	/** Seed for the simulation's random choices. */
	UPROPERTY(EditAnywhere, Category = "Skilandia")
	int32 Seed = 12345;

	/** Milliseconds a frame may spend rebuilding forest tiles. */
	UPROPERTY(EditAnywhere, Category = "Skilandia")
	float ForestBudgetMs = 4.f;

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type Reason) override;

private:
	struct FForestTile
	{
		/** Owned through ForestMeshes. */
		UInstancedStaticMeshComponent* Mesh = nullptr;
		int32 Stride = 0;
		int32 Version = -1;
	};

	TUniquePtr<Ski::Game> Game;
	FString LoadError;
	bool bShowSteepness = false;

	UPROPERTY()
	TObjectPtr<USceneComponent> Root;
	UPROPERTY()
	TObjectPtr<UDirectionalLightComponent> Sun;
	UPROPERTY()
	TObjectPtr<USkyLightComponent> SkyLight;
	UPROPERTY()
	TObjectPtr<USkyAtmosphereComponent> Atmosphere;
	UPROPERTY()
	TObjectPtr<UExponentialHeightFogComponent> Fog;

	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> CylinderMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> ConeMesh;
	UPROPERTY()
	TObjectPtr<UMaterialInterface> ShapeMaterial;
	UPROPERTY()
	TObjectPtr<UMaterialInterface> VertexColorMaterial;
	UPROPERTY()
	TArray<TObjectPtr<UMaterialInstanceDynamic>> Materials;
	/** Materials by colour (FColor::DWColor); owned through Materials. */
	TMap<uint32, UMaterialInstanceDynamic*> MaterialByColor;

	UPROPERTY()
	TArray<TObjectPtr<UProceduralMeshComponent>> TerrainChunks;
	UPROPERTY()
	TObjectPtr<UProceduralMeshComponent> NetworkMesh;
	TArray<FForestTile> ForestTiles;
	UPROPERTY()
	TArray<TObjectPtr<UInstancedStaticMeshComponent>> ForestMeshes;

	/** Rebuilt when what they show changes. */
	UPROPERTY()
	TMap<FName, TObjectPtr<UInstancedStaticMeshComponent>> Instanced;

	FString NetworkKey;
	FString BuildingKey;
	FString LiftKey;
	FString PeakKey;

	// ---------- set-up
	void LoadAssets();
	bool StartGame();
	UMaterialInterface* ColorMaterial(const FLinearColor& Color);
	UInstancedStaticMeshComponent* InstancedMesh(FName Name, UStaticMesh* Mesh, const FLinearColor& Color, bool bShadows = true);
	static void SetInstances(UInstancedStaticMeshComponent* Mesh, const TArray<FTransform>& Transforms);
	/** A transform that stands `Mesh` on `Base` with the given size in metres. */
	FTransform ShapeTransform(const UStaticMesh* Mesh, const FVector& Base, const FVector& SizeM, float YawDeg = 0.f) const;
	/** A transform that stretches `Mesh` from A to B (world space), `ThickM` metres across. */
	FTransform SegmentTransform(const UStaticMesh* Mesh, const FVector& A, const FVector& B, double ThickM) const;
	struct FRibbon
	{
		TArray<FVector> Vertices;
		TArray<int32> Triangles;
		TArray<FVector> Normals;
		TArray<FVector2D> UVs;
		TArray<FLinearColor> Colors;
	};
	/** A strip draped over the ground along a polyline (runs, roads, paths). */
	void AddRibbon(FRibbon& Out, const std::vector<Ski::Vec2>& Points, double WidthM, double LiftM, const FLinearColor& Color) const;

	// ---------- terrain
	int32 ChunksX() const;
	int32 ChunksY() const;
	void BuildTerrainChunk(int32 Index);
	void RebuildTerrainCells(int32 I0, int32 I1, int32 J0, int32 J1);
	FLinearColor TerrainColor(double X, double Y, double ElevationM) const;

	// ---------- the forest
	int32 ForestTilesX() const;
	int32 ForestTilesY() const;
	void UpdateForest();
	void BuildForestTile(int32 Index, int32 Stride);
	int32 DesiredStride(int32 Index, const FVector& Camera) const;

	// ---------- everything else
	void UpdateNetwork();
	void UpdateBuildings();
	void UpdateLifts();
	void UpdatePeaks();
	void UpdatePeople();
	void UpdateSky();
	/** Height (m) of a lift's cable `T` of the way up (0 bottom, 1 top). */
	double CableElevationM(const Ski::Lift& Lift, double T) const;
	FVector CameraLocation() const;
};
