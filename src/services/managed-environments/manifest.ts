import { z } from "zod"

export const MAX_MANIFEST_BYTES = 256 * 1024

const normalizeName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-")

/** Deliberately narrower than the complete wheel/PEP 440 grammar. */
export function wheelFilename(url: string): string {
	if (!/^https:\/\/files\.pythonhosted\.org\/packages\/(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.+-]+\.whl$/.test(url)) {
		throw new Error("Only exact HTTPS files.pythonhosted.org/packages wheel URLs are supported")
	}
	const parsed = new URL(url)
	if (parsed.href !== url || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port) {
		throw new Error("Noncanonical wheel URL")
	}
	const filename = parsed.pathname.slice(parsed.pathname.lastIndexOf("/") + 1)
	if (
		!/^[A-Za-z0-9_]+-[A-Za-z0-9_.+]+-(?:[0-9][A-Za-z0-9_]*-)?[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+\.whl$/.test(
			filename,
		)
	) {
		throw new Error("Unsupported wheel filename")
	}
	return filename
}

const packageSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*$/),
		version: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[0-9][A-Za-z0-9_.+]*$/),
		url: z.string().max(2048),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	})
	.strict()

export const manifestSchema = z
	.object({
		version: z.literal(1),
		pythonVersion: z.string().regex(/^3\.(?:[9]|[1-9][0-9])$/),
		packages: z.array(packageSchema).min(1).max(100),
	})
	.strict()
	.superRefine((manifest, context) => {
		const names = new Set<string>()
		for (const [index, pkg] of manifest.packages.entries()) {
			try {
				const filename = wheelFilename(pkg.url)
				const [name, version] = filename.split("-")
				if (normalizeName(name) !== normalizeName(pkg.name) || version !== pkg.version) {
					throw new Error("Wheel filename must match the exact package name and version")
				}
				const normalized = normalizeName(pkg.name)
				if (names.has(normalized) || ["pip", "setuptools", "wheel"].includes(normalized)) {
					throw new Error("Duplicate packages and installer replacements are not supported")
				}
				names.add(normalized)
			} catch (error) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: ["packages", index], message: String(error) })
			}
		}
	})

export type Manifest = z.infer<typeof manifestSchema>

export function parseManifest(input: unknown): Manifest {
	return manifestSchema.parse(input)
}
