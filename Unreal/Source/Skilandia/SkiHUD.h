#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"

#include "SkiHUD.generated.h"

class UFont;

/**
 * Stand-in interface drawn straight onto the canvas: the status bar, what the
 * hill is saying, the next goal, toasts, reward banners, the selection, the
 * current tool and the key list. The web game's full menus (src/main.ts,
 * index.html) are the next step, as UMG widgets.
 */
UCLASS()
class SKILANDIA_API ASkiHUD : public AHUD
{
	GENERATED_BODY()

public:
	virtual void DrawHUD() override;

private:
	/** Rewards already shown, and the one on screen now. */
	int32 LastRewardId = 0;
	FString BannerTitle;
	FString BannerText;
	double BannerUntil = 0;

	UFont* Font() const;
	UFont* BigFont() const;
	void Panel(float X, float Y, float W, float H, float Alpha = 0.55f);
	float Text(const FString& S, float X, float Y, const FLinearColor& Color = FLinearColor::White, UFont* InFont = nullptr, float Scale = 1.f);
	float TextWidth(const FString& S, UFont* InFont = nullptr, float Scale = 1.f);
	TArray<FString> Wrap(const FString& S, float MaxWidth, UFont* InFont = nullptr);
};
