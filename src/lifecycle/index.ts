export {
  FSM_STATES,
  FSM_EVENTS,
  TRANSITION_TABLE,
  transition,
  SessionFsm,
} from './fsm.js';
export type { FsmState, FsmEvent, TransitionResult } from './fsm.js';

export { recencyDecay } from './decay.js';

export { resolveLwwConflict } from './lww.js';
export type { LwwResult } from './lww.js';

export { rejectSince, parseDurationToMs } from './reject.js';

export { AntiRotTimer } from './anti-rot.js';
