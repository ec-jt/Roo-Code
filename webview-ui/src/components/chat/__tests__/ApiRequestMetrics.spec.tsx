import { act, render, screen } from "@testing-library/react"
import { ApiRequestMetrics } from "../ApiRequestMetrics"
import en from "../../../i18n/locales/en/chat.json"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values: Record<string, string> = {}) => {
			const name = key.split(".").at(-1) as keyof typeof en.apiRequest.metrics
			return en.apiRequest.metrics[name].replace(/{{(\w+)}}/g, (_, variable) => String(values[variable]))
		},
	}),
}))

afterEach(() => vi.useRealTimers())

it("shows cache hits as a share of total input, without inventing expiry", () => {
	render(<ApiRequestMetrics active={false} info={{ tokensIn: 1000, cacheReads: 800, cacheWrites: 100 }} />)
	expect(screen.getByText(/Cache read: 800 tokens/)).toHaveTextContent("80%")
	expect(screen.getByText(/Cache read: 800 tokens/)).toHaveTextContent("Cache write: 100 tokens")
	expect(screen.getByText("Cache expiry: not reported by provider")).toBeInTheDocument()
})

it("distinguishes explicit zero from missing cache telemetry in old histories", () => {
	const { rerender } = render(<ApiRequestMetrics active={false} info={{ tokensIn: 1000, cacheReads: 0 }} />)
	expect(screen.getByText("Cache usage not reported")).toBeInTheDocument()
	rerender(
		<ApiRequestMetrics active={false} info={{ tokensIn: 1000, cacheReads: 0, cacheReadTokensReported: true }} />,
	)
	expect(screen.getByText(/Cache read: 0 tokens/)).toHaveTextContent("0%")
})

it("updates a live phase timer and stops it when completed", () => {
	vi.useFakeTimers()
	vi.setSystemTime(3000)
	const timing = { startedAt: 1000, providerStartedAt: 2000 }
	const { rerender, unmount } = render(<ApiRequestMetrics active info={{ timing }} />)
	expect(screen.getByText(/Preparation 1.0s/)).toHaveTextContent("First chunk 1.0s")
	expect(screen.getByText(/Waiting for provider/)).toBeInTheDocument()
	act(() => {
		vi.advanceTimersByTime(2000)
	})
	expect(screen.getByText(/Preparation 1.0s/)).toHaveTextContent("First chunk 3.0s")
	rerender(
		<ApiRequestMetrics active={false} info={{ timing: { ...timing, firstChunkAt: 4000, completedAt: 5000 } }} />,
	)
	expect(screen.getByText(/Preparation 1.0s/)).toHaveTextContent("First chunk 2.0s")
	expect(vi.getTimerCount()).toBe(0)
	unmount()
})
