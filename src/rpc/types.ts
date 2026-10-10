export type PiEvent = { type: string; [k: string]: unknown };
export type PiResponse = { type: "response"; command: string; success: boolean; [k: string]: unknown };
export type PiCommand = { type: string; [k: string]: unknown };
