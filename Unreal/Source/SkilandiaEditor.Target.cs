using UnrealBuildTool;

public class SkilandiaEditorTarget : TargetRules
{
	public SkilandiaEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("Skilandia");
	}
}
