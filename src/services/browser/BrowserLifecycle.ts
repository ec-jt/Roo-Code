/** Serialize resource ownership changes and fence new work immediately on disposal. */
export class BrowserLifecycle {
	private pending: Promise<unknown> = Promise.resolve()
	private disposed = false
	private disposal?: Promise<void>

	assertOpen(): void {
		if (this.disposed) throw new Error("Browser service has been disposed")
	}

	run<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation)
		this.pending = result.catch(() => {})
		return result
	}

	dispose(cleanup: () => Promise<void>): Promise<void> {
		this.disposed = true
		return (this.disposal ??= this.run(cleanup))
	}
}
