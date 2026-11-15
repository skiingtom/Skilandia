#include "SkiPlayerController.h"

#include "Components/InputComponent.h"
#include "DrawDebugHelpers.h"
#include "Engine/World.h"
#include "GameFramework/Pawn.h"
#include "InputCoreTypes.h"
#include "SkiResort.h"

#include <cmath>
#include <string>

namespace
{
constexpr double kCm = 100.0;

FString Str(const std::string& S) { return FString(UTF8_TO_TCHAR(S.c_str())); }

FString Money(double V) { return FString::Printf(TEXT("$%s"), *FText::AsNumber(FMath::RoundToInt64(V)).ToString()); }

FString Metres(double V) { return FString::Printf(TEXT("%s m"), *FText::AsNumber(FMath::RoundToInt64(V)).ToString()); }

const TCHAR* ShapeModeName(Ski::SculptMode M)
{
	switch (M)
	{
	case Ski::SculptMode::Raise: return TEXT("Raise");
	case Ski::SculptMode::Lower: return TEXT("Lower");
	case Ski::SculptMode::Flatten: return TEXT("Flatten");
	case Ski::SculptMode::Smooth: return TEXT("Smooth");
	}
	return TEXT("?");
}

/** F1-F6 hire staff. Built on first use: EKeys are only ready once InputCore has started. */
const FKey& StaffKey(int32 I)
{
	static const FKey Keys[] = {EKeys::F1, EKeys::F2, EKeys::F3, EKeys::F4, EKeys::F5, EKeys::F6};
	return Keys[I];
}
} // namespace

ASkiPlayerController::ASkiPlayerController()
{
	bShowMouseCursor = true;
	DefaultMouseCursor = EMouseCursor::Default;
	bEnableClickEvents = false;
	bEnableMouseOverEvents = false;
}

const TArray<Ski::BuildingType>& ASkiPlayerController::BuildOrder()
{
	using BT = Ski::BuildingType;
	static const TArray<BT> Order = {
		// Base
		BT::Lodge, BT::Restroom, BT::Rental, BT::School, BT::Clinic, BT::Patrol,
		// Food
		BT::Shack, BT::FoodTruck, BT::Waffle, BT::Coffee, BT::Bakery, BT::Sandwich, BT::Burger, BT::Pizza, BT::Noodle, BT::Cafeteria,
		// Dining
		BT::Restaurant, BT::Bar, BT::Brewpub, BT::Fondue, BT::Sushi, BT::Steakhouse, BT::Summit,
		// Shops
		BT::Gifts, BT::SkiShop, BT::Grocery, BT::Shop, BT::Chocolate, BT::Outfitter, BT::Boutique,
		// Hotels
		BT::Motel, BT::Bnb, BT::Hostel, BT::Inn, BT::Condo, BT::Hotel, BT::BoutiqueHotel, BT::GrandHotel,
		// Resort
		BT::Lookout, BT::Spa, BT::CabinOffice, BT::Cabin, BT::Heli,
		// Parking
		BT::ParkingSmall, BT::ParkingLarge, BT::Garage,
	};
	return Order;
}

void ASkiPlayerController::BeginPlay()
{
	Super::BeginPlay();
	FInputModeGameAndUI Mode;
	Mode.SetHideCursorDuringCapture(false);
	Mode.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock);
	SetInputMode(Mode);
}

void ASkiPlayerController::SetupInputComponent()
{
	Super::SetupInputComponent();
	InputComponent->BindAxisKey(EKeys::MouseWheelAxis, this, &ASkiPlayerController::OnWheel);
}

void ASkiPlayerController::OnWheel(float Value) { Wheel += Value; }

ASkiResort* ASkiPlayerController::GetResort() const
{
	if (!Resort.IsValid()) Resort = ASkiResort::Find(GetWorld());
	return Resort.Get();
}

bool ASkiPlayerController::Shift() const { return IsInputKeyDown(EKeys::LeftShift) || IsInputKeyDown(EKeys::RightShift); }

// ---------- camera

void ASkiPlayerController::FocusOn(ASkiResort& R, double X, double Y, double DistanceM)
{
	Target = R.ToWorld(X, Y, 0);
	TargetLiftM = 0;
	Distance = DistanceM * kCm;
}

