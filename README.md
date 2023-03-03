# About
This is a little utility which uses ffmpeg to add chapters to MP4/MKV files. It does so by picking key frame after an interval (configurable) has passed. This is useful for customizing the up/down jump in Kodi.


# Quick Start
```bash
deno run --allow-read --allow-write --allow-env --allow-run chapterizer.ts <input dir> <output dir>

# or just allow all 
deno run -A chapterizer.ts <input dir> <output dir>

# checkout/edit .env for configuration
cat .env
```
