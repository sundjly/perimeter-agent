import { defineDoc } from "@earendil-works/pi-durable";
export const AuthorsDoc = defineDoc<{ requests: Record<string, string> }>({
	kind: "perimeter.authors", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ requests: {} }),
});
