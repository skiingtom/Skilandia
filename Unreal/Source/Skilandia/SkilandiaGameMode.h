#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"

#include "SkilandiaGameMode.generated.h"

/**
 * Sets up the camera pawn, the controller (input and tools) and the HUD, and
 * makes sure the level has a resort in it: any map works, even an empty one.
 */
UCLASS()
class SKILANDIA_API ASkilandiaGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	ASkilandiaGameMode();
	virtual void StartPlay() override;
};
