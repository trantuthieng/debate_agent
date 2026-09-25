/** Small, VS Code-free seam used to keep sidebar routing regression-testable. */
export interface SidebarWorkflowOrchestrator {
  runAutonomousGoal(goal: string): Promise<void>;
}

export function runSidebarGoal(
  orchestrator: SidebarWorkflowOrchestrator,
  goal: string
): Promise<void> {
  return orchestrator.runAutonomousGoal(goal);
}