void ASkiPlayerController::InitCamera(ASkiResort& R)
{
	const Ski::Game& G = *R.GetGame();
	bCameraReady = true;
	if (G.lifts.empty())
	{
		FocusOn(R, Ski::kBase.x, Ski::kBase.y, 1700);
		return;
	}
	// Over the village, looking up the starter T-bar toward the mountain.
	const Ski::Lift& L = G.lifts.front();
	FocusOn(R, (L.bottom.x + L.top.x) / 2, (L.bottom.y + L.top.y) / 2, 1700);
	Yaw = FMath::RadiansToDegrees(std::atan2(-(L.top.y - L.bottom.y), L.top.x - L.bottom.x));
	Pitch = -32;
}

void ASkiPlayerController::UpdateCamera(ASkiResort& R, float DeltaTime, const FVector2D& MouseDelta)
{
	// Right-drag looks around the target; middle-drag drags the map.
	if (IsInputKeyDown(EKeys::RightMouseButton))
	{
		Yaw += MouseDelta.X * 0.3;
		Pitch = FMath::Clamp(Pitch - MouseDelta.Y * 0.25, -88.0, -7.0);
	}
	const FVector Forward = FVector(FMath::Cos(FMath::DegreesToRadians(Yaw)), FMath::Sin(FMath::DegreesToRadians(Yaw)), 0);
	const FVector Right(-Forward.Y, Forward.X, 0);
	if (IsInputKeyDown(EKeys::MiddleMouseButton))
	{
		const double Scale = Distance * 0.0016;
		Target += (-Right * MouseDelta.X + Forward * MouseDelta.Y) * Scale;
	}
	if (Wheel != 0)
	{
		Distance = FMath::Clamp(Distance * FMath::Pow(0.88, static_cast<double>(Wheel)), 40.0 * kCm, 30000.0 * kCm);
		Wheel = 0;
	}
	// Fly: faster the higher you are, so crossing the valley doesn't take forever.
	const double Speed = (Shift() ? 2.5 : 1.0) * FMath::Max(200.0 * kCm, Distance) * 0.6 * DeltaTime;
	FVector Move = FVector::ZeroVector;
	if (IsInputKeyDown(EKeys::W) || IsInputKeyDown(EKeys::Up)) Move += Forward;
	if (IsInputKeyDown(EKeys::S) || IsInputKeyDown(EKeys::Down)) Move -= Forward;
	if (IsInputKeyDown(EKeys::D) || IsInputKeyDown(EKeys::Right)) Move += Right;
	if (IsInputKeyDown(EKeys::A) || IsInputKeyDown(EKeys::Left)) Move -= Right;
	if (!Move.IsNearlyZero()) Target += Move.GetSafeNormal() * Speed;
	if (IsInputKeyDown(EKeys::Q)) TargetLiftM += Speed * 0.7 / kCm;
	if (IsInputKeyDown(EKeys::E)) TargetLiftM = FMath::Max(0.0, TargetLiftM - Speed * 0.7 / kCm);

	// Keep the target on the map, riding over the ground.
	Ski::Vec2 M = R.ToMap(Target);
	M.x = FMath::Clamp(M.x, 0.0, Ski::kWorldW);
	M.y = FMath::Clamp(M.y, 0.0, Ski::kWorldH);
	const double GroundZ = R.ToWorld(M.x, M.y, TargetLiftM).Z;
	Target = FVector(M.x * kCm, -M.y * kCm, FMath::FInterpTo(Target.Z, GroundZ, static_cast<double>(DeltaTime), 6.0));

	const FRotator Rot(static_cast<float>(Pitch), static_cast<float>(Yaw), 0.f);
	FVector Eye = Target - Rot.Vector() * Distance;
	// Never under the snow.
	const Ski::Vec2 EyeMap = R.ToMap(Eye);
	Eye.Z = FMath::Max(Eye.Z, R.ToWorld(EyeMap.x, EyeMap.y, 15).Z);
	if (APawn* P = GetPawn()) P->SetActorLocation(Eye);
	SetControlRotation((Target - Eye).Rotation());
}

// ---------- keys

