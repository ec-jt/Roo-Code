/** Wait for an operation or cancellation, retaining an abort listener only while waiting. */
export async function abortable<T>(signal: AbortSignal, operation: () => PromiseLike<T>, message: string): Promise<T> {
	if (signal.aborted) throw new Error(message)

	let onAbort!: () => void
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Error(message))
		signal.addEventListener("abort", onAbort, { once: true })
	})

	try {
		// Convert synchronous failures into rejections so both outcomes remain observed.
		const pending = new Promise<T>((resolve) => resolve(operation()))
		return await Promise.race([pending, aborted])
	} finally {
		// Do not wait for the operation to settle: a cancelled provider may never finish.
		signal.removeEventListener("abort", onAbort)
	}
}
