import type { ProjectState } from '../types';

/** Apply the single valid terminal-success invariant in one testable place. */
export function finalizeCompletedState(state: ProjectState): ProjectState {
  state.activeTasks = [];
  state.status = 'completed';
  state.currentPhase = 'completed';
  state.currentTaskId = null;
  state.fixRetryCount = 0;
  state.updatedAt = new Date().toISOString();
  return state;
}