void ASkiPlayerController::HandleKeys(ASkiResort& R)
{
	Ski::Game& G = *R.GetGame();
	using Ski::Tool;
	using Ski::ToolKind;

	if (Pressed(EKeys::Escape))
	{
		G.cancel();
		G.selected.reset();
		bShaping = bPainting = false;
	}
	if (Pressed(EKeys::Enter) && (G.tool == ToolKind::Cut || G.tool == ToolKind::Road || G.tool == ToolKind::Path)) G.finishTrail();
	if (Pressed(EKeys::SpaceBar)) G.togglePause();
	if (Pressed(EKeys::One)) G.setSpeed(1);
	if (Pressed(EKeys::Two)) G.setSpeed(2);
	if (Pressed(EKeys::Three)) G.setSpeed(3);
	if (Pressed(EKeys::G)) R.SetShowSteepness(!R.IsShowingSteepness());
	if (Pressed(EKeys::Tab)) bShowHelp = !bShowHelp;
	if (Pressed(EKeys::Home)) FocusOn(R, Ski::kBase.x, Ski::kBase.y, 1700);
	if (Pressed(EKeys::Equals) || Pressed(EKeys::Add)) G.setTicketPrice(G.ticketPrice + 2);
	if (Pressed(EKeys::Hyphen) || Pressed(EKeys::Subtract)) G.setTicketPrice(G.ticketPrice - 2);

	// Runs: T, again to change the kind.
	if (Pressed(EKeys::T))
	{
		const Ski::TrailKind Next = G.tool == ToolKind::Cut
			? static_cast<Ski::TrailKind>((static_cast<int32>(G.trailKind) + 1) % Ski::kTrailKindCount)
			: G.trailKind;
		G.setTool(Tool::ForTrail(Next));
	}
	// Lifts: L, again to change the type.
	if (Pressed(EKeys::L))
	{
		if (G.tool == ToolKind::Lift) LiftChoice = static_cast<Ski::LiftType>((static_cast<int32>(LiftChoice) + 1) % Ski::kLiftTypeCount);
		G.setTool(Tool::ForLift(LiftChoice));
	}
	// Park features: F, again to change.
	if (Pressed(EKeys::F))
	{
		const Ski::FeatureType Next = G.tool == ToolKind::Feature
			? static_cast<Ski::FeatureType>((static_cast<int32>(G.toolFeature) + 1) % Ski::kFeatureTypeCount)
			: G.toolFeature;
		G.setTool(Tool::ForFeature(Next));
	}
	// Buildings: B (Shift+B back) through whatever is unlocked and not at its limit.
	if (Pressed(EKeys::B))
	{
		const TArray<Ski::BuildingType>& Order = BuildOrder();
		const int32 Step = Shift() ? -1 : 1;
		int32 Index = G.tool == ToolKind::Build ? BuildIndex + Step : BuildIndex;
		for (int32 Tries = 0; Tries < Order.Num(); Tries++, Index += Step)
		{
			Index = (Index % Order.Num() + Order.Num()) % Order.Num();
			const Ski::BuildingType Type = Order[Index];
			if (G.tier() >= Ski::UnlockTier(Type) && G.count(Type) < Ski::Info(Type).max)
			{
				BuildIndex = Index;
				G.setTool(Tool::Build(Type));
				break;
			}
		}
	}
	if (Pressed(EKeys::R)) G.setTool(Tool::Of(ToolKind::Road));
	if (Pressed(EKeys::P)) G.setTool(Tool::Of(ToolKind::Path));
	if (Pressed(EKeys::X)) G.setTool(Tool::Of(ToolKind::Demolish));
	if (Pressed(EKeys::C)) G.setTool(Tool::Of(ToolKind::ClearTrees));
	if (Pressed(EKeys::V))
	{
		if (G.tool == ToolKind::PlantTrees) G.plantMode = G.plantMode == Ski::PlantMode::Brush ? Ski::PlantMode::Single : Ski::PlantMode::Brush;
		G.setTool(Tool::Of(ToolKind::PlantTrees));
	}
	// Shape terrain: K, again for the next mode; Shift+K for the next brush size.
	if (Pressed(EKeys::K))
	{
		if (G.tool == ToolKind::Shape && Shift())
		{
			const auto& Sizes = Ski::kShapeSizes;
			size_t I = 0;
			while (I < Sizes.size() && Sizes[I] <= G.shapeRadius) I++;
			G.shapeRadius = Sizes[I % Sizes.size()];
		}
		else if (G.tool == ToolKind::Shape) G.setShapeMode(static_cast<Ski::SculptMode>((static_cast<int32>(G.shapeMode) + 1) % 4));
		else G.setTool(Tool::Of(ToolKind::Shape));
	}
	// Move the selected building.
	if (Pressed(EKeys::M) && G.selected && G.selected->kind == Ski::SelKind::Building) G.startMove(G.selected->id);
	// Staff: F1-F6 hire (Shift fires), in the web game's order.
	for (int32 I = 0; I < Ski::kStaffRoleCount; I++)
	{
		if (!Pressed(StaffKey(I))) continue;
		if (Shift()) G.fire(Ski::kStaffRoles[I]);
		else G.hire(Ski::kStaffRoles[I]);
	}
}

