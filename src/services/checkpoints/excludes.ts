import fs from "fs/promises"
import { join } from "path"

import { fileExistsAtPath } from "../../utils/fs"
import { MAX_CHECKPOINT_FILE_BYTES } from "./storageProtection"

const getBuildArtifactPatterns = () => [
	// Disposable environments and caches may contain gigabytes of small files.
	// Directory patterns also match nested projects without a workspace .gitignore.
	".venv/",
	".virtualenv/",
	".tox/",
	".nox/",
	"__pypackages__/",
	".mypy_cache/",
	".ruff_cache/",
	".hypothesis/",
	".pytype/",
	".ipynb_checkpoints/",
	".cache/",
	".uv-cache/",
	".npm/",
	".pnpm-store/",
	"**/.yarn/cache/",
	"**/.yarn/unplugged/",
	".turbo/",
	".svelte-kit/",
	"**/.angular/cache/",
	".gradle/",
	".idea/",
	".parcel-cache/",
	".pytest_cache/",
	".next/",
	".nuxt/",
	".sass-cache/",
	".terraform/",
	".terragrunt-cache/",
	".vs/",
	".vscode/",
	"Pods/",
	"__pycache__/",
	"bin/",
	"build/",
	"bundle/",
	"coverage/",
	"deps/",
	"dist/",
	"env/",
	"node_modules/",
	"obj/",
	"out/",
	"pkg/",
	"pycache/",
	"target/dependency/",
	"temp/",
	"vendor/",
	"venv/",
]

const getMediaFilePatterns = () => [
	"*.jpg",
	"*.jpeg",
	"*.png",
	"*.gif",
	"*.bmp",
	"*.ico",
	"*.webp",
	"*.tiff",
	"*.tif",
	"*.raw",
	"*.heic",
	"*.avif",
	"*.eps",
	"*.psd",
	"*.3gp",
	"*.aac",
	"*.aiff",
	"*.asf",
	"*.avi",
	"*.divx",
	"*.flac",
	"*.m4a",
	"*.m4v",
	"*.mkv",
	"*.mov",
	"*.mp3",
	"*.mp4",
	"*.mpeg",
	"*.mpg",
	"*.ogg",
	"*.opus",
	"*.rm",
	"*.rmvb",
	"*.vob",
	"*.wav",
	"*.webm",
	"*.wma",
	"*.wmv",
]

const getCacheFilePatterns = () => [
	"*.DS_Store",
	"*.bak",
	"*.cache",
	"*.crdownload",
	"*.dmp",
	"*.dump",
	"*.eslintcache",
	"*.lock",
	"*.log",
	"*.old",
	"*.part",
	"*.partial",
	"*.pyc",
	"*.pyo",
	"*.stackdump",
	"*.swo",
	"*.swp",
	"*.temp",
	"*.tmp",
	"*.Thumbs.db",
]

const getConfigFilePatterns = () => ["*.env*", "*.local", "*.development", "*.production"]

const getLargeDataFilePatterns = () => [
	"*.zip",
	"*.tar",
	"*.gz",
	"*.rar",
	"*.7z",
	"*.iso",
	"*.bin",
	"*.exe",
	"*.dll",
	"*.so",
	"*.dylib",
	"*.dat",
	"*.dmg",
	"*.msi",
	// Serialized model weights, not model directories: keep code, configuration,
	// tokenizer metadata and shard index JSON eligible for checkpoints.
	"*.safetensors",
	"*.gguf",
	"*.ggml",
	"*.ckpt",
	"*.pt",
	"*.pth",
	"*.onnx",
	"*.h5",
	"*.hdf5",
	"*.npy",
	"*.npz",
	"*.pkl",
	"*.pickle",
	"*.joblib",
	"*.tfrecord",
	"*.tfrecords",
	"*.tfevents.*",
]

const getDatabaseFilePatterns = () => [
	"*.arrow",
	"*.accdb",
	"*.aof",
	"*.avro",
	"*.bak",
	"*.bson",
	"*.csv",
	"*.db",
	"*.dbf",
	"*.dmp",
	"*.frm",
	"*.ibd",
	"*.mdb",
	"*.myd",
	"*.myi",
	"*.orc",
	"*.parquet",
	"*.pdb",
	"*.rdb",
	"*.sql",
	"*.sqlite",
]

const getGeospatialPatterns = () => [
	"*.shp",
	"*.shx",
	"*.dbf",
	"*.prj",
	"*.sbn",
	"*.sbx",
	"*.shp.xml",
	"*.cpg",
	"*.gdb",
	"*.mdb",
	"*.gpkg",
	"*.kml",
	"*.kmz",
	"*.gml",
	"*.geojson",
	"*.dem",
	"*.asc",
	"*.img",
	"*.ecw",
	"*.las",
	"*.laz",
	"*.mxd",
	"*.qgs",
	"*.grd",
	"*.csv",
	"*.dwg",
	"*.dxf",
]

const getLogFilePatterns = () => [
	"*.error",
	"*.log",
	"*.logs",
	"*.npm-debug.log*",
	"*.out",
	"*.stdout",
	"yarn-debug.log*",
	"yarn-error.log*",
]

const getLfsPatterns = async (workspacePath: string) => {
	try {
		const attributesPath = join(workspacePath, ".gitattributes")

		if (await fileExistsAtPath(attributesPath)) {
			const stat = await fs.lstat(attributesPath)
			if (!stat.isFile() || stat.size > MAX_CHECKPOINT_FILE_BYTES) return []
			return (await fs.readFile(attributesPath, "utf8"))
				.split("\n")
				.filter((line) => line.includes("filter=lfs"))
				.map((line) => line.split(" ")[0].trim())
		}
	} catch (error) {}

	return []
}

export const getExcludePatterns = async (workspacePath: string) => [
	".git/",
	...getBuildArtifactPatterns(),
	...getMediaFilePatterns(),
	...getCacheFilePatterns(),
	...getConfigFilePatterns(),
	...getLargeDataFilePatterns(),
	...getDatabaseFilePatterns(),
	...getGeospatialPatterns(),
	...getLogFilePatterns(),
	...dependencyLockPatterns,
	...(await getLfsPatterns(workspacePath)),
]

// Preserve reproducible dependency definitions despite the generic *.lock rule.
// These cannot re-include files inside an excluded environment/cache directory.
const dependencyLockPatterns = [
	"!uv.lock",
	"!poetry.lock",
	"!pdm.lock",
	"!Pipfile.lock",
	"!yarn.lock",
	"!Cargo.lock",
	"!composer.lock",
	"!Gemfile.lock",
	"!bun.lock",
]
