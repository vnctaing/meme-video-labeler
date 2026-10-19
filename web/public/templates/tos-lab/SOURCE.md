# tos-lab

- Title: Tears of Steel: the lab
- Source: https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov
- License: CC-BY 3.0
- Credit: Tears of Steel (c) Blender Foundation, CC-BY 3.0, mango.blender.org
- Range: 225.1 s to 244.5 s of the source (19.4 s), re-encoded to 24 fps, 466 frames, 1280x534

Produced from `pipeline/` with:

```sh
uv run python -m labelmeme prep /private/tmp/claude-501/-Users-vnctaing-projects/fa08a773-7b51-4d6c-940a-5f603e8dad4f/scratchpad/design-A-dl/tos720.mov --start 225.1 --duration 19.4 --id tos-lab --title 'Tears of Steel: the lab' --credit 'Tears of Steel (c) Blender Foundation, CC-BY 3.0, mango.blender.org' --source-url https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov --license 'CC-BY 3.0'
```
