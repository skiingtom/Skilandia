using UnrealBuildTool;

public class SkilandiaTarget : TargetRules
{
	public SkilandiaTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("Skilandia");
	}
}
