/** Asks one terminal question; the signal closes a pending readline question on cancellation. */
type Prompt = (question: string, options?: { signal?: AbortSignal }) => Promise<string>;

export { type Prompt };
