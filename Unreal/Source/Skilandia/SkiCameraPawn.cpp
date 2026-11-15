#include "SkiCameraPawn.h"

#include "Camera/CameraComponent.h"

ASkiCameraPawn::ASkiCameraPawn()
{
	PrimaryActorTick.bCanEverTick = false;
	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	RootComponent = Camera;
	Camera->bUsePawnControlRotation = true;
	// About the web game's 48 degree vertical view on a 16:9 screen.
	Camera->SetFieldOfView(75.f);
	bUseControllerRotationPitch = true;
	bUseControllerRotationYaw = true;
	SetActorEnableCollision(false);
}
