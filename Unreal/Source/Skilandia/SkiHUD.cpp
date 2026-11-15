#include "SkiHUD.h"

#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Camera/PlayerCameraManager.h"
#include "Engine/Font.h"
#include "GameFramework/PlayerController.h"
#include "SkiPlayerController.h"
#include "SkiResort.h"

#include <cmath>
#include <string>

namespace
{
FString Str(const std::string& S) { return FString(UTF8_TO_TCHAR(S.c_str())); }

FString Money(double V) { return FString::Printf(TEXT("$%s"), *FText::AsNumber(FMath::RoundToInt64(V)).ToString()); }

FString Count(double V) { return FText::AsNumber(FMath::RoundToInt64(V)).ToString(); }

const FLinearColor kGold(0.89f, 0.72f, 0.34f);
const FLinearColor kSoft(0.82f, 0.86f, 0.92f);
const FLinearColor kBad(1.f, 0.42f, 0.36f);
const FLinearColor kGood(0.45f, 0.9f, 0.55f);

const TCHAR* const kHelp[] = {
	TEXT("Right-drag  look around"),
	TEXT("Scroll  zoom"),
	TEXT("WASD  fly (Shift faster), Q/E up/down"),
	TEXT("Middle-drag  pan    Home  back to base"),
	TEXT("T  cut a run (again: next kind)"),
	TEXT("L  build a lift (again: next type)"),
	TEXT("B / Shift+B  buildings"),
	TEXT("F  park features"),
	TEXT("R  road    P  footpath"),
	TEXT("X  demolish    M  move selected building"),
	TEXT("C  clear trees    V  plant trees"),
	TEXT("K  shape terrain (again: mode, Shift: size)"),
	TEXT("Enter  finish run / road / path"),
	TEXT("Esc  cancel"),
	TEXT("G  show steepness"),
	TEXT("Space  pause    1 2 3  speed"),
	TEXT("+ / -  ticket price"),
	TEXT("F1-F6  hire staff (Shift: let go)"),
	TEXT("Tab  hide this list"),
};
} // namespace

UFont* ASkiHUD::Font() const { return GEngine ? GEngine->GetMediumFont() : nullptr; }

UFont* ASkiHUD::BigFont() const { return GEngine ? GEngine->GetLargeFont() : nullptr; }

void ASkiHUD::Panel(float X, float Y, float W, float H, float Alpha) { DrawRect(FLinearColor(0.03f, 0.05f, 0.08f, Alpha), X, Y, W, H); }

float ASkiHUD::Text(const FString& S, float X, float Y, const FLinearColor& Color, UFont* InFont, float Scale)
{
	UFont* F = InFont ? InFont : Font();
	DrawText(S, Color, X, Y, F, Scale);
	float W = 0, H = 0;
	GetTextSize(S, W, H, F, Scale);
	return H;
}

float ASkiHUD::TextWidth(const FString& S, UFont* InFont, float Scale)
{
	float W = 0, H = 0;
	GetTextSize(S, W, H, InFont ? InFont : Font(), Scale);
	return W;
}

TArray<FString> ASkiHUD::Wrap(const FString& S, float MaxWidth, UFont* InFont)
{
	TArray<FString> Words;
	S.ParseIntoArray(Words, TEXT(" "));
	TArray<FString> Lines;
	FString Line;
	for (const FString& Word : Words)
	{
		const FString Try = Line.IsEmpty() ? Word : Line + TEXT(" ") + Word;
		if (!Line.IsEmpty() && TextWidth(Try, InFont) > MaxWidth)
		{
			Lines.Add(Line);
			Line = Word;
		}
		else Line = Try;
	}
	if (!Line.IsEmpty()) Lines.Add(Line);
	return Lines;
}