// ---------- the mouse

void ASkiPlayerController::HandleMouse(ASkiResort& R, float DeltaTime)
{
	Ski::Game& G = *R.GetGame();
	using Ski::ToolKind;
	bHasHover = false;
	FVector Origin, Direction;
	if (DeprojectMousePositionToWorld(Origin, Direction)) bHasHover = R.TraceGround(Origin, Direction, HoverMap, HoverWorld);

	if (bHasHover)
	{
		G.moveHover(HoverMap.x, HoverMap.y);
		G.liftHover = HoverMap;
		G.brushHover = HoverMap;
	}
	else
	{
		G.hover.reset();
		G.liftHover.reset();
		G.brushHover.reset();
	}

	if (Pressed(EKeys::LeftMouseButton) && bHasHover)
	{
		if (G.tool == ToolKind::Shape) bShaping = true;
		else
		{
			G.click(HoverMap.x, HoverMap.y);
			// The tree brushes keep painting while the button is held.
			bPainting = G.tool == ToolKind::ClearTrees || (G.tool == ToolKind::PlantTrees && G.plantMode == Ski::PlantMode::Brush);
		}
	}
	if (IsInputKeyDown(EKeys::LeftMouseButton) && bHasHover)
	{
		if (bShaping) G.shapeStep(HoverMap.x, HoverMap.y, DeltaTime);
		else if (bPainting) G.click(HoverMap.x, HoverMap.y);
	}
	if (WasInputKeyJustReleased(EKeys::LeftMouseButton))
	{
		if (bShaping) G.endShape();
		if (bPainting) G.endBrush();
		bShaping = bPainting = false;
	}
}

// ---------- what the HUD says about the current tool

