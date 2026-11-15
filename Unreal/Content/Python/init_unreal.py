"""Runs every time the Unreal Editor opens this project.

Creates the one material the C++ code wants but can't make itself:
/Game/Skilandia/M_VertexColor, a plain lit two-sided material whose colour
comes from the mesh's vertex colours. The terrain uses it for snow, rock and
the steepness tint, and the runs and roads for their colours. Without it the
game still runs, with a plain white mountain.
"""

import unreal

PACKAGE = "/Game/Skilandia"
NAME = "M_VertexColor"


def make_vertex_color_material() -> None:
    path = f"{PACKAGE}/{NAME}"
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        return
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    material = tools.create_asset(NAME, PACKAGE, unreal.Material, unreal.MaterialFactoryNew())
    if material is None:
        unreal.log_error(f"Skilandia: couldn't create {path}")
        return
    lib = unreal.MaterialEditingLibrary
    color = lib.create_material_expression(material, unreal.MaterialExpressionVertexColor, -400, 0)
    lib.connect_material_property(color, "", unreal.MaterialProperty.MP_BASE_COLOR)
    rough = lib.create_material_expression(material, unreal.MaterialExpressionConstant, -400, 200)
    rough.set_editor_property("r", 0.85)
    lib.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)
    # Seen from either side, so a flipped triangle can't hide the ground.
    material.set_editor_property("two_sided", True)
    lib.recompile_material(material)
    unreal.EditorAssetLibrary.save_asset(path)
    unreal.log(f"Skilandia: created {path}")


make_vertex_color_material()
