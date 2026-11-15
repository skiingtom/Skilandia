#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"

#include "SkiCameraPawn.generated.h"

class UCameraComponent;

/** Just a camera. ASkiPlayerController flies it around (see its camera code). */
UCLASS()
class SKILANDIA_API ASkiCameraPawn : public APawn
{
	GENERATED_BODY()

public:
	ASkiCameraPawn();

	UPROPERTY(VisibleAnywhere, Category = "Skilandia")
	TObjectPtr<UCameraComponent> Camera;
};