void ASkiPlayerController::DescribeTool(ASkiResort& R)
{
	Ski::Game& G = *R.GetGame();
	using Ski::ToolKind;
	HoverLine.Reset();
	bHoverOk = true;
	auto Fail = [this](const std::optional<std::string>& Err, const FString& Ok) {
		bHoverOk = !Err;
		HoverLine = Err ? Str(*Err) : Ok;
	};
	switch (G.tool)
	{
	case ToolKind::Select:
	{
		ToolLine = TEXT("Look: click something to see what it is");
		if (G.hover && G.hover->kind != Ski::SelKind::Hill)
		{
			const std::optional<Ski::Selection> Was = G.selected;
			G.selected = G.hover;
			HoverLine = Str(G.selectionText().title);
			G.selected = Was;
		}
		break;
	}
	case ToolKind::Cut:
	{
		ToolLine = FString::Printf(TEXT("Cut a run: %s (T for another kind). Click downhill points, Enter to open it"), UTF8_TO_TCHAR(Ski::Spec(G.trailKind).label));
		if (const std::optional<Ski::TrailMeasure> Info = G.draftInfo())
		{
			HoverLine = FString::Printf(TEXT("%s \x00B7 %s long \x00B7 %s drop \x00B7 %s"), UTF8_TO_TCHAR(Ski::kDiff[Info->difficulty].name),
				*Metres(Info->length), *Metres(Info->drop * Ski::kVerticalM), *Money(Info->cost));
		}
		else HoverLine = TEXT("Start high on the mountain");
		break;
	}
	case ToolKind::Road:
	case ToolKind::Path:
	{
		const bool Road = G.tool == ToolKind::Road;
		ToolLine = Road ? TEXT("Road: start on the highway, a road or the lot; end on a road or the lot (Enter to finish)")
						: TEXT("Footpath: click along the way; ending on a building, lift or path finishes it");
		const Ski::Game::DraftInfo Info = Road ? G.roadDraftInfo() : G.pathDraftInfo();
		double Leg = 0;
		if (bHasHover && !G.draft.empty()) Leg = Ski::LegGrade(G.draft.back(), HoverMap);
		const double Max = Road ? Ski::kRoadMaxGrade : Ski::kPathMaxGrade;
		bHoverOk = Leg <= Max;
		HoverLine = FString::Printf(TEXT("%s \x00B7 %s \x00B7 this leg %d%% (max %d%%)"), *Metres(Info.length), *Money(Info.cost),
			FMath::RoundToInt32(Leg * 100), FMath::RoundToInt32(Max * 100));
		break;
	}
	case ToolKind::Lift:
	{
		ToolLine = FString::Printf(TEXT("Lift: %s (L for another type). Click the bottom station, then the top"), UTF8_TO_TCHAR(Ski::Spec(G.toolLift).label));
		if (G.liftStart && bHasHover)
		{
			const Ski::LiftCheck Check = G.checkLift(G.toolLift, *G.liftStart, HoverMap);
			Fail(Check.error, FString::Printf(TEXT("%s long \x00B7 %s rise \x00B7 %s"), *Metres(Check.length), *Metres(Check.rise), *Money(Check.cost)));
		}
		break;
	}
	case ToolKind::Build:
	{
		const Ski::BuildingInfo& Info = Ski::Info(G.toolBuilding);
		ToolLine = FString::Printf(TEXT("Build: %s, %s (B / Shift+B for another)"), UTF8_TO_TCHAR(Info.label), *Money(Info.cost));
		if (bHasHover) Fail(G.canPlace(G.toolBuilding, HoverMap.x, HoverMap.y), FString::Printf(TEXT("Click to build. Earns %s/min when busy"), *Money(Info.incomePerMin)));
		break;
	}
	case ToolKind::Feature:
	{
		const Ski::FeatureSpec& Spec = Ski::Spec(G.toolFeature);
		ToolLine = FString::Printf(TEXT("Park feature: %s, %s (F for another)"), UTF8_TO_TCHAR(Spec.label), *Money(Spec.cost));
		if (bHasHover) Fail(G.canPlaceFeature(G.toolFeature, HoverMap.x, HoverMap.y), TEXT("Click to build"));
		break;
	}
	case ToolKind::Demolish:
	{
		ToolLine = TEXT("Demolish: click a building, lift, run, feature, road or path");
		if (bHasHover)
		{
			if (const std::optional<Ski::DemolishTarget> T = G.demolishTarget(HoverMap.x, HoverMap.y))
				HoverLine = FString::Printf(TEXT("Take down %s%s"), *Str(T->label), T->refund ? *FString::Printf(TEXT(" (+%s)"), *Money(T->refund)) : TEXT(""));
		}
		break;
	}
	case ToolKind::ClearTrees:
	{
		ToolLine = TEXT("Clear trees: click or drag over the forest");
		if (bHasHover)
		{
			const int32 N = G.treesUnderBrush(HoverMap.x, HoverMap.y);
			HoverLine = FString::Printf(TEXT("%d trees \x00B7 %s"), N, *Money(G.freeTreeClearing ? 0 : N * Ski::kTreeFellCost));
		}
		break;
	}
	case ToolKind::PlantTrees:
		ToolLine = G.plantMode == Ski::PlantMode::Brush ? TEXT("Plant trees: drag to scatter saplings (V for one at a time)")
														: TEXT("Plant trees: one per click (V for the brush)");
		HoverLine = FString::Printf(TEXT("%s a tree"), *Money(Ski::kTreePlantCost));
		break;
	case ToolKind::Shape:
		ToolLine = FString::Printf(TEXT("Shape terrain: %s, %d m brush (K: mode, Shift+K: size). Hold the left button"), ShapeModeName(G.shapeMode),
			FMath::RoundToInt32(G.shapeRadius));
		HoverLine = bHasHover ? FString::Printf(TEXT("Ground %s \x00B7 earthworks %+.1f m \x00B7 stroke %s"), *Metres(Ski::ElevationM(HoverMap.x, HoverMap.y)),
									Ski::EarthworkAt(HoverMap.x, HoverMap.y), *Money(G.shapeCost))
							  : FString();
		break;
	case ToolKind::Move:
		ToolLine = TEXT("Move: click a new spot (Esc to cancel)");
		if (bHasHover) Fail(G.canMoveTo(HoverMap.x, HoverMap.y), TEXT("Click to move it here"));
		break;
	case ToolKind::Trail:
		break;
	}
}

// ---------- overlays drawn into the world

void ASkiPlayerController::DrawGroundLine(const ASkiResort& R, const Ski::Vec2& A, const Ski::Vec2& B, const FColor& Color) const
{
	const double Len = std::hypot(B.x - A.x, B.y - A.y);
	const int32 N = FMath::Clamp(FMath::CeilToInt32(Len / 20), 1, 400);
	const float Thick = static_cast<float>(FMath::Clamp(Distance * 0.0015, 40.0, 1500.0));
	FVector Prev = R.ToWorld(A.x, A.y, 2);
	for (int32 K = 1; K <= N; K++)
	{
		const double T = static_cast<double>(K) / N;
		const FVector P = R.ToWorld(A.x + (B.x - A.x) * T, A.y + (B.y - A.y) * T, 2);
		DrawDebugLine(GetWorld(), Prev, P, Color, false, -1.f, 0, Thick);
		Prev = P;
	}
}

