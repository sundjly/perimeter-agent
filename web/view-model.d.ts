import type { ClientEvent, SessionView } from "../src/protocol/types.ts";
export type ViewState = SessionView & { errors: string[]; phase: string };
export function initialState(): ViewState;
export function reduce(state: ViewState, event: ClientEvent): ViewState;
