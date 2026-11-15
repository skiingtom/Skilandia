using System.IO;
using UnrealBuildTool;

public class Skilandia : ModuleRules
{
	public Skilandia(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		CppStandard = CppStandardVersion.Cpp20;

		// Core/ is the simulation: plain C++ with no Unreal types, shared with
		// the headless test in Unreal/CoreTests.
		PrivateIncludePaths.Add(Path.Combine(ModuleDirectory, "Core"));

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"InputCore",
			"ProceduralMeshComponent",
		});
	}
}
