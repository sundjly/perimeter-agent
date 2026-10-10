import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

export interface ModelGateway {
	baseUrl: string;
	token: string;
	model: string;
}

export function gatewayModels(config: ModelGateway) {
	const models = createModels();
	models.setProvider(createProvider({
		id: "perimeter",
		baseUrl: config.baseUrl,
		auth: { apiKey: { name: "网关", resolve: async () => ({ auth: { apiKey: config.token }, source: "config" }) } },
		models: [{
			id: config.model, name: config.model, api: "openai-completions", provider: "perimeter",
			baseUrl: config.baseUrl, reasoning: false, input: ["text"], contextWindow: 128_000,
			maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsDeveloperRole: false, supportsStore: false, sendSessionAffinityHeaders: true, sessionAffinityFormat: "openai" },
		}],
		api: { stream, streamSimple },
	}));
	return models;
}
