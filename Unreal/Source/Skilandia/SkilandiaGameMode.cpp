#include "SkilandiaGameMode.h"

#include "EngineUtils.h"
#include "SkiCameraPawn.h"
#include "SkiHUD.h"
#include "SkiPlayerController.h"
#include "SkiResort.h"

ASkilandiaGameMode::ASkilandiaGameMode()
{
	DefaultPawnClass = ASkiCameraPawn::StaticClass();
	PlayerControllerClass = ASkiPlayerController::StaticClass();
	HUDClass = ASkiHUD::StaticClass();
}

void ASkilandiaGameMode::StartPlay()
{
	UWorld* World = GetWorld();
	if (World && !TActorIterator<ASkiResort>(World))
	{
		FActorSpawnParameters Params;
		Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
		World->SpawnActor<ASkiResort>(ASkiResort::StaticClass(), FTransform::Identity, Params);
	}
	Super::StartPlay();
}