void ASkiPlayerController::DrawGroundCircle(const ASkiResort& R, double X, double Y, double RadiusM, const FColor& Color) const
{
	constexpr int32 N = 48;
	for (int32 K = 0; K < N; K++)
	{
		const double A0 = 2 * PI * K / N;
		const double A1 = 2 * PI * (K + 1) / N;
		DrawGroundLine(R, {X + std::cos(A0) * RadiusM, Y + std::sin(A0) * RadiusM}, {X + std::cos(A1) * RadiusM, Y + std::sin(A1) * RadiusM}, Color);
	}
}

void ASkiPlayerController::DrawOverlays(ASkiResort& R) const
{
	const Ski::Game& G = *R.GetGame();
	using Ski::ToolKind;
	const FColor Good(80, 220, 120);
	const FColor Bad(230, 70, 60);
	const FColor Status = bHoverOk ? Good : Bad;

	// The run, road or path being drawn, and the next leg to the pointer.
	if (!G.draft.empty())
	{
		const FColor Color = G.tool == ToolKind::Road ? FColor(70, 70, 75) : G.tool == ToolKind::Path ? FColor(160, 136, 104) : FColor(255, 200, 40);
		for (size_t I = 1; I < G.draft.size(); I++) DrawGroundLine(R, G.draft[I - 1], G.draft[I], Color);
		if (bHasHover) DrawGroundLine(R, G.draft.back(), HoverMap, Status);
	}
	if (G.tool == ToolKind::Lift && G.liftStart && bHasHover) DrawGroundLine(R, *G.liftStart, HoverMap, Status);
	if (!bHasHover) return;
	switch (G.tool)
	{
	case ToolKind::Build:
		DrawGroundCircle(R, HoverMap.x, HoverMap.y, Ski::BuildingRadius(G.toolBuilding), Status);
		DrawGroundCircle(R, Ski::kBase.x, Ski::kBase.y, G.villageRadius(), FColor(90, 150, 230));
		break;
	case ToolKind::Move:
		DrawGroundCircle(R, HoverMap.x, HoverMap.y, 24, Status);
		break;
	case ToolKind::ClearTrees:
	case ToolKind::PlantTrees:
	case ToolKind::Shape:
		DrawGroundCircle(R, HoverMap.x, HoverMap.y, G.brushRadius(), FColor(255, 255, 255));
		break;
	case ToolKind::Feature:
		DrawGroundCircle(R, HoverMap.x, HoverMap.y, 8, Status);
		break;
	default:
		break;
	}
	// The selection.
	if (G.selected)
	{
		if (G.selected->kind == Ski::SelKind::Trail)
		{
			if (const Ski::Trail* T = G.findTrail(G.selected->id))
				for (size_t I = 1; I < T->points.size(); I++) DrawGroundLine(R, T->points[I - 1], T->points[I], FColor(255, 220, 60));
		}
		else if (G.selected->kind == Ski::SelKind::Lift)
		{
			if (const Ski::Lift* L = G.findLift(G.selected->id)) DrawGroundLine(R, L->bottom, L->top, FColor(255, 220, 60));
		}
		else if (G.selected->kind == Ski::SelKind::Building)
		{
			if (const Ski::Building* B = G.findBuilding(G.selected->id)) DrawGroundCircle(R, B->x, B->y, Ski::BuildingRadius(B->type) + 4, FColor(255, 220, 60));
		}
	}
}

void ASkiPlayerController::PlayerTick(float DeltaTime)
{
	Super::PlayerTick(DeltaTime);
	float MX = 0, MY = 0;
	const bool bMouse = GetMousePosition(MX, MY);
	const FVector2D Mouse(MX, MY);
	const FVector2D MouseDelta = bMouse ? Mouse - LastMouse : FVector2D::ZeroVector;
	if (bMouse) LastMouse = Mouse;

	ASkiResort* R = GetResort();
	if (!R || !R->GetGame()) return;
	if (!bCameraReady) InitCamera(*R);
	HandleKeys(*R);
	UpdateCamera(*R, DeltaTime, MouseDelta);
	HandleMouse(*R, DeltaTime);
	DescribeTool(*R);
	DrawOverlays(*R);
}
