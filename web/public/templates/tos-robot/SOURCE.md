# tos-robot

- Title: Tears of Steel: the robot
- Source: https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov
- License: CC-BY 3.0
- Credit: Tears of Steel (c) Blender Foundation, CC-BY 3.0, mango.blender.org
- Range: 193.1 s to 206.5 s of the source (13.4 s), re-encoded to 24 fps, 322 frames, 1280x534

Produced from `pipeline/` with:

```sh
uv run python -m labelmeme prep tears_of_steel_720p.mov --start 193.1 --duration 13.4 --id tos-robot --title 'Tears of Steel: the robot' --credit 'Tears of Steel (c) Blender Foundation, CC-BY 3.0, mango.blender.org' --source-url https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov --license 'CC-BY 3.0'
```