void ASkiHUD::DrawHUD()
{
	Super::DrawHUD();
	if (!Canvas) return;
	const float SW = Canvas->ClipX;
	const float SH = Canvas->ClipY;
	ASkiResort* Resort = ASkiResort::Find(GetWorld());
	if (!Resort) return;
	if (!Resort->GetGame())
	{
		const FString Error = Resort->GetLoadError().IsEmpty() ? FString(TEXT("Starting...")) : Resort->GetLoadError();
		Panel(SW * 0.2f, SH * 0.45f, SW * 0.6f, 60, 0.8f);
		Text(Error, SW * 0.2f + 16, SH * 0.45f + 18, kBad);
		return;
	}
	Ski::Game& G = *Resort->GetGame();
	ASkiPlayerController* PC = Cast<ASkiPlayerController>(PlayerOwner);
	const double Now = GetWorld()->GetTimeSeconds();

	// ---------- floating money and skier bubbles, under everything else
	if (PlayerOwner)
	{
		FVector2D P;
		for (const Ski::Fx& F : G.fx)
		{
			if (!PlayerOwner->ProjectWorldLocationToScreen(Resort->ToWorld(F.x, F.y, 12), P)) continue;
			FLinearColor C(FColor::FromHex(Str(F.color)));
			C.A = FMath::Clamp(static_cast<float>(F.life), 0.f, 1.f);
			const FString S = Str(F.text);
			Text(S, P.X - TextWidth(S) / 2, P.Y, C);
		}
		const FVector Eye = PlayerOwner->PlayerCameraManager ? PlayerOwner->PlayerCameraManager->GetCameraLocation() : FVector::ZeroVector;
		for (const Ski::Skier& S : G.skiers)
		{
			if (S.bubble.empty() || S.state == Ski::SkierState::Heli) continue;
			const FVector At = Resort->ToWorld(S.x, S.y, 4 + 2 * Resort->PeopleScale);
			if (FVector::Dist(At, Eye) > 250000) continue;
			if (!PlayerOwner->ProjectWorldLocationToScreen(At, P)) continue;
			const FString B = Str(S.bubble);
			const float W = TextWidth(B) + 12;
			Panel(P.X - W / 2, P.Y - 24, W, 22, 0.7f);
			Text(B, P.X - W / 2 + 6, P.Y - 22, FLinearColor::White);
		}
	}

	// ---------- the status bar
	Panel(0, 0, SW, 34, 0.65f);
	const Ski::WeatherReport W = G.weatherReport();
	const Ski::LoadLimits Load = G.loadLimits();
	int32 OnHill = 0;
	for (const Ski::Skier& S : G.skiers)
		if (S.state != Ski::SkierState::Leaving && S.state != Ski::SkierState::Arriving) OnHill++;
	const FString Left = FString::Printf(TEXT("%s    %s    %d\x00B0" "C, wind %d km/h, fresh snow %d cm"), *Money(G.money), *Str(G.clockLabel()), W.tempC, W.windKmh, W.freshCm);
	Text(Left, 14, 8, kGold);
	const FString Mid = FString::Printf(TEXT("Skiers %s / %s    Mood %d    Ticket $%d (fair $%d)"), *Count(OnHill), *Count(Load.comfortable),
		FMath::RoundToInt32(G.mood), FMath::RoundToInt32(G.ticketPrice), FMath::RoundToInt32(G.fairPrice()));
	Text(Mid, SW * 0.5f - TextWidth(Mid) / 2, 8, FLinearColor::White);
	const FString Right = FString::Printf(TEXT("%s    %d/%d peaks    %s"), UTF8_TO_TCHAR(Ski::kTiers[G.tier()].name), static_cast<int32>(G.conquered.size()),
		static_cast<int32>(Ski::Summits().size()), G.paused ? TEXT("Paused") : *FString::Printf(TEXT("%dx"), FMath::RoundToInt32(G.speed)));
	Text(Right, SW - TextWidth(Right) - 14, 8, kSoft);

	// ---------- what the hill is saying, and the next goal
	{
		const float PW = FMath::Min(460.f, SW * 0.34f);
		const float PX = SW - PW - 12;
		float Y = 44;
		TArray<FString> Lines;
		for (const std::string& C : G.complaints()) Lines.Append(Wrap(Str(C), PW - 24));
		FString Next;
		for (const Ski::Goal& Goal : G.goals())
			if (!Goal.done)
			{
				Next = Str(Goal.text);
				break;
			}
		const TArray<FString> GoalLines = Next.IsEmpty() ? TArray<FString>{TEXT("Every goal reached!")} : Wrap(Next, PW - 24);
		const float LineH = 20;
		Panel(PX, Y, PW, 34 + LineH * (Lines.Num() + GoalLines.Num()) + 26);
		Y += 8;
		Y += Text(TEXT("The hill is saying"), PX + 12, Y, kGold);
		for (const FString& L : Lines) Y += Text(L, PX + 12, Y, kSoft);
		Y += 6;
		Y += Text(TEXT("Next goal"), PX + 12, Y, kGold);
		for (const FString& L : GoalLines) Y += Text(L, PX + 12, Y, FLinearColor::White);
	}

	// ---------- key list
	if (PC && PC->bShowHelp)
	{
		const float PW = 340;
		const float LineH = 19;
		const int32 N = UE_ARRAY_COUNT(kHelp);
		Panel(12, 44, PW, N * LineH + 20, 0.5f);
		float Y = 54;
		for (const TCHAR* L : kHelp) Y += Text(L, 24, Y, kSoft);
	}

	// ---------- reward banners, one at a time
	for (const Ski::Reward& R : G.rewards)
	{
		if (R.id <= LastRewardId || Now < BannerUntil) continue;
		LastRewardId = R.id;
		BannerTitle = Str(R.title);
		BannerText = Str(R.text) + FString::Printf(TEXT("  Bonus +%s"), *Money(R.bonus));
		BannerUntil = Now + 4.5;
		break;
	}
	if (Now < BannerUntil)
	{
		const float TW = FMath::Max(TextWidth(BannerTitle, BigFont()), TextWidth(BannerText)) + 60;
		Panel(SW / 2 - TW / 2, SH * 0.16f, TW, 74, 0.8f);
		Text(BannerTitle, SW / 2 - TextWidth(BannerTitle, BigFont()) / 2, SH * 0.16f + 8, kGold, BigFont());
		Text(BannerText, SW / 2 - TextWidth(BannerText) / 2, SH * 0.16f + 44, FLinearColor::White);
	}

	// ---------- the current tool, then toasts above it
	float Y = SH - 16;
	if (PC)
	{
		if (!PC->HoverLine.IsEmpty())
		{
			Y -= 24;
			const float TW = TextWidth(PC->HoverLine) + 24;
			Panel(SW / 2 - TW / 2, Y - 3, TW, 24);
			Text(PC->HoverLine, SW / 2 - TW / 2 + 12, Y, PC->bHoverOk ? kGood : kBad);
		}
		Y -= 26;
		const float TW = TextWidth(PC->ToolLine) + 24;
		Panel(SW / 2 - TW / 2, Y - 3, TW, 24);
		Text(PC->ToolLine, SW / 2 - TW / 2 + 12, Y, kGold);
	}
	Y -= 10;
	for (int32 I = static_cast<int32>(G.toasts.size()) - 1; I >= 0; I--)
	{
		const Ski::Toast& T = G.toasts[I];
		const FString S = Str(T.text);
		Y -= 26;
		const float TW = TextWidth(S) + 24;
		Panel(SW / 2 - TW / 2, Y - 3, TW, 24, 0.7f * FMath::Clamp(static_cast<float>(T.life), 0.f, 1.f));
		FLinearColor C = T.bad ? kBad : FLinearColor::White;
		C.A = FMath::Clamp(static_cast<float>(T.life), 0.f, 1.f);
		Text(S, SW / 2 - TW / 2 + 12, Y, C);
	}

	// ---------- the selection
	if (G.selected && G.selected->kind != Ski::SelKind::Hill)
	{
		const Ski::Game::SelectionText Sel = G.selectionText();
		const float PW = FMath::Min(420.f, SW * 0.3f);
		const TArray<FString> Body = Wrap(Str(Sel.body), PW - 24);
		const float PH = 40 + Body.Num() * 20 + 10;
		const float PY = SH - PH - 12;
		Panel(12, PY, PW, PH, 0.7f);
		float LY = PY + 10;
		LY += Text(Str(Sel.title), 24, LY, kGold) + 4;
		for (const FString& L : Body) LY += Text(L, 24, LY, kSoft);
	}
}
