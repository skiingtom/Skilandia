#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "SkiGame.h"

#include "SkiPlayerController.generated.h"

class ASkiResort;

/**
 * The player's hands: flies the camera like the web game (right-drag to look,
 * scroll to zoom, WASD to fly, faster the higher you are; Q/E up and down),
 * turns keys into tools, and sends clicks on the ground to the simulation.
 *
 * There is no menu UI yet: tools are on the keyboard, and ASkiHUD lists them.
 */
UCLASS()
class SKILANDIA_API ASkiPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	ASkiPlayerController();

	virtual void BeginPlay() override;
	virtual void PlayerTick(float DeltaTime) override;
	virtual void SetupInputComponent() override;

	ASkiResort* GetResort() const;

	/** The ground under the mouse pointer, if it's over the map. */
	bool bHasHover = false;
	Ski::Vec2 HoverMap;
	FVector HoverWorld = FVector::ZeroVector;

	/** One line about the current tool, and one about what it would do under the pointer. */
	FString ToolLine;
	FString HoverLine;
	bool bHoverOk = true;

	bool bShowHelp = true;

	/** Build menu order (the web game's Base, Food, Dining, Shops, Hotels, Resort and Parking menus). */
	static const TArray<Ski::BuildingType>& BuildOrder();

private:
	mutable TWeakObjectPtr<ASkiResort> Resort;
	bool bCameraReady = false;
	/** Orbit camera: the point looked at (world cm), angles in degrees, distance in cm. */
	FVector Target = FVector::ZeroVector;
	double Yaw = 0;
	double Pitch = -35;
	double Distance = 160000;
	/** Q / E: how far (m) the look-at point floats above the ground. */
	double TargetLiftM = 0;
	float Wheel = 0;
	FVector2D LastMouse = FVector2D::ZeroVector;
	bool bShaping = false;
	bool bPainting = false;
	int32 BuildIndex = 0;
	Ski::LiftType LiftChoice = Ski::LiftType::Quad;

	void OnWheel(float Value);
	void InitCamera(ASkiResort& R);
	void FocusOn(ASkiResort& R, double X, double Y, double DistanceM);
	void UpdateCamera(ASkiResort& R, float DeltaTime, const FVector2D& MouseDelta);
	void HandleKeys(ASkiResort& R);
	void HandleMouse(ASkiResort& R, float DeltaTime);
	void DescribeTool(ASkiResort& R);
	void DrawOverlays(ASkiResort& R) const;
	void DrawGroundCircle(const ASkiResort& R, double X, double Y, double RadiusM, const FColor& Color) const;
	void DrawGroundLine(const ASkiResort& R, const Ski::Vec2& A, const Ski::Vec2& B, const FColor& Color) const;
	bool Pressed(const FKey& Key) const { return WasInputKeyJustPressed(Key); }
	bool Shift() const;
};
